import { prisma } from "@/lib/db";
import { resolveDelegatedAuthorizationHeaders } from "@/lib/delegated-oauth";
import { buildLlmConfig, dbMcpToConfig } from "@/lib/user-context";
import type { McpDiscoveredTool, McpServerConfig } from "@/types/mcp";

export type WorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  starters: string[];
};

export type ResolvedWorkspaceContext = {
  id: string;
  name: string;
  systemPrompt: string | null;
  maxSteps: number;
  approvalMode: string;
  starters: string[];
  allowedModels: string[];
  llmConfig: ReturnType<typeof buildLlmConfig>;
  llmConfigId: string | null;
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
    content: string;
  }>;
  mcpServers: McpServerConfig[];
};

const workspaceInclude = {
  groups: { select: { entraGroupId: true } },
  users: { select: { id: true } },
  skills: { where: { enabled: true }, orderBy: { name: "asc" as const } },
  llmConfig: true,
  namespace: {
    include: {
      servers: {
        where: { enabled: true, mcpServer: { enabled: true } },
        orderBy: { displayOrder: "asc" as const },
        include: { mcpServer: true },
      },
      tools: {
        where: {
          enabled: true,
          registryTool: {
            enabled: true,
            permissionMode: { not: "blocked" },
          },
        },
        include: { registryTool: true },
      },
    },
  },
};

const _workspaceQuery = () => prisma.workspace.findFirst({ include: workspaceInclude });
type WorkspaceWithContext = NonNullable<Awaited<ReturnType<typeof _workspaceQuery>>>;

export async function listAccessibleWorkspaces(
  userId: string,
  entraGroups: string[],
): Promise<WorkspaceSummary[]> {
  const workspaces = await prisma.workspace.findMany({
    where: { enabled: true },
    include: {
      groups: { select: { entraGroupId: true } },
      users: { select: { id: true } },
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return workspaces
    .filter((workspace) => canAccess(workspace, userId, entraGroups))
    .map((workspace) => ({
      description: workspace.description,
      id: workspace.id,
      isDefault: workspace.isDefault,
      name: workspace.name,
      slug: workspace.slug,
      starters: workspace.conversationStarters,
    }));
}

export async function resolveWorkspaceContext(
  workspaceId: string,
  userId: string,
  entraGroups: string[],
  selectedModel?: string,
): Promise<ResolvedWorkspaceContext | null> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, enabled: true },
    include: workspaceInclude,
  });
  if (!workspace || !canAccess(workspace, userId, entraGroups)) return null;

  const llm =
    workspace.llmConfig ??
    (await prisma.llmConfig.findFirst({
      where: { enabled: true, isDefault: true },
      orderBy: { createdAt: "asc" },
    }));
  const allowedModels = llm?.allowedModels ?? [];
  const requestedModel =
    selectedModel && allowedModels.includes(selectedModel)
      ? selectedModel
      : workspace.model && allowedModels.includes(workspace.model)
        ? workspace.model
        : undefined;

  return {
    allowedModels,
    approvalMode: workspace.approvalMode,
    id: workspace.id,
    llmConfig: llm ? buildLlmConfig(llm, requestedModel) : null,
    llmConfigId: llm?.id ?? null,
    maxSteps: workspace.maxSteps,
    mcpServers: await buildWorkspaceServers(workspace, userId),
    name: workspace.name,
    skills: workspace.skills,
    starters: workspace.conversationStarters,
    systemPrompt: workspace.systemPrompt,
  };
}

async function buildWorkspaceServers(
  workspace: WorkspaceWithContext,
  userId: string,
): Promise<McpServerConfig[]> {
  if (!workspace.namespace?.enabled) return [];

  const delegatedHeaders = await resolveDelegatedAuthorizationHeaders(
    userId,
    workspace.namespace.servers.map((entry) => entry.mcpServerId),
  );
  const toolsByServer = new Map<string, McpDiscoveredTool[]>();

  for (const item of workspace.namespace.tools) {
    const tool = item.registryTool;
    const tools = toolsByServer.get(tool.mcpServerId) ?? [];
    tools.push({
      description: item.description ?? tool.description ?? undefined,
      displayName: item.displayName ?? tool.displayName ?? item.alias,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      isDestructive: tool.destructive,
      name: tool.name,
      permissionMode:
        tool.permissionMode === "approval"
          ? "approval"
          : tool.permissionMode === "blocked"
            ? "blocked"
            : "allow",
      readOnly: tool.readOnly,
    });
    toolsByServer.set(tool.mcpServerId, tools);
  }

  return workspace.namespace.servers
    .map((entry) => {
      const authorization = delegatedHeaders.get(entry.mcpServerId);
      const config = dbMcpToConfig(entry.mcpServer, authorization);
      const tools = toolsByServer.get(entry.mcpServerId) ?? [];
      const isDelegated = entry.mcpServer.authType === "oauth_delegated";
      return {
        ...config,
        // oauth_delegated: tools are per-user and live-discovered — expose all of them.
        // Non-delegated: only expose tools curated by admin in the namespace tool list.
        approvalMode: isDelegated ? ("always" as const) : ("selected" as const),
        approvedToolNames: tools.map((tool) => tool.name),
        name: entry.alias || config.name,
        tools,
      };
    })
    .filter((server) => server.enabled && (server.approvalMode === "always" || server.approvedToolNames.length > 0));
}

export async function resolveWorkspaceBySlug(
  slug: string,
  userId: string,
  entraGroups: string[],
): Promise<ResolvedWorkspaceContext | null> {
  const workspace = await prisma.workspace.findFirst({
    where: { slug, enabled: true },
    include: workspaceInclude,
  });
  if (!workspace || !canAccess(workspace, userId, entraGroups)) return null;

  const llm =
    workspace.llmConfig ??
    (await prisma.llmConfig.findFirst({
      where: { enabled: true, isDefault: true },
      orderBy: { createdAt: "asc" },
    }));
  const allowedModels = llm?.allowedModels ?? [];

  return {
    allowedModels,
    approvalMode: workspace.approvalMode,
    id: workspace.id,
    llmConfig: llm ? buildLlmConfig(llm) : null,
    llmConfigId: llm?.id ?? null,
    maxSteps: workspace.maxSteps,
    mcpServers: await buildWorkspaceServers(workspace, userId),
    name: workspace.name,
    skills: workspace.skills,
    starters: workspace.conversationStarters,
    systemPrompt: workspace.systemPrompt,
  };
}

function canAccess(
  resource: {
    groups: Array<{ entraGroupId: string }>;
    users: Array<{ id: string }>;
  },
  userId: string,
  entraGroups: string[],
) {
  if (resource.groups.length === 0 && resource.users.length === 0) return true;
  return (
    resource.users.some((user) => user.id === userId) ||
    resource.groups.some((group) => entraGroups.includes(group.entraGroupId))
  );
}

function normalizeInputSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object" as const, properties: {}, required: [] };
  }
  const schema = value as Record<string, unknown>;
  return {
    type: "object" as const,
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, object>)
        : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  };
}
