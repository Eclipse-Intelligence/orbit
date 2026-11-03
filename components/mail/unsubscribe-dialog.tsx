"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Radio } from "@/components/_ui/radio";
import { fetchUnsubscribePreview, postSenderAction, postUnsubscribe, type UnsubscribeTarget } from "@/components/mail/mail-cache";
import type { ExistingMailChoice, UnsubscribePreview, UnsubscribeResult } from "@/lib/mail/view";

export type UnsubscribeMode = "unsubscribe" | "block" | "both";

export type UnsubscribeRequest = UnsubscribeTarget & { mode: UnsubscribeMode };

export type UnsubscribeDone = {
  sender: string;
  existing: ExistingMailChoice;
  result: UnsubscribeResult | null;
  blocked: boolean;
  moved: number;
  opened: boolean;
};

const CHOICES: { value: ExistingMailChoice; label: string }[] = [
  { value: "archive", label: "Archive them" },
  { value: "trash", label: "Move them to Trash" },
  { value: "leave", label: "Leave them" },
];

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function movedLine(existing: ExistingMailChoice, moved: number) {
  if (!moved || existing === "leave") return "";
  return existing === "trash" ? ` Moved ${moved} to Trash.` : ` Archived ${moved}.`;
}

export function unsubscribeToast(done: UnsubscribeDone): { message: string; tone?: "alert"; url?: string | null } {
  const moved = movedLine(done.existing, done.moved);
  const who = done.sender;
  if (!done.result) return { message: `Blocked ${who}.${moved}` };
  const blocked = done.blocked ? " and blocked" : "";
  switch (done.result.outcome) {
    case "unsubscribed":
      return { message: `Unsubscribed${blocked} from ${who}.${moved}` };
    case "requested":
      return { message: `Requested${blocked}. Orbit emailed ${who}'s unsubscribe address.${moved}` };
    case "needs_you":
      return { message: `Needs you: finish on ${who}'s page.${moved}`, url: done.opened ? null : done.result.url };
    case "none":
      return done.blocked ? { message: `Blocked ${who}.${moved}` } : { message: `${who} has no unsubscribe link. Block them instead.`, tone: "alert" };
    default:
      return { message: `Didn't unsubscribe from ${who}. ${done.result.detail ?? "Try again."}`, tone: "alert" };
  }
}

function describe(preview: UnsubscribePreview, mode: UnsubscribeMode) {
  if (mode === "block") return "Their new mail is archived as it arrives.";
  const block = mode === "both" ? " Their new mail is then archived as it arrives." : "";
  switch (preview.method) {
    case "one_click":
      return `Orbit unsubscribes you through ${preview.target}.${block}`;
    case "mailto":
      return `Orbit emails ${preview.target} from ${preview.account} to unsubscribe you.${block}`;
    case "page":
      return `${preview.target} needs you to finish on their page, which opens in a new tab.${block}`;
    default:
      return `${preview.sender} gives no way to unsubscribe. Block them to archive their mail as it arrives.`;
  }
}

function primaryLabel(preview: UnsubscribePreview | null, mode: UnsubscribeMode) {
  if (mode === "block" || preview?.method === "none") return "Block";
  if (mode === "both") return "Unsubscribe and block";
  if (preview?.method === "page") return "Open their page";
  return "Unsubscribe";
}

export default function UnsubscribeDialog({
  request,
  onClose,
  onDone,
}: {
  request: UnsubscribeRequest | null;
  onClose: () => void;
  onDone: (done: UnsubscribeDone) => void;
}) {
  const [preview, setPreview] = useState<UnsubscribePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [choice, setChoice] = useState<ExistingMailChoice>("archive");
  const [busy, setBusy] = useState(false);
  const confirming = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const thread = request?.thread;
  const wanted = request?.sender;
  const open = Boolean(request);

  useEffect(() => {
    if (!open) return;
    let live = true;
    confirming.current = false;
    fetchUnsubscribePreview({ thread, sender: wanted })
      .then((loaded) => {
        if (!live) return;
        setPreview(loaded);
      })
      .catch((problem: Error) => {
        if (live) setError(problem.message);
      });
    return () => {
      live = false;
      setPreview(null);
      setError(null);
      setConfirmed(false);
      setChoice("archive");
      setBusy(false);
    };
  }, [open, thread, wanted]);

  const ready = Boolean(preview) && (!preview?.protection || confirmed);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => submitButton.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [ready]);

  if (!request) return null;
  const mode = request.mode;
  const askFirst = Boolean(preview?.protection) && !confirmed;
  const sender = preview?.sender ?? request.sender ?? "this sender";
  const name = preview?.name?.trim() || sender;
  const title = mode === "block" || preview?.method === "none" ? `Block ${name}` : mode === "both" ? `Unsubscribe and block ${name}` : `Unsubscribe from ${name}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy || !request) return;
    setBusy(true);
    setError(null);
    const blockOnly = mode === "block" || preview.method === "none";
    let opened = false;
    if (!blockOnly && preview.method === "page" && preview.pageUrl) {
      window.open(preview.pageUrl, "_blank", "noopener,noreferrer");
      opened = true;
    }
    try {
      if (blockOnly) {
        const change = await postSenderAction({ sender: preview.sender, action: "block", existing: choice, confirmed: Boolean(preview.protection) });
        onDone({ sender: preview.sender, existing: choice, result: null, blocked: true, moved: change.moved, opened });
      } else {
        const result = await postUnsubscribe({
          thread: request.thread,
          sender: request.sender,
          existing: choice,
          block: mode === "both",
          confirmed: Boolean(preview.protection),
        });
        onDone({ sender: result.sender, existing: choice, result, blocked: mode === "both", moved: result.moved, opened });
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "That didn't work. Try again.");
      setBusy(false);
    }
  }

  if (askFirst && preview?.protection) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (open) return;
          queueMicrotask(() => {
            if (!confirming.current) onClose();
          });
        }}
        title={mode === "block" ? `Block ${preview.protection.name}?` : `Unsubscribe from ${preview.protection.name}?`}
        description={`${preview.protection.reason} Orbit doesn't suggest ${mode === "block" ? "blocking" : "unsubscribing from"} people and companies you work with. Go ahead with ${preview.sender} anyway?`}
        confirmLabel={mode === "block" ? "Block anyway" : "Unsubscribe anyway"}
        tone="neutral"
        onConfirm={() => {
          confirming.current = true;
          setConfirmed(true);
        }}
      />
    );
  }

  const existing = preview?.existing ?? { inbox: 0, total: 0 };
  const counts: Record<ExistingMailChoice, string> = {
    archive: existing.inbox ? plural(existing.inbox, "email in the inbox", "emails in the inbox") : "Nothing in the inbox",
    trash: existing.total ? plural(existing.total, "email", "emails") : "Nothing to move",
    leave: "",
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-busy={!preview && !error}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          formRef.current?.focus();
        }}
      >
        <form ref={formRef} tabIndex={-1} onSubmit={submit} className="outline-none">
          <DialogHeader className="pr-12">
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription>{preview ? describe(preview, mode) : error ? "Orbit couldn't check this sender." : "Checking how to unsubscribe…"}</DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-1 px-6 py-4" disabled={!preview || busy}>
            <legend className="ui-style text-soft mb-2 pt-4">Mail already received from {sender}</legend>
            {CHOICES.map((item) => (
              <label key={item.value} className="ui-style hover:bg-white/[0.03] -mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2">
                <Radio name="existing" value={item.value} checked={choice === item.value} onChange={() => setChoice(item.value)} />
                <span className="text-foreground">{item.label}</span>
                {counts[item.value] && <span className="caption-style text-subtle ml-auto tabular-nums">{counts[item.value]}</span>}
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="caption-style text-danger px-6 pb-4">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md">
                Cancel
              </Button>
            </DialogClose>
            <Button ref={submitButton} type="submit" variant="primary" size="md" disabled={!preview || busy}>
              {busy ? "Working…" : primaryLabel(preview, mode)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
