"use client";

import { useState } from "react";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import EmailFrame from "@/components/mail/email-frame";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { mailFullWhen, personName, recipientList } from "@/lib/mail/format";
import type { ThreadDetail, ThreadMessage, ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
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

function MessageBody({ message, title }: { message: ThreadMessage; title: string }) {
  if (message.html) return <EmailFrame html={message.html} rich={message.rich} title={title} />;
  if (message.text) return <p className="text-foreground whitespace-pre-wrap">{message.text}</p>;
  return <p className="text-subtle">{message.snippet || "This email has no text."}</p>;
}

function Message({
  message,
  own,
  expanded,
  onToggle,
}: {
  message: ThreadMessage;
  own: string[];
  expanded: boolean;
  onToggle: () => void;
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
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          <MessageBody message={message} title={`Email from ${sender}`} />
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

function Thread({ detail, own }: { detail: ThreadDetail; own: string[] }) {
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

export default function ThreadReader({
  summary,
  detail,
  error,
  own,
  view,
  onAction,
  onBack,
}: {
  summary: ThreadSummary | null;
  detail: ThreadDetail | null;
  error: string | null;
  own: string[];
  view: string;
  onAction: (action: ReaderAction) => void;
  onBack: () => void;
}) {
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
    <div className="flex min-h-0 flex-1 flex-col">
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-16 sm:px-6">
          <h2 className="px-4 text-pretty">{subject?.trim() || "(no subject)"}</h2>
          {detail ? (
            <Thread key={detail.key + detail.messages.length} detail={detail} own={own} />
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
