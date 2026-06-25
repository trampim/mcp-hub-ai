"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { LlmForm } from "@/components/admin/llm-form";
import { ProviderLogo } from "@/components/setup/provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, CheckCircle2, LoaderCircle, PencilLine, RefreshCw, Search, Trash2 } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn, formatTokenCount } from "@/lib/utils";
import type { LLMConfig } from "@/types/llm-config";
import { deleteLlm, setDefaultLlm, testLlmConfig, type LlmConfigRow } from "./actions";

type Props = { llms: LlmConfigRow[] };

export function LlmAdminClient({ llms }: Props) {
  const [form, setForm] = useState<{ open: boolean; llm?: LlmConfigRow }>({ open: false });
  const [search, setSearch] = useState("");
  const filteredLlms = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-BR");

    if (!query) {
      return llms;
    }

    return llms.filter((llm) =>
      [llm.displayName, llm.provider, ...llm.allowedModels].some((value) =>
        value.toLocaleLowerCase("pt-BR").includes(query),
      ),
    );
  }, [llms, search]);

  return (
    <div className="portal-page">
      <div className="portal-page-heading flex-row items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">LLM Config</h1>
          <p className="text-sm text-muted-foreground">Corporate model providers and token usage.</p>
        </div>
        <Button onClick={() => setForm({ open: true })}>+ Add Provider</Button>
      </div>

      <div className="relative max-w-sm">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search LLMs..."
          aria-label="Search LLMs"
          className="pl-9 text-[var(--color-text-secondary)]"
        />
      </div>

      <div className="portal-table-shell overflow-x-auto">
        <table className="w-full min-w-[1180px] table-fixed text-left text-sm text-[var(--color-text-secondary)]">
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[16%]" />
            <col className="w-[10%]" />
            <col className="w-[30%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 text-center font-medium">Status</th>
              <th className="px-4 py-3 text-center">Default</th>
              <th className="px-4 py-3 text-center font-medium">Tokens used</th>
              <th className="px-4 py-3 text-center font-medium">Last check</th>
              <th className="px-4 py-3 text-center font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredLlms.map((llm) => (
              <LlmRow
                key={llm.id}
                llm={llm}
                onEdit={() => setForm({ open: true, llm })}
              />
            ))}
            {filteredLlms.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <p className="font-semibold">
                    {llms.length === 0 ? "No LLM providers configured" : "No LLMs found"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {llms.length === 0
                      ? "Add the first provider to enable corporate chat."
                      : "Try searching by provider name or model."}
                  </p>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <LlmForm open={form.open} llm={form.llm} onClose={() => setForm({ open: false })} />
    </div>
  );
}

function LlmRow({ llm, onEdit }: { llm: LlmConfigRow; onEdit: () => void }) {
  const [testing, startTesting] = useTransition();
  const [defaulting, startDefaulting] = useTransition();
  const [status, setStatus] = useState(llm.lastTestStatus);
  const [lastTestAt, setLastTestAt] = useState<Date | null>(llm.lastTestAt);
  const [isDefault, setIsDefault] = useState(llm.isDefault);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const model = llm.allowedModels[0] || "No model";

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsDefault(llm.isDefault);
  }, [llm.isDefault]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function retest() {
    setError(null);
    startTesting(async () => {
      const result = await testLlmConfig(llm.id);
      setStatus(result.ok ? "connected" : "error");
      setLastTestAt(new Date());
      setError(result.error ?? null);
    });
  }

  function toggleDefault(nextValue: boolean) {
    setError(null);
    setIsDefault(nextValue);
    startDefaulting(async () => {
      try {
        await setDefaultLlm(llm.id, nextValue);
        router.refresh();
      } catch (cause) {
        setIsDefault(!nextValue);
        setError(
          cause instanceof Error ? cause.message : "Could not update default provider.",
        );
      }
    });
  }

  return (
    <tr
      className={cn(
        "border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]/55",
        !llm.enabled && "opacity-65",
      )}
    >
      <td className="px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo
            provider={llm.provider as LLMConfig["provider"]}
            flat
            className="size-10 shrink-0 rounded-xl"
            iconClassName="size-5"
          />
          <div className="min-w-0">
            <p className="max-w-[220px] truncate font-semibold text-[var(--color-text-secondary)]">
              {llm.displayName}
            </p>
            <p className="mt-0.5 max-w-[280px] truncate font-mono text-xs text-muted-foreground">{model}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
              status === "connected" &&
                "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
              status === "error" &&
                "border-[var(--color-error)] bg-[var(--color-error-soft)] text-[var(--color-error)]",
              status !== "connected" &&
                status !== "error" &&
                "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-muted-foreground",
            )}
          >
            {testing ? <LoaderCircle className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
            {testing ? "Validating" : status === "connected" ? "Connected" : status === "error" ? "Error" : "Not tested"}
          </span>
          {!llm.enabled ? <Badge variant="secondary" className="text-muted-foreground">disabled</Badge> : null}
        </div>
        {error ? (
          <p className="mt-2 truncate text-center text-xs text-[var(--color-error)]" title={error}>
            {error}
          </p>
        ) : null}
      </td>
      <td className="px-4 py-4">
        <div className="flex justify-center">
          <Switch
            checked={isDefault}
            onCheckedChange={toggleDefault}
            disabled={testing || defaulting}
            aria-label={`Set ${llm.displayName} as default`}
          />
        </div>
      </td>
      <td className="px-4 py-4">
        <div className="mx-auto grid max-w-[270px] grid-cols-3 gap-2">
          <TokenMetric label="Entrada" value={llm.inputTokens} />
          <TokenMetric label="Saída" value={llm.outputTokens} />
          <TokenMetric label="Total" value={llm.totalTokens} />
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-center text-xs text-muted-foreground">
        <div className="flex items-center justify-center gap-1.5">
          <Calendar aria-hidden="true" className="size-3.5" />
          <span>
            {lastTestAt
              ? new Intl.DateTimeFormat("pt-BR", {
                  dateStyle: "short",
                  timeStyle: "short",
                }).format(new Date(lastTestAt))
              : "Never tested"}
          </span>
        </div>
      </td>
      <td className="px-4 py-4">
        <div className="flex items-center justify-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground"
            onClick={retest}
            disabled={testing}
            aria-label="Test connection"
            title="Test connection"
          >
            {testing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground"
            onClick={onEdit}
            aria-label="Edit"
            title="Edit"
          >
            <PencilLine />
          </Button>
          <form action={async () => deleteLlm(llm.id)}>
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="inline-flex size-8 items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-[var(--color-error)] transition-[background-color,color] duration-150 hover:bg-[var(--color-error-soft)] hover:text-[var(--color-error)] focus-visible:bg-[var(--color-error-soft)] focus-visible:text-[var(--color-error)]"
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </form>
        </div>
      </td>
    </tr>
  );
}

function TokenMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-semibold text-[var(--color-text-secondary)]">
        {formatTokenCount(value)}
      </p>
    </div>
  );
}
