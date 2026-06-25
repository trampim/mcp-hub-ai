"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setMcpEnabled } from "./actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Cable, CheckCircle2, Globe, LoaderCircle, TerminalSquare, XCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

type ConnectionItem = {
  id: string;
  name: string;
  description: string | null;
  transport: string;
  authType: string;
  toolCount: number;
  userEnabled: boolean;
  connection: { status: string; updatedAt: Date } | null;
};

type NamespaceItem = {
  id: string;
  alias: string;
  name: string;
  description: string | null;
  mcpCount: number;
  endpointUrl: string;
};

type OAuthStatus = "connected" | "disconnected" | "expired" | "pending" | "error";

function TransportIcon({ transport }: { transport: string }) {
  const Icon = transport === "stdio" ? TerminalSquare : transport === "sse" ? Globe : Cable;
  return <Icon className="size-4 text-muted-foreground" />;
}

function StatusBadge({ authType, status }: { authType: string; status: OAuthStatus }) {
  if (authType !== "oauth_delegated") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-success)] bg-[var(--color-success-soft)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
        <CheckCircle2 className="size-3" /> Configured by admin
      </span>
    );
  }

  const map: Record<OAuthStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    connected: { label: "Connected", cls: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]", Icon: CheckCircle2 },
    disconnected: { label: "Not connected", cls: "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-muted-foreground", Icon: XCircle },
    expired: { label: "Expired", cls: "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]", Icon: XCircle },
    pending: { label: "Connecting…", cls: "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-muted-foreground", Icon: LoaderCircle },
    error: { label: "Error", cls: "border-[var(--color-error)] bg-[var(--color-error-soft)] text-[var(--color-error)]", Icon: XCircle },
  };

  const { label, cls, Icon } = map[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium", cls)}>
      <Icon className={cn("size-3", status === "pending" && "animate-spin")} />
      {label}
    </span>
  );
}

export function ConnectionsClient({ items, namespaces, proxyUrl }: { items: ConnectionItem[]; namespaces: NamespaceItem[]; proxyUrl: string }) {
  const router = useRouter();
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(
    Object.fromEntries(items.map((i) => [i.id, i.userEnabled])),
  );
  const [isPendingToggle, startToggle] = useTransition();

  function handleToggle(mcpId: string, val: boolean) {
    setEnabledMap((m) => ({ ...m, [mcpId]: val }));
    startToggle(async () => { await setMcpEnabled(mcpId, val); });
  }

  const [statuses, setStatuses] = useState<Record<string, OAuthStatus>>(
    Object.fromEntries(
      items.map((item) => [
        item.id,
        item.authType !== "oauth_delegated"
          ? "connected"
          : item.connection?.status === "connected"
            ? "connected"
            : item.connection?.status === "expired"
              ? "expired"
              : "disconnected",
      ]),
    ),
  );

  // Sync state when items prop updates (e.g. after router.refresh())
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEnabledMap(Object.fromEntries(items.map((i) => [i.id, i.userEnabled])));
    setStatuses(Object.fromEntries(items.map((item) => [
      item.id,
      item.authType !== "oauth_delegated"
        ? "connected"
        : item.connection?.status === "connected"
          ? "connected"
          : item.connection?.status === "expired"
            ? "expired"
            : "disconnected",
    ])));
  }, [items]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyEndpoint(id: string, path: string) {
    const url = `${window.location.origin}${path}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  const connect = useCallback(async (mcpId: string) => {
    setStatuses((s) => ({ ...s, [mcpId]: "pending" }));
    const redirectUri = `${window.location.origin}/oauth/callback`;

    try {
      const startRes = await fetch("/api/mcp/corporate-oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpServerId: mcpId, redirectUri }),
      });
      const startData = await startRes.json() as { authorizationUrl?: string; codeVerifier?: string; state?: string; error?: string };

      if (!startData.authorizationUrl || !startData.codeVerifier || !startData.state) {
        setStatuses((s) => ({ ...s, [mcpId]: "error" }));
        return;
      }

      const pendingData = { codeVerifier: startData.codeVerifier, state: startData.state, mcpServerId: mcpId, redirectUri };
      sessionStorage.setItem(`corp-oauth-${startData.state}`, JSON.stringify(pendingData));

      const popup = window.open(startData.authorizationUrl, "mcp-oauth", "width=600,height=700");
      if (!popup) { sessionStorage.removeItem(`corp-oauth-${startData.state}`); setStatuses((s) => ({ ...s, [mcpId]: "error" })); return; }

      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-callback") return;
        window.removeEventListener("message", handleMessage);
        popup.close();
        const { code, state, error } = event.data as { code?: string; state?: string; error?: string };
        if (error || !code || !state) { setStatuses((s) => ({ ...s, [mcpId]: "error" })); return; }
        const stored = sessionStorage.getItem(`corp-oauth-${state}`);
        if (!stored) { setStatuses((s) => ({ ...s, [mcpId]: "error" })); return; }
        sessionStorage.removeItem(`corp-oauth-${state}`);
        const pending = JSON.parse(stored) as typeof pendingData;
        if (pending.state !== state || pending.mcpServerId !== mcpId) { setStatuses((s) => ({ ...s, [mcpId]: "error" })); return; }
        const exchangeRes = await fetch("/api/mcp/corporate-oauth/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcpServerId: pending.mcpServerId, code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, state }),
        });
        setStatuses((s) => ({ ...s, [mcpId]: exchangeRes.ok ? "connected" : "error" }));
        if (exchangeRes.ok) router.refresh();
      };

      window.addEventListener("message", handleMessage);
      const monitor = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(monitor);
        window.removeEventListener("message", handleMessage);
        const key = `corp-oauth-${startData.state}`;
        if (sessionStorage.getItem(key)) { sessionStorage.removeItem(key); setStatuses((s) => ({ ...s, [mcpId]: "disconnected" })); }
      }, 500);
    } catch {
      setStatuses((s) => ({ ...s, [mcpId]: "error" }));
    }
  }, [router]);

  const disconnect = useCallback(async (mcpId: string) => {
    setStatuses((s) => ({ ...s, [mcpId]: "pending" }));
    const res = await fetch("/api/mcp/corporate-oauth/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mcpServerId: mcpId }) });
    setStatuses((s) => ({ ...s, [mcpId]: res.ok ? "disconnected" : "error" }));
    if (res.ok) router.refresh();
  }, [router]);

  return (
    <div className="portal-page">
      <div className="portal-page-heading flex-row items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Connections</h1>
          <p className="text-sm text-muted-foreground">All MCP tools available to your account.</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="portal-table-shell">
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            No MCP tools configured for your account yet.
          </p>
        </div>
      ) : (
        <div className="portal-table-shell overflow-x-auto">
          <table className="w-full text-left text-sm text-[var(--color-text-secondary)]">
            <thead>
              <tr>
                <th className="px-4 py-3">MCP Server</th>
                <th className="px-4 py-3">Transport</th>
                <th className="px-4 py-3">Tools</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const status = statuses[item.id] ?? "disconnected";
                const isOAuth = item.authType === "oauth_delegated";
                return (
                  <tr key={item.id} className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]/55">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
                          <TransportIcon transport={item.transport} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-[var(--color-text-secondary)]">{item.name}</p>
                          {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {item.transport}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">
                      {item.toolCount > 0
                        ? `${item.toolCount} tool${item.toolCount !== 1 ? "s" : ""}`
                        : item.authType === "oauth_delegated" && statuses[item.id] !== "connected"
                          ? <span className="italic">Not connected</span>
                          : <span className="italic">Not inspected</span>}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge authType={item.authType} status={status} />
                    </td>
                    <td className="px-4 py-4">
                      <Switch
                        checked={enabledMap[item.id] ?? true}
                        onCheckedChange={(v) => handleToggle(item.id, v)}
                        disabled={isPendingToggle || (item.authType === "oauth_delegated" && statuses[item.id] !== "connected")}
                        aria-label={`${enabledMap[item.id] ? "Disable" : "Enable"} ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-4 text-center">
                      {isOAuth && (
                        status === "connected" ? (
                          <Button size="sm" variant="ghost" className="bg-[var(--color-error-soft)] text-[var(--color-error)] hover:bg-[var(--color-error-soft)] hover:text-[var(--color-error)]" onClick={() => void disconnect(item.id)}>
                            Disconnect
                          </Button>
                        ) : (
                          <Button size="sm" disabled={status === "pending"} onClick={() => void connect(item.id)}>
                            {status === "expired" ? "Reconnect" : "Connect"}
                          </Button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {namespaces.length > 0 && (
        <div>
          <div className="portal-page-heading">
            <h2 className="text-lg font-semibold">Namespace Endpoints</h2>
            <p className="text-sm text-muted-foreground">
              MCP endpoints you can add to VS Code or Claude Desktop.
            </p>
          </div>
          <div className="portal-table-shell overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--color-text-secondary)]">
              <thead>
                <tr>
                  <th className="px-4 py-3">Namespace</th>
                  <th className="px-4 py-3">MCPs</th>
                  <th className="px-4 py-3 text-center">Endpoint</th>
                </tr>
              </thead>
              <tbody>
                {namespaces.map((ns) => (
                  <tr key={ns.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]/55">
                    <td className="px-4 py-4">
                      <p className="font-semibold text-[var(--color-text-secondary)]">{ns.name}</p>
                      {ns.description && (
                        <p className="text-xs text-muted-foreground">{ns.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-muted-foreground">
                      {ns.mcpCount} server{ns.mcpCount !== 1 ? "s" : ""}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-center gap-2">
                        <code className="font-mono text-xs text-muted-foreground">{ns.endpointUrl}</code>
                        <button
                          type="button"
                          onClick={() => copyEndpoint(ns.id, ns.endpointUrl)}
                          className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-muted)] hover:text-foreground"
                        >
                          {copiedId === ns.id ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-success)]"><polyline points="20 6 9 17 4 12"/></svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MCP Proxy Endpoint */}
      <div className="portal-section">
        <div>
          <h2 className="font-semibold">MCP Proxy Endpoint</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Endpoint para conectar VS Code, Claude Desktop ou qualquer cliente MCP usando seu token pessoal.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2">
          <code className="flex-1 truncate text-xs text-muted-foreground">{proxyUrl}</code>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 text-xs"
            onClick={() => void navigator.clipboard.writeText(proxyUrl)}
          >
            Copiar
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Header necessário: <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs">Authorization: Bearer &lt;seu-token&gt;</code>
        </p>
      </div>
    </div>
  );
}
