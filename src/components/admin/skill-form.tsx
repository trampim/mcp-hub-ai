"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { createSkill, parseSkillFile, updateSkill, type SkillRow } from "@/app/admin/skills/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Tab = "write" | "upload";
type Props = { open: boolean; onClose: () => void; skill?: SkillRow };

export function SkillForm({ open, onClose, skill }: Props) {
  const [tab, setTab] = useState<Tab>("write");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setContent(skill?.content ?? "");
    setEnabled(skill?.enabled ?? true);
    setTab("write");
    setError(null);
  }, [skill, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleSave(formData: FormData) {
    setError(null);
    formData.set("enabled", String(enabled));
    startTransition(async () => {
      try {
        if (skill) await updateSkill(skill.id, formData);
        else await createSkill(formData);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  function handleFileUpload(file: File) {
    setError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const parsed = await parseSkillFile(fd);
        if (parsed.name) setName(parsed.name);
        if (parsed.description) setDescription(parsed.description);
        if (parsed.content) setContent(parsed.content);
        setTab("write");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse file.");
      }
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    e.target.value = "";
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="admin-dialog max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? "Edit Skill" : "Add Skill"}</DialogTitle>
        </DialogHeader>

        {/* Single scrollable body — gets padding/bg from .admin-dialog > [data-dialog-body] */}
        <div data-dialog-body="">

          {/* Tab switcher — only for new skill */}
          {!skill && (
            <div className="flex gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1">
              {(["write", "upload"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTab(t); setError(null); }}
                  className={cn(
                    "flex-1 rounded-xl py-1.5 text-xs font-semibold transition-all",
                    tab === t
                      ? "bg-white dark:bg-[var(--color-surface)] shadow-[0_2px_8px_rgba(15,23,42,0.08)] text-[var(--color-text-primary)]"
                      : "text-muted-foreground hover:text-[var(--color-text-primary)]",
                  )}
                >
                  {t === "write" ? "Write" : "Upload file"}
                </button>
              ))}
            </div>
          )}

          {/* Upload panel */}
          {tab === "upload" && !skill && (
            <>
              <div
                role="button"
                tabIndex={0}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors select-none",
                  dragOver
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                    : "border-[var(--color-border)] hover:border-[var(--color-primary)]/50 hover:bg-[var(--color-surface-muted)]",
                  isPending && "pointer-events-none opacity-60",
                )}
              >
                <svg className="size-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-[var(--color-text-secondary)]">
                    {isPending ? "Parsing…" : "Drag and drop or click to upload"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">.zip, .md, or .skill — max 5 MB</p>
                </div>
              </div>

              <input ref={fileRef} type="file" accept=".zip,.md,.skill" className="sr-only" onChange={handleFileInput} />

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-[var(--color-text-secondary)]">File requirements</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>A <code>.md</code> or <code>.skill</code> file may include YAML frontmatter with <code>name</code> and <code>description</code></li>
                  <li>A <code>.zip</code> must contain a <code>SKILL.md</code> file</li>
                </ul>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              <EnabledToggle enabled={enabled} onChange={setEnabled} />
              <div className="admin-form-footer">
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              </div>
            </>
          )}

          {/* Write panel */}
          {(tab === "write" || !!skill) && (
            <form action={handleSave} className="contents">
              <div className="flex flex-col gap-1">
                <Label htmlFor="sk-name">Name *</Label>
                <Input id="sk-name" name="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="sk-desc">Description</Label>
                <Input id="sk-desc" name="description" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="sk-content">Content (Markdown) *</Label>
                <textarea
                  id="sk-content"
                  name="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={13}
                  required
                  placeholder={"# Skill Name\n\nYou are a helpful assistant that...\n\n## Instructions\n\n- ..."}
                  className="w-full rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm font-mono resize-y shadow-[0_1px_4px_rgba(15,23,42,0.06)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <EnabledToggle enabled={enabled} onChange={setEnabled} />
              <div className="admin-form-footer">
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? "Saving…" : "Save"}</Button>
              </div>
            </form>
          )}

        </div>
      </DialogContent>
    </Dialog>
  );
}

function EnabledToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <Switch id="sk-enabled" checked={enabled} onCheckedChange={onChange} aria-label="Enabled" />
      <Label htmlFor="sk-enabled" className="cursor-pointer text-sm font-medium normal-case tracking-normal text-muted-foreground">
        Enabled
      </Label>
    </div>
  );
}
