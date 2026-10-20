"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MessageAttachments from "@/components/mail/message-attachments";
import ReadStatus from "@/components/mail/read-status";
import { useComposer } from "@/components/mail/compose-dock";
import { loadSummary, type ThreadSummaryText } from "@/components/mail/mail-cache";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import MailComposer, { type ComposerStart } from "@/components/mail/mail-composer";
import Button from "@/components/_ui/button";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import EmailFrame from "@/components/mail/email-frame";
import { useShortcut, useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { mailFullWhen, personName, recipientList, stripQuoted } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import {
  MAIL_SPLITS,
  replyDefaults,
  SPLIT_LABELS,
  type ComposeAccount,
  type DraftMode,
  type MailSplit,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSummary,
} from "@/lib/mail/view";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import ForwardIcon from "@/public/assets/images/mail/forward.svg";
import ReplyAllIcon from "@/public/assets/images/mail/reply-all.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

export type ReaderAction = "archive" | "trash" | "inbox" | "read" | "unread" | "flag" | "unflag" | "snooze";

function ToolButton({
  label,
  hint,
  onClick,
  active,
  children,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      title={hint ? `${label} (${hint})` : label}
      onClick={onClick}
      className={cn(active && "text-warning hover:text-warning")}
    >
      {children}
    </Button>
  );
}

function MessageBody({ message, title, swipe }: { message: ThreadMessage; title: string; swipe: () => SwipeHandlers }) {
  if (message.html) return <EmailFrame html={message.html} rich={message.rich} title={title} swipe={swipe} />;
  if (message.text) return <p className="text-foreground whitespace-pre-wrap">{message.text}</p>;
  return <p className="text-subtle">{message.snippet || "This email has no text."}</p>;
}

function Message({
  message,
  own,
  expanded,
  onToggle,
  swipe,
  onEditDraft,
  onDeleteDraft,
}: {
  onEditDraft: (message: ThreadMessage) => void;
  onDeleteDraft: (message: ThreadMessage) => void;
  message: ThreadMessage;
  own: string[];
  expanded: boolean;
  onToggle: () => void;
  swipe: () => SwipeHandlers;
}) {
  const sender = personName(message.from);
  const to = recipientList(message.to, own);
  const cc = recipientList(message.cc, own);
  return (
    <article className={cn("ease-power3-out rounded-2xl transition-colors duration-150", expanded ? "bg-white/[0.025]" : "hover:bg-white/[0.025]")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Monogram name={sender} className="mt-0.5 size-7 rounded-full text-[11px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("truncate text-[14px]", message.isRead ? "text-foreground" : "text-foreground font-medium")}>
              {sender}
            </span>
            {expanded && message.from && message.from.address !== sender && (
              <span className="text-subtle hidden min-w-0 truncate text-[12px] sm:inline">{message.from.address}</span>
            )}
            {message.isDraft && <span className="text-danger shrink-0 text-[12px]">Draft</span>}
            <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{mailFullWhen(message.at)}</span>
          </span>
          {expanded ? (
            <span className="text-subtle truncate text-[12px]">
              {to ? `To ${to}` : "No recipients"}
              {cc ? ` · Cc ${cc}` : ""}
            </span>
          ) : (
            <span className="text-subtle truncate text-[13px]">{message.snippet}</span>
          )}
        </span>
      </button>
      {message.isDraft && (
        <div className="-mt-1 flex flex-wrap items-center gap-2 px-4 pb-3 sm:pl-14">
          <span className="caption-style text-subtle mr-1">Draft made outside Orbit.</span>
          <Button variant="secondary" size="sm" onClick={() => onEditDraft(message)}>
            Edit in Orbit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDeleteDraft(message)}>
            Delete draft
          </Button>
        </div>
      )}
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          <MessageBody message={message} title={`Email from ${sender}`} swipe={swipe} />
          {message.hasAttachments && <MessageAttachments messageId={message.id} />}
        </div>
      )}
    </article>
  );
}

function SummaryLine({ threadKey, latestId, messages }: { threadKey: string; latestId: string; messages: number }) {
  const id = `${threadKey}|${latestId}`;
  const [state, setState] = useState<{ id: string; data: ThreadSummaryText | null; failed: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    loadSummary(threadKey, latestId)
      .then((data) => live && setState({ id, data, failed: false }))
      .catch(() => live && setState({ id, data: null, failed: true }));
    return () => {
      live = false;
    };
  }, [id, threadKey, latestId]);

  const current = state?.id === id ? state : null;
  if (!current) {
    if (messages < 2) return null;
    return (
      <div aria-label="Summarising" className="mx-4 flex items-center gap-2.5 rounded-xl bg-white/[0.025] px-3 py-3">
        <SparkleIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0 animate-pulse" />
        <span className="h-2.5 w-2/3 animate-pulse rounded-full bg-white/[0.06]" />
      </div>
    );
  }
  if (current.failed || !current.data?.summary) return null;
  return (
    <div className="animate-rise-in mx-4 flex items-start gap-2.5 rounded-xl bg-white/[0.025] px-3 py-2.5">
      <SparkleIcon aria-hidden className="text-primary-foreground mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1 text-[13px] leading-5">
        <p className="text-soft">{current.data.summary}</p>
        {current.data.todo && (
          <p className="text-foreground">
            <span className="text-subtle">Next: </span>
            {current.data.todo}
          </p>
        )}
      </div>
    </div>
  );
}

function Thread({
  detail,
  own,
  swipe,
  onEditDraft,
  onDeleteDraft,
}: {
  detail: ThreadDetail;
  own: string[];
  swipe: () => SwipeHandlers;
  onEditDraft: (message: ThreadMessage) => void;
  onDeleteDraft: (message: ThreadMessage) => void;
}) {
  const last = detail.messages.length - 1;
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(detail.messages.filter((message, index) => index === last || !message.isRead).map((message) => message.id)),
  );
  const [showAll, setShowAll] = useState(detail.messages.length <= 4);
  const hidden = showAll ? 0 : detail.messages.length - 3;
  const visible = showAll ? detail.messages : [detail.messages[0], ...detail.messages.slice(-2)];

  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((message, index) => (
        <div key={message.id} className="flex flex-col gap-1.5">
          <Message
            message={message}
            own={own}
            swipe={swipe}
            onEditDraft={onEditDraft}
            onDeleteDraft={onDeleteDraft}
            expanded={open.has(message.id)}
            onToggle={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(message.id)) next.delete(message.id);
                else next.add(message.id);
                return next;
              })
            }
          />
          {!showAll && index === 0 && hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="caption-style text-subtle hover:text-foreground mx-4 cursor-pointer self-start rounded-full px-2 py-1 outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {hidden} more {hidden === 1 ? "email" : "emails"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const REPLIES: { mode: Exclude<DraftMode, "new">; label: string; shortcut: string; icon: typeof ReplyIcon }[] = [
  { mode: "reply", label: "Reply", shortcut: "mail-reply", icon: ReplyIcon },
  { mode: "reply_all", label: "Reply all", shortcut: "mail-reply-all", icon: ReplyAllIcon },
  { mode: "forward", label: "Forward", shortcut: "mail-forward", icon: ForwardIcon },
];

type Echo = { body: string; to: MailAddress[]; count: number };

export default function ThreadReader({
  summary,
  detail,
  error,
  own,
  view,
  accounts,
  onAction,
  onBack,
  onSent,
  onNext,
  onSplit,
}: {
  onSplit: (sender: string, split: MailSplit) => void;
  summary: ThreadSummary | null;
  detail: ThreadDetail | null;
  error: string | null;
  own: string[];
  view: string;
  accounts: ComposeAccount[];
  onAction: (action: ReaderAction) => void;
  onBack: () => void;
  onSent: () => void;
  onNext: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const swipeHandlers = useRef<SwipeHandlers>({});
  const swipe = useCallback(() => swipeHandlers.current, []);
  const [composer, setComposer] = useState<ComposerStart | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [removedDrafts, setRemovedDrafts] = useState<Set<string>>(() => new Set());
  const [draftError, setDraftError] = useState<string | null>(null);
  const replyHint = useShortcutHint("mail-reply");
  const replyAllHint = useShortcutHint("mail-reply-all");
  const forwardHint = useShortcutHint("mail-forward");
  const hints: Record<Exclude<DraftMode, "new">, string> = { reply: replyHint, reply_all: replyAllHint, forward: forwardHint };
  const target = detail?.messages.filter((message) => !message.isDraft).at(-1) ?? null;
  const { openComposer } = useComposer();
  const sourceId = detail?.key.split("|")[0] ?? "";
  const newDraft = detail?.drafts.find((draft) => draft.mode === "new") ?? null;
  const restored = !dismissed ? (detail?.drafts.find((draft) => draft.mode !== "new") ?? null) : null;
  const active: ComposerStart | null =
    composer ??
    (restored && target
      ? {
          mode: restored.mode,
          messageId: restored.messageId ?? target.id,
          sourceId: restored.sourceId,
          to: restored.to,
          cc: restored.cc,
          subject: restored.subject,
          draft: restored,
        }
      : null);

  function startReply(mode: Exclude<DraftMode, "new">) {
    if (!detail || !target) return false;
    if (active) {
      document.querySelector<HTMLTextAreaElement>("[data-reader-composer] textarea")?.focus();
      return;
    }
    const defaults = replyDefaults(mode, target, detail.subject, own);
    setComposer({ mode, messageId: target.id, sourceId, to: defaults.to, cc: defaults.cc, subject: defaults.subject, draft: null });
  }

  function editOutsideDraft(message: ThreadMessage) {
    if (!detail || !target) return;
    const mode: DraftMode = message.to.length + message.cc.length > 1 ? "reply_all" : "reply";
    const subject = detail.subject ?? "";
    const body = stripQuoted(message.text ?? message.snippet ?? "").replace(/\s*[\u2013\u2014]\s*/g, ", ");
    setRemovedDrafts((existing) => new Set(existing).add(message.id));
    setComposer({
      mode,
      messageId: target.id,
      sourceId,
      to: message.to,
      cc: message.cc,
      subject,
      replaces: message.id,
      draft: { id: "", sourceId, mode, messageId: target.id, to: message.to, cc: message.cc, bcc: [], subject, body, savedAt: "", sendAt: null, sendError: null },
    });
  }

  async function deleteOutsideDraft(message: ThreadMessage) {
    setDraftError(null);
    setRemovedDrafts((existing) => new Set(existing).add(message.id));
    const response = await fetch(`/api/mail/draft-message?id=${encodeURIComponent(message.id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
      setRemovedDrafts((existing) => {
        const next = new Set(existing);
        next.delete(message.id);
        return next;
      });
      setDraftError(body?.error ?? "Outlook didn't delete the draft. Try again.");
    }
  }

  function closeComposer() {
    setComposer(null);
    setDismissed(true);
  }

  useEffect(() => {
    swipeHandlers.current = window.matchMedia("(min-width: 64rem)").matches ? {} : { onLeft: onNext, onRight: onBack };
  });

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    return watchSwipe(element, swipe);
  }, [swipe]);

  useShortcut("mail-reply", () => startReply("reply"), Boolean(detail));
  useShortcut("mail-reply-all", () => startReply("reply_all"), Boolean(detail));
  useShortcut("mail-forward", () => startReply("forward"), Boolean(detail));

  const archiveHint = useShortcutHint("mail-archive");
  const trashHint = useShortcutHint("mail-trash");
  const readHint = useShortcutHint("mail-read");
  const flagHint = useShortcutHint("mail-flag");
  const snoozeHint = useShortcutHint("mail-snooze");

  if (!summary && !detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-soft">Nothing open.</p>
        <p className="caption-style text-subtle">Press J or K to move through your mail, or pick a conversation.</p>
      </div>
    );
  }

  const subject = detail?.subject ?? summary?.subject;
  const account = detail?.account ?? summary?.account ?? "";
  const unread = summary ? summary.unread : Boolean(detail?.messages.some((message) => !message.isRead));
  const flagged = summary ? summary.flagged : Boolean(detail?.messages.some((message) => message.isFlagged));
  const restorable = view === "archive" || view === "trash" || view === "snoozed";
  const ownSet = new Set(own.map((item) => item.toLowerCase()));
  const tracked = detail?.messages.filter((message) => message.opens !== null).at(-1) ?? null;
  const sender =
    detail?.messages.filter((message) => message.from && !ownSet.has(message.from.address.toLowerCase())).at(-1)?.from?.address ??
    (summary?.from && !ownSet.has(summary.from.address.toLowerCase()) ? summary.from.address : null);

  return (
    <div ref={surface} className="flex min-h-0 flex-1 touch-pan-y flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to the list" title="Back (Esc)" data-shortcut="back" onClick={onBack} className="lg:hidden">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        {restorable ? (
          <ToolButton label="Move to Inbox" onClick={() => onAction("inbox")}>
            <InboxIcon aria-hidden className="size-3.5" />
          </ToolButton>
        ) : (
          <ToolButton label="Archive" hint={archiveHint} onClick={() => onAction("archive")}>
            <ArchiveIcon aria-hidden className="size-3.5" />
          </ToolButton>
        )}
        {view !== "snoozed" && (
          <ToolButton label="Remind me" hint={snoozeHint} onClick={() => onAction("snooze")}>
            <ClockIcon aria-hidden className="size-3.5" />
          </ToolButton>
        )}
        {view !== "trash" && (
          <ToolButton label="Move to Trash" hint={trashHint} onClick={() => onAction("trash")}>
            <TrashIcon aria-hidden className="size-3.5" />
          </ToolButton>
        )}
        <ToolButton label={unread ? "Mark read" : "Mark unread"} hint={readHint} onClick={() => onAction(unread ? "read" : "unread")}>
          <MailOpenIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label={flagged ? "Remove flag" : "Flag"} hint={flagHint} active={flagged} onClick={() => onAction(flagged ? "unflag" : "flag")}>
          <FlagIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {summary?.split && sender && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Split: ${SPLIT_LABELS[summary.split]}. Change where this sender goes`} title="Change where this sender's email goes">
                  {SPLIT_LABELS[summary.split]}
                  <ChevronDownIcon aria-hidden className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[17rem]">
                <DropdownMenuLabel>Always put email from {sender} in</DropdownMenuLabel>
                {MAIL_SPLITS.map((split) => (
                  <DropdownMenuItem key={split} onSelect={() => onSplit(sender, split)}>
                    <span className="flex-1">{SPLIT_LABELS[split]}</span>
                    {split === summary.split && <span className="text-subtle">Now</span>}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuLabel>Everyone at @{sender.split("@")[1]}</DropdownMenuLabel>
                {MAIL_SPLITS.map((split) => (
                  <DropdownMenuItem key={`domain-${split}`} onSelect={() => onSplit(`@${sender.split("@")[1]}`, split)}>
                    {SPLIT_LABELS[split]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(account) }} />
          <span className="caption-style text-subtle truncate">{account}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
        <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-32 sm:px-6">
          <h2 className="px-4 text-pretty">{subject?.trim() || "(no subject)"}</h2>
          {detail && target && <SummaryLine threadKey={detail.key} latestId={target.id} messages={detail.messages.length} />}
          {detail ? (
            <>
              <Thread
                key={detail.key + detail.messages.length}
                detail={{ ...detail, messages: detail.messages.filter((message) => !removedDrafts.has(message.id)) }}
                own={own}
                swipe={swipe}
                onEditDraft={editOutsideDraft}
                onDeleteDraft={(message) => void deleteOutsideDraft(message)}
              />
              {draftError && (
                <p role="alert" className="text-danger px-4 text-[13px]">
                  {draftError}
                </p>
              )}
              {echo && echo.count === detail.messages.length && (
                <article aria-label="Sent just now" className="flex items-start gap-3 rounded-2xl bg-white/[0.025] px-4 py-3">
                  <Monogram name="Me" className="mt-0.5 size-7 rounded-full text-[11px]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-foreground text-[14px]">You</span>
                      <span className="text-subtle ml-auto text-[12px]">Sent just now</span>
                    </span>
                    <span className="text-subtle truncate text-[12px]">To {recipientList(echo.to, own)}</span>
                    <span className="text-foreground mt-1 text-[14px] whitespace-pre-wrap">{echo.body}</span>
                  </span>
                </article>
              )}
              {active && target ? (
                <div data-reader-composer="">
                <MailComposer
                  key={active.draft?.id ?? active.mode}
                  start={active}
                  variant="inline"
                  accounts={accounts}
                  onClose={closeComposer}
                  onSent={(body, to) => {
                    setEcho({ body, to, count: detail.messages.length });
                    closeComposer();
                  }}
                  onDelivered={onSent}
                  onUndone={() => setEcho(null)}
                />
                </div>
              ) : !target && newDraft ? (
                <div className="flex flex-col items-start gap-3 px-4">
                  <p className="text-subtle">This is a new email you haven&apos;t sent yet.</p>
                  <Button variant="primary" onClick={() => openComposer({ draft: newDraft })}>
                    Continue writing
                  </Button>
                </div>
              ) : (
                target && (
                  <div className="flex flex-wrap items-center gap-2 px-4">
                    {tracked && (
                      <span className="order-last ml-auto">
                        <ReadStatus opens={tracked.opens!} recipients={[...tracked.to, ...tracked.cc]} />
                      </span>
                    )}
                    {REPLIES.map((reply) => (
                      <Button key={reply.mode} variant="secondary" onClick={() => startReply(reply.mode)} title={`${reply.label} (${hints[reply.mode]})`}>
                        <reply.icon aria-hidden className="size-3.5" />
                        {reply.label}
                      </Button>
                    ))}
                  </div>
                )
              )}
            </>
          ) : error ? (
            <p role="alert" className="text-danger px-4">
              {error}
            </p>
          ) : (
            <div aria-label="Loading the conversation" className="flex flex-col gap-3 px-4">
              <span className="bg-white/[0.05] h-3 w-1/4 animate-pulse rounded-full" />
              <span className="bg-white/[0.035] h-24 w-full animate-pulse rounded-2xl" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
