"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import Tag from "@/components/_ui/tag";
import { OFFLINE, postCapture } from "@/components/capture/capture-post";
import { useComposer } from "@/components/mail/compose-dock";
import type { SkippedEmail } from "@/lib/mail/capture-filter";
import type { SenderRule } from "@/lib/mail/relevance";
import { SKIPPED_LABELS } from "@/lib/mail/relevance-labels";
import { threadHref } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

export default function NotShown({
  items,
  total,
  sorting,
  rules,
  workspaceId,
}: {
  items: SkippedEmail[];
  total: number;
  sorting: number;
  rules: SenderRule[];
  workspaceId: string;
}) {
  const router = useRouter();
  const { showToast } = useComposer();
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [seen, setSeen] = useState({ items, rules });
  if (seen.items !== items || seen.rules !== rules) {
    setSeen({ items, rules });
    setRestored(new Set());
    setRemoved(new Set());
  }
  const left = items.filter((item) => !restored.has(item.key));
  const count = Math.max(0, total - (items.length - left.length));
  const shownRules = rules.filter((rule) => !removed.has(rule.sender));
  if (total === 0 && rules.length === 0 && sorting === 0) return null;

  function mark(key: string, on: boolean) {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function focusAfter(pressed: HTMLButtonElement | null) {
    const active = document.activeElement;
    const stillHere = !active || active === document.body || active === pressed || Boolean(listRef.current?.contains(active));
    if (!stillHere) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-not-shown-action] button, button[data-not-shown-action]") ?? [])];
    const index = pressed ? buttons.indexOf(pressed) : -1;
    const next = buttons.slice(index + 1).find((button) => !button.disabled) ?? buttons.slice(0, Math.max(0, index)).reverse().find((button) => !button.disabled);
    (next ?? toggleRef.current)?.focus();
  }

  async function run(key: string, work: () => Promise<unknown>, done: string, after: () => void) {
    const holder = listRef.current?.querySelector(`[data-not-shown-action="${CSS.escape(key)}"]`) ?? null;
    const pressed = holder instanceof HTMLButtonElement ? holder : (holder?.querySelector("button") ?? null);
    mark(key, true);
    try {
      await work();
      focusAfter(pressed);
      after();
      showToast({ message: done });
      router.refresh();
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : OFFLINE, tone: "alert" });
    } finally {
      mark(key, false);
    }
  }

  const show = (item: SkippedEmail) =>
    run(item.key, () => postCapture({ kind: "email-show", key: item.key }, workspaceId), "Shown in Capture", () =>
      setRestored((current) => new Set(current).add(item.key)),
    );

  const remove = (rule: SenderRule) =>
    run(`rule:${rule.sender}`, () => postCapture({ kind: "rule-remove", sender: rule.sender }, workspaceId), "Rule deleted", () =>
      setRemoved((current) => new Set(current).add(rule.sender)),
    );

  return (
    <section aria-label="Not shown" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {(total > 0 || rules.length > 0) && (
          <Button
            ref={toggleRef}
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            className="text-subtle -ml-2 self-start px-[9px]"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", !open && "-rotate-90")} />
            {count > 0 || shownRules.length === 0 ? (
              <>
                <span className="tabular-nums">{count}</span> not shown
              </>
            ) : (
              "Rules"
            )}
          </Button>
        )}
        {sorting > 0 && (
          <p role="status" className="caption-style text-subtle">
            Sorting <span className="tabular-nums">{sorting}</span>
          </p>
        )}
      </div>
      {open && (
        <div id={listId} ref={listRef} className="flex flex-col gap-3">
          {left.length > 0 && (
            <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
              {left.map((item) => (
                <li key={item.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link href={threadHref(item.key)} className="ui-style text-foreground min-w-0 truncate hover:underline">
                        {item.name || item.email}
                      </Link>
                      <Tag size="sm" className="text-[12px]">
                        {SKIPPED_LABELS[item.category]}
                      </Tag>
                    </div>
                    {item.name && <p className="caption-style text-subtle truncate">{item.email}</p>}
                    <p className="caption-style text-subtle truncate">{item.subject?.trim() || "(no subject)"}</p>
                    {item.reason && <p className="caption-style text-soft line-clamp-2">{item.reason}</p>}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 self-start sm:self-center"
                    data-not-shown-action={item.key}
                    aria-label={`Show ${item.name || item.email} in Capture`}
                    disabled={busy.has(item.key)}
                    onClick={() => void show(item)}
                  >
                    Show in Capture
                  </Button>
                </li>
              ))}
              {count > left.length && <li className="caption-style text-subtle px-4 py-3">Showing the latest {left.length} of {count}.</li>}
            </ul>
          )}
          {shownRules.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="eyebrow-style text-subtle font-normal">Rules</h2>
              <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
                {shownRules.map((rule) => (
                  <li key={rule.sender} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                    <span className="ui-style text-foreground min-w-0 flex-1 break-all">{rule.sender}</span>
                    <Tag size="sm" className="text-[12px]">
                      {rule.kind === "never" ? "Never ask" : "Always show"}
                    </Tag>
                    <span data-not-shown-action={`rule:${rule.sender}`} className="contents">
                      <HoldButton tone="neutral" disabled={busy.has(`rule:${rule.sender}`)} onConfirm={() => void remove(rule)}>
                        Hold to delete<span className="sr-only"> the rule for {rule.sender}</span>
                      </HoldButton>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
