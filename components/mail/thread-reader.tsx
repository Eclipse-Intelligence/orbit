"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReadStatus from "@/components/mail/read-status";
import { useComposer } from "@/components/mail/compose-dock";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import MailComposer, { type ComposerStart } from "@/components/mail/mail-composer";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import EmailFrame from "@/components/mail/email-frame";
import { useShortcut, useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { mailFullWhen, personName, recipientList } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import { replyDefaults, type ComposeAccount, type DraftMode, type ThreadDetail, type ThreadMessage, type ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import ForwardIcon from "@/public/assets/images/mail/forward.svg";
import ReplyAllIcon from "@/public/assets/images/mail/reply-all.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

export type ReaderAction = "archive" | "trash" | "inbox" | "read" | "unread" | "flag" | "unflag";

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
}: {
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
      {message.opens && (
        <div className="-mt-1 px-4 pb-2 sm:pl-14">
          <ReadStatus opens={message.opens} recipients={[...message.to, ...message.cc]} />
        </div>
      )}
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          <MessageBody message={message} title={`Email from ${sender}`} swipe={swipe} />
          {message.hasAttachments && (
            <p className="caption-style text-subtle flex items-center gap-1.5">
              <PaperclipIcon aria-hidden className="size-3" />
              Has attachments.
              {message.webLink && (
                <a href={message.webLink} target="_blank" rel="noreferrer" className="text-soft hover:text-foreground underline underline-offset-2">
                  Open in Outlook
                </a>
              )}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function Thread({ detail, own, swipe }: { detail: ThreadDetail; own: string[]; swipe: () => SwipeHandlers }) {
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
}: {
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
  const restorable = view === "archive" || view === "trash";
  const latestLink = detail?.messages.findLast((message) => message.webLink)?.webLink ?? null;

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
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(account) }} />
          <span className="caption-style text-subtle truncate">{account}</span>
          {latestLink && (
            <a href={latestLink} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "hidden sm:inline-flex")}>
              Open in Outlook
            </a>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
        <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-32 sm:px-6">
          <h2 className="px-4 text-pretty">{subject?.trim() || "(no subject)"}</h2>
          {detail ? (
            <>
              <Thread key={detail.key + detail.messages.length} detail={detail} own={own} swipe={swipe} />
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
                    onSent();
                  }}
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
