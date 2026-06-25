"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { saveWorkspace, type WorkspaceRow } from "@/app/admin/workspaces/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Plus, Trash2 } from "@/components/ui/icons";

type Option = { id: string; name: string };

const BORDER = "border-[var(--color-border)]";
const CARD = `rounded-2xl border ${BORDER} bg-[var(--color-surface)] p-4 shadow-[0_8px_24px_rgba(17,63,124,0.04)]`;
const SECTION_LABEL = "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground";
const SECTION_HELPER = "text-sm text-muted-foreground";
const SELECT_CLS = `h-10 w-full rounded-xl border ${BORDER} bg-[var(--color-surface)] px-3 py-2 text-sm shadow-[0_1px_4px_rgba(15,23,42,0.04)] focus:border-[var(--color-primary)] focus:outline-none`;

export function WorkspaceForm({
  groups,
  llms,
  namespaces,
  onClose,
  open,
  skills,
  workspace,
  users: _users,
}: {
  groups: Array<{ id: string; displayName: string }>;
  llms: Array<{ id: string; displayName: string; allowedModels: string[] }>;
  namespaces: Option[];
  onClose: () => void;
  open: boolean;
  skills: Option[];
  workspace?: WorkspaceRow;
  users?: Array<{ id: string; name: string | null; email: string | null }>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(workspace?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(workspace?.isDefault ?? false);
  const [allUsers, setAllUsers] = useState(Boolean(workspace && workspace.groups.length === 0 && workspace.users.length === 0));
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>(workspace?.skills.map((skill) => skill.id) ?? []);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(workspace?.groups.map((group) => group.id) ?? []);
  const [draftSkillIds, setDraftSkillIds] = useState<string[]>(workspace?.skills.map((skill) => skill.id) ?? []);
  const [draftGroupIds, setDraftGroupIds] = useState<string[]>(workspace?.groups.map((group) => group.id) ?? []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEnabled(workspace?.enabled ?? true);
    setIsDefault(workspace?.isDefault ?? false);
    setAllUsers(Boolean(workspace && workspace.groups.length === 0 && workspace.users.length === 0));
    setSelectedSkillIds(workspace?.skills.map((skill) => skill.id) ?? []);
    setDraftSkillIds(workspace?.skills.map((skill) => skill.id) ?? []);
    setSelectedGroupIds(workspace?.groups.map((group) => group.id) ?? []);
    setDraftGroupIds(workspace?.groups.map((group) => group.id) ?? []);
    setAddSkillOpen(false);
    setAddGroupOpen(false);
    setError(null);
  }, [workspace, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedSkills = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const selectedGroups = useMemo(() => new Set(selectedGroupIds), [selectedGroupIds]);
  const availableSkills = skills.filter((skill) => !selectedSkills.has(skill.id));
  const availableGroups = groups.filter((group) => !selectedGroups.has(group.id));

  function submit(formData: FormData) {
    setError(null);
    formData.set("enabled", String(enabled));
    formData.set("isDefault", String(isDefault));
    formData.set("allUsers", String(allUsers));
    if (allUsers) {
      formData.delete("groupIds");
    } else {
      selectedGroupIds.forEach((groupId) => formData.append("groupIds", groupId));
    }
    selectedSkillIds.forEach((skillId) => formData.append("skillIds", skillId));
    startTransition(async () => {
      try {
        await saveWorkspace(formData);
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save workspace.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={`max-w-3xl gap-0 overflow-hidden rounded-2xl border ${BORDER} bg-[var(--color-surface)] p-0 shadow-[0_20px_48px_rgba(15,23,42,0.10)]`}
      >
        <DialogHeader className={`border-b ${BORDER} bg-[var(--color-surface)] px-6 py-4`}>
          <DialogTitle className="text-base font-semibold">
            {workspace ? "Edit workspace" : "Add workspace"}
          </DialogTitle>
        </DialogHeader>

        <form action={submit}>
          <input type="hidden" name="id" value={workspace?.id ?? ""} />
          <input type="hidden" name="approvalMode" value="risk_based" />
          <input type="hidden" name="allUsers" value={String(allUsers)} />

          <div className="app-scroll flex max-h-[calc(90vh-160px)] flex-col gap-5 overflow-y-auto bg-[var(--color-bg)] px-6 py-5">
            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>Basics</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Core identity for the workspace and its endpoint.</p>
              </div>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ws-name">Name *</Label>
                    <Input id="ws-name" name="name" defaultValue={workspace?.name ?? ""} required />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ws-alias">Alias *</Label>
                    <Input id="ws-alias" name="alias" defaultValue={workspace?.slug ?? ""} required />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ws-desc">Description</Label>
                  <Textarea
                    id="ws-desc"
                    name="description"
                    defaultValue={workspace?.description ?? ""}
                    rows={3}
                    placeholder="Short description of what this workspace groups together."
                  />
                </div>
              </div>
            </section>

            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>System prompt</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Prompt used during execution.</p>
              </div>
              <Textarea
                id="ws-system-prompt"
                name="systemPrompt"
                defaultValue={workspace?.systemPrompt ?? ""}
                rows={6}
                placeholder="Instructions that guide the workspace behavior."
              />
            </section>

            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>LLM</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Choose the model provider used by this workspace.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ws-llm">LLM configuration</Label>
                <select
                  id="ws-llm"
                  name="llmConfigId"
                  defaultValue={workspace?.llmConfigId ?? llms[0]?.id ?? ""}
                  className={SELECT_CLS}
                >
                  {llms.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>Namespace</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Assign the namespace used by this workspace.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ws-namespace">Namespace</Label>
                <select
                  id="ws-namespace"
                  name="namespaceId"
                  defaultValue={workspace?.namespaceId ?? namespaces[0]?.id ?? ""}
                  className={SELECT_CLS}
                >
                  {namespaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            {skills.length > 0 && (
              <section className={CARD}>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <p className={SECTION_LABEL}>Skills</p>
                    <p className={cn(SECTION_HELPER, "mt-1")}>Select which skills are available in this workspace.</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9 rounded-full"
                    onClick={() => {
                      setDraftSkillIds(selectedSkillIds);
                      setAddSkillOpen(true);
                    }}
                    aria-label="Add skills"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <div className="flex flex-col gap-2">
                  {selectedSkillIds.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No skills selected.</p>
                  ) : (
                    selectedSkillIds.map((skillId) => {
                      const skill = skills.find((item) => item.id === skillId);
                      if (!skill) return null;
                      return (
                        <div
                          key={skill.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
                        >
                          <p className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
                            {skill.name}
                          </p>
                          <button
                            type="button"
                            className="inline-flex size-8 items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-[var(--color-error)] transition-[background-color,color] duration-150 hover:bg-[var(--color-error-soft)] hover:text-[var(--color-error)]"
                            aria-label={`Remove ${skill.name}`}
                            onClick={() => setSelectedSkillIds((current) => current.filter((id) => id !== skill.id))}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            )}

            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>Access control</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Manage which groups can use this workspace.</p>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] px-4 py-3">
                  <Switch
                    checked={allUsers}
                    onCheckedChange={(checked) => setAllUsers(checked)}
                    aria-label="Available to all authenticated users"
                  />
                  <div>
                    <p className="text-sm font-semibold">Available to all authenticated users</p>
                    <p className="text-xs text-muted-foreground">When enabled, group-based access is removed.</p>
                  </div>
                </div>

                {!allUsers && (
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-medium">Groups</h3>
                        <p className="text-sm text-muted-foreground">Entra groups assigned to this workspace.</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-9 rounded-full"
                        onClick={() => {
                          setDraftGroupIds(selectedGroupIds);
                          setAddGroupOpen(true);
                        }}
                        aria-label="Add groups"
                      >
                        <Plus className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2">
                      {selectedGroupIds.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No groups selected.</p>
                      ) : (
                        selectedGroupIds.map((groupId) => {
                          const group = groups.find((item) => item.id === groupId);
                          if (!group) return null;
                          return (
                            <div
                              key={group.id}
                              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
                            >
                              <p className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
                                {group.displayName}
                              </p>
                              <button
                                type="button"
                                className="inline-flex size-8 items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-[var(--color-error)] transition-[background-color,color] duration-150 hover:bg-[var(--color-error-soft)] hover:text-[var(--color-error)]"
                                aria-label={`Remove ${group.displayName}`}
                                onClick={() => setSelectedGroupIds((current) => current.filter((id) => id !== group.id))}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className={CARD}>
              <div className="mb-4">
                <p className={SECTION_LABEL}>Settings</p>
                <p className={cn(SECTION_HELPER, "mt-1")}>Workspace availability and default selection.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className={`flex items-center gap-2.5 rounded-xl border ${BORDER} bg-[var(--color-surface-muted)]/40 px-4 py-3`}>
                  <Switch
                    id="ws-enabled"
                    checked={enabled}
                    onCheckedChange={(value) => {
                      setEnabled(value);
                      if (!value) setIsDefault(false);
                    }}
                    aria-label="Enabled"
                  />
                  <Label htmlFor="ws-enabled" className="cursor-pointer text-sm font-medium normal-case tracking-normal text-muted-foreground">
                    Enabled
                  </Label>
                </div>
                <div className={`flex items-center gap-2.5 rounded-xl border ${BORDER} bg-[var(--color-surface-muted)]/40 px-4 py-3`}>
                  <Switch
                    id="ws-default"
                    checked={isDefault}
                    disabled={!enabled}
                    onCheckedChange={setIsDefault}
                    aria-label="Default workspace"
                  />
                  <Label htmlFor="ws-default" className="cursor-pointer text-sm font-medium normal-case tracking-normal text-muted-foreground">
                    Default workspace
                  </Label>
                </div>
              </div>
            </section>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter className={`flex-row items-center justify-end gap-2 border-t ${BORDER} bg-[var(--color-surface)] px-6 py-4`}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <SelectionDialog
        title="Add skills"
        open={addSkillOpen}
        setOpen={setAddSkillOpen}
        items={availableSkills.map((item) => ({ id: item.id, title: item.name, subtitle: null }))}
        selected={draftSkillIds}
        setSelected={setDraftSkillIds}
        onAdd={async () => {
          setSelectedSkillIds(draftSkillIds);
        }}
      />

      <SelectionDialog
        title="Add groups"
        open={addGroupOpen}
        setOpen={setAddGroupOpen}
        items={availableGroups.map((item) => ({ id: item.id, title: item.displayName, subtitle: null }))}
        selected={draftGroupIds}
        setSelected={setDraftGroupIds}
        onAdd={async () => {
          setSelectedGroupIds(draftGroupIds);
        }}
      />
    </Dialog>
  );
}

function SelectionDialog({
  title,
  open,
  setOpen,
  items,
  selected,
  setSelected,
  onAdd,
}: {
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  items: Array<{ id: string; title: string; subtitle: string | null }>;
  selected: string[];
  setSelected: (ids: string[]) => void;
  onAdd: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto">
          {items.length ? (
            items.map((item) => (
              <label
                key={item.id}
                className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] px-4 py-3"
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  <span className="block text-sm font-medium">{item.title}</span>
                  {item.subtitle ? <span className="block text-xs text-muted-foreground">{item.subtitle}</span> : null}
                </span>
              </label>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No additional items available.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected.length}
            onClick={async () => {
              await onAdd();
              setOpen(false);
            }}
          >
            Add selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
