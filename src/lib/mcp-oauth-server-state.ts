import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signed state for the inbound MCP OAuth flow.
 * Carries the Claude Code client's PKCE challenge and redirect info
 * through the Entra ID authorization redirect, securely bound to this server.
 */
type McpOAuthServerStatePayload = {
  codeChallenge: string;
  clientId: string;
  clientRedirectUri: string;
  clientState: string;
  expiresAt: number;
  nonce: string;
};

function getSigningSecret() {
  const secret = process.env.NEXTAUTH_SECRET?.trim();
  if (!secret) throw new Error("NEXTAUTH_SECRET is required for MCP OAuth server.");
  return secret;
}

function sign(encodedPayload: string) {
  return createHmac("sha256", getSigningSecret()).update(encodedPayload).digest("base64url");
}

export function createMcpOAuthServerState(
  payload: Omit<McpOAuthServerStatePayload, "nonce" | "expiresAt">,
  ttlMs = 10 * 60 * 1000,
): string {
  const full: McpOAuthServerStatePayload = {
    ...payload,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyMcpOAuthServerState(state: string): McpOAuthServerStatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts as [string, string];

  const expected = sign(encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<McpOAuthServerStatePayload>;

    if (
      typeof payload.codeChallenge !== "string" ||
      typeof payload.clientRedirectUri !== "string" ||
      typeof payload.clientState !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return payload as McpOAuthServerStatePayload;
  } catch {
    return null;
  }
}
