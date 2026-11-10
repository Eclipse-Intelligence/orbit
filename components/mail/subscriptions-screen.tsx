"use client";

import { useState } from "react";
import Button, { buttonVariants } from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import FilterChip from "@/components/_ui/filter-chip";
import Tag from "@/components/_ui/tag";
import { Monogram } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { useComposer } from "@/components/mail/compose-dock";
import { fetchSubscriptions, postBulkUnsubscribe, postSenderAction, type BulkResult, type SenderAction } from "@/components/mail/mail-cache";
import UnsubscribeDialog, { unsubscribeToast, type UnsubscribeRequest } from "@/components/mail/unsubscribe-dialog";
import { OUTCOME_LABELS, SUBSCRIPTION_LABELS, type SubscriptionSender, type SubscriptionStatus, type UnsubscribeResult } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";

type Filter = "all" | "suggested" | "subscribed" | "unsubscribed" | "ignored" | "blocked" | "research";

const FILTERS: { id: Filter; label: string; match: (sender: SubscriptionSender) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "suggested", label: "Not opened", match: (sender) => sender.suggest },
  { id: "subscribed", label: "Subscribed", match: (sender) => sender.status === "subscribed" || sender.status === "kept" },
  { id: "unsubscribed", label: "Unsubscribed", match: (sender) => sender.status === "unsubscribed" },
  { id: "ignored", label: "Ignored your unsubscribe", match: (sender) => sender.status === "ignored" },
  { id: "blocked", label: "Blocked", match: (sender) => sender.status === "blocked" },
  { id: "research", label: "Research", match: (sender) => sender.status === "research" },
];

const TONES: Record<SubscriptionStatus, "neutral" | "green" | "amber" | "red" | "blue"> = {
  subscribed: "neutral",
  kept: "neutral",
  unsubscribed: "green",
  ignored: "amber",
  blocked: "red",
  research: "blue",
};

const DONE: Record<"keep" | "subscribe", (name: string) => string> = {
  keep: (name) => `Kept ${name}.`,
  subscribe: (name) => `${name} is back to Subscribed.`,
};

function day(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function failed(result: BulkResult): result is { sender: string; error: string } {
  return "error" in result;
}

function SenderRow({
  sender,
  busy,
  onUnsubscribe,
  onAction,
}: {
  sender: SubscriptionSender;
  busy: boolean;
  onUnsubscribe: () => void;
  onAction: (action: SenderAction) => void;
}) {
  const name = sender.name?.trim() || sender.sender;
  const last = day(sender.lastAt);
  const meta = [plural(sender.emails, "email", "emails"), `${sender.opened} opened`, last ? `last ${last}` : null].filter(Boolean).join(" · ");
  const away = sender.status === "unsubscribed" || sender.status === "ignored";
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Monogram name={name} className="mt-0.5 size-7 shrink-0 rounded-full text-[11px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground truncate text-[14px] font-medium">{name}</span>
            <Tag tone={TONES[sender.status]} size="sm" className="text-[12px]">
              {SUBSCRIPTION_LABELS[sender.status]}
            </Tag>
            {sender.status === "kept" && <span className="caption-style text-subtle">Kept</span>}
            {sender.coldPitch && <span className="caption-style text-subtle">Cold pitch</span>}
          </div>
          {name !== sender.sender && <span className="caption-style text-subtle truncate">{sender.sender}</span>}
          <span className="caption-style text-subtle tabular-nums">{meta}</span>
          {sender.protection && (
            <span className="caption-style text-soft">
              {sender.protection.reason}{" "}
              <Button variant="link" size="none" href={sender.protection.href} className="caption-style">
                Open
              </Button>
            </span>
          )}
        </div>
      </div>
      <div role="group" aria-label={`Actions for ${name}`} className="flex flex-wrap items-center gap-1 pl-10 sm:pl-0">
        {!away && sender.status !== "blocked" && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onUnsubscribe} aria-label={`Unsubscribe from ${name}`}>
            Unsubscribe
          </Button>
        )}
        {(sender.status === "subscribed" || sender.status === "research") && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction("keep")} aria-label={`Keep ${name}`}>
            Keep
          </Button>
        )}
        {sender.status !== "research" && sender.status !== "blocked" && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction("research")} aria-label={`Keep ${name} for research`}>
            Keep for research
          </Button>
        )}
        {sender.status !== "blocked" && (
          <Button variant={sender.status === "ignored" ? "secondary" : "ghost"} size="sm" disabled={busy} onClick={() => onAction("block")} aria-label={`Block ${name}`}>
            Block
          </Button>
        )}
        {(sender.status === "kept" || sender.status === "research" || sender.status === "blocked") && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction("subscribe")} aria-label={`Undo for ${name}`}>
            Undo
          </Button>
        )}
      </div>
    </li>
  );
}

function BulkResults({ results, onBlock, onClose }: { results: BulkResult[]; onBlock: (sender: string) => void; onClose: () => void }) {
  const done = results.filter((result): result is UnsubscribeResult => !failed(result));
  const problems = results.filter(failed);
  const counts = (["unsubscribed", "requested", "needs_you", "none", "failed"] as const)
    .map((outcome) => ({ outcome, count: done.filter((result) => result.outcome === outcome).length }))
    .filter((item) => item.count > 0);
  const needs = done.filter((result) => result.outcome === "needs_you" && result.url);
  const blockable = done.filter((result) => result.outcome === "none");
  return (
    <section role="status" aria-label="Unsubscribe results" className="mx-3 flex flex-col gap-2 rounded-xl bg-white/[0.035] px-4 py-3 sm:mx-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-foreground text-[14px]">{counts.map((item) => `${OUTCOME_LABELS[item.outcome]}: ${item.count}`).join(" · ") || "Nothing changed."}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
      {needs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {needs.map((result) => (
            <li key={result.sender} className="caption-style text-soft flex flex-wrap items-center gap-x-2">
              <span className="min-w-0 truncate">{result.sender} needs you.</span>
              <a href={result.url!} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "link", size: "none" }), "caption-style")}>
                Open page
              </a>
            </li>
          ))}
        </ul>
      )}
      {blockable.length > 0 && (
        <ul className="flex flex-col gap-1">
          {blockable.map((result) => (
            <li key={result.sender} className="caption-style text-soft flex flex-wrap items-center gap-x-2">
              <span className="min-w-0 truncate">{result.sender} has no unsubscribe link.</span>
              <Button variant="link" size="none" className="caption-style" onClick={() => onBlock(result.sender)}>
                Block
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul className="flex flex-col gap-1">
          {problems.map((result) => (
            <li key={result.sender} className="caption-style text-danger">
              {result.sender}: {result.error}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function SubscriptionsScreen({ viewer, initial, days }: { viewer: Viewer; initial: SubscriptionSender[]; days: number }) {
  const { showToast } = useComposer();
  const [senders, setSenders] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [unsubscribing, setUnsubscribing] = useState<UnsubscribeRequest | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const unopened = senders.filter((sender) => sender.suggest);
  const shown = senders.filter(FILTERS.find((item) => item.id === filter)!.match);

  function reload() {
    fetchSubscriptions()
      .then((listed) => setSenders(listed.senders))
      .catch(() => null);
  }

  function working(sender: string, on: boolean) {
    setBusy((existing) => {
      const next = new Set(existing);
      if (on) next.add(sender);
      else next.delete(sender);
      return next;
    });
  }

  function act(sender: SubscriptionSender, action: SenderAction) {
    if (action === "block" || action === "research") {
      setUnsubscribing({ sender: sender.sender, mode: action });
      return;
    }
    working(sender.sender, true);
    postSenderAction({ sender: sender.sender, action, existing: "leave" })
      .then((change) => {
        setSenders((existing) => existing.map((item) => (item.sender === sender.sender ? { ...item, status: change.status, suggest: false } : item)));
        showToast({ message: DONE[action === "keep" ? "keep" : "subscribe"](sender.name?.trim() || sender.sender) });
        reload();
      })
      .catch((error: Error) => showToast({ message: error.message, tone: "alert" }))
      .finally(() => working(sender.sender, false));
  }

  function blockByAddress(address: string) {
    setUnsubscribing({ sender: address, mode: "block" });
  }

  function runBulk() {
    const chosen = unopened.map((sender) => sender.sender);
    if (chosen.length === 0) return;
    setBulkRunning(true);
    setResults(null);
    chosen.forEach((sender) => working(sender, true));
    postBulkUnsubscribe(chosen, "archive")
      .then((body) => {
        setResults(body.results);
        reload();
      })
      .catch((error: Error) => showToast({ message: error.message, tone: "alert" }))
      .finally(() => {
        setBulkRunning(false);
        chosen.forEach((sender) => working(sender, false));
      });
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Subscriptions"
        viewer={viewer}
        heading={
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" href="/mail" aria-label="Back to Mail">
              <ChevronLeftIcon aria-hidden className="size-3.5" />
            </Button>
            <h1 className="truncate">Subscriptions</h1>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[60em] flex-col gap-3 pt-3">
          <div className="flex flex-col gap-3 px-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <p className="caption-style text-subtle">Newsletters and bulk senders across your mailboxes, with what came in the last {days} days.</p>
            <Button
              variant="primary"
              size="sm"
              disabled={unopened.length === 0 || bulkRunning}
              onClick={() => setConfirmBulk(true)}
              className="h-auto self-start rounded-xl px-3 py-2 text-left leading-4 whitespace-normal sm:self-auto sm:rounded-full"
            >
              {bulkRunning ? "Unsubscribing…" : `Unsubscribe from everything you haven't opened in ${days} days (${unopened.length})`}
            </Button>
          </div>
          {results && <BulkResults results={results} onBlock={blockByAddress} onClose={() => setResults(null)} />}
          <nav aria-label="Filter senders" className="flex items-center gap-0.5 overflow-x-auto px-3 [scrollbar-width:none] sm:px-4">
            {FILTERS.map((item) => {
              const count = senders.filter(item.match).length;
              if (item.id !== "all" && count === 0) return null;
              const active = filter === item.id;
              return (
                <FilterChip key={item.id} active={active} aria-pressed={active} count={count} onClick={() => setFilter(item.id)}>
                  {item.label}
                </FilterChip>
              );
            })}
          </nav>
          {shown.length === 0 ? (
            <p className="text-subtle px-4 py-12 text-center">{senders.length === 0 ? "No newsletters or bulk senders yet." : "Nothing here."}</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {shown.map((sender) => (
                <SenderRow
                  key={sender.sender}
                  sender={sender}
                  busy={busy.has(sender.sender)}
                  onUnsubscribe={() => setUnsubscribing({ sender: sender.sender, mode: "unsubscribe" })}
                  onAction={(action) => act(sender, action)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <UnsubscribeDialog
        request={unsubscribing}
        onClose={() => setUnsubscribing(null)}
        onDone={(done) => {
          setUnsubscribing(null);
          const toast = unsubscribeToast(done);
          showToast({
            message: toast.message,
            tone: toast.tone,
            action: toast.url ? { label: "Open page", run: () => window.open(toast.url!, "_blank", "noopener,noreferrer") } : undefined,
          });
          reload();
        }}
      />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Unsubscribe from ${plural(unopened.length, "sender", "senders")}?`}
        description={`You haven't opened anything from these in ${days} days. Orbit unsubscribes you and archives what they already sent. Contacts and companies you work with are left out.`}
        confirmLabel="Unsubscribe from all"
        tone="neutral"
        onConfirm={runBulk}
      >
        <ul aria-label="Senders" className="flex max-h-[40dvh] flex-col gap-1 overflow-y-auto px-6 py-4">
          {unopened.map((sender) => (
            <li key={sender.sender} className="ui-style flex min-w-0 items-baseline gap-2">
              <span className="text-foreground truncate">{sender.name?.trim() || sender.sender}</span>
              <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{plural(sender.emails, "email", "emails")}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
