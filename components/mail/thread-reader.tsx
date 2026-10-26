"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MessageAttachments from "@/components/mail/message-attachments";
import ReadStatus from "@/components/mail/read-status";
import { useComposer } from "@/components/mail/compose-dock";
import { loadSummary, type ThreadSummaryText } from "@/components/mail/mail-cache";
import { watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import MailComposer, { type ComposerStart } from "@/components/mail/mail-composer";
import Button from "@/components/_ui/button";
import InviteDialog, { InviteNotice, type InvitePrefill } from "@/components/crm/invite-dialog";
import type { InviteSetup } from "@/lib/crm/invites";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import EmailFrame, { QuoteToggle } from "@/components/mail/email-frame";
import { useShortcut, useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { mailFullWhen, personName, recipientList, snippetCore, stripQuoted } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import {
  MAIL_SPLITS,
  replyDefaults,
  SPLIT_LABELS,
  type ComposeAccount,
  type DraftMode,
  type MailSplit,
  type PreparedReply,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSummary,
} from "@/lib/mail/view";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
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
  own,
  expanded,
  collapsible,
  hideQuotes,
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
  collapsible: boolean;
  hideQuotes: boolean;
  onToggle: () => void;
  swipe: () => SwipeHandlers;
}) {
  const [details, setDetails] = useState(false);
  const detailsId = `addresses-${message.id}`;
  const showingDetails = expanded && details;
  const sender = personName(message.from);
  const to = recipientList(message.to, own);
  const cc = recipientList(message.cc, own);
  return (
    <article className={cn("ease-power3-out rounded-2xl transition-colors duration-150", expanded ? "bg-white/[0.025]" : "hover:bg-white/[0.025]")}>
      <div className="flex items-start">
        <button
          type="button"
          onClick={expanded ? () => setDetails((open) => !open) : onToggle}
          aria-expanded={expanded ? details : false}
          aria-controls={showingDetails ? detailsId : undefined}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
              {message.isDraft && message.folderRole === "drafts" && <span className="shrink-0 text-[12px] text-[var(--tag-amber-text)]">Draft</span>}
              <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{mailFullWhen(message.at)}</span>
            </span>
            {expanded ? (
              <span className="text-subtle flex min-w-0 items-center gap-1 text-[12px]">
                <span className="truncate">
                  {to ? `To ${to}` : "No recipients"}
                  {cc ? ` · Cc ${cc}` : ""}
                </span>
                <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 shrink-0 transition-transform duration-150", details && "rotate-180")} />
                <span className="sr-only">{details ? "Hide addresses" : "Show addresses"}</span>
              </span>
            ) : (
              <span className="text-subtle truncate text-[13px]">{snippetCore(message.snippet)}</span>
            )}
          </span>
        </button>
        {expanded && collapsible && (
          <Button variant="ghost" size="icon" aria-label="Collapse this email" title="Collapse" onClick={onToggle} className="mt-2 mr-2 shrink-0">
            <ChevronDownIcon aria-hidden className="size-4 rotate-180" />
          </Button>
        )}
      </div>
      {showingDetails && <AddressDetails id={detailsId} message={message} />}
      {message.isDraft && message.folderRole === "drafts" && (
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
          <MessageBody message={message} title={`Email from ${sender}`} swipe={swipe} hideQuotes={hideQuotes} />
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

function PreparedCard({ prepared, onUse, onDismiss }: { prepared: PreparedReply; onUse: () => void; onDismiss: () => void }) {
  return (
    <section
      aria-label={prepared.kind === "nudge" ? "Follow-up ready" : "Reply ready"}
      className="animate-rise-in mx-4 flex flex-col gap-2 rounded-2xl bg-white/[0.025] px-4 py-3"
    >
      <span className="text-subtle flex items-center gap-1.5 text-[12px]">
        <SparkleIcon aria-hidden className="text-primary-foreground size-3.5" />
        {prepared.kind === "nudge" ? "Nobody has replied. Orbit has a follow-up ready." : "Orbit has a reply ready"}
      </span>
      <p className={cn("text-soft text-[14px] leading-6 whitespace-pre-line", prepared.times ? "line-clamp-[14]" : "line-clamp-5")}>{prepared.body}</p>
      {prepared.times && (
        <span className="caption-style text-subtle">The times are free in your calendar. Orbit checks them again when you open the reply.</span>
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
        <div className="flex items-start gap-3 rounded-2xl bg-white/[0.025] px-4 py-3">
          <Monogram name={sender} className="mt-0.5 size-7 rounded-full text-[11px]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate text-[14px]", thread.unread ? "text-foreground font-medium" : "text-foreground")}>{sender}</span>
              <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{mailFullWhen(thread.latestAt)}</span>
            </span>
            <span className="text-soft text-[14px] leading-5">{snippetCore(thread.snippet)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

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
  onPrevious,
  previous,
  next,
  entered,
  onSplit,
}: {
  previous: ThreadSummary | null;
  next: ThreadSummary | null;
  onPrevious: (swiped: boolean) => void;
  entered: boolean;
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
  const [dismissed, setDismissed] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [removedDrafts, setRemovedDrafts] = useState<Set<string>>(() => new Set());
  const [draftError, setDraftError] = useState<string | null>(null);
  const [hiddenPrepared, setHiddenPrepared] = useState<Set<string>>(() => new Set());
  const [cancelledFollowUp, setCancelledFollowUp] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ prefill: InvitePrefill; setup: InviteSetup; at: number } | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const replyHint = useShortcutHint("mail-reply");
  const replyAllHint = useShortcutHint("mail-reply-all");
  const forwardHint = useShortcutHint("mail-forward");
  const hints: Record<Exclude<DraftMode, "new">, string> = { reply: replyHint, reply_all: replyAllHint, forward: forwardHint };
  const target = detail?.messages.filter((message) => !(message.isDraft && message.folderRole === "drafts")).at(-1) ?? null;
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

  const prepared = detail?.prepared && target && detail.prepared.messageId === target.id && !hiddenPrepared.has(detail.prepared.id) ? detail.prepared : null;
  const followUp = detail?.followUp && detail.followUp.id !== cancelledFollowUp ? detail.followUp : null;

  async function preparedAction(id: string, action: "use" | "dismiss" | "cancel_reminder") {
    const response = await fetch("/api/mail/prepared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { prepared?: PreparedReply | null } | null;
    return body?.prepared ?? null;
  }

  async function takePrepared(item: PreparedReply) {
    if (!target) return;
    const everyone = target.to.length + target.cc.length > 1;
    const fresh = item.times ? await preparedAction(item.id, "use") : null;
    startReply(everyone ? "reply_all" : "reply", fresh?.body ?? item.body);
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
      if (!response.ok || !body.setup) throw new Error(body.error ?? "Orbit couldn't read the meeting from this email. Try again.");
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
      setNotice(problem instanceof Error ? problem.message : "Orbit couldn't read the meeting from this email. Try again.");
    } finally {
      setInviteBusy(false);
    }
  }

  function dismissPrepared(item: PreparedReply) {
    setHiddenPrepared((existing) => new Set(existing).add(item.id));
    void preparedAction(item.id, "dismiss");
  }

  function startReply(mode: Exclude<DraftMode, "new">, body?: string) {
    if (!detail || !target) return false;
    if (active) {
      document.querySelector<HTMLTextAreaElement>("[data-reader-composer] textarea")?.focus();
      return;
    }
    const defaults = replyDefaults(mode, target, detail.subject, own);
    const addressedTo = new Set([...target.to, ...target.cc].map((item) => item.address.toLowerCase()));
    const identity = accounts.find((account) => account.identityId && account.sourceId === sourceId && addressedTo.has(account.email.toLowerCase()));
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
    <div
      ref={surface}
      className={cn(
        "relative flex min-h-0 flex-1 touch-pan-y flex-col will-change-transform",
        entered && "animate-in fade-in slide-in-from-right-12 ease-power3-out duration-200",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to the list" title="Back (Esc)" data-shortcut="back" onClick={onBack} className="md:hidden">
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
        {detail && (
          <ToolButton label={inviteBusy ? "Reading the meeting from this email" : "Send an invite from this email"} onClick={() => void makeInvite()}>
            <CalendarIcon aria-hidden className={cn("size-3.5", inviteBusy && "animate-pulse")} />
          </ToolButton>
        )}
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
      {previous && <ThreadPeek thread={previous} own={own} side="previous" />}
      {next && <ThreadPeek thread={next} own={own} side="next" />}
      <div ref={scroller} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
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
                  <>
                  {prepared && <PreparedCard prepared={prepared} onUse={() => void takePrepared(prepared)} onDismiss={() => dismissPrepared(prepared)} />}
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
                  {followUp && (
                    <div role="status" className="caption-style text-subtle flex flex-wrap items-center gap-x-2 px-4">
                      <span>
                        {followUp.automatic ? "Orbit will remind you" : "You'll be reminded"} on {mailFullWhen(followUp.at)} if nobody replies.
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCancelledFollowUp(followUp.id);
                          void preparedAction(followUp.id, "cancel_reminder");
                        }}
                      >
                        Don&apos;t remind me
                      </Button>
                    </div>
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
            <div aria-label="Loading the conversation" className="flex flex-col gap-3 px-4">
              <span className="bg-white/[0.05] h-3 w-1/4 animate-pulse rounded-full" />
              <span className="bg-white/[0.035] h-24 w-full animate-pulse rounded-2xl" />
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
          onSent={setNotice}
        />
      )}
      <InviteNotice message={notice} onDone={clearNotice} />
    </div>
  );
}
