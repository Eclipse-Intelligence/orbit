"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import BodyEditor, { type BodyEditorHandle } from "@/components/mail/body-editor";
import { useComposer } from "@/components/mail/compose-dock";
import { FollowUpBlock, NoReplyMenu, type NoReplyChoice, type NoReplyThen } from "@/components/mail/follow-up-composer";
import { writeWithAi } from "@/components/mail/mail-cache";
import RecipientField from "@/components/mail/recipient-field";
import { laterDetail, laterOptions } from "@/lib/mail/later";
import { useShortcutHint, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, DraftFile, DraftMode, MailDraft } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import BoldIcon from "@/public/assets/images/mail/bold.svg";
import ItalicIcon from "@/public/assets/images/mail/italic.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1500;
const FILE_LINK_ERROR = "That's a link to a file on your computer, which no one else can open. Drag the screenshot itself, or copy it and paste it here.";
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
  followUpDays: number | null;
  followUpBody: string | null;
  attachments: string[];
  files: DraftFile[];
  replaces?: string | null;
  identityId?: string | null;
};

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
  onScheduled,
}: {
  start: ComposerStart;
  accounts: ComposeAccount[];
  variant: "inline" | "card";
  onSent: (body: string, to: MailAddress[]) => void;
  onClose: () => void;
  onSubject?: (subject: string) => void;
  onDelivered?: () => void;
  onUndone?: () => void;
  onScheduled?: () => void;
}) {
  const { queueSend, scheduleSend, pickLater } = useComposer();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUndo, setAiUndo] = useState<string | null>(null);
  const aiInput = useRef<HTMLInputElement>(null);
  const aiHint = useShortcutHint("mail-ai-write");
  const id = useId();
  const sendHint = useShortcutHint("submit");
  const { mac } = useShortcuts();
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
  const [noReply, setNoReply] = useState<NoReplyChoice>({ remindHours: draft?.remindHours ?? null, followUpDays: draft?.followUpDays ?? null });
  const [noReplyThen, setNoReplyThen] = useState<NoReplyThen>(draft?.followUpDays ? "send" : "remind");
  const [followUpBody, setFollowUpBody] = useState(draft?.followUpBody ?? "");
  const [withSignature, setWithSignature] = useState(true);
  const [save, setSave] = useState<SaveState>(draft?.savedAt ? { kind: "saved" } : { kind: "idle" });
  const [scheduledFor, setScheduledFor] = useState(draft?.sendAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const attachments = useEmailAttachments(draft?.attachments);
  const fileKey = attachments.ids.join(",");
  const savedFiles = useRef(fileKey);
  const draftId = useRef<string | null>(draft?.id || null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = useRef(false);
  const editor = useRef<BodyEditorHandle>(null);
  const [formats, setFormats] = useState({ bold: false, italic: false });
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
    attachments: attachments.ids,
    remindHours: noReply.remindHours,
    followUpDays: noReply.followUpDays,
    followUpBody: noReply.followUpDays ? followUpBody : null,
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
      attachments: attachments.ids,
      remindHours: noReply.remindHours,
      followUpDays: noReply.followUpDays,
      followUpBody: noReply.followUpDays ? followUpBody : null,
    };
  });

  useEffect(() => {
    if (savedFiles.current === fileKey) return;
    savedFiles.current = fileKey;
    dirty.current = true;
  }, [fileKey]);

  useEffect(() => {
    onSubject?.(subject);
  }, [subject, onSubject]);

  useEffect(() => {
    if (!card) editor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const recipientsFirst = !draft && (start.mode === "forward" || (start.mode === "new" && start.to.length === 0));
    if (!recipientsFirst) editor.current?.focus();
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
  }, [fromId, to, cc, bcc, subject, body, withSignature, fileKey, noReply, followUpBody]);

  useEffect(
    () => () => {
      if (!dirty.current) return;
      const snapshot = { ...payload.current, id: draftId.current };
      if (!draftId.current && !snapshot.body.trim() && !snapshot.subject.trim()) return;
      void postJson("/api/mail/drafts", snapshot, true).catch(() => null);
    },
    [],
  );

  function takeFiles(files: File[]) {
    const taken = attachments.items.map((item) => item.name);
    const images: string[] = [];
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    const named = files.map((file, index) => {
      const base = file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `Pasted image ${stamp}${files.length > 1 ? ` ${index + 1}` : ""}.${file.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
      let name = base;
      for (let copy = 2; taken.includes(name); copy += 1) name = base.replace(/(\.[^.]+)?$/, ` (${copy})$1`);
      taken.push(name);
      if (file.type.startsWith("image/")) images.push(name);
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
    });
    void attachments.add(named);
    if (images.length === 0) return;
    editor.current?.insertBlock(images.map((name) => `[Image: ${name}]`).join("\n"));
  }

  function dropFiles(event: DragEvent) {
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      event.preventDefault();
      setError(null);
      takeFiles(files);
      return;
    }
    if (/^file:/i.test(event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"))) {
      event.preventDefault();
      setError(FILE_LINK_ERROR);
    }
  }

  function editorFiles(files: File[]) {
    setError(null);
    takeFiles(files);
  }

  function fileLinkDropped() {
    setError(FILE_LINK_ERROR);
  }

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
    const snapshot = { ...payload.current, attachments: attachments.ids, files: attachments.files };
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
        onScheduled?.();
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
      window.setTimeout(() => editor.current?.focus(), 0);
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
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("text/uri-list")) event.preventDefault();
      }}
      onDrop={dropFiles}
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
          <label htmlFor={`${id}-subject`} className={cn("text-subtle min-w-8 shrink-0 text-[13px]", card && "sr-only")}>
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
                  editor.current?.focus();
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
      <BodyEditor
        ref={editor}
        value={body}
        onChange={change(setBody)}
        onFiles={editorFiles}
        onFileLink={fileLinkDropped}
        onFormats={(next) => setFormats((current) => (current.bold === next.bold && current.italic === next.italic ? current : next))}
        label="Message"
        placeholder={start.mode === "forward" ? "Add a note" : start.mode === "new" ? "Write your email" : "Write your reply"}
        fill={card}
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
      {noReply.followUpDays && (
        <FollowUpBlock
          days={noReply.followUpDays}
          body={followUpBody}
          onBody={change(setFollowUpBody)}
          onRemove={() => {
            dirty.current = true;
            setNoReply({ remindHours: null, followUpDays: null });
            setFollowUpBody("");
          }}
        />
      )}
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
        <NoReplyMenu
          choice={noReply}
          then={noReplyThen}
          onChange={(choice, then) => {
            dirty.current = true;
            setNoReply(choice);
            setNoReplyThen(then);
          }}
        />
        <AttachButton id={`${id}-attach`} onFiles={(files) => void attachments.add(files)} compact />
        <Button variant="ghost" size="icon" aria-label="Write with AI" title={`Write with AI (${aiHint})`} onClick={openAi}>
          <SparkleIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Bold"
          aria-pressed={formats.bold}
          className={cn(formats.bold && "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white")}
          title={`Bold (${mac ? "⌘B" : "Ctrl+B"})`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => editor.current?.toggle("**")}
        >
          <BoldIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Italic"
          aria-pressed={formats.italic}
          className={cn(formats.italic && "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white")}
          title={`Italic (${mac ? "⌘I" : "Ctrl+I"})`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => editor.current?.toggle("*")}
        >
          <ItalicIcon aria-hidden className="size-3.5" />
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
