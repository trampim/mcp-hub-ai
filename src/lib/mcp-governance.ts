import type { InputJsonValue } from "@prisma/client/runtime/library";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { executeMcpTool } from "@/lib/mcp-client";
import type { McpServerConfig } from "@/types/mcp";

type ExecutionSource = "chat" | "proxy" | "direct" | "namespace";

export type McpExecutionContext = {
  source: ExecutionSource;
  userId?: string;
  personalTokenId?: string;
  authSource?: string;
  traceId?: string;
};

type RuntimePolicy = {
  dbServerId?: string;
  circuitCooldownMs: number;
  circuitOpenedAt: Date | null;
  circuitState: string;
  failureThreshold: number;
  maxConcurrentCalls: number;
  maxRetries: number;
  rateLimitRequests: number;
  rateLimitWindowMs: number;
  toolTimeoutMs: number;
  consecutiveFailures: number;
  readOnly: boolean;
  toolAllowed: boolean;
};

type RateWindow = { count: number; resetsAt: number };

const activeCalls = new Map<string, number>();
const rateWindows = new Map<string, RateWindow>();
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

export class McpGovernanceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "circuit_open"
      | "concurrency_limit"
      | "rate_limit"
      | "timeout"
      | "tool_disabled",
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "McpGovernanceError";
  }
}

export async function executeGovernedMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  context: McpExecutionContext,
) {
  const policy = await loadPolicy(server.id, toolName);
  const actor = context.personalTokenId ?? context.userId ?? "anonymous";
  const rateKey = `${actor}:${server.id}:${toolName}`;
  const concurrencyKey = policy.dbServerId ?? server.id;
  const startedAt = Date.now();
  let attempts = 0;
  let auditStatus = "error";
  let auditError: string | undefined;

  try {
    if (!policy.toolAllowed) {
      throw new McpGovernanceError(
        `Tool "${toolName}" is disabled or is not registered.`,
        "tool_disabled",
      );
    }
    enforceCircuit(policy);
    enforceRateLimit(rateKey, policy);
    acquireConcurrency(concurrencyKey, policy.maxConcurrentCalls);

    try {
      const retryCount = policy.readOnly ? policy.maxRetries : 0;
      let lastError: unknown;

      for (attempts = 1; attempts <= retryCount + 1; attempts += 1) {
        try {
          const result = await withTimeout(
            executeMcpTool(server, toolName, args),
            policy.toolTimeoutMs,
          );
          auditStatus = resultIsToolError(result) ? "tool_error" : "success";
          await recordSuccess(policy);
          return result;
        } catch (error) {
          lastError = error;
          if (attempts > retryCount || !isTransientError(error)) break;
        }
      }

      throw lastError;
    } finally {
      releaseConcurrency(concurrencyKey);
    }
  } catch (error) {
    auditError = errorMessage(error);
    auditStatus = error instanceof McpGovernanceError ? error.code : "error";
    if (
      policy.dbServerId &&
      !(error instanceof McpGovernanceError &&
        ["circuit_open", "concurrency_limit", "rate_limit", "tool_disabled"].includes(error.code))
    ) {
      await recordFailure(policy);
    }
    throw error;
  } finally {
    await writeAudit({
      args,
      attemptCount: Math.max(1, attempts),
      context,
      errorMessage: auditError,
      latencyMs: Date.now() - startedAt,
      mcpServerId: policy.dbServerId,
      serverName: server.name,
      status: auditStatus,
      toolName,
    });
  }
}

async function loadPolicy(serverId: string, toolName: string): Promise<RuntimePolicy> {
  const server = await prisma.mcpServer.findUnique({
    where: { id: serverId },
    select: {
      authType: true,
      circuitCooldownMs: true,
      circuitOpenedAt: true,
      circuitState: true,
      consecutiveFailures: true,
      enabled: true,
      failureThreshold: true,
      id: true,
      maxConcurrentCalls: true,
      maxRetries: true,
      rateLimitRequests: true,
      rateLimitWindowMs: true,
      registryTools: {
        where: { name: toolName },
        select: { enabled: true, readOnly: true },
        take: 1,
      },
      toolTimeoutMs: true,
    },
  });

  if (server) {
    const tool = server.registryTools[0];
    // oauth_delegated: tools are live-discovered per-user, no registry entry exists.
    const isDelegated = server.authType === "oauth_delegated";
    return {
      ...server,
      dbServerId: server.id,
      readOnly: tool?.readOnly ?? false,
      toolAllowed: server.enabled && (isDelegated || Boolean(tool?.enabled)),
    };
  }

  return {
    circuitCooldownMs: 60_000,
    circuitOpenedAt: null,
    circuitState: "closed",
    consecutiveFailures: 0,
    failureThreshold: 3,
    maxConcurrentCalls: 5,
    maxRetries: 0,
    rateLimitRequests: 60,
    rateLimitWindowMs: 60_000,
    readOnly: false,
    toolAllowed: true,
    toolTimeoutMs: 30_000,
  };
}

function enforceCircuit(policy: RuntimePolicy) {
  if (policy.circuitState !== "open" || !policy.circuitOpenedAt) return;

  const retryAfterMs =
    policy.circuitOpenedAt.getTime() + policy.circuitCooldownMs - Date.now();
  if (retryAfterMs > 0) {
    throw new McpGovernanceError(
      "MCP circuit breaker is open after repeated failures.",
      "circuit_open",
      retryAfterMs,
    );
  }
}

function enforceRateLimit(key: string, policy: RuntimePolicy) {
  if (policy.rateLimitRequests <= 0) return;

  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || current.resetsAt <= now) {
    rateWindows.set(key, {
      count: 1,
      resetsAt: now + policy.rateLimitWindowMs,
    });
    return;
  }

  if (current.count >= policy.rateLimitRequests) {
    throw new McpGovernanceError(
      "MCP tool rate limit exceeded.",
      "rate_limit",
      current.resetsAt - now,
    );
  }
  current.count += 1;
}

function acquireConcurrency(key: string, limit: number) {
  const active = activeCalls.get(key) ?? 0;
  if (limit > 0 && active >= limit) {
    throw new McpGovernanceError(
      "MCP server concurrency limit reached.",
      "concurrency_limit",
    );
  }
  activeCalls.set(key, active + 1);
}

function releaseConcurrency(key: string) {
  const active = activeCalls.get(key) ?? 0;
  if (active <= 1) activeCalls.delete(key);
  else activeCalls.set(key, active - 1);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new McpGovernanceError(
                `MCP tool execution timed out after ${timeoutMs} ms.`,
                "timeout",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isTransientError(error: unknown) {
  if (error instanceof McpGovernanceError) return error.code === "timeout";
  const message = errorMessage(error);
  return /(timeout|timed out|econnreset|econnrefused|socket|network|503|502|429)/i.test(message);
}

async function recordSuccess(policy: RuntimePolicy) {
  if (!policy.dbServerId) return;
  await prisma.mcpServer.update({
    where: { id: policy.dbServerId },
    data: {
      circuitOpenedAt: null,
      circuitState: "closed",
      consecutiveFailures: 0,
    },
  });
}

async function recordFailure(policy: RuntimePolicy) {
  if (!policy.dbServerId) return;
  const failureCount = policy.consecutiveFailures + 1;
  const shouldOpen = failureCount >= policy.failureThreshold;
  await prisma.mcpServer.update({
    where: { id: policy.dbServerId },
    data: {
      circuitOpenedAt: shouldOpen ? new Date() : policy.circuitOpenedAt,
      circuitState: shouldOpen ? "open" : policy.circuitState,
      consecutiveFailures: { increment: 1 },
    },
  });
}

async function writeAudit(input: {
  args: Record<string, unknown>;
  attemptCount: number;
  context: McpExecutionContext;
  errorMessage?: string;
  latencyMs: number;
  mcpServerId?: string;
  serverName: string;
  status: string;
  toolName: string;
}) {
  try {
    await prisma.mcpToolExecution.create({
      data: {
        actorUserId: input.context.userId,
        arguments: sanitizeArguments(input.args) as InputJsonValue,
        attemptCount: input.attemptCount,
        authSource: input.context.authSource,
        errorMessage: input.errorMessage?.slice(0, 8_000),
        latencyMs: input.latencyMs,
        mcpServerId: input.mcpServerId,
        personalTokenId: input.context.personalTokenId,
        serverName: input.serverName,
        source: input.context.source,
        status: input.status,
        toolName: input.toolName,
        traceId: input.context.traceId,
      },
    });
  } catch (error) {
    console.error("Failed to persist MCP execution audit.", error);
  }
}

export function sanitizeArguments(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeArguments(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeArguments(entry, depth + 1),
        ]),
    );
  }
  if (typeof value === "string") return value.slice(0, 4_000);
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "MCP tool execution failed.");
}

function resultIsToolError(result: unknown) {
  return Boolean(
    result &&
      typeof result === "object" &&
      "isError" in result &&
      (result as { isError?: boolean }).isError,
  );
}
