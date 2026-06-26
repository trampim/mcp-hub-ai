import { createHash } from "crypto";
import type { InputJsonValue } from "@prisma/client/runtime/library";

import { prisma } from "@/lib/db";
import {
  createInspectableServerConfig,
  inspectMcpServer,
} from "@/lib/mcp-client";
import type {
  McpDiscoveredTool,
  McpServerConfig,
} from "@/types/mcp";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

type ResolveOptions = {
  forceRefresh?: boolean;
  ttlMs?: number;
};

export async function resolveMcpServerTools(
  server: McpServerConfig,
  options: ResolveOptions = {},
) {
  // oauth_delegated servers use per-user tokens — never read/write global DB cache.
  // Tool discovery is ephemeral: live-probe every request, no DB side effects.
  if (server.requiresUserAuthorization) {
    return resolveUserDelegatedServerTools(server);
  }

  const ttlMs = options.ttlMs ?? readCacheTtl();
  const dbServer = await prisma.mcpServer.findUnique({
    where: { id: server.id },
    select: {
      connectionTimeoutMs: true,
      healthStatus: true,
      lastHealthCheckAt: true,
      registryTools: {
        where: { enabled: true },
        orderBy: { name: "asc" },
      },
    },
  });

  const lastHealthCheckAt = dbServer?.lastHealthCheckAt ?? null;
  const cacheIsFresh =
    !options.forceRefresh &&
    dbServer?.healthStatus === "connected" &&
    lastHealthCheckAt !== null &&
    Date.now() - lastHealthCheckAt.getTime() <= ttlMs &&
    dbServer.registryTools.length > 0;

  if (cacheIsFresh && dbServer) {
    return {
      ...server,
      connectionStatus: "connected" as const,
      lastCheckedAt: String(lastHealthCheckAt.getTime()),
      tools: dbServer.registryTools.map(registryToolToDiscoveredTool),
    };
  }

  const startedAt = performance.now();
  let result: Awaited<ReturnType<typeof inspectMcpServer>>;
  try {
    result = await withConnectionTimeout(
      inspectMcpServer(
        createInspectableServerConfig({
          ...server,
          connectionStatus: "pending",
          tools: [],
        }),
      ),
      dbServer?.connectionTimeoutMs ?? 10_000,
    );
  } catch (error) {
    if (dbServer) {
      await prisma.mcpServer.update({
        where: { id: server.id },
        data: {
          consecutiveFailures: { increment: 1 },
          healthStatus: "error",
          lastHealthCheckAt: new Date(),
          lastLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
      });
    }
    throw error;
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (!dbServer) {
    return result.server;
  }

  if (result.server.connectionStatus !== "connected") {
    await prisma.mcpServer.update({
      where: { id: server.id },
      data: {
        consecutiveFailures: { increment: 1 },
        healthStatus: "error",
        lastHealthCheckAt: new Date(),
        lastLatencyMs: latencyMs,
      },
    });
    return result.server;
  }

  await persistToolSnapshot(server.id, result.server.tools, latencyMs);
  const enabledNames = new Set(
    (
      await prisma.mcpToolRegistry.findMany({
        where: { mcpServerId: server.id, enabled: true },
        select: { name: true },
      })
    ).map((tool) => tool.name),
  );

  return {
    ...result.server,
    tools: result.server.tools.filter((tool) => enabledNames.has(tool.name)),
  };
}

// Live-probe an oauth_delegated server without touching the global DB cache.
async function resolveUserDelegatedServerTools(server: McpServerConfig) {
  const connectionTimeoutMs =
    (
      await prisma.mcpServer.findUnique({
        where: { id: server.id },
        select: { connectionTimeoutMs: true },
      })
    )?.connectionTimeoutMs ?? 10_000;

  try {
    const result = await withConnectionTimeout(
      inspectMcpServer(
        createInspectableServerConfig({
          ...server,
          connectionStatus: "pending",
          tools: [],
        }),
      ),
      connectionTimeoutMs,
    );
    return result.server;
  } catch {
    return { ...server, connectionStatus: "error" as const, tools: [] };
  }
}

export async function isRegisteredToolEnabled(
  mcpServerId: string,
  toolName: string,
) {
  const record = await prisma.mcpToolRegistry.findUnique({
    where: { mcpServerId_name: { mcpServerId, name: toolName } },
    select: { enabled: true },
  });
  return record?.enabled ?? false;
}

export async function getRegisteredToolPermission(
  mcpServerId: string,
  toolName: string,
) {
  const record = await prisma.mcpToolRegistry.findUnique({
    where: { mcpServerId_name: { mcpServerId, name: toolName } },
    select: { enabled: true, permissionMode: true },
  });
  if (!record?.enabled || record.permissionMode === "blocked") return "blocked";
  return record.permissionMode === "approval" ? "approval" : "allow";
}

async function persistToolSnapshot(
  mcpServerId: string,
  tools: McpDiscoveredTool[],
  latencyMs: number,
) {
  const now = new Date();
  const names = tools.map((tool) => tool.name);

  await prisma.$transaction([
    ...tools.map((tool) =>
      prisma.mcpToolRegistry.upsert({
        where: { mcpServerId_name: { mcpServerId, name: tool.name } },
        create: {
          annotations: {
            destructiveHint: tool.isDestructive ?? false,
            readOnlyHint: tool.readOnly ?? false,
          },
          description: tool.description,
          displayName: tool.displayName,
          destructive: tool.isDestructive ?? false,
          inputSchema: toJson(tool.inputSchema ?? {}),
          lastSeenAt: now,
          mcpServerId,
          name: tool.name,
          readOnly: tool.readOnly ?? false,
          schemaHash: hashTool(tool),
        },
        update: {
          annotations: {
            destructiveHint: tool.isDestructive ?? false,
            readOnlyHint: tool.readOnly ?? false,
          },
          description: tool.description,
          displayName: tool.displayName,
          destructive: tool.isDestructive ?? false,
          inputSchema: toJson(tool.inputSchema ?? {}),
          lastSeenAt: now,
          readOnly: tool.readOnly ?? false,
          schemaHash: hashTool(tool),
        },
      }),
    ),
    prisma.mcpToolRegistry.deleteMany({
      where: {
        mcpServerId,
        ...(names.length > 0 ? { name: { notIn: names } } : {}),
      },
    }),
    prisma.mcpServer.update({
      where: { id: mcpServerId },
      data: {
        consecutiveFailures: 0,
        healthStatus: "connected",
        lastHealthCheckAt: now,
        lastLatencyMs: latencyMs,
      },
    }),
  ]);
}

function registryToolToDiscoveredTool(tool: {
  name: string;
  displayName: string | null;
  description: string | null;
  inputSchema: unknown;
  readOnly: boolean;
  destructive: boolean;
  permissionMode: string;
}): McpDiscoveredTool {
  return {
    description: tool.description ?? undefined,
    displayName: tool.displayName ?? undefined,
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
  };
}

function normalizeInputSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object" as const, properties: {}, required: [] };
  }

  const candidate = value as Record<string, unknown>;
  return {
    type: "object" as const,
    properties:
      candidate.properties &&
      typeof candidate.properties === "object" &&
      !Array.isArray(candidate.properties)
        ? (candidate.properties as Record<string, object>)
        : {},
    required: Array.isArray(candidate.required)
      ? candidate.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  };
}

function hashTool(tool: McpDiscoveredTool) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? {},
        isDestructive: tool.isDestructive ?? false,
        name: tool.name,
        readOnly: tool.readOnly ?? false,
      }),
    )
    .digest("hex");
}

function toJson(value: unknown): InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as InputJsonValue;
}

function readCacheTtl() {
  const configured = Number(process.env.MCP_TOOL_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_CACHE_TTL_MS;
}

async function withConnectionTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`MCP connection timed out after ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
