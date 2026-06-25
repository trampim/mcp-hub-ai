import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata.
 * Advertises this MCP Hub as a protected resource whose authorization server
 * is the Hub itself (which delegates authentication to Microsoft Entra ID).
 */
export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}
