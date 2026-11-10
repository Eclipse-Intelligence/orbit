"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Radio } from "@/components/_ui/radio";
import { fetchUnsubscribePreview, postSenderAction, postUnsubscribe, type UnsubscribeTarget } from "@/components/mail/mail-cache";
import type { ExistingMailChoice, UnsubscribePreview, UnsubscribeResult } from "@/lib/mail/view";

export type UnsubscribeMode = "unsubscribe" | "block" | "both" | "research";

export type UnsubscribeRequest = UnsubscribeTarget & { mode: UnsubscribeMode };

export type UnsubscribeDone = {
  sender: string;
  thread: string | null;
  mode: UnsubscribeMode;
  existing: ExistingMailChoice;
  result: UnsubscribeResult | null;
  blocked: boolean;
  moved: number;
  moveError: string | null;
  opened: boolean;
};

const CHOICES: { value: ExistingMailChoice; label: string }[] = [
  { value: "archive", label: "Archive" },
  { value: "trash", label: "Move to Trash" },
  { value: "leave", label: "Leave" },
];

const RESEARCH_CHOICES: { value: ExistingMailChoice; label: string }[] = [
  { value: "archive", label: "Move to Research" },
  { value: "leave", label: "Leave" },
];

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function movedLine(existing: ExistingMailChoice, moved: number, research = false) {
  if (!moved || existing === "leave") return "";
  if (research) return ` Moved ${moved} to Research.`;
  return existing === "trash" ? ` Moved ${moved} to Trash.` : ` Archived ${moved}.`;
}

export function unsubscribeToast(done: UnsubscribeDone): { message: string; tone?: "alert"; url?: string | null } {
  const moved = movedLine(done.existing, done.moved, done.mode === "research");
  const failedMove = done.moveError ? ` Some mail didn't move: ${done.moveError}` : "";
  const who = done.sender;
  if (!done.result) {
    const message = done.mode === "research" ? `Keeping ${who} for research.${moved}` : `Blocked ${who}.${moved}`;
    return { message: `${message}${failedMove}`, tone: failedMove ? "alert" : undefined };
  }
  const blocked = done.blocked ? " and blocked" : "";
  const tone = failedMove ? ("alert" as const) : undefined;
  switch (done.result.outcome) {
    case "unsubscribed":
      return { message: `Unsubscribed${blocked} from ${who}.${moved}${failedMove}`, tone };
    case "requested":
      return { message: `Unsubscribe requested from ${who}${blocked}.${moved}${failedMove}`, tone };
    case "needs_you":
      return { message: `Needs you: finish on ${who}'s page.${moved}${failedMove}`, tone, url: done.opened ? null : done.result.url };
    case "none":
      return done.blocked ? { message: `Blocked ${who}.${moved}${failedMove}`, tone } : { message: `${who} has no unsubscribe link. Block them instead.`, tone: "alert" };
    default:
      return { message: `Didn't unsubscribe from ${who}. ${done.result.detail ?? "Try again."}${failedMove}`, tone: "alert" };
  }
}

function describe(preview: UnsubscribePreview, mode: UnsubscribeMode) {
  if (mode === "block") return "Their new mail is archived.";
  if (mode === "research") return "Their new mail goes to Research.";
  const block = mode === "both" ? " Their new mail is archived." : "";
  switch (preview.method) {
    case "one_click":
      return block.trim();
    case "mailto":
      return `Sends an unsubscribe email from ${preview.account}.${block}`;
    case "page":
      return `Opens their page in a new tab.${block}`;
    default:
      return "No unsubscribe link. Blocking archives their new mail.";
  }
}

function blockOnly(preview: UnsubscribePreview | null, mode: UnsubscribeMode) {
  return mode === "block" || (mode !== "research" && preview?.method === "none");
}

function primaryLabel(preview: UnsubscribePreview | null, mode: UnsubscribeMode) {
  if (mode === "research") return "Keep for research";
  const anyway = preview?.protection ? " anyway" : "";
  if (blockOnly(preview, mode)) return `Block${anyway}`;
  if (mode === "both") return `Unsubscribe and block${anyway}`;
  if (anyway) return "Unsubscribe anyway";
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
  const [choice, setChoice] = useState<ExistingMailChoice>("archive");
  const [busy, setBusy] = useState(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const thread = request?.thread;
  const wanted = request?.sender;
  const light = request?.mode === "block" || request?.mode === "research";
  const open = Boolean(request);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchUnsubscribePreview({ thread, sender: wanted }, light ? "block" : undefined)
      .then((loaded) => {
        if (live) setPreview(loaded);
      })
      .catch((problem: Error) => {
        if (live) setError(problem.message);
      });
    return () => {
      live = false;
      setPreview(null);
      setError(null);
      setChoice("archive");
      setBusy(false);
    };
  }, [open, thread, wanted, light]);

  const ready = Boolean(preview) && (!preview?.protection || request?.mode === "research");
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => submitButton.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [ready]);

  if (!request) return null;
  const mode = request.mode;
  const warning = mode !== "research" ? preview?.protection?.reason : null;
  const sender = preview?.sender ?? request.sender ?? "this sender";
  const name = preview?.name?.trim() || sender;
  const title =
    mode === "research"
      ? `Keep ${name} for research`
      : blockOnly(preview, mode)
        ? `Block ${name}`
        : mode === "both"
          ? `Unsubscribe and block ${name}`
          : `Unsubscribe from ${name}`;

  function close() {
    if (!busy) onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy || !request) return;
    const target = { thread: request.thread ?? null, sender: request.sender, mode: request.mode };
    setBusy(true);
    setError(null);
    let opened = false;
    if (!blockOnly(preview, target.mode) && target.mode !== "research" && preview.method === "page" && preview.pageUrl) {
      window.open(preview.pageUrl, "_blank", "noopener,noreferrer");
      opened = true;
    }
    try {
      if (target.mode === "research" || blockOnly(preview, target.mode)) {
        const action = target.mode === "research" ? "research" : "block";
        const change = await postSenderAction({ sender: preview.sender, action, existing: choice, confirmed: Boolean(preview.protection) });
        onDone({ sender: preview.sender, thread: target.thread, mode: target.mode, existing: choice, result: null, blocked: action === "block", moved: change.moved, moveError: change.error, opened });
      } else {
        const result = await postUnsubscribe({
          thread: target.thread ?? undefined,
          sender: target.sender,
          existing: choice,
          block: target.mode === "both",
          confirmed: Boolean(preview.protection),
        });
        onDone({ sender: result.sender, thread: target.thread, mode: target.mode, existing: choice, result, blocked: target.mode === "both", moved: result.moved, moveError: result.moveError, opened });
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "That didn't work. Try again.");
      setBusy(false);
    }
  }

  const existing = preview?.existing ?? { inbox: 0, total: 0 };
  const choices = mode === "research" ? RESEARCH_CHOICES : CHOICES;
  const counts: Record<ExistingMailChoice, string> = {
    archive: existing.inbox ? `${existing.inbox} in inbox` : "None in inbox",
    trash: existing.total ? plural(existing.total, "email", "emails") : "None",
    leave: "",
  };

  const description = preview ? describe(preview, mode) : error ? "Couldn't check this sender." : "Checking…";

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        {...(description ? {} : { "aria-describedby": undefined })}
        aria-busy={busy || (!preview && !error)}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          formRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form ref={formRef} tabIndex={-1} onSubmit={submit} className="outline-none">
          <DialogHeader className="pr-12">
            <DialogTitle className="break-words">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
            {warning && (
              <p role="status" className="caption-style text-warning">
                {warning}
              </p>
            )}
          </DialogHeader>
          <fieldset className="flex flex-col gap-1 px-6 py-4" disabled={!preview || busy}>
            <legend className="ui-style text-soft mb-2 pt-4">Existing mail</legend>
            {choices.map((item) => (
              <label key={item.value} className="ui-style -mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.03]">
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
            <Button variant="ghost" size="md" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button ref={submitButton} type="submit" variant="primary" size="md" disabled={!preview || busy}>
              {busy ? "Working…" : primaryLabel(preview, mode)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
