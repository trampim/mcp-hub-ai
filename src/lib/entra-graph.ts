type GraphTokenCache = {
  accessToken: string;
  expiresAt: number;
};

type EntraGroupSearchResult = {
  id: string;
  displayName: string;
  mail: string | null;
  description: string | null;
};

type EntraGroupSyncResult = {
  exists: boolean;
  displayName: string | null;
  memberCount: number;
};

let graphTokenCache: GraphTokenCache | null = null;

async function getGraphAccessToken(): Promise<string> {
  if (graphTokenCache && graphTokenCache.expiresAt > Date.now() + 60_000) {
    return graphTokenCache.accessToken;
  }

  const tenantId = process.env.AZURE_AD_TENANT_ID;
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Entra group search is not configured. Set AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, and AZURE_AD_CLIENT_SECRET.",
    );
  }

  const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
    cache: "no-store",
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Failed to get Microsoft Graph token: ${tokenResponse.status} ${errorText}`);
  }

  const tokenJson = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!tokenJson.access_token) {
    throw new Error("Microsoft Graph token response did not include an access token.");
  }

  graphTokenCache = {
    accessToken: tokenJson.access_token,
    expiresAt: Date.now() + (tokenJson.expires_in ?? 3600) * 1000,
  };

  return graphTokenCache.accessToken;
}

function buildSearchQuery(query: string): string {
  const cleaned = query.replace(/"/g, "").trim();
  return cleaned.replace(/'/g, "''");
}

export async function searchEntraGroups(query: string): Promise<EntraGroupSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const accessToken = await getGraphAccessToken();
  const endpoint = new URL("https://graph.microsoft.com/v1.0/groups");
  endpoint.searchParams.set("$select", "id,displayName,mail,description");
  endpoint.searchParams.set("$top", "10");
  endpoint.searchParams.set("$filter", `startswith(displayName,'${buildSearchQuery(trimmed)}')`);

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: "eventual",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Microsoft Graph group search failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    value?: Array<{
      id?: string;
      displayName?: string;
      mail?: string | null;
      description?: string | null;
    }>;
  };

  return (data.value ?? [])
    .filter((group): group is { id: string; displayName: string; mail?: string | null; description?: string | null } =>
      typeof group.id === "string" && typeof group.displayName === "string" && group.displayName.length > 0,
    )
    .map((group) => ({
      id: group.id,
      displayName: group.displayName,
      mail: group.mail ?? null,
      description: group.description ?? null,
    }));
}

export async function getUserGroupsByOid(oid: string): Promise<string[]> {
  const accessToken = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(oid)}/memberOf?$select=id&$top=100`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" },
      cache: "no-store",
    },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { value?: Array<{ id?: string }> };
  return (data.value ?? []).map((g) => g.id).filter((id): id is string => typeof id === "string");
}

export async function syncEntraGroup(groupId: string): Promise<EntraGroupSyncResult> {
  const accessToken = await getGraphAccessToken();
  const groupResponse = await fetch(
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}?$select=id,displayName`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (groupResponse.status === 404) {
    return { exists: false, displayName: null, memberCount: 0 };
  }

  if (!groupResponse.ok) {
    const errorText = await groupResponse.text();
    throw new Error(`Microsoft Graph group sync failed: ${groupResponse.status} ${errorText}`);
  }

  const groupData = (await groupResponse.json()) as {
    displayName?: string;
  };

  const countResponse = await fetch(
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/members/$count`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ConsistencyLevel: "eventual",
      },
      cache: "no-store",
    },
  );

  let memberCount = 0;
  if (countResponse.ok) {
    const text = (await countResponse.text()).trim();
    const parsed = Number.parseInt(text, 10);
    memberCount = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  return {
    exists: true,
    displayName: groupData.displayName ?? null,
    memberCount,
  };
}
