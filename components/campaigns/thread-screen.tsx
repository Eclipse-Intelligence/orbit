"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Monogram } from "@/components/beautifui/record-marks";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Radio } from "@/components/_ui/radio";
import Tag from "@/components/_ui/tag";
import { Textarea } from "@/components/_ui/textarea";
import ChannelIcon from "@/components/campaigns/channel-icon";
import { DoNotContactDialog, DoNotContactStatus } from "@/components/campaigns/do-not-contact";
import DetailSection from "@/components/companies/detail/detail-section";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { When } from "@/components/mail/thread-reader";
import { useSyncSignal } from "@/components/crm/sync-signals";
import { useShortcut, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import {
  markConversationReadAction,
  refreshProspectThreadAction,
  removeProspectAction,
  replyToProspectAction,
  setProspectCategoryAction,
  setProspectPausedAction,
} from "@/app/(crm)/campaigns/actions";
import { CAMPAIGN_CATEGORIES, categoryTone } from "@/lib/campaigns/format";
import {
  campaignStateLine,
  failedSendPlan,
  restoredDraft,
  messageStatus,
  newClientKey,
  noteLabel,
  replyChannel,
  retryable,
  SEND_FAILED,
  sourceLink,
  withoutReply,
  withPending,
  type Draft,
  type PendingReply,
} from "@/lib/campaigns/thread-view";
import type { ProspectThread, ReplyOption, ThreadCampaign, ThreadMessage } from "@/lib/campaigns/threads";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { contactHref } from "@/lib/crm/hrefs";
import { stripQuoted } from "@/lib/mail/format";
import { SHORTCUT_BY_ID, shortcutKeys } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";

const CHANNEL_LABELS: Record<CampaignChannel, string> = { email: "Email", linkedin: "LinkedIn" };

type SendStatus = { state: "sending" | "sent" | "failed"; error: string | null; retryable?: boolean };

function MessageBody({ message }: { message: Pick<ThreadMessage, "body" | "channel" | "direction"> }) {
  const [full, setFull] = useState(false);
  const short = message.channel === "email" ? stripQuoted(message.body) : message.body;
  const trimmed = Boolean(short) && short.length < message.body.trim().length;
  return (
    <>
      <p className={cn("text-[14px] leading-[1.45] break-words whitespace-pre-wrap", message.direction === "inbound" ? "text-foreground" : "text-soft")}>
        {full || !trimmed ? message.body.trim() : short}
      </p>
      {trimmed && (
        <Button variant="link" size="none" onClick={() => setFull((value) => !value)} aria-expanded={full} className="caption-style hit self-start font-normal">
          {full ? "Hide quoted text" : "Show quoted text"}
        </Button>
      )}
    </>
  );
}

function Bubble({
  author,
  channel,
  at,
  inbound,
  label,
  children,
}: {
  author: string;
  channel: CampaignChannel;
  at: string;
  inbound: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="bg-surface-panel flex items-start gap-3 rounded-2xl px-4 py-3">
      <Monogram name={author} className="mt-0.5 size-7 rounded-full text-[11px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("truncate text-[14px]", inbound ? "text-foreground" : "text-soft")}>{author}</span>
          <span className="text-subtle ml-auto flex shrink-0 items-center gap-1.5 text-[12px] tabular-nums">
            <ChannelIcon channel={channel} className="size-3 self-center" />
            <When at={at} />
          </span>
        </div>
        {children}
      </div>
    </article>
  );
}

function SendLine({ status, onRetry }: { status: { text: string; failed: boolean; detail?: string | null; final?: boolean } | null; onRetry?: () => void }) {
  if (!status) return null;
  return (
    <p role={status.failed ? "alert" : "status"} className={cn("caption-style flex flex-wrap items-center gap-x-2", status.failed ? "text-danger" : "text-subtle")}>
      <span title={status.detail ?? undefined}>{status.text}</span>
      {onRetry && (
        <Button variant="link" size="none" onClick={onRetry} className="caption-style hit font-normal">
          Try again
        </Button>
      )}
    </p>
  );
}

function ChannelSwitch({ options, value, onChange }: { options: ReplyOption[]; value: CampaignChannel; onChange: (channel: CampaignChannel) => void }) {
  return (
    <span role="radiogroup" aria-label="Reply on" className="flex items-center gap-1 rounded-full bg-white/[0.04] p-0.5">
      {options.map((option) => (
        <label
          key={option.channel}
          className={cn(
            "caption-style hit ease-power3-out has-[:focus-visible]:ring-ring/60 flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 whitespace-nowrap transition-colors duration-150 has-[:focus-visible]:ring-2",
            value === option.channel ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
          )}
        >
          <Radio name="reply-channel" value={option.channel} checked={value === option.channel} onChange={() => onChange(option.channel)} className="sr-only" />
          <span aria-hidden className="flex">
            <ChannelIcon channel={option.channel} className="size-3" />
          </span>
          <span>{CHANNEL_LABELS[option.channel]}</span>
        </label>
      ))}
    </span>
  );
}

function Composer({
  options,
  preferred,
  draft,
  error,
  onDraft,
  onSend,
}: {
  options: ReplyOption[];
  preferred: CampaignChannel;
  draft: Draft;
  error: { text: string; detail: string | null } | null;
  onDraft: (draft: Draft) => void;
  onSend: (option: ReplyOption, text: string) => void;
}) {
  const { mac } = useShortcuts();
  const { text, chosen } = draft;
  const setText = (value: string) => onDraft({ text: value, chosen });
  const setChosen = (value: CampaignChannel) => onDraft({ text, chosen: value });
  const field = useRef<HTMLTextAreaElement>(null);
  const channel = replyChannel(options, preferred, chosen);
  const option = options.find((item) => item.channel === channel) ?? null;
  const submitDef = SHORTCUT_BY_ID.get("submit");

  useShortcut("mail-reply", () => field.current?.focus(), Boolean(option?.canReply));

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 360)}px`;
  }, [text, channel]);

  if (!option) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!option?.canReply || !body) return;
    onSend(option, body);
    onDraft({ text: "", chosen });
  }

  const placeholder = option.channel === "linkedin" ? (option.senderName ? `Send on LinkedIn as ${option.senderName}` : "Reply on LinkedIn") : "Reply by email";

  return (
    <form
      onSubmit={submit}
      aria-label="Reply"
      className="bg-surface-field flex flex-col gap-3 rounded-2xl px-4 pt-3 pb-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
    >
      {option.canReply ? (
        <Textarea
          ref={field}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              field.current?.blur();
            }
          }}
          aria-label={placeholder}
          placeholder={placeholder}
          rows={2}
          className="text-foreground placeholder:text-subtle min-h-11 w-full resize-none rounded-none border-0 bg-transparent p-0 text-[14px] leading-[1.45] shadow-none outline-none focus-visible:ring-0"
        />
      ) : (
        <p role="status" className="caption-style text-subtle">
          {option.reason}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {option.canReply && (
          <Button variant="primary" type="submit" disabled={!text.trim()} shortcut={submitDef ? shortcutKeys(submitDef, mac) : undefined} className="hit">
            Send
          </Button>
        )}
        {options.length > 1 && <ChannelSwitch options={options} value={option.channel} onChange={setChosen} />}
      </div>
      {error && (
        <p role="alert" title={error.detail ?? undefined} className="caption-style text-danger">
          {error.text}
        </p>
      )}
    </form>
  );
}

function CategoryPicker({ category, disabled, onChange }: { category: string | null; disabled: boolean; onChange: (category: string | null) => void }) {
  const choices: string[] = [...CAMPAIGN_CATEGORIES];
  if (category && !choices.includes(category)) choices.unshift(category);
  if (disabled) {
    return category ? (
      <Tag tone={categoryTone(category)} size="sm" className="caption-style">
        {category}
      </Tag>
    ) : null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          aria-label={category ? `Category: ${category}` : "Set a category"}
          className="hit focus-visible:ring-ring/60 shrink-0 rounded-full p-0 hover:bg-transparent"
        >
          {category ? (
            <Tag tone={categoryTone(category)} size="sm" className="caption-style">
              {category}
            </Tag>
          ) : (
            <Tag tone="neutral" size="sm" className="caption-style text-subtle border-dashed">
              Category
            </Tag>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={category ?? ""} onValueChange={(value) => onChange(value || null)}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {choice}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="">No category</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Action = { kind: "pause" | "resume" | "remove"; campaign: ThreadCampaign };

function MoreMenu({
  campaigns,
  contactId,
  canAct,
  busy,
  onAction,
  onDoNotContact,
}: {
  campaigns: ThreadCampaign[];
  contactId: string | null;
  canAct: boolean;
  busy: boolean;
  onAction: (action: Action) => void;
  onDoNotContact?: () => void;
}) {
  const router = useRouter();
  const actionable = canAct ? campaigns.filter((campaign) => campaign.canPause || campaign.canResume || campaign.canRemove) : [];
  if (!contactId && actionable.length === 0 && !onDoNotContact) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More" title="More" className="hit">
          <MoreIcon aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {contactId && <DropdownMenuItem onSelect={() => router.push(contactHref(contactId))}>Open contact</DropdownMenuItem>}
        {actionable.map((campaign, index) => (
          <div key={campaign.prospectId} role="group" aria-label={campaign.name}>
            {(contactId || index > 0) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <ChannelIcon channel={campaign.channel} className="size-3 shrink-0" />
              <span className="truncate">{campaign.name}</span>
            </DropdownMenuLabel>
            {campaign.canPause && (
              <DropdownMenuItem disabled={busy} onSelect={() => onAction({ kind: "pause", campaign })}>
                Pause
              </DropdownMenuItem>
            )}
            {campaign.canResume && (
              <DropdownMenuItem disabled={busy} onSelect={() => onAction({ kind: "resume", campaign })}>
                Resume
              </DropdownMenuItem>
            )}
            {campaign.canRemove && (
              <DropdownMenuItem disabled={busy} onSelect={() => onAction({ kind: "remove", campaign })} className="text-danger">
                Remove…
              </DropdownMenuItem>
            )}
          </div>
        ))}
        {onDoNotContact && (
          <>
            {(contactId || actionable.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={busy} onSelect={onDoNotContact} className="text-danger">
              Do not contact…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Variables({ thread }: { thread: ProspectThread }) {
  if (thread.variables.length === 0) return null;
  return (
    <DetailSection title="Variables" className="gap-3">
      <dl className="flex flex-col gap-3">
        {thread.variables.map((variable) => {
          const source = sourceLink(variable.source);
          return (
            <div key={variable.name} className="flex flex-col gap-0.5">
              <dt className="font-mono text-[12px] text-(--tag-purple-text)">{variable.name}</dt>
              <dd className="ui-style break-words">{variable.value}</dd>
              {source && (
                <dd className="caption-style text-subtle break-words">
                  {source.href ? (
                    <a href={source.href} target="_blank" rel="noopener noreferrer" className="hover:text-foreground underline underline-offset-2">
                      {source.label}
                    </a>
                  ) : (
                    source.label
                  )}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </DetailSection>
  );
}

export default function ThreadScreen({ viewer, thread, canAct, pane }: { viewer: Viewer; thread: ProspectThread; canAct: boolean; pane?: { back: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [sends, setSends] = useState<Record<string, SendStatus>>({});
  const [category, setCategory] = useState<{ value: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ThreadCampaign | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [draft, setDraftState] = useState<Draft>({ text: "", chosen: null });
  const [sendError, setSendError] = useState<{ text: string; detail: string | null } | null>(null);
  const draftNow = useRef(draft);
  const end = useRef<HTMLDivElement>(null);
  const opened = thread.campaigns.find((campaign) => campaign.prospectId === thread.prospectId) ?? null;
  const shownCategory = category ? category.value : thread.category;
  const items = withPending(thread.items, pending);
  const latestInbound = thread.items.findLast((item) => item.type === "message" && item.direction === "inbound")?.id ?? null;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, []);

  useSyncSignal("campaigns", () => {
    if (!pane) router.refresh();
  });

  useEffect(() => {
    if (!latestInbound) return;
    let live = true;
    void markConversationReadAction(thread.prospectId)
      .then((outcome) => {
        if (live && outcome.read) router.refresh();
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [thread.prospectId, latestInbound, router]);

  useEffect(() => {
    let live = true;
    async function refresh() {
      const outcome = await refreshProspectThreadAction(thread.prospectId).catch(() => null);
      if (live && outcome?.saved) router.refresh();
    }
    void refresh();
    function onVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [thread.prospectId, router]);

  async function deliver(clientKey: string, prospectId: string, text: string, channel?: CampaignChannel) {
    setSends((current) => ({ ...current, [clientKey]: { state: "sending", error: null } }));
    const outcome = await replyToProspectAction(prospectId, text, clientKey).catch(() => ({ error: SEND_FAILED, result: undefined }));
    if (outcome.error || !outcome.result) {
      const stored = "stored" in outcome ? outcome.stored : undefined;
      const retryable = !("retryable" in outcome) || outcome.retryable !== false;
      setSends((current) => ({ ...current, [clientKey]: { state: "failed", error: outcome.error ?? SEND_FAILED, retryable } }));
      if (channel && failedSendPlan(draftNow.current.text, stored) === "restore") {
        setPending((current) => withoutReply(current, clientKey));
        setDraft(restoredDraft(draftNow.current, { text, channel }));
        setSendError(retryable ? { text: SEND_FAILED, detail: outcome.error ?? null } : { text: outcome.error ?? SEND_FAILED, detail: null });
      }
      if (stored) router.refresh();
      return;
    }
    const messageId = outcome.result.messageId;
    setPending((current) => current.map((reply) => (reply.clientKey === clientKey ? { ...reply, messageId, state: "sent" } : reply)));
    setSends((current) => ({ ...current, [clientKey]: { state: "sent", error: null } }));
    router.refresh();
  }

  function send(option: ReplyOption, text: string) {
    const reply: PendingReply = {
      clientKey: newClientKey(),
      prospectId: option.prospectId,
      channel: option.channel,
      text,
      at: new Date().toISOString(),
      state: "sending",
      messageId: null,
      error: null,
    };
    setPending((current) => [...current, reply]);
    window.requestAnimationFrame(() => end.current?.scrollIntoView({ block: "nearest" }));
    setSendError(null);
    void deliver(reply.clientKey, reply.prospectId, reply.text, reply.channel);
  }

  function setDraft(next: Draft) {
    draftNow.current = next;
    setDraftState(next);
  }

  async function chooseCategory(value: string | null) {
    const before = category;
    setCategory({ value });
    setProblem(null);
    const outcome = await setProspectCategoryAction(thread.prospectId, value).catch(() => ({ error: "Couldn't save. Try again.", category: undefined }));
    if (outcome.error) {
      setCategory(before);
      setProblem(outcome.error);
      return;
    }
    router.refresh();
  }

  async function act(action: Action) {
    setBusy(true);
    setProblem(null);
    const outcome =
      action.kind === "remove"
        ? await removeProspectAction(action.campaign.prospectId).catch(() => ({ error: "Couldn't remove. Try again." }))
        : await setProspectPausedAction(action.campaign.prospectId, action.kind === "pause").catch(() => ({
            error: action.kind === "pause" ? "Couldn't pause. Try again." : "Couldn't resume. Try again.",
          }));
    setBusy(false);
    if (outcome.error) {
      setProblem(outcome.error);
      return;
    }
    router.refresh();
  }

  function statusOf(clientKey: string | null, fallback: ReturnType<typeof messageStatus>, sendError: string | null = null) {
    const local = clientKey ? sends[clientKey] : undefined;
    if (local?.state === "sending") return { text: "Sending…", failed: false };
    if (local?.state === "failed") return local.retryable === false ? { text: local.error ?? SEND_FAILED, failed: true, detail: null, final: true } : { text: "Couldn't send.", failed: true, detail: local.error };
    if (local?.state === "sent" && fallback === "Sending…") return null;
    const failed = fallback === "Couldn't send.";
    return fallback ? { text: fallback, failed, detail: failed ? sendError : null } : null;
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {pane ? (
        <header className="border-border flex min-h-13 shrink-0 items-center gap-2 border-b px-3 py-2 sm:px-4 lg:h-(--header-height) lg:py-0">
          <Button variant="ghost" size="icon" href={pane.back} data-shortcut="back" aria-label="Back to Conversations" title="Back to Conversations" className="text-subtle hit shrink-0 md:hidden">
            <ChevronLeftIcon aria-hidden className="size-3" />
          </Button>
          <h2 className="truncate">{thread.person.name}</h2>
          <CategoryPicker category={shownCategory} disabled={!canAct} onChange={(value) => void chooseCategory(value)} />
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {thread.person.contactId && (
              <Button variant="secondary" href={contactHref(thread.person.contactId)} className="hit max-sm:hidden">
                Open contact
              </Button>
            )}
            <MoreMenu
              campaigns={thread.campaigns}
              contactId={thread.person.contactId}
              canAct={canAct}
              busy={busy}
              onAction={(action) => (action.kind === "remove" ? setRemoving(action.campaign) : void act(action))}
              onDoNotContact={canAct && !thread.doNotContact ? () => setBlocking(true) : undefined}
            />
          </span>
        </header>
      ) : (
        <SectionHeader
          title={thread.person.name}
          viewer={viewer}
          heading={
            <span className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                href={opened ? `/campaigns/${opened.campaignId}` : "/campaigns"}
                data-shortcut="back"
                aria-label={opened ? `Back to ${opened.name}` : "Back to Campaigns"}
                title={opened ? `Back to ${opened.name}` : "Back to Campaigns"}
                className="text-subtle hit shrink-0"
              >
                <ChevronLeftIcon aria-hidden className="size-3" />
              </Button>
              <h1 className="truncate">{thread.person.name}</h1>
              <CategoryPicker category={shownCategory} disabled={!canAct} onChange={(value) => void chooseCategory(value)} />
            </span>
          }
          action={
            <MoreMenu
              campaigns={thread.campaigns}
              contactId={thread.person.contactId}
              canAct={canAct}
              busy={busy}
              onAction={(action) => (action.kind === "remove" ? setRemoving(action.campaign) : void act(action))}
              onDoNotContact={canAct && !thread.doNotContact ? () => setBlocking(true) : undefined}
            />
          }
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={cn("grid min-h-full", !pane && "lg:grid-cols-[minmax(0,1fr)_300px]")}>
          <div className={cn("border-border flex min-w-0 flex-col gap-3 px-3 py-4 sm:px-5", !pane && "border-b lg:border-r lg:border-b-0")}>
            <div className="mx-auto flex w-full max-w-[47.5em] flex-col gap-3 pb-20">
              {thread.doNotContact && <DoNotContactStatus status={thread.doNotContact} target={{ prospectId: thread.prospectId }} canLift={canAct} />}
              {problem && (
                <p role="alert" className="caption-style text-danger">
                  {problem}
                </p>
              )}
              {items.length === 0 && <p className="ui-style text-subtle">No messages yet</p>}
              {items.map((item) => {
                if (item.type === "note") {
                  return (
                    <p key={item.id} className="caption-style text-subtle py-1 text-center" title={item.campaignName}>
                      {noteLabel(item)}
                    </p>
                  );
                }
                if (item.type === "pending") {
                  const reply = item.reply;
                  const status = statusOf(reply.clientKey, "Sending…");
                  return (
                    <Bubble key={item.id} author={viewer.name} channel={reply.channel} at={reply.at} inbound={false} label={`Your reply on ${CHANNEL_LABELS[reply.channel]}`}>
                      <MessageBody message={{ body: reply.text, channel: reply.channel, direction: "outbound" }} />
                      <SendLine status={status} onRetry={status?.failed && !status.final ? () => void deliver(reply.clientKey, reply.prospectId, reply.text) : undefined} />
                    </Bubble>
                  );
                }
                const inbound = item.direction === "inbound";
                const status = statusOf(item.clientKey, messageStatus(item), item.sendError);
                const canRetry = retryable(item) && sends[item.clientKey!]?.state !== "sending";
                return (
                  <Bubble
                    key={item.id}
                    author={item.author}
                    channel={item.channel}
                    at={item.at}
                    inbound={inbound}
                    label={`From ${item.author} on ${CHANNEL_LABELS[item.channel]}`}
                  >
                    <MessageBody message={item} />
                    <SendLine status={status} onRetry={canRetry && status?.failed ? () => void deliver(item.clientKey!, item.prospectId, item.body) : undefined} />
                  </Bubble>
                );
              })}
              <Composer options={thread.replyOptions} preferred={thread.defaultChannel} draft={draft} error={sendError} onDraft={setDraft} onSend={send} />
              <div ref={end} />
            </div>
          </div>
          {!pane && (
            <aside aria-label="About this thread" className="flex min-w-0 flex-col">
              <DetailSection title="Campaigns" className="gap-3">
                <ul className="flex flex-col gap-1.5">
                  {thread.campaigns.map((campaign) => (
                    <li key={campaign.prospectId} className="flex min-w-0">
                      <Link
                        href={`/campaigns/${campaign.campaignId}`}
                        className="caption-style text-soft hover:text-foreground hit flex min-w-0 items-center gap-1.5 transition-colors duration-150"
                      >
                        <ChannelIcon channel={campaign.channel} className="size-3 shrink-0" />
                        <span className="truncate">{campaignStateLine(campaign)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </DetailSection>
              <Variables thread={thread} />
            </aside>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove ${thread.person.name} from ${removing.name}?` : "Remove"}
        description="They get nothing more from this campaign."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) void act({ kind: "remove", campaign: removing });
        }}
      />
      <DoNotContactDialog open={blocking} onOpenChange={setBlocking} name={thread.person.name} target={{ prospectId: thread.prospectId }} />
    </section>
  );
}
