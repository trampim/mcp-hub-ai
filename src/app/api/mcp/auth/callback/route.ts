import { createHash, randomBytes } from "crypto";

import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { verifyMcpOAuthServerState } from "@/lib/mcp-oauth-server-state";

export const dynamic = "force-dynamic";

type EntraTokenResponse = {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type EntraIdClaims = {
  oid?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
};

function redirectWithError(redirectUri: string, error: string, description: string, state: string) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString());
}

/**
 * OAuth 2.0 Authorization Callback.
 *
 * Receives the authorization code from Entra ID after the user authenticates,
 * exchanges it for identity information, finds or auto-provisions the user,
 * then issues a short-lived Hub authorization code to the MCP client.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description") ?? "Authentication failed.";
  const stateParam = url.searchParams.get("state");
  const entraCode = url.searchParams.get("code");

  // Decode state first so we can redirect errors to the client
  const parsedState = stateParam ? verifyMcpOAuthServerState(stateParam) : null;
  const clientRedirectUri = parsedState?.clientRedirectUri;
  const clientState = parsedState?.clientState ?? "";

  if (error) {
    if (clientRedirectUri) {
      return redirectWithError(clientRedirectUri, error, errorDescription, clientState);
    }
    return Response.json({ error, error_description: errorDescription }, { status: 400 });
  }

  if (!parsedState || !clientRedirectUri) {
    return Response.json(
      { error: "invalid_request", error_description: "Invalid or expired state." },
      { status: 400 },
    );
  }

  if (!entraCode) {
    return redirectWithError(clientRedirectUri, "invalid_request", "Missing authorization code.", clientState);
  }

  const tenantId = process.env.AZURE_AD_TENANT_ID;
  const azureClientId = process.env.AZURE_AD_CLIENT_ID;
  const azureClientSecret = process.env.AZURE_AD_CLIENT_SECRET;

  if (!tenantId || !azureClientId || !azureClientSecret) {
    return redirectWithError(clientRedirectUri, "server_error", "Azure AD is not configured.", clientState);
  }

  // Exchange Entra authorization code for tokens
  const hubCallbackUrl = `${origin}/api/mcp/auth/callback`;
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: azureClientId,
        client_secret: azureClientSecret,
        code: entraCode,
        redirect_uri: hubCallbackUrl,
      }),
    },
  );

  const tokenData = (await tokenRes.json().catch(() => ({}))) as EntraTokenResponse;

  if (!tokenRes.ok || !tokenData.id_token) {
    return redirectWithError(
      clientRedirectUri,
      "access_denied",
      tokenData.error_description ?? "Token exchange with identity provider failed.",
      clientState,
    );
  }

  // Decode id_token payload — safe: token received directly from Entra over HTTPS
  let idClaims: EntraIdClaims;
  try {
    const [, payloadB64] = tokenData.id_token.split(".");
    idClaims = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf8")) as EntraIdClaims;
  } catch {
    return redirectWithError(clientRedirectUri, "server_error", "Failed to decode identity token.", clientState);
  }

  const entraOid = idClaims.oid;
  if (!entraOid) {
    return redirectWithError(clientRedirectUri, "server_error", "Missing user identifier in identity token.", clientState);
  }

  const email = idClaims.email ?? idClaims.preferred_username ?? null;
  const name = idClaims.name ?? null;
  const entraGroups = Array.isArray(idClaims.groups) ? idClaims.groups : [];

  // Find or auto-provision user by Entra OID
  let user = await prisma.user.findUnique({ where: { entraOid } });

  if (!user) {
    user = await prisma.user.create({
      data: {
        entraOid,
        email: email ?? undefined,
        name: name ?? undefined,
        entraGroups,
        lastLoginAt: new Date(),
      },
    });
    void logAudit({
      userId: user.id,
      userEmail: email ?? undefined,
      action: "user.auto_provision",
      resource: "User",
      resourceId: user.id,
      metadata: { source: "oauth_flow", entraOid },
    });
  } else {
    void prisma.user
      .update({ where: { id: user.id }, data: { entraGroups, lastLoginAt: new Date() } })
      .catch(() => undefined);
  }

  // Generate a short-lived Hub authorization code
  const rawCode = randomBytes(32).toString("hex");
  const codeHash = createHash("sha256").update(rawCode).digest("hex");

  await prisma.oAuthCode.create({
    data: {
      userId: user.id,
      codeHash,
      codeChallenge: parsedState.codeChallenge,
      clientId: parsedState.clientId || null,
      expiresAt: new Date(Date.now() + 60_000), // 60 seconds
    },
  });

  // Redirect to the MCP client's redirect_uri with the Hub-issued code
  const clientRedirect = new URL(clientRedirectUri);
  clientRedirect.searchParams.set("code", rawCode);
  if (clientState) clientRedirect.searchParams.set("state", clientState);

  return Response.redirect(clientRedirect.toString());
}
