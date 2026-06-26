import { createHash, randomBytes } from "crypto";

import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/token-auth";

export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 Token Endpoint (RFC 6749 §3.2).
 *
 * Exchanges a Hub-issued authorization code (plus PKCE verifier) for a
 * PersonalToken that can be used as a Bearer token on MCP endpoints.
 *
 * The issued PersonalToken is functionally identical to manually-created tokens
 * but is named "Claude Code – <date>" and replaces any prior token of the same
 * prefix to avoid accumulation across repeated OAuth flows.
 */
export async function POST(request: Request) {
  let body: URLSearchParams;
  try {
    body = new URLSearchParams(await request.text());
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (body.get("grant_type") !== "authorization_code") {
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const code = body.get("code");
  const codeVerifier = body.get("code_verifier");

  if (!code || !codeVerifier) {
    return Response.json(
      { error: "invalid_request", error_description: "code and code_verifier are required" },
      { status: 400 },
    );
  }

  const codeHash = createHash("sha256").update(code).digest("hex");
  const oauthCode = await prisma.oAuthCode.findUnique({ where: { codeHash } });

  if (!oauthCode) {
    return Response.json(
      { error: "invalid_grant", error_description: "Authorization code not found." },
      { status: 400 },
    );
  }
  if (oauthCode.usedAt) {
    return Response.json(
      { error: "invalid_grant", error_description: "Authorization code already used." },
      { status: 400 },
    );
  }
  if (oauthCode.expiresAt < new Date()) {
    return Response.json(
      { error: "invalid_grant", error_description: "Authorization code has expired." },
      { status: 400 },
    );
  }

  // Verify PKCE: BASE64URL(SHA256(code_verifier)) must equal stored codeChallenge
  const computedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  if (computedChallenge !== oauthCode.codeChallenge) {
    return Response.json(
      { error: "invalid_grant", error_description: "PKCE verification failed." },
      { status: 400 },
    );
  }

  // Mark code as consumed (single-use)
  await prisma.oAuthCode.update({ where: { id: oauthCode.id }, data: { usedAt: new Date() } });

  // Replace any existing OAuth-issued token for this user to avoid accumulation
  const tokenPrefix = "Claude Code – ";
  const existingOAuthToken = await prisma.personalToken.findFirst({
    where: { userId: oauthCode.userId, name: { startsWith: tokenPrefix } },
    orderBy: { createdAt: "asc" },
  });
  if (existingOAuthToken) {
    await prisma.personalToken.delete({ where: { id: existingOAuthToken.id } });
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await prisma.personalToken.create({
    data: {
      userId: oauthCode.userId,
      name: `${tokenPrefix}${new Date().toISOString().slice(0, 10)}`,
      tokenHash,
    },
  });

  return Response.json({
    access_token: rawToken,
    token_type: "Bearer",
    expires_in: 31536000,
    scope: "mcp",
  });
}
