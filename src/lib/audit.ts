import { prisma } from "@/lib/db";
import type { InputJsonValue } from "@prisma/client/runtime/library";

export type AuditAction =
  // MCP Server
  | "mcp.create"
  | "mcp.update"
  | "mcp.delete"
  | "mcp.enable"
  | "mcp.disable"
  | "mcp.refresh"
  | "mcp.tool.enable"
  | "mcp.tool.disable"
  | "mcp.tool.permission"
  | "mcp.proxy"
  | "mcp.namespace"
  | "namespace.mcp.add"
  | "namespace.mcp.remove"
  | "namespace.group.add"
  | "namespace.group.remove"
  | "namespace.access.update"
  | "namespace.tool.enable"
  | "namespace.tool.disable"
  // LLM Config
  | "llm.create"
  | "llm.update"
  | "llm.default"
  | "llm.delete"
  | "llm.test"
  | "llm.chat"
  // Skill
  | "skill.create"
  | "skill.update"
  | "skill.delete"
  // Group / Access Policy
  | "group.upsert"
  | "group.sync"
  | "group.delete"
  // Workspace
  | "workspace.create"
  | "workspace.update"
  | "workspace.delete"
  // User preferences
  | "user.mcp.enable"
  | "user.mcp.disable"
  // OAuth
  | "user.oauth.connect"
  | "user.oauth.disconnect"
  // Auth
  | "user.login"
  | "user.auto_provision";

export function logAudit(params: {
  userId?: string;
  userEmail?: string;
  action: AuditAction;
  resource: string;
  resourceId?: string;
  metadata?: InputJsonValue;
}): void {
  void prisma.auditLog
    .create({
      data: {
        userId: params.userId ?? null,
        userEmail: params.userEmail ?? null,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId ?? null,
        metadata: params.metadata ?? {},
      },
    })
    .catch((err: unknown) => {
      console.error("[audit] Failed to write audit log:", err);
    });
}
