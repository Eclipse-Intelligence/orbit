"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { FollowUpBanner, FollowUpCancelledNote } from "@/components/mail/follow-up-banner";
import DeferralNotice from "@/components/mail/deferral-notice";
import MessageAttachments from "@/components/mail/message-attachments";
import ReadStatus from "@/components/mail/read-status";
import ThreadPeople from "@/components/mail/thread-people";
import { cancelReminder, loadSummary, type ThreadSummaryText } from "@/components/mail/mail-cache";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import type { ComposerStart } from "@/components/mail/mail-composer";
import { ComposerLoading } from "@/components/mail/composer-loading";
import { useComposer } from "@/components/mail/compose-dock";
import Button from "@/components/_ui/button";
import type { InvitePrefill } from "@/components/crm/invite-dialog";
import type { InviteSetup } from "@/lib/crm/invites";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import EmailFrame, { QuoteToggle } from "@/components/mail/email-frame";
import { useShortcut, useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { mailFullWhen, mailShortWhen, personName, recipientList, snippetCore, stripQuoted } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import {
  MAIL_SPLITS,
  replyDefaults,
  SPLIT_LABELS,
  type ComposeAccount,
  type ComposeIntent,
  type DraftMode,
  type MailSplit,
  type PreparedReply,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSubscription,
  type ThreadSummary,
} from "@/lib/mail/view";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import ForwardIcon from "@/public/assets/images/mail/forward.svg";
import ReplyAllIcon from "@/public/assets/images/mail/reply-all.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";
import UnsubscribeIcon from "@/public/assets/images/mail/unsubscribe.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import type { UnsubscribeMode } from "@/components/mail/unsubscribe-dialog";

const MailComposer = dynamic(() => import("@/components/mail/mail-composer"), { ssr: false, loading: () => <ComposerLoading /> });
const InviteDialog = dynamic(() => import("@/components/crm/invite-dialog"), { ssr: false });

const UNDO_DELETE_MS = 8_000;
const DRAFT_DELETE_FAILED = "Couldn't discard the draft. Try again.";

async function sendDraftDelete(id: string, keepalive: boolean) {
  const response = await fetch(`/api/mail/draft-message?id=${encodeURIComponent(id)}`, { method: "DELETE", keepalive }).catch(() => null);
  if (response?.ok) return null;
  const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
  return body?.error ?? DRAFT_DELETE_FAILED;
}

function minuteNow() {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function watchMinute(notify: () => void) {
  const timer = window.setInterval(notify, 30_000);
  return () => window.clearInterval(timer);
}

function useMinute() {
  return useSyncExternalStore<number | null>(watchMinute, minuteNow, () => null);
}

function When({ at, className }: { at: string | null; className?: string }) {
  const now = useMinute();
  if (!at) return null;
  const full = mailFullWhen(at);
  const short = now === null ? new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : mailShortWhen(at, now);
  return (
    <time dateTime={at} title={full} className={className}>
      <span aria-hidden>{short}</span>
      <span className="sr-only">{full}</span>
    </time>
  );
}

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
      className={cn("pointer-coarse:size-11", active && "text-warning hover:text-warning")}
    >
      {children}
    </Button>
  );
}

function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-subtle max-sm:hidden @max-lg:hidden" />;
}

function MenuAction({
  icon: Icon,
  label,
  reason = null,
  onSelect,
}: {
  icon: typeof ArchiveIcon;
  label: string;
  reason?: string | null;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem disabled={Boolean(reason)} disabledReason={reason ?? undefined} onSelect={onSelect} className="pointer-coarse:py-2.5">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </DropdownMenuItem>
  );
}

function TextBody({ text, hideQuotes }: { text: string; hideQuotes: boolean }) {
  const [shown, setShown] = useState(false);
  const core = hideQuotes ? stripQuoted(text) : "";
  const quoted = Boolean(core) && core !== text.trim();
  return (
    <>
      <p className="text-foreground whitespace-pre-wrap">{quoted && !shown ? core : text}</p>
      {quoted && <QuoteToggle shown={shown} onToggle={() => setShown((open) => !open)} />}
    </>
  );
}

function MessageBody({
  message,
  title,
  swipe,
  hideQuotes,
}: {
  message: ThreadMessage;
  title: string;
  swipe: () => SwipeHandlers;
  hideQuotes: boolean;
}) {
  if (message.html) return <EmailFrame html={message.html} rich={message.rich} title={title} swipe={swipe} hideQuotes={hideQuotes} />;
  if (message.text) return <TextBody text={message.text} hideQuotes={hideQuotes} />;
  return <p className="text-subtle">{message.snippet || "This email has no text."}</p>;
}

function fullAddress(address: MailAddress) {
  const name = address.name?.trim();
  return name && name.toLowerCase() !== address.address.toLowerCase() ? `${name} <${address.address}>` : address.address;
}

function AddressDetails({ id, message }: { id: string; message: ThreadMessage }) {
  const rows: [string, MailAddress[]][] = [
    ["From", message.from ? [message.from] : []],
    ["To", message.to],
    ["Cc", message.cc],
  ];
  return (
    <dl id={id} className="animate-rise-in -mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 pb-3 text-[12px] leading-5 sm:pl-14">
      {rows
        .filter(([, addresses]) => addresses.length > 0)
        .map(([label, addresses]) => (
          <div key={label} className="contents">
            <dt className="text-subtle">{label}</dt>
            <dd className="text-soft flex min-w-0 flex-col select-text">
              {addresses.map((address) => (
                <span key={address.address} className="break-words">
                  {fullAddress(address)}
                </span>
              ))}
            </dd>
          </div>
        ))}
      {message.at && (
        <div className="contents">
          <dt className="text-subtle">Date</dt>
          <dd className="text-soft tabular-nums select-text">{mailFullWhen(message.at)}</dd>
        </div>
      )}
    </dl>
  );
}

function Message({
  message,
  companies,
  workspaceName,
  own,
  expanded,
  collapsible,
  hideQuotes,
  onToggle,
  swipe,
  onEditDraft,
  onDeleteDraft,
  footer,
}: {
  onEditDraft: (message: ThreadMessage) => void;
  onDeleteDraft: (message: ThreadMessage) => void;
  footer?: ReactNode;
  message: ThreadMessage;
  companies: { id: string; name: string }[];
  workspaceName: string;
  own: string[];
  expanded: boolean;
  collapsible: boolean;
  hideQuotes: boolean;
  onToggle: () => void;
  swipe: () => SwipeHandlers;
}) {
  const [details, setDetails] = useState(false);
  const detailsId = `addresses-${message.id}`;
  const headingId = `email-${message.id}`;
  const summaryId = `email-summary-${message.id}`;
  const showingDetails = expanded && details;
  const sender = personName(message.from);
  const to = recipientList(message.to, own);
  const cc = recipientList(message.cc, own);
  const draft = message.isDraft && message.folderRole === "drafts";
  const spoken = [
    message.from ? `From ${fullAddress(message.from)}.` : "",
    to ? `To ${to}.` : "No recipients.",
    cc ? `Cc ${cc}.` : "",
    message.at ? `${draft ? "Saved" : "Sent"} ${mailFullWhen(message.at)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article
      aria-labelledby={headingId}
      aria-describedby={summaryId}
      className={cn("ease-power3-out rounded-2xl transition-colors duration-150", expanded ? "bg-surface-panel" : "hover:bg-surface-hover")}
    >
      <h3 id={headingId} className="sr-only">
        {draft ? `Draft from ${sender}` : `Email from ${sender}`}
      </h3>
      <p id={summaryId} className="sr-only">
        {spoken}
      </p>
      <div className="flex items-start">
        <Button
          variant="item"
          size="none"
          onClick={expanded ? () => setDetails((open) => !open) : onToggle}
          aria-expanded={expanded ? details : false}
          aria-controls={showingDetails ? detailsId : undefined}
          aria-label={expanded ? `${details ? "Hide" : "Show"} the addresses on ${sender}'s email` : `Open ${sender}'s email`}
          className="min-w-0 flex-1 rounded-2xl px-4 py-3 leading-normal hover:bg-transparent"
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
              {draft && <span className="shrink-0 text-[12px] text-[var(--tag-amber-text)]">Draft</span>}
              <When at={message.at} className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums" />
            </span>
            {expanded ? (
              <span className="text-subtle flex min-w-0 items-center gap-1 text-[12px]">
                <span className="truncate">
                  {to ? `To ${to}` : "No recipients"}
                  {cc ? ` · Cc ${cc}` : ""}
                </span>
                <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 shrink-0 transition-transform duration-150", details && "rotate-180")} />
              </span>
            ) : (
              <span className="text-subtle truncate text-[13px]">{snippetCore(message.snippet)}</span>
            )}
          </span>
        </Button>
        {expanded && collapsible && (
          <Button variant="ghost" size="icon" aria-label={`Collapse ${sender}'s email`} title="Collapse" onClick={onToggle} className="mt-2 mr-2 shrink-0 pointer-coarse:mt-0.5 pointer-coarse:mr-0.5 pointer-coarse:size-11">
            <ChevronDownIcon aria-hidden className="size-4 rotate-180" />
          </Button>
        )}
      </div>
      {showingDetails && <AddressDetails id={detailsId} message={message} />}
      {draft && (
        <div className="-mt-1 flex flex-wrap items-center gap-2 px-4 pb-3 sm:pl-14">
          <Button variant="secondary" size="sm" onClick={() => onEditDraft(message)} className="pointer-coarse:h-11">
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDeleteDraft(message)} className="pointer-coarse:h-11">
            Discard
          </Button>
        </div>
      )}
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          <MessageBody message={message} title={`Email from ${sender}`} swipe={swipe} hideQuotes={hideQuotes} />
          {message.hasAttachments && <MessageAttachments messageId={message.id} companies={companies} workspaceName={workspaceName} />}
          {footer}
        </div>
      )}
      {!expanded && footer && <div className="px-4 pb-3 sm:pl-14">{footer}</div>}
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
      <div role="status" aria-busy="true" className="mx-4 flex flex-col gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5">
        <span aria-hidden className="text-subtle font-mono text-[10.5px] leading-4 tracking-[0.08em] uppercase">Summary</span>
        <span className="sr-only">Summarising the conversation</span>
        <span aria-hidden className="h-2.5 w-2/3 bg-surface-raised animate-pulse rounded-full" />
      </div>
    );
  }
  if (current.failed || !current.data?.summary) return null;
  return (
    <div className="animate-rise-in mx-4 flex flex-col gap-1.5 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-[13px] leading-5">
      <span className="text-subtle font-mono text-[10.5px] leading-4 tracking-[0.08em] uppercase">Summary</span>
      <p className="text-soft">{current.data.summary}</p>
      {current.data.todo && (
        <p className="text-foreground border-t border-dashed border-white/10 pt-1.5">
          <span className="text-subtle mr-1.5 font-mono text-[10.5px] tracking-[0.08em] uppercase">Next</span>
          {current.data.todo}
        </p>
      )}
    </div>
  );
}

function PreparedCard({ prepared, onUse, onDismiss }: { prepared: PreparedReply; onUse: () => void; onDismiss: () => void }) {
  return (
    <section
      aria-label={prepared.kind === "nudge" ? "Follow-up ready" : "Reply ready"}
      className="animate-rise-in bg-surface-panel mx-4 flex flex-col gap-2 rounded-2xl px-4 py-3"
    >
      <span className="text-subtle flex items-center gap-1.5 text-[12px]">
        <SparkleIcon aria-hidden className="text-primary-foreground size-3.5" />
        {prepared.kind === "nudge" ? "Follow-up ready" : "Reply ready"}
      </span>
      <p className={cn("text-soft text-[14px] leading-6 whitespace-pre-line", prepared.times ? "line-clamp-[14]" : "line-clamp-5")}>{prepared.body}</p>
      {prepared.times && (
        <span className="caption-style text-subtle">Times are free in your calendar.</span>
      )}
      <span className="mt-1 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onUse}>
          Edit and send
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
    </section>
  );
}

function Thread({
  detail,
  own,
  workspaceName,
  swipe,
  onEditDraft,
  onDeleteDraft,
  before,
}: {
  detail: ThreadDetail;
  own: string[];
  workspaceName: string;
  swipe: () => SwipeHandlers;
  onEditDraft: (message: ThreadMessage) => void;
  onDeleteDraft: (message: ThreadMessage) => void;
  before?: { id: string; node: ReactNode } | null;
}) {
  const last = detail.messages.length - 1;
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(detail.messages.filter((message, index) => index === last || !message.isRead).map((message) => message.id)),
  );
  const [showAll, setShowAll] = useState(detail.messages.length <= 4);
  const hidden = showAll ? 0 : detail.messages.length - 3;
  const companies = useMemo(() => {
    const seen = new Map<string, string>();
    for (const person of detail.people ?? []) if (person.companyId && person.companyName && !seen.has(person.companyId)) seen.set(person.companyId, person.companyName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [detail.people]);
  const visible = showAll ? detail.messages : [detail.messages[0], ...detail.messages.slice(-2)];

  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((message, index) => (
        <div key={message.id} className="flex flex-col gap-1.5">
          {before?.id === message.id && before.node}
          <Message
            message={message}
            companies={companies}
            workspaceName={workspaceName}
            own={own}
            swipe={swipe}
            onEditDraft={onEditDraft}
            onDeleteDraft={onDeleteDraft}
            footer={detail.deferral?.messageId === message.id ? <DeferralNotice key={`${detail.deferral.id}:${detail.deferral.at}`} deferral={detail.deferral} /> : null}
            expanded={open.has(message.id)}
            collapsible={detail.messages.length > 1}
            hideQuotes={message.id !== detail.messages[0].id}
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
            <Button variant="chip" size="chip" onClick={() => setShowAll(true)} className="mx-4 self-start pointer-coarse:h-11">
              {hidden} more {hidden === 1 ? "email" : "emails"}
            </Button>
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

function ThreadPeek({ thread, own, side }: { thread: ThreadSummary; own: string[]; side: "previous" | "next" }) {
  const sender = thread.from ? personName(thread.from) : recipientList(thread.to, own) || "Unknown sender";
  return (
    <div
      aria-hidden
      className={cn("bg-background pointer-events-none absolute inset-y-0 flex w-full flex-col lg:hidden", side === "previous" ? "right-full" : "left-full")}
    >
      <div className="h-[52px] shrink-0" />
      <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 overflow-hidden px-3 pt-3 sm:px-6">
        <h2 className="px-4 text-pretty">{thread.subject?.trim() || "(no subject)"}</h2>
        <div className="bg-surface-panel flex items-start gap-3 rounded-2xl px-4 py-3">
          <Monogram name={sender} className="mt-0.5 size-7 rounded-full text-[11px]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate text-[14px]", thread.unread ? "text-foreground font-medium" : "text-foreground")}>{sender}</span>
              <When at={thread.latestAt} className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums" />
            </span>
            <span className="text-soft text-[14px] leading-5">{snippetCore(thread.snippet)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function shortDay(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
}

function SenderNotice({
  subscription,
  onUnsubscribe,
  onBlock,
}: {
  subscription: ThreadSubscription;
  onUnsubscribe: (mode: UnsubscribeMode) => void;
  onBlock: (sender: string) => void;
}) {
  const line =
    subscription.status === "ignored"
      ? `Ignored your unsubscribe on ${shortDay(subscription.unsubscribedAt)}. Their mail is archived.`
      : subscription.status === "blocked"
        ? "Blocked. Their mail is archived."
        : subscription.status === "research"
          ? "Kept for research."
          : subscription.status === "unsubscribed"
            ? `Unsubscribed ${shortDay(subscription.unsubscribedAt)}.`
            : subscription.coldPitch
              ? "Cold pitch"
              : "";
  if (!line) return null;
  const tone = subscription.status === "ignored" || (subscription.coldPitch && subscription.status === "subscribed");
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-2.5 text-[13px] leading-5",
        tone ? "border border-[var(--tag-amber-border)] bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)]" : "text-subtle bg-surface-panel",
      )}
    >
      <span className="min-w-0 flex-1">{line}</span>
      {subscription.status === "ignored" && (
        <Button variant="secondary" size="sm" onClick={() => onBlock(subscription.sender)}>
          Block
        </Button>
      )}
      {subscription.coldPitch && subscription.status === "subscribed" && (
        <Button variant="secondary" size="sm" onClick={() => onUnsubscribe("both")}>
          Unsubscribe and block
        </Button>
      )}
    </div>
  );
}

export default function ThreadReader({
  summary,
  detail,
  error,
  own,
  workspaceName = "",
  view,
  accounts,
  onAction,
  onBack,
  onSent,
  onNext,
  onPrevious,
  previous,
  next,
  entered,
  onSplit,
  onUnsubscribe,
  onBlock,
  compose = null,
}: {
  compose?: ComposeIntent | null;
  onUnsubscribe: (mode: UnsubscribeMode) => void;
  onBlock: (sender: string) => void;
  previous: ThreadSummary | null;
  next: ThreadSummary | null;
  onPrevious: (swiped: boolean) => void;
  entered: boolean;
  onSplit: (sender: string, split: MailSplit) => void;
  summary: ThreadSummary | null;
  detail: ThreadDetail | null;
  error: string | null;
  own: string[];
  workspaceName?: string;
  view: string;
  accounts: ComposeAccount[];
  onAction: (action: ReaderAction) => void;
  onBack: () => void;
  onSent: () => void;
  onNext: (swiped?: boolean) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const settling = useRef(false);
  const alive = useRef(true);
  const swipeHandlers = useRef<SwipeHandlers>({});
  const swipe = useCallback(() => swipeHandlers.current, []);
  const [composer, setComposer] = useState<ComposerStart | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [removedDrafts, setRemovedDrafts] = useState<Set<string>>(() => new Set());
  const [draftError, setDraftError] = useState<string | null>(null);
  const [hiddenPrepared, setHiddenPrepared] = useState<Set<string>>(() => new Set());
  const [cancelledFollowUp, setCancelledFollowUp] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ prefill: InvitePrefill; setup: InviteSetup; at: number } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const { showToast } = useComposer();
  const pendingDeletes = useRef(new Map<string, number>());
  const deleteFailed = useRef<(id: string, problem: string) => void>(() => undefined);
  const replyHint = useShortcutHint("mail-reply");
  const replyAllHint = useShortcutHint("mail-reply-all");
  const forwardHint = useShortcutHint("mail-forward");
  const hints: Record<Exclude<DraftMode, "new">, string> = { reply: replyHint, reply_all: replyAllHint, forward: forwardHint };
  const target = detail?.messages.filter((message) => !(message.isDraft && message.folderRole === "drafts")).at(-1) ?? null;
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

  const outsideDraft =
    !dismissed && !active && target ? (detail?.messages.filter((message) => message.isDraft && message.folderRole === "drafts" && !removedDrafts.has(message.id)).at(-1) ?? null) : null;
  const [openedOutside, setOpenedOutside] = useState<string | null>(null);
  if (outsideDraft && openedOutside !== outsideDraft.id) editOutsideDraft(outsideDraft, true);

  const prepared = detail?.prepared && target && detail.prepared.messageId === target.id && !hiddenPrepared.has(detail.prepared.id) ? detail.prepared : null;
  const [composerPrepared, setComposerPrepared] = useState<string | null>(null);
  const openedPrepared = useRef<string | null>(null);
  const autoPrepared = prepared && !active && !dismissed && !outsideDraft ? prepared : null;

  useEffect(() => {
    if (!autoPrepared || openedPrepared.current === autoPrepared.id) return;
    openedPrepared.current = autoPrepared.id;
    void takePrepared(autoPrepared, true);
  });
  const followUp = detail?.followUp && detail.followUp.id !== cancelledFollowUp ? detail.followUp : null;

  async function preparedAction(id: string, action: "use" | "dismiss") {
    const response = await fetch("/api/mail/prepared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { prepared?: PreparedReply | null } | null;
    return body?.prepared ?? null;
  }

  async function takePrepared(item: PreparedReply, auto = false) {
    if (!target) return;
    const everyone = target.to.length + target.cc.length > 1;
    const fresh = item.times ? await preparedAction(item.id, "use") : null;
    startReply(everyone ? "reply_all" : "reply", fresh?.body ?? item.body, auto);
    setComposerPrepared(item.id);
    setHiddenPrepared((existing) => new Set(existing).add(item.id));
    if (!item.times) void preparedAction(item.id, "use");
  }

  async function makeInvite() {
    if (!detail || inviteBusy) return;
    setInviteBusy(true);
    try {
      const response = await fetch("/api/mail/ai/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: detail.key }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        title?: string;
        date?: string | null;
        time?: string | null;
        durationMinutes?: number;
        notes?: string;
        guests?: InvitePrefill["guests"];
        setup?: InviteSetup;
      };
      if (!response.ok || !body.setup) throw new Error(body.error ?? "Couldn't read the meeting. Try again.");
      setInvite({
        prefill: {
          title: body.title,
          date: body.date ?? undefined,
          time: body.time ?? undefined,
          durationMinutes: body.durationMinutes,
          notes: body.notes,
          guests: body.guests ?? [],
        },
        setup: body.setup,
        at: Date.now(),
      });
    } catch (problem) {
      showToast({ message: problem instanceof Error ? problem.message : "Couldn't read the meeting. Try again.", tone: "alert" });
    } finally {
      setInviteBusy(false);
    }
  }

  function dismissPrepared(item: PreparedReply) {
    setHiddenPrepared((existing) => new Set(existing).add(item.id));
    void preparedAction(item.id, "dismiss");
  }

  function startReply(mode: Exclude<DraftMode, "new">, body?: string, auto = false) {
    if (!detail || !target) return false;
    if (active) {
      document.querySelector<HTMLElement>("[data-reader-composer] [data-composer-body]")?.focus();
      return;
    }
    const defaults = replyDefaults(mode, target, detail.subject, own);
    const addressedTo = new Set([...target.to, ...target.cc].map((item) => item.address.toLowerCase()));
    const identity = accounts.find((account) => account.identityId && account.sourceId === sourceId && addressedTo.has(account.email.toLowerCase()));
    setAutoOpened(auto);
    setComposer({
      mode,
      messageId: target.id,
      sourceId,
      to: defaults.to,
      cc: defaults.cc,
      subject: defaults.subject,
      draft: body
        ? { id: "", sourceId, mode, messageId: target.id, to: defaults.to, cc: defaults.cc, bcc: [], subject: defaults.subject, body, savedAt: "", sendAt: null, sendError: null }
        : null,
      fromId: identity?.id ?? null,
    });
  }

  function editOutsideDraft(message: ThreadMessage, auto = false) {
    if (!detail || !target) return;
    setAutoOpened(auto);
    const mode: DraftMode = message.to.length + message.cc.length > 1 ? "reply_all" : "reply";
    const subject = detail.subject ?? "";
    const body = stripQuoted(message.text ?? message.snippet ?? "").replace(/\s*[\u2013\u2014]\s*/g, ", ");
    setOpenedOutside(message.id);
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

  function restoreDraft(id: string) {
    setRemovedDrafts((existing) => {
      const next = new Set(existing);
      next.delete(id);
      return next;
    });
  }

  function deleteOutsideDraft(message: ThreadMessage) {
    setDraftError(null);
    setRemovedDrafts((existing) => new Set(existing).add(message.id));
    const id = message.id;
    const pending = pendingDeletes.current;
    const timer = window.setTimeout(() => {
      if (!pending.delete(id)) return;
      void sendDraftDelete(id, false).then((problem) => problem && deleteFailed.current(id, problem));
    }, UNDO_DELETE_MS);
    pending.set(id, timer);
    showToast({
      message: "Draft discarded.",
      duration: UNDO_DELETE_MS - 500,
      action: {
        label: "Undo",
        run: () => {
          const waiting = pending.get(id);
          if (waiting === undefined) return;
          window.clearTimeout(waiting);
          pending.delete(id);
          restoreDraft(id);
        },
      },
    });
  }

  function closeComposer() {
    setComposer(null);
    setDismissed(true);
  }

  useEffect(() => {
    if (window.matchMedia("(min-width: 64rem)").matches) {
      swipeHandlers.current = {};
      return;
    }
    const move = (dx: number, duration: number) => {
      const element = surface.current;
      if (!element) return;
      element.style.transition = duration ? `transform ${duration}ms var(--ease-power3-out)` : "none";
      element.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : "";
    };
    swipeHandlers.current = {
      canLeft: Boolean(next),
      canRight: Boolean(previous),
      scroller: () => scroller.current,
      onDrag: (dx) => {
        if (settling.current) return;
        offset.current = dx;
        move(dx, 0);
      },
      onRelease: (commit, velocity) => {
        const element = surface.current;
        if (!element || settling.current) return;
        const width = element.offsetWidth || window.innerWidth;
        const goal = commit === "left" ? -width : commit === "right" ? width : 0;
        const remaining = Math.abs(goal - offset.current);
        const duration = Math.round(Math.min(320, Math.max(160, remaining / Math.max(Math.abs(velocity), 0.6))));
        offset.current = goal;
        if (!commit) {
          move(0, duration);
          return;
        }
        settling.current = true;
        const done = () => {
          window.clearTimeout(fallback);
          element.removeEventListener("transitionend", done);
          if (!alive.current) return;
          if (commit === "left") onNext(true);
          else onPrevious(true);
        };
        const fallback = window.setTimeout(done, duration + 80);
        element.addEventListener("transitionend", done);
        move(goal, duration);
      },
    };
  });

  useEffect(() => {
    alive.current = true;
    const element = surface.current;
    const stop = element ? watchSwipe(element, swipe) : undefined;
    return () => {
      alive.current = false;
      stop?.();
    };
  }, [swipe]);

  useEffect(() => {
    deleteFailed.current = (id, problem) => {
      if (alive.current) {
        restoreDraft(id);
        setDraftError(problem);
      } else {
        showToast({ message: problem, tone: "alert" });
      }
    };
  });

  useEffect(() => {
    const pending = pendingDeletes.current;
    const failed = deleteFailed;
    const flush = () => {
      for (const [id, timer] of pending) {
        window.clearTimeout(timer);
        pending.delete(id);
        void sendDraftDelete(id, true).then((problem) => problem && failed.current(id, problem));
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);

  const composeStarted = useRef(false);
  useEffect(() => {
    if (!compose || !detail || !target || composeStarted.current) return;
    composeStarted.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("compose");
    window.history.replaceState(window.history.state, "", url);
    const start = compose === "prepared" && prepared ? () => void takePrepared(prepared) : () => startReply("reply");
    window.setTimeout(start, 0);
  });

  useShortcut("mail-reply", () => startReply("reply"), Boolean(detail));
  useShortcut("mail-reply-all", () => startReply("reply_all"), Boolean(detail));
  useShortcut("mail-forward", () => startReply("forward"), Boolean(detail));

  const archiveHint = useShortcutHint("mail-archive");
  const trashHint = useShortcutHint("mail-trash");
  const readHint = useShortcutHint("mail-read");
  const flagHint = useShortcutHint("mail-flag");
  const snoozeHint = useShortcutHint("mail-snooze");
  const unsubscribeHint = useShortcutHint("mail-unsubscribe");

  if (!summary && !detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-soft">Nothing open</p>
      </div>
    );
  }

  const subject = detail?.subject ?? summary?.subject;
  const account = detail?.account ?? summary?.account ?? "";
  const unread = summary ? summary.unread : Boolean(detail?.messages.some((message) => !message.isRead));
  const flagged = summary ? summary.flagged : Boolean(detail?.messages.some((message) => message.isFlagged));
  const restorable = view === "archive" || view === "trash" || view === "snoozed" || view === "junk";
  const ownSet = new Set(own.map((item) => item.toLowerCase()));
  const tracked = detail?.messages.filter((message) => message.opens !== null).at(-1) ?? null;
  const sender =
    detail?.messages.filter((message) => message.from && !ownSet.has(message.from.address.toLowerCase())).at(-1)?.from?.address ??
    (summary?.from && !ownSet.has(summary.from.address.toLowerCase()) ? summary.from.address : null);

  return (
    <div
      ref={surface}
      className={cn(
        "relative flex min-h-0 flex-1 touch-pan-y flex-col will-change-transform",
        entered && "animate-in fade-in slide-in-from-right-12 ease-power3-out duration-200",
      )}
    >
      <div role="group" aria-label="Conversation actions" className="@container flex shrink-0 items-center gap-1 px-3 py-2 sm:px-5">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to the list"
          title="Back (Esc)"
          data-shortcut="back"
          onClick={onBack}
          className="pointer-coarse:size-11 md:hidden"
        >
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        <span role="group" aria-label="Move" className="flex items-center gap-1">
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
        </span>
        <ToolbarDivider />
        <span role="group" aria-label="Mark" className="flex items-center gap-1 max-sm:hidden @max-lg:hidden">
          <ToolButton label={unread ? "Mark read" : "Mark unread"} hint={readHint} onClick={() => onAction(unread ? "read" : "unread")}>
            <MailOpenIcon aria-hidden className="size-3.5" />
          </ToolButton>
          <ToolButton label={flagged ? "Remove flag" : "Flag"} hint={flagHint} active={flagged} onClick={() => onAction(flagged ? "unflag" : "flag")}>
            <FlagIcon aria-hidden className="size-3.5" />
          </ToolButton>
        </span>
        {(sender || detail) && <ToolbarDivider />}
        <span role="group" aria-label="Sender and meetings" className="flex items-center gap-1 max-sm:hidden @max-lg:hidden">
          {sender && (
            <ToolButton label="Unsubscribe" hint={unsubscribeHint} onClick={() => onUnsubscribe("unsubscribe")}>
              <UnsubscribeIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
          {detail && (
            <ToolButton label={inviteBusy ? "Reading the meeting…" : "Send an invite"} onClick={() => void makeInvite()}>
              <CalendarIcon aria-hidden className={cn("size-3.5", inviteBusy && "animate-pulse")} />
            </ToolButton>
          )}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions" title="More actions" className={cn("pointer-coarse:size-11 sm:@lg:hidden", flagged && "text-warning")}>
              <MoreIcon aria-hidden className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[15rem]">
            <MenuAction icon={MailOpenIcon} label={unread ? "Mark read" : "Mark unread"} onSelect={() => onAction(unread ? "read" : "unread")} />
            <MenuAction icon={FlagIcon} label={flagged ? "Remove flag" : "Flag"} onSelect={() => onAction(flagged ? "unflag" : "flag")} />
            <DropdownMenuSeparator />
            <MenuAction
              icon={UnsubscribeIcon}
              label="Unsubscribe"
              reason={sender ? null : "Only you have written in this conversation."}
              onSelect={() => onUnsubscribe("unsubscribe")}
            />
            <MenuAction
              icon={CalendarIcon}
              label="Send an invite"
              reason={!detail ? "Still loading" : inviteBusy ? "Reading the meeting" : null}
              onSelect={() => void makeInvite()}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {summary?.split && sender && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Split: ${SPLIT_LABELS[summary.split]}. Change where this sender goes`} className="pointer-coarse:h-11 pointer-coarse:px-3">
                  {SPLIT_LABELS[summary.split]}
                  <ChevronDownIcon aria-hidden className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[17rem]">
                <DropdownMenuLabel>{sender} goes to</DropdownMenuLabel>
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
          <span className="caption-style text-subtle truncate max-sm:sr-only">{account}</span>
        </span>
      </div>
      {previous && <ThreadPeek thread={previous} own={own} side="previous" />}
      {next && <ThreadPeek thread={next} own={own} side="next" />}
      <div ref={scroller} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
        <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-[var(--floating-clearance)] sm:px-6">
          <h2 className="px-4 text-pretty">{subject?.trim() || "(no subject)"}</h2>
          {detail?.subscription && <SenderNotice subscription={detail.subscription} onUnsubscribe={onUnsubscribe} onBlock={onBlock} />}
          {detail && <ThreadPeople key={detail.key} people={detail.people ?? []} threadKey={detail.key} filing={detail.filing ?? null} />}
          {detail && target && <SummaryLine threadKey={detail.key} latestId={target.id} messages={detail.messages.length} />}
          {detail ? (
            <>
              <Thread
                key={detail.key + detail.messages.length}
                detail={{ ...detail, messages: detail.messages.filter((message) => !removedDrafts.has(message.id) && message.id !== active?.replaces) }}
                workspaceName={workspaceName}
                own={own}
                swipe={swipe}
                onEditDraft={(message) => editOutsideDraft(message)}
                onDeleteDraft={deleteOutsideDraft}
                before={detail.followUpReplied ? { id: detail.followUpReplied.messageId, node: <FollowUpCancelledNote replied={detail.followUpReplied} /> } : null}
              />
              {draftError && (
                <p role="alert" className="text-danger px-4 text-[13px]">
                  {draftError}
                </p>
              )}
              {echo && echo.count === detail.messages.length && (
                <article aria-label="Sent just now" className="bg-surface-panel flex items-start gap-3 rounded-2xl px-4 py-3">
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
                  passive={composer ? autoOpened : true}
                  accounts={accounts}
                  onClose={closeComposer}
                  onDiscard={() => {
                    if (composerPrepared) void preparedAction(composerPrepared, "dismiss");
                  }}
                  onSent={(body, to) => {
                    setEcho({ body, to, count: detail.messages.length });
                    closeComposer();
                  }}
                  onDelivered={onSent}
                  onUndone={() => setEcho(null)}
                />
                </div>
              ) : !target && newDraft ? (
                <div data-reader-composer="">
                  <MailComposer
                    key={newDraft.id}
                    start={{
                      mode: "new",
                      messageId: null,
                      sourceId: newDraft.sourceId,
                      to: newDraft.to,
                      cc: newDraft.cc,
                      subject: newDraft.subject,
                      draft: newDraft,
                    }}
                    variant="inline"
                    passive
                    accounts={accounts}
                    onClose={onBack}
                    onSent={() => onBack()}
                    onDelivered={onSent}
                  />
                </div>
              ) : (
                target && (
                  <>
                  {prepared && <PreparedCard prepared={prepared} onUse={() => void takePrepared(prepared)} onDismiss={() => dismissPrepared(prepared)} />}
                  {followUp?.action === "send" && <FollowUpBanner key={followUp.id} followUp={followUp} onChanged={onSent} />}
                  <div className="flex flex-wrap items-center gap-2 px-4">
                    {tracked && (
                      <span className="order-last ml-auto">
                        <ReadStatus opens={tracked.opens!} recipients={[...tracked.to, ...tracked.cc]} sentAt={tracked.at} />
                      </span>
                    )}
                    {REPLIES.map((reply) => (
                      <Button key={reply.mode} variant="secondary" onClick={() => startReply(reply.mode)} title={`${reply.label} (${hints[reply.mode]})`} className="pointer-coarse:h-11 pointer-coarse:px-4">
                        <reply.icon aria-hidden className="size-3.5" />
                        {reply.label}
                      </Button>
                    ))}
                  </div>
                  {followUp && followUp.action !== "send" && (
                    <div role="status" className="caption-style text-subtle flex flex-wrap items-center gap-x-2 px-4">
                      <span>
                        Reminder {mailFullWhen(followUp.at)} if no reply.
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Cancel reminder"
                        onClick={() => {
                          const id = followUp.id;
                          setCancelledFollowUp(id);
                          setReminderError(null);
                          cancelReminder(id).catch((problem: Error) => {
                            setCancelledFollowUp((current) => (current === id ? null : current));
                            setReminderError(problem.message);
                          });
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                  {reminderError && (
                    <p role="alert" className="caption-style text-danger px-4">
                      {reminderError}
                    </p>
                  )}
                  </>
                )
              )}
            </>
          ) : error ? (
            <p role="alert" className="text-danger px-4">
              {error}
            </p>
          ) : (
            <div role="status" aria-busy="true" className="flex flex-col gap-3 px-4">
              <span className="sr-only">Loading the conversation</span>
              <span aria-hidden className="bg-surface-raised h-3 w-1/4 animate-pulse rounded-full" />
              <span aria-hidden className="bg-surface-hover h-24 w-full animate-pulse rounded-2xl" />
            </div>
          )}
        </div>
      </div>
      {invite && (
        <InviteDialog
          open
          onOpenChange={(open) => {
            if (!open) setInvite(null);
          }}
          setup={invite.setup}
          prefill={invite.prefill}
          now={invite.at}
          onSent={(message) => showToast({ message })}
        />
      )}
    </div>
  );
}
