"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/_ui/dialog";
import BulkEmailDialog from "@/components/crm/bulk-email-dialog";
import { TagOptions, TagPopover } from "@/components/crm/tags";
import type { BulkActionResult } from "@/app/(crm)/bulk";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import { downloadCsv, type CsvCell } from "@/lib/csv";
import type { Recipient } from "@/lib/crm/personalise";
import type { TagCount } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const NOTICE_MS = 10_000;

type Notice = {
  id: number;
  message: string;
  tone: "status" | "error";
  undo?: string[];
};

export function RowCheckbox({
  checked,
  label,
  revealed,
  onToggle,
  className,
}: {
  checked: boolean;
  label: string;
  revealed: boolean;
  onToggle: (range: boolean) => void;
  className?: string;
}) {
  return (
    <Checkbox
      checked={checked}
      aria-label={label}
      data-row-key="x"
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(event.shiftKey);
      }}
      className={cn(
        "opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:pointer-events-none",
        revealed && "opacity-100 [@media(hover:none)]:pointer-events-auto",
        className,
      )}
    />
  );
}

export function SelectAllCheckbox({
  selection,
  label,
  className,
}: {
  selection: BulkSelection;
  label: string;
  className?: string;
}) {
  return (
    <Checkbox
      checked={
        selection.allSelected ? true : selection.someSelected ? "indeterminate" : false
      }
      onCheckedChange={selection.toggleAll}
      aria-label={label}
      data-shortcut="select-all"
      disabled={selection.ids.length === 0}
      className={cn(
        "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:none)]:pointer-events-none",
        selection.revealed && "opacity-100 [@media(hover:none)]:pointer-events-auto",
        className,
      )}
    />
  );
}

export function SelectToggle({ selection }: { selection: BulkSelection }) {
  if (selection.ids.length === 0) return null;
  return (
    <Button
      variant={selection.revealed ? "muted" : "ghost"}
      size="sm"
      aria-pressed={selection.revealed}
      onClick={() =>
        selection.revealed ? selection.clear() : selection.setSelecting(true)
      }
      className="[@media(hover:hover)]:hidden"
    >
      {selection.revealed ? "Done" : "Select"}
    </Button>
  );
}

function count(value: number, noun: [string, string]) {
  return `${value} ${value === 1 ? noun[0] : noun[1]}`;
}

function failureText(results: { ok: boolean; error?: string }[], verb: string) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return "";
  const first = failed.find((result) => result.error)?.error;
  return ` · ${failed.length} could not be ${verb}${first ? `: ${first}` : "."}`;
}

type BulkTagging = {
  tags: TagCount[];
  selectedTags: (ids: string[]) => string[];
  add: (ids: string[], tag: string) => Promise<BulkActionResult>;
  remove: (ids: string[], tag: string) => Promise<BulkActionResult>;
};

export type BulkExtraAction = {
  key: string;
  label: string;
  title?: string;
  confirm?: (ids: string[]) => { title: string; description: string; action: string };
  run: (ids: string[], progress: (text: string) => void) => Promise<{ message: string; tone: "status" | "error" }>;
};

export default function BulkActions({
  selection,
  noun,
  archive,
  unarchive,
  exportRows,
  exportName,
  emailLabel,
  recipients,
  mailboxConnected,
  tagging,
  extraActions = [],
}: {
  selection: BulkSelection;
  noun: [string, string];
  archive: (ids: string[]) => Promise<BulkActionResult>;
  unarchive: (ids: string[]) => Promise<BulkActionResult>;
  exportRows: (ids: string[]) => Promise<CsvCell[][]>;
  exportName: string;
  emailLabel: string;
  recipients: (ids: string[]) => Recipient[] | Promise<Recipient[]>;
  mailboxConnected: boolean;
  tagging?: BulkTagging;
  extraActions?: BulkExtraAction[];
}) {
  const router = useRouter();
  const [extraBusy, setExtraBusy] = useState<{ key: string; text: string } | null>(null);
  const noticeCount = useRef(0);
  const [confirmExtra, setConfirmExtra] = useState<{ action: BulkExtraAction; ids: string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const [busy, setBusy] = useState<"archive" | "undo" | "export" | "email" | "tag" | "extra" | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [composing, setComposing] = useState<Recipient[] | null>(null);
  const ids = selection.selectedIds;

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function show(message: string, tone: Notice["tone"], undo?: string[]) {
    noticeCount.current += 1;
    setNotice({ id: noticeCount.current, message, tone, undo });
  }

  async function runArchive() {
    const chosen = ids;
    setConfirming(false);
    if (chosen.length === 0) return;
    setBusy("archive");
    try {
      const result = await archive(chosen);
      if ("error" in result) {
        show(result.error, "error");
        return;
      }
      const done = result.results.filter((item) => item.ok).map((item) => item.id);
      const failed = result.results.filter((item) => !item.ok).map((item) => item.id);
      selection.keep(failed);
      const tail = failureText(result.results, "archived");
      show(
        done.length > 0
          ? `Archived ${count(done.length, noun)}${tail}`
          : `Nothing archived${tail}`,
        failed.length > 0 ? "error" : "status",
        done.length > 0 ? done : undefined,
      );
      router.refresh();
    } catch {
      show("Archiving failed. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function undo(restore: string[]) {
    setBusy("undo");
    try {
      const result = await unarchive(restore);
      if ("error" in result) {
        show(result.error, "error");
        return;
      }
      const done = result.results.filter((item) => item.ok).length;
      const tail = failureText(result.results, "restored");
      show(`Restored ${count(done, noun)}${tail}`, tail ? "error" : "status");
      router.refresh();
    } catch {
      show("Undo failed. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function runTag(tag: string, mode: "add" | "remove") {
    const chosen = ids;
    setTagMenu(false);
    if (!tagging || chosen.length === 0) return;
    setBusy("tag");
    try {
      const result = await (mode === "add" ? tagging.add : tagging.remove)(chosen, tag);
      if ("error" in result) {
        show(result.error, "error");
        return;
      }
      const done = result.results.filter((item) => item.ok).length;
      const tail = failureText(result.results, mode === "add" ? "tagged" : "updated");
      show(
        mode === "add"
          ? `Tagged ${count(done, noun)} “${tag}”${tail}`
          : `Removed “${tag}” from ${count(done, noun)}${tail}`,
        tail ? "error" : "status",
      );
      router.refresh();
    } catch {
      show("Tagging failed. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function runExtra(action: BulkExtraAction) {
    const chosen = ids;
    if (chosen.length === 0) return;
    setBusy("extra");
    setExtraBusy({ key: action.key, text: "Starting…" });
    try {
      const result = await action.run(chosen, (text) => setExtraBusy({ key: action.key, text }));
      show(result.message, result.tone);
      router.refresh();
    } catch (error) {
      show(error instanceof Error ? error.message : "That didn't work. Try again.", "error");
    } finally {
      setBusy(null);
      setExtraBusy(null);
    }
  }

  async function runExport() {
    setBusy("export");
    try {
      const rows = await exportRows(ids);
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(`${exportName}-selected-${day}.csv`, rows);
    } catch {
      show("The export failed. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function openComposer() {
    setBusy("email");
    try {
      setComposing(await recipients(ids));
    } catch {
      show("Could not load the recipients. Try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  const active = ids.length > 0;
  if (!active && !notice && !composing) return null;

  return (
    <>
      {(active || notice) && (
        <>
          <div aria-hidden className="order-last h-24 shrink-0 md:hidden" />
          <div
            data-quick-add-avoid=""
            className={cn(
              "border-line-strong bg-popover shadow-overlay caption-style fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-40 flex flex-col gap-2 rounded-xl border px-3 py-2.5",
              "md:static md:inset-auto md:shrink-0 md:rounded-none md:border-x-0 md:border-b-0 md:bg-transparent md:px-4 md:py-2 md:shadow-none",
            )}
          >
            {notice && (
              <div
                key={notice.id}
                role={notice.tone === "error" ? "alert" : "status"}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className={notice.tone === "error" ? "text-danger" : "text-foreground"}>
                  {notice.message}
                </span>
                <span className="flex items-center gap-1">
                  {notice.undo && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      data-shortcut="bulk-undo"
                      title="Undo (Z)"
                      onClick={() => notice.undo && undo(notice.undo)}
                    >
                      {busy === "undo" ? "Restoring…" : "Undo"}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
                    Dismiss
                  </Button>
                </span>
              </div>
            )}
            {active && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="flex items-center gap-1">
                  <span className="text-foreground tabular-nums">{ids.length} selected</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selection.clear}
                    disabled={busy !== null}
                  >
                    Clear
                  </Button>
                  {!selection.allSelected && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="md:hidden"
                      onClick={selection.selectAll}
                    >
                      Select all
                    </Button>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {!mailboxConnected && (
                    <Button variant="link" size="none" href="/capture" className="text-subtle mr-1">
                      Connect Microsoft in Capture to email
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={openComposer}
                    disabled={busy !== null || !mailboxConnected}
                    data-shortcut="bulk-email"
                    title={mailboxConnected ? `${emailLabel} (E)` : "Connect Microsoft in Capture to send email"}
                  >
                    {busy === "email" ? "Loading…" : emailLabel}
                  </Button>
                  {tagging && (
                    <TagPopover
                      open={tagMenu}
                      onOpenChange={setTagMenu}
                      align="end"
                      trigger={
                        <Button variant="secondary" size="sm" disabled={busy !== null} data-shortcut="bulk-tag" title="Tag (L)">
                          {busy === "tag" ? "Tagging…" : "Tag"}
                        </Button>
                      }
                    >
                      <TagOptions
                        suggestions={tagging.tags}
                        onPick={(tag) => runTag(tag, "add")}
                        removable={tagging.selectedTags(ids)}
                        onRemove={(tag) => runTag(tag, "remove")}
                        placeholder="Add or remove a tag"
                      />
                    </TagPopover>
                  )}
                  {extraActions.map((action) => (
                    <Button
                      key={action.key}
                      variant="secondary"
                      size="sm"
                      onClick={() => (action.confirm ? setConfirmExtra({ action, ids }) : runExtra(action))}
                      disabled={busy !== null}
                      title={action.title}
                    >
                      {extraBusy?.key === action.key ? extraBusy.text : action.label}
                    </Button>
                  ))}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={runExport}
                    disabled={busy !== null}
                    data-shortcut="bulk-export"
                  >
                    {busy === "export" ? "Exporting…" : "Export selected"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirming(true)}
                    disabled={busy !== null}
                    data-shortcut="bulk-archive"
                    title="Archive (Delete)"
                  >
                    {busy === "archive" ? "Archiving…" : "Archive"}
                  </Button>
                </span>
              </div>
            )}
          </div>
        </>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Archive {count(ids.length, noun)}?</DialogTitle>
            <DialogDescription>
              {ids.length === 1 ? "It's" : "They're"} hidden from Orbit but not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={runArchive} autoFocus>
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmExtra !== null} onOpenChange={(open) => !open && setConfirmExtra(null)}>
        <DialogContent className="max-w-[440px]">
          {confirmExtra && (
            <>
              <DialogHeader>
                <DialogTitle>{confirmExtra.action.confirm!(confirmExtra.ids).title}</DialogTitle>
                <DialogDescription>{confirmExtra.action.confirm!(confirmExtra.ids).description}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setConfirmExtra(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  autoFocus
                  onClick={() => {
                    const chosen = confirmExtra.action;
                    setConfirmExtra(null);
                    void runExtra(chosen);
                  }}
                >
                  {confirmExtra.action.confirm!(confirmExtra.ids).action}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {composing && (
        <BulkEmailDialog
          recipients={composing}
          mailboxConnected={mailboxConnected}
          onClose={(sent) => {
            setComposing(null);
            if (sent > 0) {
              selection.clear();
              show(`Sent ${count(sent, ["email", "emails"])}`, "status");
              router.refresh();
            }
          }}
        />
      )}
    </>
  );
}
