import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { logAudit } from "@/lib/audit";
import { executeGovernedMcpTool } from "@/lib/mcp-governance";
import { resolveAccessibleNamespace } from "@/lib/mcp-namespace";
import { resolveTokenUser } from "@/lib/token-auth";

const CHARACTER_LIMIT = 25_000;

function extractBearer(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;
}

async function handleNamespaceRequest(
  request: Request,
  context: { params: Promise<{ alias: string }> },
): Promise<Response> {
  const bearer = extractBearer(request);
  const resourceMetadataUrl = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  const wwwAuthenticate = `Bearer realm="mcp-hub", resource_metadata="${resourceMetadataUrl}"`;

  if (!bearer) {
    return Response.json(
      { error: "Provide a personal access token or complete the OAuth flow." },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate } },
    );
  }
  const tokenUser = await resolveTokenUser(bearer);
  if (!tokenUser) {
    return Response.json(
      { error: "Invalid personal access token." },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate } },
    );
  }

  const { alias } = await context.params;
  const namespace = await resolveAccessibleNamespace(
    alias,
    tokenUser.userId,
    tokenUser.entraGroups,
  );
  if (!namespace) {
    return Response.json(
      { error: "Namespace not found, unpublished, or access denied." },
      { status: 404 },
    );
  }

  const traceId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const tools = new Map(namespace.tools.map((tool) => [tool.alias, tool]));
  const server = new Server(
    { name: `${alias}-mcp-server`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logAudit({
      userId: tokenUser.userId,
        userEmail: tokenUser.userEmail ?? undefined,
        action: "mcp.namespace",
        resource: "McpNamespace",
        resourceId: namespace.id,
        metadata: {
          alias,
          traceId,
          method: request.method,
          toolCount: namespace.tools.length,
        event: "discovery_tools",
      },
    });

    return {
      tools: namespace.tools.map((tool) => ({
        annotations: tool.annotations,
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.alias,
        title: tool.title,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => {
    const tool = tools.get(toolRequest.params.name);
    if (!tool) {
      return {
        content: [{
          type: "text",
          text: `Unknown tool "${toolRequest.params.name}". Call tools/list to refresh the namespace catalog.`,
        }],
        isError: true,
      };
    }

    try {
      logAudit({
        userId: tokenUser.userId,
        userEmail: tokenUser.userEmail ?? undefined,
        action: "mcp.namespace",
        resource: "McpNamespace",
        resourceId: namespace.id,
        metadata: {
          alias,
          traceId,
          method: request.method,
          toolName: toolRequest.params.name,
          event: "tool_used",
        },
      });

      const result = await executeGovernedMcpTool(
        {
          ...tool.server,
          approvalMode: "always",
          approvedToolNames: [],
        },
        tool.originalToolName,
        toolRequest.params.arguments ?? {},
        {
          authSource: "personal_token",
          personalTokenId: tokenUser.tokenId,
          source: "namespace",
          traceId,
          userId: tokenUser.userId,
        },
      );
      return normalizeToolResult(result);
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: error instanceof Error
            ? error.message
            : "Namespace tool execution failed. Retry or inspect the MCP audit dashboard.",
        }],
        isError: true,
      };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function normalizeToolResult(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const candidate = result as { content: Array<Record<string, unknown>>; isError?: boolean };
    return {
      content: candidate.content.map((item) =>
        item.type === "text" && typeof item.text === "string"
          ? { ...item, text: truncate(item.text) }
          : item
      ),
      isError: candidate.isError,
    };
  }
  return {
    content: [{ type: "text", text: truncate(JSON.stringify(result)) }],
  };
}

function truncate(value: string) {
  return value.length <= CHARACTER_LIMIT
    ? value
    : `${value.slice(0, CHARACTER_LIMIT)}\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Use narrower tool arguments.]`;
}

export const GET = handleNamespaceRequest;
export const POST = handleNamespaceRequest;
export const DELETE = handleNamespaceRequest;
