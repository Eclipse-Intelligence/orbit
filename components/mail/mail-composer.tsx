"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import RecipientField from "@/components/mail/recipient-field";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, DraftMode, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1500;
export const MODE_LABEL: Record<DraftMode, string> = { new: "New email", reply: "Reply", reply_all: "Reply all", forward: "Forward" };

export type ComposerStart = {
  mode: DraftMode;
  messageId: string | null;
  sourceId: string;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  draft: MailDraft | null;
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
}: {
  start: ComposerStart;
  accounts: ComposeAccount[];
  variant: "inline" | "card";
  onSent: (body: string, to: MailAddress[]) => void;
  onClose: () => void;
  onSubject?: (subject: string) => void;
}) {
  const id = useId();
  const sendHint = useShortcutHint("submit");
  const draft = start.draft;
  const [sourceId, setSourceId] = useState(draft?.sourceId ?? start.sourceId);
  const [to, setTo] = useState<MailAddress[]>(draft?.to ?? start.to);
  const [cc, setCc] = useState<MailAddress[]>(draft?.cc ?? start.cc);
  const [bcc, setBcc] = useState<MailAddress[]>(draft?.bcc ?? []);
  const [showCopies, setShowCopies] = useState(Boolean(draft?.cc.length || draft?.bcc.length || start.cc.length));
  const [subject, setSubject] = useState(draft?.subject || start.subject);
  const [body, setBody] = useState(draft?.body ?? "");
  const [withSignature, setWithSignature] = useState(true);
  const [save, setSave] = useState<SaveState>(draft ? { kind: "saved" } : { kind: "idle" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useEmailAttachments();
  const draftId = useRef<string | null>(draft?.id ?? null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const payload = useRef({ mode: start.mode, messageId: start.messageId, sourceId, to, cc, bcc, subject, body, signature: withSignature });
  const account = accounts.find((item) => item.id === sourceId) ?? null;
  const showSubject = start.mode === "new" || start.mode === "forward";
  const card = variant === "card";

  useEffect(() => {
    payload.current = { mode: start.mode, messageId: start.messageId, sourceId, to, cc, bcc, subject, body, signature: withSignature };
  });

  useEffect(() => {
    onSubject?.(subject);
  }, [subject, onSubject]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
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
  }, [sourceId, to, cc, bcc, subject, body, withSignature]);

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

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (sending) return;
    if (attachments.uploading) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    if (to.length + cc.length + bcc.length === 0) {
      setError("Add at least one person to send to.");
      return;
    }
    if (start.mode === "new" && !subject.trim()) {
      setError("Add a subject.");
      return;
    }
    setSending(true);
    setError(null);
    await chain.current.catch(() => null);
    dirty.current = false;
    try {
      const result = await postJson<{ warning: string | null }>("/api/mail/drafts/send", {
        ...payload.current,
        id: draftId.current,
        attachments: attachments.ids,
      });
      attachments.clear();
      draftId.current = null;
      onSent(body, [...to, ...cc]);
      if (result.warning) setError(result.warning);
    } catch (problem) {
      dirty.current = true;
      setSending(false);
      setError(problem instanceof Error ? problem.message : "The email didn't send. Try again.");
    }
  }

  async function discard() {
    dirty.current = false;
    await chain.current.catch(() => null);
    const current = draftId.current;
    draftId.current = null;
    onClose();
    if (current) await fetch(`/api/mail/drafts?id=${encodeURIComponent(current)}`, { method: "DELETE" }).catch(() => null);
  }

  const status = save.kind === "saving" ? "Saving to Outlook…" : save.kind === "saved" ? "Saved in Outlook" : save.kind === "error" ? save.message : "";

  return (
    <form
      onSubmit={send}
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
      {card && accounts.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-from`} className="text-subtle w-8 shrink-0 text-[13px]">
            From
          </label>
          <span className="relative flex min-w-0 items-center">
            <select
              id={`${id}-from`}
              value={sourceId}
              onChange={(event) => change(setSourceId)(event.target.value)}
              className="text-foreground h-7 min-w-0 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-0 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {accounts.map((item) => (
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
        className="text-foreground placeholder:text-subtle mt-2 min-h-24 w-full resize-none bg-transparent text-[14px] leading-6 outline-none"
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
      <AttachmentList items={attachments.items} onRemove={attachments.remove} disabled={sending} />
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1 pt-2">
        <Button variant="primary" type="submit" disabled={sending} data-shortcut-submit title={`Send (${sendHint})`}>
          {sending ? "Sending…" : "Send"}
        </Button>
        <AttachButton id={`${id}-attach`} onFiles={(files) => void attachments.add(files)} disabled={sending} />
        {card && (
          <span role="status" className={cn("caption-style ml-2 min-w-0 truncate", save.kind === "error" ? "text-danger" : "text-subtle")}>
            {status}
          </span>
        )}
        <Button variant="ghost" size="icon" aria-label="Discard draft" title="Discard draft" onClick={() => void discard()} className="ml-auto" disabled={sending}>
          <TrashIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}
