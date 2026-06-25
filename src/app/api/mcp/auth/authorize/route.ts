import { NextResponse } from "next/server";
import { createMcpOAuthServerState } from "@/lib/mcp-oauth-server-state";

export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 Authorization Endpoint (RFC 6749 §3.1).
 *
 * Called by MCP clients (e.g. Claude Code) to start the authorization code flow.
 * Validates PKCE parameters, embeds them in a signed state, then redirects the
 * user's browser to Microsoft Entra ID for authentication.
 *
 * IMPORTANT: The redirect_uri for the Entra flow is always the Hub's own callback
 * (/api/mcp/auth/callback). The client's redirect_uri is stored inside the signed
 * state and is only used after the Hub verifies the Entra identity.
 *
 * Prerequisites (Azure portal):
 *   Add https://<your-host>/api/mcp/auth/callback to the app registration's
 *   allowed redirect URIs alongside the existing NextAuth callback.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const clientState = url.searchParams.get("state") ?? "";

  if (responseType !== "code") {
    return NextResponse.json({ error: "unsupported_response_type" }, { status: 400 });
  }
  if (!redirectUri) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "redirect_uri is required" },
      { status: 400 },
    );
  }
  if (!codeChallenge) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "code_challenge is required (PKCE mandatory)" },
      { status: 400 },
    );
  }
  if (codeChallengeMethod !== "S256") {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" },
      { status: 400 },
    );
  }

  const tenantId = process.env.AZURE_AD_TENANT_ID;
  const azureClientId = process.env.AZURE_AD_CLIENT_ID;
  if (!tenantId || !azureClientId) {
    return NextResponse.json(
      { error: "server_error", error_description: "Azure AD is not configured." },
      { status: 500 },
    );
  }

  const state = createMcpOAuthServerState({
    codeChallenge,
    clientId,
    clientRedirectUri: redirectUri,
    clientState,
  });

  const hubCallbackUrl = `${origin}/api/mcp/auth/callback`;
  const entraUrl = new URL(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
  );
  entraUrl.searchParams.set("client_id", azureClientId);
  entraUrl.searchParams.set("response_type", "code");
  entraUrl.searchParams.set("redirect_uri", hubCallbackUrl);
  entraUrl.searchParams.set("scope", "openid profile email");
  entraUrl.searchParams.set("state", state);
  entraUrl.searchParams.set("response_mode", "query");

  return NextResponse.redirect(entraUrl.toString());
}
