import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata.
 * Points MCP clients (e.g. Claude Code) to the MCP Hub's own OAuth endpoints,
 * which internally delegate identity verification to Microsoft Entra ID.
 */
export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/auth/authorize`,
    token_endpoint: `${origin}/api/mcp/auth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
