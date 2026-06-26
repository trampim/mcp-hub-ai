import { prisma } from "@/lib/db";
import { resolveDelegatedAuthorizationHeaders } from "@/lib/delegated-oauth";
import { dbMcpToConfig } from "@/lib/user-context";
import type { McpServerConfig } from "@/types/mcp";

export type ResolvedNamespaceTool = {
  alias: string;
  title?: string;
  description?: string;
  inputSchema: object;
  annotations: {
    destructiveHint: boolean;
    readOnlyHint: boolean;
  };
  originalToolName: string;
  server: McpServerConfig;
};

export async function resolveAccessibleNamespace(
  alias: string,
  userId: string,
  entraGroups: string[],
): Promise<{ id: string; name: string; tools: ResolvedNamespaceTool[] } | null> {
  const namespace = await prisma.mcpNamespace.findFirst({
    where: { alias, enabled: true, published: true },
    include: {
      groups: { select: { entraGroupId: true } },
      users: { select: { id: true } },
      servers: {
        where: { enabled: true, mcpServer: { enabled: true } },
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
  });
  if (!namespace || !canAccess(namespace, userId, entraGroups)) return null;

  const delegatedHeaders = await resolveDelegatedAuthorizationHeaders(
    userId,
    namespace.servers.map((entry) => entry.mcpServerId),
  );
  const serverMap = new Map<string, McpServerConfig>();
  for (const entry of namespace.servers) {
    const authorization = delegatedHeaders.get(entry.mcpServerId);
    const config = dbMcpToConfig(entry.mcpServer, authorization);
    if (config.enabled) {
      serverMap.set(entry.mcpServerId, {
        ...config,
        name: entry.alias || config.name,
      });
    }
  }

  return {
    id: namespace.id,
    name: namespace.name,
    tools: namespace.tools.flatMap((item) => {
      const tool = item.registryTool;
      const server = serverMap.get(tool.mcpServerId);
      if (!server) return [];
      return [{
        alias: item.alias,
        annotations: {
          destructiveHint: tool.destructive,
          readOnlyHint: tool.readOnly,
        },
        description: item.description ?? tool.description ?? undefined,
        inputSchema: normalizeObject(tool.inputSchema),
        originalToolName: tool.name,
        server,
        title: item.displayName ?? tool.displayName ?? undefined,
      }];
    }),
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

function normalizeObject(value: unknown): object {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as object)
    : { type: "object", properties: {} };
}
