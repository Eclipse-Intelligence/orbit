"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { OFFLINE, postCapture } from "@/components/capture/capture-post";
import { useComposer } from "@/components/mail/compose-dock";
import { listDismissedAction } from "@/app/(crm)/capture/actions";
import { dayLabel } from "@/lib/crm/capture-format";
import type { DismissedImport } from "@/lib/crm/conversations";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const SOURCE: Record<DismissedImport["source"], string> = { teams: "Teams", granola: "Granola" };
const SAVE_FAILED = "That didn't save. Try again.";
const RESTORE_FAILED = "Couldn't restore. Try again.";
const MORE_FAILED = "Couldn't load more. Try again.";

function callTitle(item: DismissedImport) {
  return item.title || (item.kind === "call" ? "Teams call" : "Meeting");
}

function people(item: DismissedImport) {
  return item.participants
    .map((person) => person.name || person.email)
    .filter(Boolean)
    .join(", ");
}

export default function Dismissed({
  items,
  total,
  now,
  workspaceId,
  onRestored,
}: {
  items: DismissedImport[];
  total: number;
  now: number;
  workspaceId: string;
  onRestored: (id: string) => void;
}) {
  const router = useRouter();
  const { showToast } = useComposer();
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<DismissedImport[]>([]);
  const [loading, setLoading] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [seen, setSeen] = useState(items);
  if (seen !== items) {
    setSeen(items);
    setExtra([]);
    setRestored(new Set());
  }
  const loaded = [...items, ...extra.filter((item) => !items.some((first) => first.id === item.id))];
  const left = loaded.filter((item) => !restored.has(item.id));
  const count = Math.max(0, total - restored.size);
  if (total === 0) return null;

  function mark(id: string, on: boolean) {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function focusAfter(pressed: HTMLButtonElement | null) {
    const active = document.activeElement;
    const stillHere = !active || active === document.body || active === pressed || Boolean(listRef.current?.contains(active));
    if (!stillHere) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-dismissed-action]") ?? [])];
    const index = pressed ? buttons.indexOf(pressed) : -1;
    const next = buttons.slice(index + 1).find((button) => !button.disabled) ?? buttons.slice(0, Math.max(0, index)).reverse().find((button) => !button.disabled);
    (next ?? toggleRef.current)?.focus();
  }

  async function restore(item: DismissedImport) {
    const pressed = listRef.current?.querySelector<HTMLButtonElement>(`button[data-dismissed-action="${CSS.escape(item.id)}"]`) ?? null;
    mark(item.id, true);
    try {
      await postCapture({ kind: "import-restore", id: item.id }, workspaceId);
      focusAfter(pressed);
      setRestored((current) => new Set(current).add(item.id));
      onRestored(item.id);
      showToast({ message: "Restored" });
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : OFFLINE;
      showToast({ message: message === SAVE_FAILED ? RESTORE_FAILED : message, tone: "alert" });
    } finally {
      mark(item.id, false);
    }
  }

  async function showMore() {
    setLoading(true);
    try {
      const result = await listDismissedAction(workspaceId, left.length);
      if (result.error || !result.page) showToast({ message: result.error ?? MORE_FAILED, tone: "alert" });
      else setExtra((current) => [...current, ...result.page!.items.filter((item) => !current.some((held) => held.id === item.id))]);
    } catch {
      showToast({ message: MORE_FAILED, tone: "alert" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Dismissed calls" className="flex flex-col gap-3">
      <Button
        ref={toggleRef}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="text-subtle -ml-2 self-start"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", !open && "-rotate-90")} />
        <span className="tabular-nums">{count}</span> dismissed {count === 1 ? "call" : "calls"}
      </Button>
      {open && left.length > 0 && (
        <div id={listId} className="flex flex-col gap-2">
          <ul ref={listRef} className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
            {left.map((item) => {
              const names = people(item);
              const when = item.occurredAt ? dayLabel(item.occurredAt, now) : null;
              return (
                <li key={item.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="ui-style text-foreground min-w-0 truncate">{callTitle(item)}</p>
                    <p className="caption-style text-subtle truncate">{[SOURCE[item.source], when, names].filter(Boolean).join(" · ")}</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 self-start sm:self-center"
                    data-dismissed-action={item.id}
                    aria-label={`Restore ${callTitle(item)}${when ? `, ${when}` : ""}, to Capture`}
                    disabled={busy.has(item.id)}
                    onClick={() => void restore(item)}
                  >
                    Restore
                  </Button>
                </li>
              );
            })}
          </ul>
          {left.length < count && (
            <Button variant="ghost" size="sm" className="text-subtle -ml-2 self-start" disabled={loading} onClick={() => void showMore()}>
              Show more<span className="sr-only"> dismissed calls</span>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
