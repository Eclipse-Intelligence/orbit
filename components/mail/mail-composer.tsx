"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { useComposer } from "@/components/mail/compose-dock";
import { writeWithAi } from "@/components/mail/mail-cache";
import RecipientField from "@/components/mail/recipient-field";
import { laterDetail, laterOptions } from "@/lib/mail/later";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, DraftMode, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import BellIcon from "@/public/assets/images/mail/bell.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1500;
export const MODE_LABEL: Record<DraftMode, string> = { new: "New email", reply: "Reply", reply_all: "Reply all", forward: "Forward" };

export type SendPayload = {
  id: string | null;
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  signature: boolean;
  remindHours: number | null;
  attachments: string[];
  replaces?: string | null;
  identityId?: string | null;
};

const REMINDERS: { hours: number | null; label: string }[] = [
  { hours: null, label: "No reminder" },
  { hours: 24, label: "1 day" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
];

export type ComposerStart = {
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  draft: MailDraft | null;
  replaces?: string | null;
  fromId?: string | null;
};

type SaveState = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

async function postJson<T>(url: string, body: unknown, keepalive = false): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? "Outlook didn't take the draft. Try again.");
  return json;
}

export default function MailComposer({
  start,
  accounts,
  variant,
  onSent,
  onClose,
  onSubject,
  onDelivered,
  onUndone,
}: {
  start: ComposerStart;
  accounts: ComposeAccount[];
  variant: "inline" | "card";
  onSent: (body: string, to: MailAddress[]) => void;
  onClose: () => void;
  onSubject?: (subject: string) => void;
  onDelivered?: () => void;
  onUndone?: () => void;
}) {
  const { queueSend, scheduleSend, pickLater } = useComposer();
  const [remindHours, setRemindHours] = useState<number | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUndo, setAiUndo] = useState<string | null>(null);
  const aiInput = useRef<HTMLInputElement>(null);
  const aiHint = useShortcutHint("mail-ai-write");
  const id = useId();
  const sendHint = useShortcutHint("submit");
  const draft = start.draft;
  const [fromId, setFromId] = useState(
    draft?.identityId ? `smtp:${draft.identityId}` : (start.fromId ?? draft?.sourceId ?? start.sourceId),
  );
  const fromAccount = accounts.find((item) => item.id === fromId) ?? null;
  const sourceId = fromAccount?.sourceId ?? fromAccount?.id ?? draft?.sourceId ?? start.sourceId;
  const identityId = fromAccount?.identityId ?? null;
  const fromChoices = start.mode === "new" ? accounts : accounts.filter((item) => (item.sourceId ?? item.id) === (draft?.sourceId ?? start.sourceId));
  const [to, setTo] = useState<MailAddress[]>(draft?.to ?? start.to);
  const [cc, setCc] = useState<MailAddress[]>(draft?.cc ?? start.cc);
  const [bcc, setBcc] = useState<MailAddress[]>(draft?.bcc ?? []);
  const [showCopies, setShowCopies] = useState(Boolean(draft?.cc.length || draft?.bcc.length || start.cc.length));
  const [subject, setSubject] = useState(draft?.subject || start.subject);
  const [body, setBody] = useState(draft?.body ?? "");
  const [withSignature, setWithSignature] = useState(true);
  const [save, setSave] = useState<SaveState>(draft?.savedAt ? { kind: "saved" } : { kind: "idle" });
  const [scheduledFor, setScheduledFor] = useState(draft?.sendAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const attachments = useEmailAttachments();
  const draftId = useRef<string | null>(draft?.id || null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const payload = useRef({
    mode: start.mode,
    messageId: start.messageId,
    sourceId,
    identityId,
    to,
    cc,
    bcc,
    subject,
    body,
    signature: withSignature,
    replaces: start.replaces ?? null,
  });
  const account = fromAccount;
  const showSubject = start.mode === "new" || start.mode === "forward";
  const card = variant === "card";

  useEffect(() => {
    payload.current = {
      mode: start.mode,
      messageId: start.messageId,
      sourceId,
      identityId,
      to,
      cc,
      bcc,
      subject,
      body,
      signature: withSignature,
      replaces: start.replaces ?? null,
    };
  });

  useEffect(() => {
    onSubject?.(subject);
  }, [subject, onSubject]);

  useEffect(() => {
    const element = textarea.current;
    if (!element || card) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, card ? 420 : 560)}px`;
  }, [body, card]);

  useEffect(() => {
    if (!card) textarea.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const recipientsFirst = !draft && (start.mode === "forward" || (start.mode === "new" && start.to.length === 0));
    if (!recipientsFirst) textarea.current?.focus({ preventScroll: true });
  }, [card, draft, start.mode, start.to.length]);

  function saveNow() {
    const run = chain.current.then(async () => {
      if (!dirty.current) return;
      const snapshot = { ...payload.current, id: draftId.current };
      if (!draftId.current && !snapshot.body.trim() && !snapshot.subject.trim()) return;
      dirty.current = false;
      setSave({ kind: "saving" });
      try {
        const saved = await postJson<MailDraft>("/api/mail/drafts", snapshot);
        draftId.current = saved.id;
        setSave({ kind: "saved" });
      } catch (problem) {
        dirty.current = true;
        setSave({ kind: "error", message: problem instanceof Error ? problem.message : "Couldn't save the draft." });
      }
    });
    chain.current = run;
    return run;
  }

  const saveRef = useRef(saveNow);
  useEffect(() => {
    saveRef.current = saveNow;
  });

  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [fromId, to, cc, bcc, subject, body, withSignature]);

  useEffect(
    () => () => {
      if (!dirty.current) return;
      const snapshot = { ...payload.current, id: draftId.current };
      if (!draftId.current && !snapshot.body.trim() && !snapshot.subject.trim()) return;
      void postJson("/api/mail/drafts", snapshot, true).catch(() => null);
    },
    [],
  );

  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      dirty.current = true;
      setter(value);
    };
  }

  function ready() {
    if (attachments.uploading) {
      setError("Wait for the attachments to finish uploading.");
      return false;
    }
    if (to.length + cc.length + bcc.length === 0) {
      setError("Add at least one person to send to.");
      return false;
    }
    if (start.mode === "new" && !subject.trim()) {
      setError("Add a subject.");
      return false;
    }
    if (!body.trim() && start.mode !== "forward") {
      setError("Write a message first.");
      return false;
    }
    return true;
  }

  function handOver(): Promise<SendPayload> {
    const snapshot = { ...payload.current, remindHours, attachments: attachments.ids };
    dirty.current = false;
    const pending = chain.current.catch(() => null);
    return pending.then(() => ({ ...snapshot, id: draftId.current }));
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!ready()) return;
    queueSend(handOver(), { onDelivered, onUndone });
    onSent(body, [...to, ...cc]);
  }

  function sendLater() {
    if (!ready()) return;
    const now = Date.now();
    pickLater({
      title: "Send later",
      description: "Orbit keeps the draft in Outlook and sends it at this time.",
      options: laterOptions(now),
      now,
      onPick: (at, detail) => {
        scheduleSend(handOver(), at, detail);
        onClose();
      },
    });
  }

  async function unschedule() {
    const current = draftId.current;
    if (!current) return;
    setScheduledFor(null);
    await fetch(`/api/mail/drafts/schedule?id=${encodeURIComponent(current)}`, { method: "DELETE" }).catch(() => null);
  }

  async function discard() {
    dirty.current = false;
    await chain.current.catch(() => null);
    const current = draftId.current;
    draftId.current = null;
    onClose();
    if (current) await fetch(`/api/mail/drafts?id=${encodeURIComponent(current)}`, { method: "DELETE" }).catch(() => null);
  }

  async function writeAi() {
    if (aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await writeWithAi({ mode: start.mode, messageId: start.messageId, to: [...to, ...cc], subject, instruction: aiText, current: body });
      setAiUndo(body);
      change(setBody)(result.body);
      setAiOpen(false);
      setAiText("");
      window.setTimeout(() => textarea.current?.focus(), 0);
    } catch (problem) {
      setAiError(problem instanceof Error ? problem.message : "The AI didn't answer. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  function openAi() {
    setAiOpen(true);
    setAiError(null);
    window.setTimeout(() => aiInput.current?.focus(), 0);
  }

  const status = save.kind === "saving" ? "Saving to Outlook…" : save.kind === "saved" ? "Saved in Outlook" : save.kind === "error" ? save.message : "";

  return (
    <form
      onSubmit={send}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
          event.preventDefault();
          openAi();
        }
      }}
      aria-label={MODE_LABEL[start.mode]}
      className={cn(
        "flex min-h-0 flex-col gap-1",
        card ? "flex-1 px-4 pt-1 pb-3" : "animate-rise-in rounded-2xl bg-white/[0.035] px-4 pt-3 pb-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]",
      )}
    >
      {!card && (
        <div className="flex items-center justify-between gap-3 pb-1">
          <span className="caption-style text-subtle">
            {MODE_LABEL[start.mode]} from {account?.email ?? "your mailbox"}
          </span>
          <span role="status" className={cn("caption-style", save.kind === "error" ? "text-danger" : "text-subtle")}>
            {status}
          </span>
        </div>
      )}
      {fromChoices.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-from`} className="text-subtle w-8 shrink-0 text-[13px]">
            From
          </label>
          <span className="relative flex min-w-0 items-center">
            <select
              id={`${id}-from`}
              value={fromId}
              onChange={(event) => change(setFromId)(event.target.value)}
              className="text-foreground h-7 min-w-0 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-0 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {fromChoices.map((item) => (
                <option key={item.id} value={item.id} className="bg-popover">
                  {item.email}
                </option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden className="text-subtle pointer-events-none absolute right-1 size-3" />
          </span>
        </div>
      )}
      <RecipientField
        label="To"
        value={to}
        onChange={change(setTo)}
        autoFocus={!draft && (start.mode === "forward" || (start.mode === "new" && start.to.length === 0))}
        trailing={
          !showCopies && (
            <button
              type="button"
              onClick={() => setShowCopies(true)}
              className="caption-style text-subtle hover:text-foreground shrink-0 cursor-pointer rounded-full px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Cc Bcc
            </button>
          )
        }
      />
      {showCopies && (
        <>
          <RecipientField label="Cc" value={cc} onChange={change(setCc)} />
          <RecipientField label="Bcc" value={bcc} onChange={change(setBcc)} />
        </>
      )}
      {showSubject && (
        <div className={cn("flex items-center gap-2", card && "mt-1")}>
          <label htmlFor={`${id}-subject`} className={cn("text-subtle w-8 shrink-0 text-[13px]", card && "sr-only")}>
            Subject
          </label>
          <input
            id={`${id}-subject`}
            value={subject}
            onChange={(event) => change(setSubject)(event.target.value)}
            placeholder="Subject"
            className={cn(
              "text-foreground placeholder:text-subtle h-8 min-w-0 flex-1 bg-transparent outline-none",
              card ? "text-[16px] font-medium" : "text-[14px]",
            )}
          />
        </div>
      )}
      {aiOpen && (
        <div className="animate-rise-in mt-2 flex flex-col gap-1.5 rounded-xl bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] px-3 py-2">
          <div className="flex items-center gap-2">
            <SparkleIcon aria-hidden className={cn("text-primary-foreground size-3.5 shrink-0", aiBusy && "animate-pulse")} />
            <label htmlFor={`${id}-ai`} className="sr-only">
              What should the email say?
            </label>
            <input
              ref={aiInput}
              id={`${id}-ai`}
              value={aiText}
              disabled={aiBusy}
              onChange={(event) => setAiText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void writeAi();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAiOpen(false);
                  textarea.current?.focus();
                }
              }}
              placeholder={body.trim() ? "How should it change? Or press Enter to polish it" : "What should it say? Or press Enter for a sensible reply"}
              className="text-foreground placeholder:text-subtle h-7 min-w-0 flex-1 bg-transparent text-[14px] outline-none disabled:opacity-60"
            />
            <Button variant="ghost" size="sm" onClick={() => void writeAi()} disabled={aiBusy}>
              {aiBusy ? "Writing…" : "Write"}
            </Button>
          </div>
          {aiError && (
            <p role="alert" className="caption-style text-danger">
              {aiError}
            </p>
          )}
        </div>
      )}
      {aiUndo !== null && !aiOpen && (
        <p className="caption-style text-subtle flex items-center gap-2 pt-2">
          <SparkleIcon aria-hidden className="size-3" />
          Written with AI. Check it before you send.
          <button
            type="button"
            onClick={() => {
              change(setBody)(aiUndo);
              setAiUndo(null);
            }}
            className="text-foreground cursor-pointer underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Undo
          </button>
        </p>
      )}
      <label htmlFor={`${id}-body`} className="sr-only">
        Message
      </label>
      <textarea
        ref={textarea}
        id={`${id}-body`}
        data-composer-body=""
        value={body}
        onChange={(event) => change(setBody)(event.target.value)}
        placeholder={start.mode === "forward" ? "Add a note" : start.mode === "new" ? "Write your email" : "Write your reply"}
        rows={card ? 8 : 4}
        className={cn(
          "text-foreground placeholder:text-subtle mt-2 min-h-24 w-full resize-none bg-transparent text-[14px] leading-6 outline-none",
          card && "flex-1",
        )}
      />
      {account?.signature && (
        <div className="flex items-start gap-3 pb-1">
          <p className={cn("caption-style min-w-0 flex-1 whitespace-pre-wrap", withSignature ? "text-subtle" : "text-faint line-through")}>
            {account.signature}
          </p>
          <button
            type="button"
            onClick={() => change(setWithSignature)(!withSignature)}
            className="caption-style text-subtle hover:text-foreground shrink-0 cursor-pointer rounded-full px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {withSignature ? "Remove signature" : "Add signature"}
          </button>
        </div>
      )}
      <AttachmentList items={attachments.items} onRemove={attachments.remove} />
      {scheduledFor && (
        <p className="caption-style text-soft flex items-center gap-2">
          <ClockIcon aria-hidden className="text-primary size-3.5" />
          Scheduled for {laterDetail(scheduledFor, Date.parse(draft?.savedAt || scheduledFor))}. Changes here go out with it.
          <button
            type="button"
            onClick={() => void unschedule()}
            className="text-foreground cursor-pointer underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Unschedule
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1 pt-2">
        <Button variant="primary" type="submit" data-shortcut-submit title={`Send (${sendHint})`}>
          {scheduledFor ? "Send now" : "Send"}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Send later" title="Send later" onClick={sendLater}>
          <ClockIcon aria-hidden className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size={remindHours ? "sm" : "icon"}
              aria-label={remindHours ? `Remind me if no reply in ${REMINDERS.find((item) => item.hours === remindHours)?.label}` : "Remind me if no reply"}
              title="Remind me if no reply"
              className={cn(remindHours && "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white")}
            >
              <BellIcon aria-hidden className="size-3.5" />
              {remindHours ? REMINDERS.find((item) => item.hours === remindHours)?.label : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Remind me if no reply in</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(remindHours ?? "")} onValueChange={(value) => setRemindHours(value ? Number(value) : null)}>
              {REMINDERS.map((item) => (
                <DropdownMenuRadioItem key={item.label} value={String(item.hours ?? "")}>
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <AttachButton id={`${id}-attach`} onFiles={(files) => void attachments.add(files)} compact />
        <Button variant="ghost" size="icon" aria-label="Write with AI" title={`Write with AI (${aiHint})`} onClick={openAi}>
          <SparkleIcon aria-hidden className="size-3.5" />
        </Button>
        {card && (
          <span role="status" className={cn("caption-style ml-2 min-w-0 truncate", save.kind === "error" ? "text-danger" : "text-subtle")}>
            {status}
          </span>
        )}
        <Button variant="ghost" size="icon" aria-label="Discard draft" title="Discard draft" onClick={() => void discard()} className="ml-auto">
          <TrashIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}
