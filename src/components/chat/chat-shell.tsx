"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatNavigation, type ChatSession } from "@/components/chat/chat-navigation";
import { ChatThread } from "@/components/chat/chat-thread";
import { useAppPreferences } from "@/components/providers/app-preferences-provider";
import { McpServerDialog } from "@/components/chat/mcp-server-dialog";
import { MessageComposer } from "@/components/chat/message-composer";
import { SidebarDrawer } from "@/components/chat/sidebar-drawer";
import { SidebarTools } from "@/components/chat/sidebar-tools";
import type { SystemPrompt } from "@/components/chat/system-prompt-section";
import { PortalHeader } from "@/components/layout/portal-header";
import {
  migrateLocalJsonToSession,
  SESSION_LLM_CONFIG_KEY,
  SESSION_MCP_SERVER_KEY,
  writeSessionJson,
} from "@/lib/client-storage";
import { cn } from "@/lib/utils";
import { parseStreamChunks } from "@/lib/chat-stream";
import {
  clearPendingMcpOAuth,
  readPendingMcpOAuth,
  savePendingMcpOAuth,
  waitForMcpOAuthCallback,
} from "@/lib/mcp-oauth-browser";
import type { PendingMcpOAuth } from "@/lib/mcp-oauth-browser";
import type { ChatStreamEvent, Message, ToolEvent } from "@/types/chat";
import type { McpInspectResponse, McpServerConfig } from "@/types/mcp";
import type { LLMConfig } from "@/types/llm-config";
import type { WorkspaceOption } from "@/components/chat/workspace-selector";
import { LEGACY_LLM_CONFIG_STORAGE_KEY } from "@/types/llm-config";

const MESSAGE_STORAGE_KEY = "ai-chat-messages";
const TOOL_EVENT_STORAGE_KEY = "ai-chat-tool-events";
const LEGACY_MCP_STORAGE_KEY = "ai-chat-mcp-servers";
const CUSTOM_PROMPT_KEY = "ai-chat-custom-prompt";
const STORAGE_VERSION_KEY = "ai-chat-ui-version";
const STORAGE_BACKUP_PREFIX = "ai-chat-storage-backup";
const STORAGE_VERSION = "2026-03-30-ui-refresh-5";
const SESSIONS_INDEX_KEY = "ai-chat-sessions-v1";
const ACTIVE_SESSION_ID_KEY = "ai-chat-active-session-id";
const SESSION_DATA_PREFIX = "ai-chat-session-data-";
const DEV_MODE_KEY = "ai-chat-dev-mode";
const MCP_REVALIDATION_INTERVAL_MS = 20000;
const MCP_REVALIDATION_FOCUS_DEBOUNCE_MS = 1500;
const MCP_REVALIDATION_ERROR_BACKOFF_MS = 45000;
const MCP_CHAT_SERVER_CACHE_TTL_MS = 12000;

type ThreadItem =
  | { id: string; type: "message"; value: Message }
  | { id: string; type: "tool"; value: ToolEvent };

function chatGreeting(userName: string | null): string {
  const hour = new Date().getHours();
  const period = hour >= 5 && hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const first = userName ? `, ${userName.split(" ")[0]}` : "";
  return `${period}${first}`;
}

function buildInitialAssistantMessage(content: string): Message {
  return {
    id: "assistant-welcome",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    status: "complete",
  };
}

function isDeprecatedLocalTestServer(server: Partial<McpServerConfig>) {
  const normalizedUrl = server.url?.trim().toLowerCase();
  const normalizedName = server.name?.trim().toLowerCase();

  return (
    normalizedUrl === "http://localhost:3001/mcp" ||
    normalizedUrl === "http://localhost:3002/mcp" ||
    normalizedName === "server 3001" ||
    normalizedName === "server 3002"
  );
}

function normalizeStoredServer(server: Partial<McpServerConfig>): McpServerConfig | null {
  if (!server.id || !server.name || !server.transport) {
    return null;
  }

  return {
    authMode: server.authMode ?? "none",
    approvalMode: server.approvalMode ?? "never",
    approvedToolNames: Array.isArray(server.approvedToolNames) ? server.approvedToolNames : [],
    args: Array.isArray(server.args) ? server.args : [],
    command: server.command,
    connectionStatus: server.connectionStatus ?? "pending",
    enabled: server.enabled ?? true,
    description: server.description,
    env: server.env ?? {},
    errorMessage: server.errorMessage,
    headers: server.headers ?? {},
    id: server.id,
    lastCheckedAt: server.lastCheckedAt,
    name: server.name,
    oauth: server.oauth,
    tools: Array.isArray(server.tools) ? server.tools : [],
    transport: server.transport,
    url: server.url,
  };
}

function normalizeStoredMessage(message: Partial<Message>): Message | null {
  if (!message.id || !message.role || !message.createdAt) {
    return null;
  }

  return {
    content: message.content ?? "",
    createdAt: message.createdAt,
    feedback: message.feedback,
    id: message.id,
    requestId: message.requestId,
    role: message.role,
    status: message.status ?? "complete",
    usage: message.usage,
  };
}

function normalizeStoredToolEvent(event: Partial<ToolEvent>): ToolEvent | null {
  if (!event.id || !event.tool || !event.title || !event.reason || !event.createdAt || !event.status) {
    return null;
  }

  return {
    createdAt: event.createdAt,
    detailKind: event.detailKind ?? "tool",
    id: event.id,
    reason: event.reason,
    requestId: event.requestId,
    serverName: event.serverName,
    status: event.status,
    summary: event.summary,
    title: event.title,
    tool: event.tool,
    argsText: event.argsText,
  };
}

export function ChatShell({
  initialWorkspaceId = null,
  isAdmin = false,
  userName,
  userImage,
}: {
  initialWorkspaceId?: string | null;
  isAdmin?: boolean;
  userName?: string | null;
  userImage?: string | null;
}) {
  const { locale, t } = useAppPreferences();
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const initialAssistantMessage = useMemo(
    () => buildInitialAssistantMessage(t("chat.welcome")),
    [t],
  );
  const [messages, setMessages] = useState<Message[]>(() => [buildInitialAssistantMessage(t("chat.welcome"))]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMcpDialogOpen, setIsMcpDialogOpen] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [retestingServerIds, setRetestingServerIds] = useState<string[]>([]);
  const [togglingServerIds, setTogglingServerIds] = useState<string[]>([]);
  const [systemPrompts, setSystemPrompts] = useState<SystemPrompt[]>([]);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [userSkills, setUserSkills] = useState<{ id: string; name: string; description: string | null }[]>([]);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [hasCorporateLlm, setHasCorporateLlm] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceStarters, setWorkspaceStarters] = useState<string[]>([]);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [devMode, setDevMode] = useState(false);
  const currentAssistantIdRef = useRef<string | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const hasRevalidatedStoredServersRef = useRef(false);
  const isRevalidatingServersRef = useRef(false);
  const nextAllowedRevalidationAtRef = useRef<Record<string, number>>({});
  const focusRevalidationTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const storedVersion = localStorage.getItem(STORAGE_VERSION_KEY);
      if (storedVersion !== STORAGE_VERSION) {
        const storedMessagesSnapshot = localStorage.getItem(MESSAGE_STORAGE_KEY);
        const storedToolsSnapshot = localStorage.getItem(TOOL_EVENT_STORAGE_KEY);
        if (storedMessagesSnapshot || storedToolsSnapshot) {
          const backupKey = `${STORAGE_BACKUP_PREFIX}-${Date.now()}`;
          localStorage.setItem(
            backupKey,
            JSON.stringify({
              messages: storedMessagesSnapshot ? JSON.parse(storedMessagesSnapshot) : [],
              toolEvents: storedToolsSnapshot ? JSON.parse(storedToolsSnapshot) : [],
              previousVersion: storedVersion,
            }),
          );
          setStorageNotice(t("chat.storageReset"));
        }
        localStorage.removeItem(MESSAGE_STORAGE_KEY);
        localStorage.removeItem(TOOL_EVENT_STORAGE_KEY);
        localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION);
      }

      try {
        const storedMessages = localStorage.getItem(MESSAGE_STORAGE_KEY);
        if (storedMessages) {
          const parsed = JSON.parse(storedMessages) as Array<Partial<Message>>;
          if (Array.isArray(parsed) && parsed.length > 0) {
            setMessages(parsed.map(normalizeStoredMessage).filter(Boolean) as Message[]);
          }
        }
      } catch {
        // Ignore corrupted messages.
      }

      try {
        const storedToolEvents = localStorage.getItem(TOOL_EVENT_STORAGE_KEY);
        if (storedToolEvents) {
          const parsed = JSON.parse(storedToolEvents) as Array<Partial<ToolEvent>>;
          if (Array.isArray(parsed)) {
            setToolEvents(parsed.map(normalizeStoredToolEvent).filter(Boolean) as ToolEvent[]);
          }
        }
      } catch {
        // Ignore corrupted tool events.
      }

      try {
        const parsed = migrateLocalJsonToSession<Array<Partial<McpServerConfig>>>(
          LEGACY_MCP_STORAGE_KEY,
          SESSION_MCP_SERVER_KEY,
        );
        if (Array.isArray(parsed)) {
          setMcpServers(
            parsed
              .filter((server) => !isDeprecatedLocalTestServer(server))
              .map(normalizeStoredServer)
              .filter(Boolean) as McpServerConfig[],
          );
        }
      } catch {
        // Ignore corrupted server config.
      }

      try {
        const storedPrompts = localStorage.getItem(CUSTOM_PROMPT_KEY);
        if (storedPrompts) {
          const parsed = JSON.parse(storedPrompts) as { prompts: SystemPrompt[]; activeId: string | null };
          if (parsed.prompts) setSystemPrompts(parsed.prompts);
          if (parsed.activeId !== undefined) setActivePromptId(parsed.activeId);
        }
      } catch {
        // Ignore corrupted prompts.
      }
    } catch {
      // Ignore corrupted local state.
    }

    // Sessions + dev mode init
    try {
      setDevMode(localStorage.getItem(DEV_MODE_KEY) === "true");

      const existingActiveId = localStorage.getItem(ACTIVE_SESSION_ID_KEY);
      if (existingActiveId) {
        const sessionsJson = localStorage.getItem(SESSIONS_INDEX_KEY);
        const sessionsList: ChatSession[] = sessionsJson ? JSON.parse(sessionsJson) : [];
        setSessions(sessionsList);
        setActiveSessionId(existingActiveId);
      } else {
        // First setup — migrate current messages into a session
        const newId = crypto.randomUUID();
        const storedMsgs = localStorage.getItem(MESSAGE_STORAGE_KEY);
        const storedTools = localStorage.getItem(TOOL_EVENT_STORAGE_KEY);
        const firstUserContent = storedMsgs
          ? (JSON.parse(storedMsgs) as Array<{ role?: string; content?: string }>)
              .find((m) => m.role === "user")?.content ?? ""
          : "";
        const title = firstUserContent
          ? firstUserContent.slice(0, 42) + (firstUserContent.length > 42 ? "…" : "")
          : "Nova Conversa";
        const newSession: ChatSession = { id: newId, title, createdAt: new Date().toISOString() };
        setSessions([newSession]);
        setActiveSessionId(newId);
        localStorage.setItem(
          SESSION_DATA_PREFIX + newId,
          JSON.stringify({ messages: storedMsgs ? JSON.parse(storedMsgs) : [], toolEvents: storedTools ? JSON.parse(storedTools) : [] }),
        );
        localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify([newSession]));
        localStorage.setItem(ACTIVE_SESSION_ID_KEY, newId);
      }
    } catch {
      // ignore — sessions are enhancement, not critical
    }

    setIsHydrated(true);
  }, [t]);

  useEffect(() => {
    try {
      const stored = migrateLocalJsonToSession<LLMConfig>(
        LEGACY_LLM_CONFIG_STORAGE_KEY,
        SESSION_LLM_CONFIG_KEY,
      );
      if (stored) {
        setLlmConfig(stored);
      }
    } catch {
      // Corrupted config — ignore, user will reconfigure.
    }
  }, []);

  useEffect(() => {
    fetch("/api/user/context")
      .then((res) => res.json())
      .then((data: {
        skills: typeof userSkills;
        allowedModels: string[];
        hasCorporateLlm: boolean;
        starters: string[];
        workspaces: WorkspaceOption[];
      }) => {
        setUserSkills(data.skills ?? []);
        setAllowedModels(data.allowedModels ?? []);
        setHasCorporateLlm(data.hasCorporateLlm ?? false);
        setWorkspaceStarters(data.starters ?? []);
        setWorkspaces(data.workspaces ?? []);
        if (initialWorkspaceId && data.workspaces?.some((w) => w.id === initialWorkspaceId)) {
          setSelectedWorkspaceId(initialWorkspaceId);
        } else {
          const defaultWorkspace = data.workspaces?.find((workspace) => workspace.isDefault);
          if (defaultWorkspace) setSelectedWorkspaceId(defaultWorkspace.id);
        }
        if (data.allowedModels?.length > 0) {
          setSelectedModel(data.allowedModels[0]);
        }
      })
      .catch(() => {
        // Silently ignore — user context is enhancement, not required
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setWorkspaceStarters([]);
      return;
    }
    fetch(`/api/user/context?workspaceId=${encodeURIComponent(selectedWorkspaceId)}`)
      .then((response) => response.json())
      .then((data: {
        skills: typeof userSkills;
        allowedModels: string[];
        hasCorporateLlm: boolean;
        starters: string[];
      }) => {
        setUserSkills(data.skills ?? []);
        setAllowedModels(data.allowedModels ?? []);
        setHasCorporateLlm(data.hasCorporateLlm ?? false);
        setWorkspaceStarters(data.starters ?? []);
        setSelectedSkillId(null);
        setSelectedModel(data.allowedModels?.[0] ?? null);
      })
      .catch(() => undefined);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!storageNotice) {
      return;
    }

    setMessages((current) => {
      if (current.some((message) => message.id === "storage-version-notice")) {
        return current;
      }

      return [
        {
          id: "storage-version-notice",
          role: "assistant",
          content: storageNotice,
          createdAt: new Date().toISOString(),
          status: "complete",
        },
        ...current,
      ];
    });
  }, [storageNotice, t]);

  useEffect(() => {
    setMessages((current) => {
      if (current.length !== 1 || current[0]?.id !== "assistant-welcome") {
        return current;
      }

      return [initialAssistantMessage];
    });
  }, [initialAssistantMessage]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem(MESSAGE_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Quota exceeded — skip persistence silently.
    }
  }, [messages, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem(TOOL_EVENT_STORAGE_KEY, JSON.stringify(toolEvents));
    } catch {
      // Quota exceeded — skip persistence silently.
    }
  }, [isHydrated, toolEvents]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      writeSessionJson(SESSION_MCP_SERVER_KEY, mcpServers);
    } catch {
      // Quota exceeded — skip persistence silently.
    }
  }, [isHydrated, mcpServers]);

  const items = useMemo<ThreadItem[]>(() => {
    const renderedToolIds = new Set<string>();
    const grouped: ThreadItem[] = [];
    const sortedMessages = [...messages].sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (aTime !== bTime) return aTime - bTime;
      return a.id.localeCompare(b.id);
    });

    for (const message of sortedMessages) {
      if (message.role === "assistant" && message.requestId) {
        const relatedTools = toolEvents
          .filter((tool) =>
            tool.requestId === message.requestId &&
            !renderedToolIds.has(tool.id) &&
            (tool.detailKind === "tool" || tool.detailKind === "context")
          )
          .sort((a, b) => {
            const aTime = Date.parse(a.createdAt);
            const bTime = Date.parse(b.createdAt);
            if (aTime !== bTime) return aTime - bTime;
            return a.id.localeCompare(b.id);
          });

        for (const tool of relatedTools) {
          renderedToolIds.add(tool.id);
          grouped.push({ id: tool.id, type: "tool", value: tool });
        }
      }

      grouped.push({ id: message.id, type: "message", value: message });
    }

    return grouped;
  }, [messages, toolEvents]);

  function persistSessionData(id: string, msgs: Message[], tools: ToolEvent[], sessionList: ChatSession[]) {
    if (!id) return;
    try {
      localStorage.setItem(SESSION_DATA_PREFIX + id, JSON.stringify({ messages: msgs, toolEvents: tools }));
      const firstUser = msgs.find((m) => m.role === "user" && m.id !== "assistant-welcome");
      const title = firstUser?.content
        ? firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? "…" : "")
        : "Nova Conversa";
      const updated = sessionList.map((s) => (s.id === id ? { ...s, title } : s));
      localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(updated));
      setSessions(updated);
    } catch {
      // quota exceeded — ignore
    }
  }

  function handleDevModeToggle(value: boolean) {
    setDevMode(value);
    try {
      localStorage.setItem(DEV_MODE_KEY, String(value));
    } catch {
      // ignore
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
    markCurrentAssistantStopped();
  }

  function handleNewConversation() {
    abortControllerRef.current?.abort();
    // Save current session before resetting
    persistSessionData(activeSessionId, messages, toolEvents, sessions);
    // Create fresh session
    const newId = crypto.randomUUID();
    const newSession: ChatSession = { id: newId, title: "Nova Conversa", createdAt: new Date().toISOString() };
    const nextSessions = [newSession, ...sessions];
    setSessions(nextSessions);
    setActiveSessionId(newId);
    try {
      localStorage.setItem(SESSION_DATA_PREFIX + newId, JSON.stringify({ messages: [], toolEvents: [] }));
      localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(nextSessions));
      localStorage.setItem(ACTIVE_SESSION_ID_KEY, newId);
    } catch {
      // ignore
    }
    setMessages([initialAssistantMessage]);
    setToolEvents([]);
    setScrollRequest((current) => current + 1);
    currentAssistantIdRef.current = null;
    currentRequestIdRef.current = null;
  }

  function handleSessionSwitch(targetId: string) {
    if (targetId === activeSessionId) return;
    persistSessionData(activeSessionId, messages, toolEvents, sessions);
    try {
      const raw = localStorage.getItem(SESSION_DATA_PREFIX + targetId);
      if (raw) {
        const parsed = JSON.parse(raw) as { messages?: Array<Partial<Message>>; toolEvents?: Array<Partial<ToolEvent>> };
        const loadedMsgs = (parsed.messages ?? []).map(normalizeStoredMessage).filter(Boolean) as Message[];
        const loadedTools = (parsed.toolEvents ?? []).map(normalizeStoredToolEvent).filter(Boolean) as ToolEvent[];
        setMessages(loadedMsgs.length > 0 ? loadedMsgs : [initialAssistantMessage]);
        setToolEvents(loadedTools);
      } else {
        setMessages([initialAssistantMessage]);
        setToolEvents([]);
      }
    } catch {
      setMessages([initialAssistantMessage]);
      setToolEvents([]);
    }
    setActiveSessionId(targetId);
    setScrollRequest((current) => current + 1);
    try {
      localStorage.setItem(ACTIVE_SESSION_ID_KEY, targetId);
    } catch {
      // ignore
    }
  }

  function handleSessionDelete(targetId: string) {
    const nextSessions = sessions.filter((s) => s.id !== targetId);
    setSessions(nextSessions);
    try {
      localStorage.removeItem(SESSION_DATA_PREFIX + targetId);
      localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(nextSessions));
    } catch {
      // ignore
    }
    if (targetId === activeSessionId) {
      if (nextSessions.length > 0) {
        handleSessionSwitch(nextSessions[0].id);
      } else {
        handleNewConversation();
      }
    }
  }

  async function handleCopySession() {
    let sessionText = `${t("chat.sessionLogTitle")}\n==============================\n\n`;

    for (const item of items) {
      if (item.type === "message") {
        const role = item.value.role === "assistant" ? t("chat.assistant") : t("chat.you");
        const date = new Date(item.value.createdAt).toLocaleString();
        sessionText += `[${role}] (${date}):\n${item.value.content || t("chat.emptyContent")}\n\n`;
      } else {
        const date = new Date(item.value.createdAt).toLocaleString();
        sessionText += `[TOOL] ${item.value.tool} (${date})\nStatus: ${item.value.status}\n`;
        if (item.value.argsText) {
          sessionText += `${t("chat.argLabel")}\n${item.value.argsText}\n`;
        }
        if (item.value.summary) {
          let summaryToPrint = item.value.summary;
          try {
            summaryToPrint = JSON.stringify(JSON.parse(item.value.summary), null, 2);
          } catch { }
          sessionText += `${t("chat.resultLabel")}\n${summaryToPrint}\n`;
        }
        sessionText += "\n";
      }
    }

    try {
      await navigator.clipboard.writeText(sessionText);
    } catch (err) {
      console.error(t("chat.copySessionError"), err);
    }
  }

  const inspectServer = useCallback(async (server: McpServerConfig) => {
    const response = await fetch("/api/mcp/inspect", {
      body: JSON.stringify({ server }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const payload = (await response.json()) as McpInspectResponse | { error?: string };

    if (!("server" in payload)) {
      const errorMessage = "error" in payload ? payload.error : undefined;
      throw new Error(errorMessage ?? t("chat.mcpValidateFailed"));
    }

    return {
      ok: response.ok && payload.server.connectionStatus === "connected",
      server: payload.server,
    };
  }, [t]);

  const revalidateServers = useCallback(async (
    servers: McpServerConfig[],
    options?: { silent?: boolean },
  ) => {
    const enabledServers = servers.filter((server) => server.enabled);

    if (enabledServers.length === 0 || isRevalidatingServersRef.current) {
      return servers;
    }

    isRevalidatingServersRef.current = true;
    const serverIds = enabledServers.map((server) => server.id);
    if (!options?.silent) {
      setRetestingServerIds((current) => [...new Set([...current, ...serverIds])]);
    }

    try {
      const results = await Promise.all(
        enabledServers.map(async (server) => {
          try {
            return await inspectServer(server);
          } catch {
            return { ok: false, server: { ...server, connectionStatus: "error" as const, tools: [] } };
          }
        }),
      );

      const inspectedServers = results.map((result) => result.server);
      const byId = new Map(inspectedServers.map((server) => [server.id, server]));

      setMcpServers((current) =>
        current.map((server) => byId.get(server.id) ?? server),
      );

      const nextAllowed = { ...nextAllowedRevalidationAtRef.current };
      const now = Date.now();
      for (const server of inspectedServers) {
        nextAllowed[server.id] =
          server.connectionStatus === "connected"
            ? 0
            : now + MCP_REVALIDATION_ERROR_BACKOFF_MS;
      }
      nextAllowedRevalidationAtRef.current = nextAllowed;

      return inspectedServers;
    } finally {
      isRevalidatingServersRef.current = false;
      if (!options?.silent) {
        setRetestingServerIds((current) => current.filter((id) => !serverIds.includes(id)));
      }
    }
  }, [inspectServer]);

  async function handleToggleServerEnabled(serverId: string) {
    if (togglingServerIds.includes(serverId) || retestingServerIds.includes(serverId)) {
      return;
    }

    const target = mcpServers.find((server) => server.id === serverId);
    if (!target) {
      return;
    }

    setTogglingServerIds((current) => [...new Set([...current, serverId])]);

    if (target.enabled) {
      setMcpServers((current) =>
        current.map((server) =>
          server.id === serverId
            ? {
              ...server,
              enabled: false,
            }
            : server,
        ),
      );
      setRetestingServerIds((current) => current.filter((id) => id !== serverId));
      nextAllowedRevalidationAtRef.current = {
        ...nextAllowedRevalidationAtRef.current,
        [serverId]: 0,
      };
      setTogglingServerIds((current) => current.filter((id) => id !== serverId));
      return;
    }

    const enabledServer = {
      ...target,
      connectionStatus: "pending" as const,
      enabled: true,
      errorMessage: undefined,
      tools: [],
    };

    setMcpServers((current) =>
      current.map((server) => (server.id === serverId ? enabledServer : server)),
    );
    setRetestingServerIds((current) => [...new Set([...current, serverId])]);

    try {
      const result = await inspectServer(enabledServer);
      setMcpServers((current) =>
        current.map((server) => (server.id === serverId ? result.server : server)),
      );
      nextAllowedRevalidationAtRef.current = {
        ...nextAllowedRevalidationAtRef.current,
        [serverId]:
          result.server.connectionStatus === "connected"
            ? 0
            : Date.now() + MCP_REVALIDATION_ERROR_BACKOFF_MS,
      };
    } catch {
      setMcpServers((current) =>
        current.map((server) =>
          server.id === serverId
            ? {
              ...enabledServer,
              connectionStatus: "error",
              errorMessage: t("chat.mcpValidateFailed"),
            }
            : server,
        ),
      );
      nextAllowedRevalidationAtRef.current = {
        ...nextAllowedRevalidationAtRef.current,
        [serverId]: Date.now() + MCP_REVALIDATION_ERROR_BACKOFF_MS,
      };
    } finally {
      setRetestingServerIds((current) => current.filter((id) => id !== serverId));
      setTogglingServerIds((current) => current.filter((id) => id !== serverId));
    }
  }

  async function handleSaveServer(server: McpServerConfig) {
    const preparedServer =
      server.authMode === "oauth" && !server.oauth?.accessToken
        ? await completeMcpOAuth(server)
        : server;

    const result = await inspectServer(preparedServer);
    if (!result.ok) {
      throw new Error(result.server.errorMessage ?? t("chat.mcpConnectFailed"));
    }
    const inspectedServer = result.server;

    setMcpServers((current) => {
      const existingIndex = current.findIndex((item) => item.id === inspectedServer.id);
      if (existingIndex === -1) {
        return [...current, inspectedServer];
      }

      return current.map((item) => (item.id === inspectedServer.id ? inspectedServer : item));
    });

    setEditingServerId(null);
  }

  async function completeMcpOAuth(server: McpServerConfig) {
    if (server.transport === "stdio") {
      return server;
    }

    const redirectUri = new URL("/oauth/callback", window.location.origin).toString();
    const response = await fetch("/api/mcp/oauth/start", {
      body: JSON.stringify({
        clientName: server.oauth?.clientName?.trim() || "MCP Hub",
        clientId: server.oauth?.clientId?.trim() || undefined,
        clientUri: window.location.origin,
        redirectUri,
        resourceUrl: server.url ?? "",
        scope: server.oauth?.scope?.trim() || undefined,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const payload = (await response.json()) as
      | {
          authorizationServerUrl: string;
          authorizationUrl: string;
          clientId: string;
          clientSecret?: string;
          codeVerifier: string;
          redirectUri: string;
          resourceUrl: string;
          scope?: string;
          state: string;
          tokenEndpoint: string;
        }
      | { error?: string };

    if (!response.ok || !("authorizationUrl" in payload)) {
      throw new Error("error" in payload ? payload.error ?? t("chat.mcpConnectFailed") : t("chat.mcpConnectFailed"));
    }

    const pending: PendingMcpOAuth = {
      authorizationServerUrl: payload.authorizationServerUrl,
      clientId: payload.clientId,
      clientName: server.oauth?.clientName?.trim() || "MCP Hub",
      clientSecret: payload.clientSecret,
      codeVerifier: payload.codeVerifier,
      redirectUri: payload.redirectUri,
      resourceUrl: payload.resourceUrl,
      scope: payload.scope,
      state: payload.state,
      tokenEndpoint: payload.tokenEndpoint,
    };

    savePendingMcpOAuth(pending);

    try {
      const callback = await waitForMcpOAuthCallback(payload.state, payload.authorizationUrl);

      if (callback.error) {
        throw new Error(callback.errorDescription || callback.error);
      }

      if (!callback.code) {
        throw new Error("OAuth callback missing authorization code.");
      }

      const stored = readPendingMcpOAuth(payload.state);
      if (!stored) {
        throw new Error("OAuth session expired.");
      }

      const exchangeResponse = await fetch("/api/mcp/oauth/exchange", {
        body: JSON.stringify({
          clientId: stored.clientId,
          clientSecret: stored.clientSecret,
          code: callback.code,
          codeVerifier: stored.codeVerifier,
          redirectUri: stored.redirectUri,
          resourceUrl: stored.resourceUrl,
          state: stored.state,
          tokenEndpoint: stored.tokenEndpoint,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const exchangePayload = (await exchangeResponse.json()) as
        | {
            oauth: {
              accessToken: string;
              clientId: string;
              clientSecret?: string;
              expiresAt?: string;
              redirectUri: string;
              refreshToken?: string;
              scope?: string;
              tokenEndpoint: string;
              tokenType?: string;
            };
          }
        | { error?: string };

      if (!exchangeResponse.ok || !("oauth" in exchangePayload)) {
        throw new Error(
          "error" in exchangePayload ? exchangePayload.error ?? t("chat.mcpConnectFailed") : t("chat.mcpConnectFailed"),
        );
      }

      return {
        ...server,
        oauth: {
          ...server.oauth,
          ...exchangePayload.oauth,
        },
      };
    } finally {
      clearPendingMcpOAuth(payload.state);
    }
  }

  async function handleRetestServer(serverId: string) {
    const target = mcpServers.find((server) => server.id === serverId);
    if (!target) return;

    await revalidateServers([target]);
  }

  useEffect(() => {
    const enabledServers = mcpServers.filter((server) => server.enabled);
    if (!isHydrated || hasRevalidatedStoredServersRef.current || enabledServers.length === 0) {
      return;
    }

    hasRevalidatedStoredServersRef.current = true;
    void revalidateServers(enabledServers);
  }, [isHydrated, mcpServers, revalidateServers]);

  useEffect(() => {
    if (!isHydrated || mcpServers.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const dueServers = mcpServers.filter(
        (server) => server.enabled && now >= (nextAllowedRevalidationAtRef.current[server.id] ?? 0),
      );
      if (dueServers.length === 0) {
        return;
      }
      void revalidateServers(dueServers);
    }, MCP_REVALIDATION_INTERVAL_MS);

    const handleFocus = () => {
      if (document.visibilityState === "hidden") {
        return;
      }

      if (focusRevalidationTimeoutRef.current) {
        window.clearTimeout(focusRevalidationTimeoutRef.current);
      }

      focusRevalidationTimeoutRef.current = window.setTimeout(() => {
        const now = Date.now();
        const dueServers = mcpServers.filter(
          (server) => server.enabled && now >= (nextAllowedRevalidationAtRef.current[server.id] ?? 0),
        );
        if (dueServers.length === 0) {
          return;
        }

        void revalidateServers(dueServers);
      }, MCP_REVALIDATION_FOCUS_DEBOUNCE_MS);
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);

    return () => {
      window.clearInterval(intervalId);
      if (focusRevalidationTimeoutRef.current) {
        window.clearTimeout(focusRevalidationTimeoutRef.current);
      }
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [isHydrated, mcpServers, revalidateServers]);

  function handleRemoveServer(serverId: string) {
    setMcpServers((current) => current.filter((server) => server.id !== serverId));
  }

  async function handleSubmit(content: string) {
    if (abortControllerRef.current || isStreaming) {
      return false;
    }

    const enabledServers = mcpServers.filter((server) => server.enabled);
    const resolvedServers =
      enabledServers.length > 0
        ? await revalidateServers(enabledServers, { silent: true })
        : [];
    const requestId = `request-${crypto.randomUUID()}`;
    currentRequestIdRef.current = requestId;

    const userMessage: Message = {
      id: `message-${crypto.randomUUID()}`,
      requestId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      status: "complete",
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setScrollRequest((current) => current + 1);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const now = Date.now();
      const response = await fetch("/api/chat", {
        body: JSON.stringify({
          customPrompt: systemPrompts.find((p) => p.id === activePromptId)?.content || undefined,
          llmConfig: llmConfig ?? undefined,
          locale,
          mcpServers: resolvedServers.map((server) => ({
            ...server,
            lastCheckedAt: now.toString(),
          })),
          message: content,
          messages: nextMessages.map((message) => ({
            content: message.content,
            role: message.role,
          })),
          requestId,
          skillId: selectedSkillId ?? undefined,
          selectedModel: selectedModel ?? undefined,
          workspaceId: selectedWorkspaceId ?? undefined,
          availableSkills: selectedSkillId ? undefined : userSkills,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      setSelectedSkillId(null);

      if (!response.ok) {
        const errorText = await response.text();
        applyStreamEvent({
          type: "error",
          message: errorText || `HTTP ${response.status}`,
        });
        return false;
      }

      if (!response.body) {
        applyStreamEvent({
          type: "error",
          message: t("chat.noResponseBody"),
        });
        return false;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseStreamChunks(buffer);
        buffer = parsed.nextBuffer;

        for (const event of parsed.events) {
          applyStreamEvent(event);
        }
      }

      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        markCurrentAssistantStopped();
      } else {
        applyStreamEvent({
          type: "error",
          message:
            error instanceof Error ? error.message : t("chat.streamFailed"),
        });
      }

      return false;
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  function applyStreamEvent(event: ChatStreamEvent) {
    switch (event.type) {
      case "message_start":
        currentAssistantIdRef.current = event.id;
        currentRequestIdRef.current = event.requestId ?? currentRequestIdRef.current;
        setScrollRequest((current) => current + 1);
        setMessages((current) => [
          ...current,
          {
            id: event.id,
            requestId: event.requestId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            status: "streaming",
          },
        ]);
        break;
      case "message_delta":
        ensureAssistantMessage(event.id, event.requestId);
        setMessages((current) =>
          current.map((message) =>
            message.id === resolveAssistantId(event.id)
              ? {
                ...message,
                content: `${message.content}${event.delta}`,
                status: "streaming",
              }
              : message,
          ),
        );
        break;
      case "tool_start":
        setScrollRequest((current) => current + 1);
        setToolEvents((current) => [
          ...current,
          {
            id: event.id,
            requestId: event.requestId ?? currentRequestIdRef.current ?? undefined,
            tool: event.tool,
            title: event.title,
            reason: event.reason,
            argsText: event.argsText,
            detailKind: event.title.toLowerCase().includes("contexto") ? "context" : "tool",
            status: "running",
            createdAt: new Date().toISOString(),
          },
        ]);
        break;
      case "tool_end":
        setToolEvents((current) =>
          current.map((tool) =>
            tool.id === event.id
              ? {
                ...tool,
                requestId: event.requestId ?? tool.requestId,
                status: event.status,
                summary: event.summary,
              }
              : tool,
          ),
        );
        break;
      case "message_end":
        currentAssistantIdRef.current = null;
        currentRequestIdRef.current = null;
        setScrollRequest((current) => current + 1);
        setMessages((current) =>
          current.map((message) =>
            message.id === resolveAssistantId(event.id)
              ? {
                ...message,
                status: message.status === "stopped" ? "stopped" : "complete",
                usage: event.usage ?? message.usage,
              }
              : message,
          ),
        );
        break;
      case "trace":
        setToolEvents((current) => [
          ...current,
          {
            id: event.id,
            requestId: event.requestId ?? currentRequestIdRef.current ?? undefined,
            tool: event.kind === "assistant" ? "ASSISTANT_RESPONSE" : event.kind === "system" ? "SYSTEM_PROMPT" : "USER_PROMPT",
            title: event.kind === "assistant" ? "Assistant Completion" : event.kind === "system" ? "System Prompt" : "User Input Context",
            reason: event.kind === "assistant" ? "Final LLM Output" : event.kind === "system" ? "System Prompt Configuration" : "Frontend Request Payload",
            status: "success",
            createdAt: new Date().toISOString(),
            summary: event.content,
            detailKind: event.kind,
          },
        ]);
        break;
      case "error":
        const pendingAssistantId = currentAssistantIdRef.current;
        const errorMessage = `${t("chat.requestFailed")}: ${event.message}`;
        currentAssistantIdRef.current = null;
        currentRequestIdRef.current = null;
        setMessages((current) => {
          if (pendingAssistantId && current.some((message) => message.id === pendingAssistantId)) {
            return current.map((message) =>
              message.id === pendingAssistantId
                ? {
                  ...message,
                  content: message.content.trim() || errorMessage,
                  status: "error",
                }
                : message,
            );
          }

          return [
            ...current,
            {
              id: `error-${crypto.randomUUID()}`,
              role: "assistant",
              content: errorMessage,
              createdAt: new Date().toISOString(),
              status: "error",
            },
          ];
        });
        break;
    }
  }

  async function handleFeedback(messageId: string, value: "up" | "down") {
    const messageContent = messages.find((message) => message.id === messageId)?.content;
    const previousFeedback = messages.find((message) => message.id === messageId)?.feedback;

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, feedback: value } : message,
      ),
    );

    try {
      const response = await fetch("/api/feedback", {
        body: JSON.stringify({ messageId, feedback: value, content: messageContent }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, feedback: previousFeedback } : message,
        ),
      );
      setFeedbackError(t("chat.feedbackError"));
      window.setTimeout(() => setFeedbackError(null), 4000);
    }
  }

  function ensureAssistantMessage(id: string, requestId?: string) {
    const resolvedId = resolveAssistantId(id);
    currentAssistantIdRef.current = resolvedId;

    setMessages((current) => {
      if (current.some((message) => message.id === resolvedId)) return current;
      return [
        ...current,
        {
          id: resolvedId,
          requestId: requestId ?? currentRequestIdRef.current ?? undefined,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          status: "streaming",
        },
      ];
    });
  }

  function markCurrentAssistantStopped() {
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) {
      return;
    }

    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
            ...message,
            content:
              message.content.trim() || t("chat.stoppedEmpty"),
            status: "stopped",
          }
          : message,
      ),
    );
  }

  function resolveAssistantId(id: string) {
    if (id === "assistant-current") {
      return currentAssistantIdRef.current ?? `assistant-${crypto.randomUUID()}`;
    }
    return id;
  }

  const editingServer =
    editingServerId === null
      ? null
      : mcpServers.find((server) => server.id === editingServerId) ?? null;

  function savePrompts(prompts: SystemPrompt[], activeId: string | null) {
    localStorage.setItem(CUSTOM_PROMPT_KEY, JSON.stringify({ prompts, activeId }));
  }

  function handleAddPrompt(prompt: SystemPrompt) {
    const next = [...systemPrompts, prompt];
    setSystemPrompts(next);
    setActivePromptId(prompt.id);
    savePrompts(next, prompt.id);
  }

  function handleEditPrompt(prompt: SystemPrompt) {
    const next = systemPrompts.map((p) => (p.id === prompt.id ? prompt : p));
    setSystemPrompts(next);
    const nextActive = activePromptId ?? prompt.id;
    if (!activePromptId) {
      setActivePromptId(prompt.id);
    }
    savePrompts(next, nextActive);
  }

  function handleDeletePrompt(id: string) {
    const next = systemPrompts.filter((p) => p.id !== id);
    const nextActive = activePromptId === id ? null : activePromptId;
    setSystemPrompts(next);
    setActivePromptId(nextActive);
    savePrompts(next, nextActive);
  }

  function handleSelectPrompt(id: string | null) {
    setActivePromptId(id);
    savePrompts(systemPrompts, id);
  }

  const tokenTotals = useMemo(
    () =>
      messages.reduce(
        (totals, message) => ({
          inputTokens: (totals.inputTokens ?? 0) + (message.usage?.inputTokens ?? 0),
          outputTokens: (totals.outputTokens ?? 0) + (message.usage?.outputTokens ?? 0),
          totalTokens: (totals.totalTokens ?? 0) + (message.usage?.totalTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ),
    [messages],
  );
  const tokenUsageState = useMemo(() => {
    const assistantResponses = messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.id !== "assistant-welcome" &&
        message.id !== "storage-version-notice" &&
        message.status !== "streaming",
    );

    if (assistantResponses.length === 0) {
      return "idle" as const;
    }

    return assistantResponses.some(
      (message) =>
        (message.usage?.inputTokens ?? message.usage?.outputTokens ?? message.usage?.totalTokens) != null,
    )
      ? ("available" as const)
      : ("unavailable" as const);
  }, [messages]);
  const promptProps = {
    systemPrompts,
    activePromptId,
    onAddPrompt: handleAddPrompt,
    onEditPrompt: handleEditPrompt,
    onDeletePrompt: handleDeletePrompt,
    onSelectPrompt: handleSelectPrompt,
  };
  const llmProps = {
    llmConfig,
    onChangeLlmConfig: setLlmConfig,
    usageTotals: tokenTotals,
    usageState: tokenUsageState,
  };
  const corporateProps = {
    userSkills,
    allowedModels,
    hasCorporateLlm,
    selectedSkillId,
    selectedModel,
    onSkillChange: setSelectedSkillId,
    onModelChange: setSelectedModel,
    workspaces,
    selectedWorkspaceId,
    onWorkspaceChange: setSelectedWorkspaceId,
  };
  return (
    <div className="fixed inset-0 flex flex-col bg-[var(--color-bg)]">
      {/* Same header as admin pages */}
      <PortalHeader isAdmin={isAdmin} section="Chat" userName={userName} userImage={userImage} />

      {/* Same layout container as PortalShell */}
      <div className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 gap-5 px-4 py-5 lg:px-6">
        {/* Desktop sidebar — hidden on mobile, portal-sidebar handles sticky + sizing */}
        <div className="hidden lg:block">
          <ChatNavigation
            activeSessionId={activeSessionId}
            devMode={devMode}
            isAdmin={isAdmin}
            onAddServer={() => { setEditingServerId(null); setIsMcpDialogOpen(true); }}
            onDevModeToggle={handleDevModeToggle}
            onEditServer={(serverId) => { setEditingServerId(serverId); setIsMcpDialogOpen(true); }}
            onNewConversation={handleNewConversation}
            onRemoveServer={handleRemoveServer}
            onRetestServer={handleRetestServer}
            onSessionDelete={handleSessionDelete}
            onSessionSwitch={handleSessionSwitch}
            onToggleServerEnabled={handleToggleServerEnabled}
            onWorkspaceChange={setSelectedWorkspaceId}
            retestingServerIds={retestingServerIds}
            selectedWorkspaceId={selectedWorkspaceId}
            servers={mcpServers}
            sessions={sessions}
            togglingServerIds={togglingServerIds}
            workspaces={workspaces}
          />
        </div>

        {/* Mobile overlay drawer */}
        <SidebarDrawer
          isOpen={isSidebarOpen}
          {...promptProps}
          {...llmProps}
          {...corporateProps}
          onAddServer={() => { setEditingServerId(null); setIsSidebarOpen(false); setIsMcpDialogOpen(true); }}
          onClose={() => setIsSidebarOpen(false)}
          onEditServer={(serverId) => { setEditingServerId(serverId); setIsSidebarOpen(false); setIsMcpDialogOpen(true); }}
          onRemoveServer={handleRemoveServer}
          onRetestServer={handleRetestServer}
          onToggleServerEnabled={handleToggleServerEnabled}
          retestingServerIds={retestingServerIds}
          togglingServerIds={togglingServerIds}
          servers={mcpServers}
        />

        <McpServerDialog
          key={`${editingServer?.id ?? "new"}-${isMcpDialogOpen ? "open" : "closed"}`}
          initialServer={editingServer}
          isOpen={isMcpDialogOpen}
          onClose={() => { setIsMcpDialogOpen(false); setEditingServerId(null); }}
          onSave={handleSaveServer}
        />

        {/* Chat content — flex-1 fills remaining height after header */}
        <main
          className="portal-content min-h-0 min-w-0 flex-1 overflow-hidden p-0"
          style={{ minHeight: 0 }}
        >
          <div className="flex h-full flex-col overflow-hidden">
            {feedbackError ? (
              <div role="alert" aria-live="polite"
                className="mx-4 mt-3 rounded-lg border border-[var(--color-error-soft)] bg-[var(--color-error-soft)]/40 px-3 py-2 text-[12px] text-[var(--color-error)]">
                {feedbackError}
              </div>
            ) : null}

            {messages.some((m) => m.role === "user") ? (
              <>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatThread
                    isStreaming={isStreaming}
                    items={items.filter((i) => !(i.type === "message" && i.value.id === "assistant-welcome"))}
                    onFeedback={handleFeedback}
                    scrollRequest={scrollRequest}
                  />
                </div>
                <div className="shrink-0 px-3 pb-4 pt-2 sm:px-5">
                  <MessageComposer
                    isSubmitting={isStreaming}
                    onStop={handleStop}
                    onSubmit={handleSubmit}
                    skills={userSkills}
                    activeSkillId={selectedSkillId}
                    onSkillSelect={setSelectedSkillId}
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
                <div className="w-full max-w-[680px] space-y-8">
                  <div className="space-y-2 text-center">
                    <h1 className="text-[2rem] font-semibold tracking-tight text-foreground">
                      {chatGreeting(userName ?? null)}
                    </h1>
                    <p className="text-[14px] text-muted-foreground">
                      Como posso ajudá-lo hoje?
                    </p>
                  </div>
                  <MessageComposer
                    isSubmitting={isStreaming}
                    onStop={handleStop}
                    onSubmit={handleSubmit}
                    skills={userSkills}
                    activeSkillId={selectedSkillId}
                    onSkillSelect={setSelectedSkillId}
                  />
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
