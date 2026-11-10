"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { useComposer } from "@/components/mail/compose-dock";
import type { SkippedEmail } from "@/lib/mail/capture-filter";
import { SKIPPED_LABELS } from "@/lib/mail/relevance-labels";
import { threadHref } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const OFFLINE = "That didn't save. Check your connection and try again.";

async function showInCapture(key: string, workspaceId: string) {
  let response: Response;
  try {
    response = await fetch("/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "email-show", key, captureWorkspaceId: workspaceId }),
    });
  } catch {
    throw new Error(OFFLINE);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "That didn't save. Try again.");
  }
}

export default function NotShown({ items, total, workspaceId }: { items: SkippedEmail[]; total: number; workspaceId: string }) {
  const router = useRouter();
  const { showToast } = useComposer();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [restored, setRestored] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const left = items.filter((item) => !restored.has(item.key));
  const count = Math.max(0, total - restored.size);
  if (count === 0) return null;

  async function show(item: SkippedEmail) {
    setBusy(item.key);
    try {
      await showInCapture(item.key, workspaceId);
      setRestored((current) => new Set(current).add(item.key));
      showToast({ message: "Shown in Capture" });
      router.refresh();
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : OFFLINE, tone: "alert" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Not shown" className="flex flex-col gap-3">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={listId}
        className="text-subtle -ml-2 self-start"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", !open && "-rotate-90")} />
        <span className="tabular-nums">{count}</span> not shown
      </Button>
      {open && (
        <ul id={listId} className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
          {left.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Link href={threadHref(item.key)} className="ui-style text-foreground min-w-0 truncate hover:underline">
                    {item.name || item.email}
                  </Link>
                  <Tag size="sm" className="text-[12px]" title={item.reason ?? undefined}>
                    {SKIPPED_LABELS[item.category]}
                  </Tag>
                </div>
                <p className="caption-style text-subtle truncate">{item.subject?.trim() || "(no subject)"}</p>
              </div>
              <Button variant="secondary" size="sm" className="shrink-0" disabled={busy === item.key} onClick={() => void show(item)}>
                Show in Capture
              </Button>
            </li>
          ))}
          {count > left.length && <li className="caption-style text-subtle px-4 py-3">Showing the latest {left.length} of {count}.</li>}
        </ul>
      )}
    </section>
  );
}
