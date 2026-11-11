"use client";

import { memo, useId, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import Tag from "@/components/_ui/tag";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import MentionInput from "@/components/assistant/mention-input";
import { AvatarStack, ChatAvatar, useChat, type ChatPane } from "@/components/chat/chat-context";
import { focusComposer } from "@/components/chat/composer";
import { HookAvatar, HookCardBody } from "@/components/chat/hook-message";
import MessageBody from "@/components/chat/message-body";
import { SEND_FAILED } from "@/components/chat/use-chat-actions";
import { clockTime, fullTime, shortWhen, stampWhen } from "@/lib/chat/format";
import { isLocal } from "@/lib/chat/timeline";
import type { ChatMessage } from "@/lib/chat/types";
import { mentionsIn, plainMentions, type Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CopyIcon from "@/public/assets/images/assistant/copy.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;
const CLICK_GUARD_MS = 700;

type Props = {
  message: ChatMessage;
  continuation: boolean;
  inThread: boolean;
  pane: ChatPane;
  fullStamp?: boolean;
  highlighted?: boolean;
  tabStop?: boolean;
};

function EditBox({ message, onDone }: { message: ChatMessage; onDone: () => void }) {
  const { edit } = useChat();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = () => {
    const from = box.current;
    onDone();
    window.setTimeout(() => focusComposer(from), 0);
  };
  const [value, setValue] = useState(() => plainMentions(message.body));
  const [mentions, setMentions] = useState<Mention[]>(() => mentionsIn(message.body));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!value.trim() || saving) return;
    setSaving(true);
    if (await edit(message, value, mentions)) done();
    else setSaving(false);
  }

  return (
    <div ref={box} className="flex flex-col gap-2 py-1">
      <div className="border-line-strong bg-secondary focus-within:border-ring rounded-xl border px-3 py-1.5">
        <MentionInput
          id={`chat-edit-${id}`}
          inputRef={input}
          value={value}
          mentions={mentions}
          placeholder="Message"
          ariaLabel="Edit message"
          autoFocus
          autoSize={200}
          onChange={(next, kept) => {
            setValue(next);
            setMentions(kept);
          }}
          onSubmit={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              done();
            }
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="caption-style text-subtle max-sm:hidden">Enter to save, Esc to cancel</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={done} className="max-md:h-11">
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!value.trim() || saving} onClick={() => void save()} className="max-md:h-11">
          Save
        </Button>
      </div>
    </div>
  );
}

function ToolButton({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={title ?? label} onClick={onClick}>
      {children}
    </Button>
  );
}

function ChatMessageRow({ message, continuation, inThread, pane, fullStamp, highlighted, tabStop }: Props) {
  const chat = useChat();
  const { viewer, now, failed, editing, setEditing, retry, remove, copyLink, openThread, memberNames } = chat;
  const pressed = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const local = isLocal(message);
  const own = message.author.id === viewer.id;
  const deleted = Boolean(message.deletedAt);
  const error = local && message.clientKey ? failed[message.clientKey] : undefined;
  const isEditing = editing?.id === message.id && editing.pane === pane && !deleted;
  const mentionsMe = (!own || Boolean(message.via)) && !deleted && message.mentions.some((id) => id.toLowerCase() === viewer.id.toLowerCase());
  const canReply = !inThread && !local && !deleted;
  const canEdit = own && !local && !deleted && !message.via;
  const canDelete = (own || (Boolean(message.hook) && !local)) && !deleted;
  const author = { id: message.author.id ?? `former:${message.author.name}`, name: message.author.name };

  function startPress(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    pressed.current = false;
    if (event.pointerType !== "touch" || isEditing) return;
    const timer = window.setTimeout(() => {
      press.current = null;
      pressed.current = true;
      window.setTimeout(() => {
        pressed.current = false;
      }, CLICK_GUARD_MS);
      setMenu(true);
    }, LONG_PRESS_MS);
    press.current = { timer, x: event.clientX, y: event.clientY };
  }

  function movePress(event: PointerEvent<HTMLDivElement>) {
    const current = press.current;
    if (!current) return;
    if (Math.abs(event.clientX - current.x) > MOVE_SLOP || Math.abs(event.clientY - current.y) > MOVE_SLOP) endPress();
  }

  function endPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  async function copy() {
    const ok = await copyLink(message);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function act(run: () => void) {
    setMenu(false);
    run();
  }

  const row = useRef<HTMLDivElement>(null);
  const editRequested = useRef(false);

  function focusEdit() {
    row.current?.querySelector<HTMLTextAreaElement>("textarea[aria-label='Edit message']")?.focus({ preventScroll: true });
  }

  function startEdit() {
    editRequested.current = true;
    setMenu(false);
    flushSync(() => setEditing({ id: message.id, pane }));
    focusEdit();
  }

  const stamp = fullStamp ? stampWhen(message.createdAt, now) : clockTime(message.createdAt);

  return (
    <div
      ref={row}
      data-chat-message={message.id}
      data-chat-own={own ? "" : undefined}
      data-chat-conversation={message.conversationId}
      tabIndex={tabStop ? 0 : -1}
      onPointerDown={startPress}
      onPointerMove={movePress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={(event) => {
        if (!pressed.current || !event.currentTarget.contains(event.target as Node)) return;
        pressed.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (menu || press.current) event.preventDefault();
      }}
      className={cn(
        "group hover:bg-surface-hover focus-visible:bg-surface-hover relative flex gap-3 px-5 outline-none max-md:px-3.5 [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]",
        continuation ? "pt-0.5 pb-1.5" : "pt-1.5 pb-1.5",
        mentionsMe && "bg-[color-mix(in_srgb,var(--primary)_7%,transparent)] shadow-[inset_2px_0_0_color-mix(in_srgb,var(--primary)_80%,white)]",
        highlighted && "bg-surface-selected",
      )}
    >
      {continuation ? (
        <span className="w-7 shrink-0 text-right">
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="text-faint invisible text-[10.5px] leading-[22px] tabular-nums group-hover:visible group-focus-visible:visible">
            {clockTime(message.createdAt)}
          </time>
        </span>
      ) : message.hook ? (
        <HookAvatar />
      ) : (
        <ChatAvatar person={author} size="lg" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {!continuation && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-medium">
              {message.author.name}
              {message.via && <span className="text-subtle font-normal"> via {message.via.name}</span>}
            </span>
            {message.hook && (
              <Tag size="sm" className="h-[18px] self-center text-[11px]">
                Hook
              </Tag>
            )}
            <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="caption-style text-subtle shrink-0 tabular-nums">
              {stamp}
            </time>
          </div>
        )}
        {deleted ? (
          <p className="text-subtle italic">Message deleted</p>
        ) : isEditing ? (
          <EditBox message={message} onDone={() => setEditing(null)} />
        ) : message.hook ? (
          <HookCardBody card={message.hook} body={message.body} />
        ) : (
          <MessageBody body={message.body} viewerId={viewer.id} names={memberNames} className={cn(error && "text-soft")} />
        )}
        {message.editedAt && !deleted && !isEditing && <span className="caption-style text-faint">Edited</span>}
        {error && (
          <div role="alert" className="caption-style text-danger flex flex-wrap items-center gap-1.5">
            <AlertIcon aria-hidden className="size-3" />
            {error === SEND_FAILED ? "Couldn't send." : error}
            <Button variant="link" size="none" className="caption-style min-h-6 max-md:min-h-11" onClick={() => retry(message)}>
              Try again
            </Button>
          </div>
        )}
        {!inThread && message.replyCount > 0 && (
          <button
            type="button"
            onClick={() => openThread(message.conversationId, message.id)}
            className="hover:bg-surface-raised -ml-1.5 mt-1 inline-flex min-h-7 items-center gap-2 self-start rounded-lg py-0.5 pr-2 pl-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-md:min-h-11"
          >
            <AvatarStack people={message.replyAuthors} size="xs" />
            <span className="font-medium text-violet">
              {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
            </span>
            {message.lastReplyAt && <span className="text-subtle">Last reply {shortWhen(message.lastReplyAt, now)}</span>}
          </button>
        )}
      </div>
      {!isEditing && !local && !deleted && (
        <div className="bg-popover border-line-strong shadow-overlay absolute -top-3.5 right-4 hidden items-center gap-0.5 rounded-[10px] border p-0.5 group-focus-within:flex group-hover:flex [@media(pointer:coarse)]:!hidden">
          {canReply && (
            <ToolButton label="Reply in thread" title="Reply in thread (R)" onClick={() => openThread(message.conversationId, message.id)}>
              <ReplyIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
          <ToolButton label={copied ? "Link copied" : "Copy link"} onClick={() => void copy()}>
            {copied ? <CheckIcon aria-hidden className="text-success size-3.5" /> : <LinkIcon aria-hidden className="size-3.5" />}
          </ToolButton>
          {canEdit && (
            <ToolButton label="Edit" title="Edit (Up arrow)" onClick={() => setEditing({ id: message.id, pane })}>
              <EditIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
          {canDelete && (
            <ToolButton label="Delete" onClick={() => setConfirming(true)}>
              <TrashIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
        </div>
      )}
      {local && error && (
        <div className="absolute -top-3.5 right-4 hidden group-hover:flex [@media(pointer:coarse)]:!hidden">
          <Button variant="secondary" size="sm" onClick={() => void remove(message)}>
            Discard
          </Button>
        </div>
      )}
      <span role="status" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this message?"
        description={message.replyCount > 0 ? "Its replies stay in the thread." : undefined}
        confirmLabel="Delete"
        onConfirm={() => void remove(message)}
      />
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent
          side="bottom"
          className="gap-1 px-2 pt-2"
          onCloseAutoFocus={(event) => {
            if (!editRequested.current) return;
            editRequested.current = false;
            event.preventDefault();
            focusEdit();
          }}
        >
          <SheetTitle className="sr-only">Message actions</SheetTitle>
          <SheetDescription className="sr-only">Actions for this message</SheetDescription>
          {canReply && (
            <SheetAction onClick={() => act(() => openThread(message.conversationId, message.id))} icon={<ReplyIcon aria-hidden className="size-4" />}>
              Reply in thread
            </SheetAction>
          )}
          {!deleted && (
            <SheetAction
              onClick={() => act(() => void navigator.clipboard?.writeText(plainMentions(message.body)).catch(() => undefined))}
              icon={<CopyIcon aria-hidden className="size-4" />}
            >
              Copy text
            </SheetAction>
          )}
          {!local && (
            <SheetAction onClick={() => act(() => void copy())} icon={<LinkIcon aria-hidden className="size-4" />}>
              Copy link
            </SheetAction>
          )}
          {canEdit && (
            <SheetAction onClick={startEdit} icon={<EditIcon aria-hidden className="size-4" />}>
              Edit
            </SheetAction>
          )}
          {local && error && (
            <SheetAction onClick={() => act(() => retry(message))} icon={<RefreshIcon aria-hidden className="size-4" />}>
              Try again
            </SheetAction>
          )}
          {canDelete && (
            <SheetAction danger onClick={() => act(() => (local ? void remove(message) : setConfirming(true)))} icon={<TrashIcon aria-hidden className="size-4" />}>
              {local ? "Discard" : "Delete"}
            </SheetAction>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SheetAction({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <Button variant="ghost" size="md" onClick={onClick} className={cn("h-12 w-full justify-start gap-3 rounded-xl px-4 text-[16px] font-normal", danger ? "text-danger hover:text-danger" : "text-foreground")}>
      {icon}
      {children}
    </Button>
  );
}

export default memo(ChatMessageRow);
