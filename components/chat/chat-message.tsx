"use client";

import Link from "next/link";
import { memo, useId, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import Tag from "@/components/_ui/tag";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import { MessageAttachments, UploadQueue } from "@/components/chat/attachments";
import { AvatarStack, ChatAvatar, useChat, type ChatPane } from "@/components/chat/chat-context";
import type { ChatInputHandle } from "@/components/chat/chat-input";
import { ComposerBox, focusComposer } from "@/components/chat/composer";
import EmojiPopover from "@/components/chat/emoji-popover";
import { HookAvatar, HookCardBody } from "@/components/chat/hook-message";
import MessageLinks from "@/components/chat/link-previews";
import MessageBody from "@/components/chat/message-body";
import { askLabel, CREATE_TASK_LABEL, useOrbitActions } from "@/components/chat/orbit-actions";
import QuotedMessage from "@/components/chat/quoted-message";
import Reactions from "@/components/chat/reactions";
import { SEND_FAILED } from "@/components/chat/use-chat-actions";
import { REMIND_CHOICES } from "@/components/chat/use-saved";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { pushRecentEmoji, QUICK_REACTIONS } from "@/lib/chat/client";
import { clockTime, fullTime, shortWhen, stampWhen } from "@/lib/chat/format";
import { CHAT_SAVED_PATH } from "@/lib/chat/routes";
import { canSaveMessage } from "@/lib/chat/saved";
import { isLocal } from "@/lib/chat/timeline";
import type { ChatMessage } from "@/lib/chat/types";
import { mentionsIn, plainMentions, ROOM_MENTION_MAX_MEMBERS, type Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useChatShare } from "@/stores/chat-share-store";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import BellIcon from "@/public/assets/images/chat/bell.svg";
import BookmarkIcon from "@/public/assets/images/chat/bookmark.svg";
import CopyIcon from "@/public/assets/images/assistant/copy.svg";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PinIcon from "@/public/assets/images/chat/pin.svg";
import ShareIcon from "@/public/assets/images/chat/share.svg";
import TaskIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import SmilePlusIcon from "@/public/assets/images/chat/smile-plus.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";
import UnreadIcon from "@/public/assets/images/chat/unreads.svg";

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;
const CLICK_GUARD_MS = 700;
const SHARE_LABEL = "Share message";

type Props = {
  message: ChatMessage;
  continuation: boolean;
  inThread: boolean;
  pane: ChatPane;
  fullStamp?: boolean;
  highlighted?: boolean;
  tabStop?: boolean;
  readOnly?: boolean;
};

function EditBox({ message, pane, onDone }: { message: ChatMessage; pane: ChatPane; onDone: () => void }) {
  const { edit, discussion, conversation, memberNames } = useChat();
  const id = useId();
  const roomMention = !discussion && pane === "room" && !message.parentId && conversation(message.conversationId)?.kind === "room" && memberNames.size <= ROOM_MENTION_MAX_MEMBERS;
  const input = useRef<ChatInputHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = () => {
    const from = box.current;
    onDone();
    window.setTimeout(() => focusComposer(from), 0);
  };
  const [value, setValue] = useState(() => plainMentions(message.body));
  const [mentions, setMentions] = useState<Mention[]>(() => mentionsIn(message.body));
  const [saving, setSaving] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);
  const kept = message.attachments.filter((file) => !removed.includes(file.id));
  const empty = !value.trim() && kept.length === 0 && !message.quotedId;

  async function save() {
    if (empty || saving) return;
    setSaving(true);
    if (await edit(message, value, mentions, removed)) done();
    else setSaving(false);
  }

  return (
    <div ref={box} className="flex flex-col gap-1 py-1">
      <ComposerBox
        id={`chat-edit-${id}`}
        inputRef={input}
        value={value}
        mentions={mentions}
        placeholder="Message"
        label="Edit message"
        submitVerb="save"
        scope={pane === "room" && !discussion ? "room" : "thread"}
        roomMention={roomMention}
        autoFocus
        queue={
          kept.length > 0 ? (
            <UploadQueue
              files={kept.map((file) => ({ key: file.id, name: file.name, size: file.size, contentType: file.contentType, preview: null, status: "done", progress: 1, id: file.id, width: file.width, height: file.height }))}
              onRemove={(id) => setRemoved((current) => [...current, id])}
              onRetry={() => undefined}
            />
          ) : null
        }
        actions={
          <span className="flex items-center gap-2 pointer-coarse:gap-3">
            <Button variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={done} className="hit max-md:h-11">
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={empty || saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void save()} className="hit max-md:h-11">
              Save
            </Button>
          </span>
        }
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
      <span className="caption-style text-subtle px-1 max-sm:hidden">Enter to save, Esc to cancel</span>
    </div>
  );
}

function ToolButton({ label, title, onClick, children, className }: { label: string; title?: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={title ?? label} onClick={onClick} className={className}>
      {children}
    </Button>
  );
}

function ChatMessageRow({ message, continuation, inThread, pane, fullStamp, highlighted, tabStop, readOnly = false }: Props) {
  const chat = useChat();
  const { viewer, now, failed, editing, setEditing, retry, remove, react, copyLink, openThread, memberNames, markUnread, discussion, saved, pins, go } = chat;
  const unreadHint = useShortcutHint("chat-mark-unread");
  const [picking, setPicking] = useState(false);
  const quick = chat.emoji.recent.slice(0, QUICK_REACTIONS);
  const pickRequested = useRef(false);
  const pressed = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const [remindChoices, setRemindChoices] = useState(false);
  const [remindMenu, setRemindMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const afterMenu = useRef<(() => void) | null>(null);
  const orbit = useOrbitActions(message);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const local = isLocal(message);
  const own = message.author.id === viewer.id;
  const deleted = Boolean(message.deletedAt);
  const error = local && message.clientKey ? failed[message.clientKey] : undefined;
  const isEditing = editing?.id === message.id && editing.pane === pane && !deleted;
  const mentionsMe =
    (!own || Boolean(message.via)) && !deleted && (message.mentions.some((id) => id.toLowerCase() === viewer.id.toLowerCase()) || message.everyone === true);
  const canReply = !inThread && !local && !deleted && !readOnly;
  const canEdit = own && !local && !deleted && !message.via && !readOnly;
  const canDelete = (own || (Boolean(message.hook) && !local)) && !deleted && (!readOnly || local);
  const canMarkUnread = pane === "room" && !discussion && !inThread && !message.parentId && !local && !deleted && !readOnly && message.kind !== "event";
  const canReact = !local && !deleted && !readOnly;
  const canSave = canSaveMessage(message);
  const isSaved = canSave && saved.isSaved(message.id);
  const canShare = canSave;
  const canPin = canSave && !readOnly && !discussion && pins.known(message.conversationId);
  const isPinned = canSave && pins.isPinned(message);
  const pinLabel = isPinned ? "Unpin" : "Pin";
  const author = { id: message.author.id ?? `former:${message.author.name}`, name: message.author.name };

  function startPress(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    pressed.current = false;
    if (event.pointerType !== "touch" || isEditing || deleted) return;
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

  function closeMenu() {
    setMenu(false);
    setRemindChoices(false);
  }

  function act(run: () => void) {
    closeMenu();
    run();
  }

  function runAfterClose(event: Event) {
    const run = afterMenu.current;
    if (!run) return false;
    afterMenu.current = null;
    event.preventDefault();
    run();
    return true;
  }

  function actAfterClose(run: () => void) {
    afterMenu.current = run;
    closeMenu();
  }

  const row = useRef<HTMLDivElement>(null);
  const editRequested = useRef(false);

  function focusEdit() {
    row.current?.querySelector<HTMLElement>("[data-chat-input][aria-label='Edit message']")?.focus({ preventScroll: true });
  }

  function startEdit() {
    editRequested.current = true;
    closeMenu();
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
        if (canMarkUnread && event.altKey && !isEditing && event.currentTarget.contains(event.target as Node)) {
          event.preventDefault();
          event.stopPropagation();
          void markUnread(message.conversationId, message.id);
          return;
        }
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
          <EditBox message={message} pane={pane} onDone={() => setEditing(null)} />
        ) : message.hook ? (
          <HookCardBody card={message.hook} body={message.body} />
        ) : (
          <>
            {message.body && <MessageBody body={message.body} format={message.format} viewerId={viewer.id} names={memberNames} everyone={message.everyone} className={cn(error && "text-soft")} />}
            {message.quotedId && <QuotedMessage id={message.quotedId} />}
            <MessageAttachments message={message} />
            {!local && <MessageLinks message={message} viewerId={viewer.id} canRemove={!readOnly} />}
          </>
        )}
        {message.editedAt && !deleted && !isEditing && <span className="caption-style text-faint">Edited</span>}
        {error && (
          <div role="alert" className="caption-style text-danger flex flex-wrap items-center gap-1.5 md:pointer-coarse:my-2">
            <AlertIcon aria-hidden className="size-3" />
            {error === SEND_FAILED ? "Couldn't send." : error}
            <Button variant="link" size="none" className="caption-style hit min-h-6 max-md:min-h-11" onClick={() => retry(message)}>
              Try again
            </Button>
          </div>
        )}
        {!local && !deleted && !isEditing && (
          <Reactions message={message} viewerId={viewer.id} readOnly={!canReact} onToggle={(emoji) => react(message, emoji)} onAdd={() => setPicking(true)} />
        )}
        {!inThread && message.replyCount > 0 && (
          <button
            type="button"
            onClick={() => openThread(message.conversationId, message.id)}
            className="hover:bg-surface-raised hit -ml-1.5 mt-1 inline-flex min-h-7 items-center gap-2 self-start rounded-lg py-0.5 pr-2 pl-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-md:min-h-11 md:pointer-coarse:mt-1.5 md:pointer-coarse:mb-0.5"
          >
            <AvatarStack people={message.replyAuthors} size="xs" />
            <span className="font-medium text-violet">
              {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
            </span>
            {message.lastReplyAt && <span className="text-subtle">Last reply {shortWhen(message.lastReplyAt, now)}</span>}
          </button>
        )}
        {isPinned && !isEditing && (
          <span className="caption-style text-subtle mt-1 inline-flex items-center gap-1 self-start">
            <PinIcon aria-hidden className="size-3" />
            Pinned
          </span>
        )}
        {isSaved && !isEditing && (
          <Link
            href={CHAT_SAVED_PATH}
            aria-label="Saved. Open Saved"
            onClick={(event) => {
              if (discussion || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              go({ view: { kind: "saved" }, thread: null, message: null });
            }}
            className="caption-style text-subtle hover:text-soft hit mt-1 inline-flex min-h-5 items-center gap-1 self-start rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:mt-2.5 pointer-coarse:mb-1.5"
          >
            <BookmarkIcon aria-hidden className="text-primary size-3 fill-current" />
            Saved
          </Link>
        )}
      </div>
      {!isEditing && !local && !deleted && (
        <div
          className={cn(
            "bg-popover border-line-strong shadow-overlay absolute -top-3.5 right-4 hidden items-center gap-0.5 rounded-[10px] border p-0.5 group-focus-within:flex group-hover:flex [@media(pointer:coarse)]:!hidden",
            (picking || more || remindMenu) && "flex",
          )}
        >
          {canReact && (
            <>
              {quick.slice(0, 3).map((emoji) => (
                <ToolButton key={emoji} label={`React with ${emoji}`} onClick={() => react(message, emoji)} className="text-[15px] leading-none">
                  {emoji}
                </ToolButton>
              ))}
              <span aria-hidden className="bg-line-strong mx-0.5 h-4 w-px" />
              <ToolButton label="Add reaction" onClick={() => setPicking(true)}>
                <SmilePlusIcon aria-hidden className="size-3.5" />
              </ToolButton>
            </>
          )}
          {canReply && (
            <ToolButton label="Reply in thread" title="Reply in thread (R)" onClick={() => openThread(message.conversationId, message.id)}>
              <ReplyIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
          {canMarkUnread && (
            <ToolButton label="Mark unread" title={unreadHint ? `Mark unread (${unreadHint})` : "Mark unread"} onClick={() => void markUnread(message.conversationId, message.id)}>
              <UnreadIcon aria-hidden className="size-3.5" />
            </ToolButton>
          )}
          {canSave && (
            <>
              <ToolButton label={isSaved ? "Remove from Saved" : "Save"} onClick={() => saved.save(message, !isSaved)}>
                <BookmarkIcon aria-hidden className={cn("size-3.5", isSaved && "text-primary fill-current")} />
              </ToolButton>
              <DropdownMenu open={remindMenu} onOpenChange={setRemindMenu}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Remind me about this" title="Remind me about this">
                    <BellIcon aria-hidden className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[148px]">
                  {REMIND_CHOICES.map((choice) => (
                    <DropdownMenuItem key={choice.when} onSelect={() => saved.remind(message, choice.when)}>
                      {choice.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
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
          {(orbit.canCreateTask || orbit.canAsk || canShare || canPin) && (
            <DropdownMenu modal={false} open={more} onOpenChange={setMore}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
                  <MoreIcon aria-hidden className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]" onCloseAutoFocus={runAfterClose}>
                {canPin && (
                  <DropdownMenuItem onSelect={() => pins.pin(message, !isPinned)}>
                    <PinIcon aria-hidden className={cn("size-3.5 shrink-0", isPinned ? "text-foreground" : "text-subtle")} />
                    {pinLabel}
                  </DropdownMenuItem>
                )}
                {canShare && (
                  <DropdownMenuItem onSelect={() => {
                      afterMenu.current = () => useChatShare.getState().open(message);
                    }}>
                    <ShareIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                    {SHARE_LABEL}
                  </DropdownMenuItem>
                )}
                {orbit.canCreateTask && (
                  <DropdownMenuItem onSelect={() => {
                      afterMenu.current = orbit.createTask;
                    }}>
                    <TaskIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                    {CREATE_TASK_LABEL}
                  </DropdownMenuItem>
                )}
                {orbit.canAsk && (
                  <DropdownMenuItem onSelect={() => {
                      afterMenu.current = orbit.ask;
                    }}>
                    <SparkleIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
                    {askLabel(message)}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
      {canReact && picking && (
        <EmojiPopover
          open={picking}
          onOpenChange={setPicking}
          onPick={(emoji) => {
            pushRecentEmoji(viewer.id, emoji);
            react(message, emoji);
          }}
        >
          <span aria-hidden className="pointer-events-none absolute top-0 right-4 size-px" />
        </EmojiPopover>
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
      <Sheet
        open={menu}
        onOpenChange={(open) => {
          setMenu(open);
          if (!open) setRemindChoices(false);
        }}
      >
        <SheetContent
          side="bottom"
          className="gap-1 overflow-y-auto px-2 pt-2 [&>*]:shrink-0"
          onCloseAutoFocus={(event) => {
            if (pickRequested.current) {
              pickRequested.current = false;
              event.preventDefault();
              setPicking(true);
              return;
            }
            if (runAfterClose(event)) return;
            if (!editRequested.current) return;
            editRequested.current = false;
            event.preventDefault();
            focusEdit();
          }}
        >
          <SheetTitle className="sr-only">Message actions</SheetTitle>
          <SheetDescription className="sr-only">Actions for this message</SheetDescription>
          {canReact && (
            <div role="group" aria-label="Reactions" className="flex items-center justify-between gap-1 px-2 pt-1 pb-2.5">
              {quick.map((emoji) => (
                <Button
                  key={emoji}
                  variant="ghost"
                  size="none"
                  aria-label={`React with ${emoji}`}
                  aria-pressed={message.reactions.some((reaction) => reaction.emoji === emoji && reaction.mine)}
                  onClick={() => act(() => react(message, emoji))}
                  className="bg-surface-raised aria-pressed:bg-surface-selected size-12 rounded-full text-[22px] leading-none"
                >
                  {emoji}
                </Button>
              ))}
              <Button variant="ghost" size="none" aria-label="Add reaction" onClick={() => {
                  pickRequested.current = true;
                  closeMenu();
                }} className="bg-surface-raised text-soft size-12 rounded-full">
                <SmilePlusIcon aria-hidden className="size-5" />
              </Button>
            </div>
          )}
          {canReply && (
            <SheetAction onClick={() => act(() => openThread(message.conversationId, message.id))} icon={<ReplyIcon aria-hidden className="size-4" />}>
              Reply in thread
            </SheetAction>
          )}
          {canSave && (
            <SheetAction onClick={() => act(() => saved.save(message, !isSaved))} icon={<BookmarkIcon aria-hidden className={cn("size-4", isSaved && "text-primary fill-current")} />}>
              {isSaved ? "Remove from Saved" : "Save"}
            </SheetAction>
          )}
          {canSave && (
            <SheetAction aria-expanded={remindChoices} onClick={() => setRemindChoices((open) => !open)} icon={<BellIcon aria-hidden className="size-4" />}>
              Remind me about this
            </SheetAction>
          )}
          {canSave && remindChoices && (
            <div role="group" aria-label="Remind me" className="flex flex-col gap-1 pl-8">
              {REMIND_CHOICES.map((choice) => (
                <SheetAction key={choice.when} onClick={() => act(() => saved.remind(message, choice.when))} icon={null}>
                  {choice.label}
                </SheetAction>
              ))}
            </div>
          )}
          {!deleted && message.body.trim() !== "" && (
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
          {canMarkUnread && (
            <SheetAction onClick={() => act(() => void markUnread(message.conversationId, message.id))} icon={<UnreadIcon aria-hidden className="size-4" />}>
              Mark unread
            </SheetAction>
          )}
          {canPin && (
            <SheetAction onClick={() => act(() => pins.pin(message, !isPinned))} icon={<PinIcon aria-hidden className={cn("size-4", isPinned && "text-primary")} />}>
              {pinLabel}
            </SheetAction>
          )}
          {canShare && (
            <SheetAction onClick={() => actAfterClose(() => useChatShare.getState().open(message))} icon={<ShareIcon aria-hidden className="size-4" />}>
              {SHARE_LABEL}
            </SheetAction>
          )}
          {orbit.canCreateTask && (
            <SheetAction onClick={() => actAfterClose(orbit.createTask)} icon={<TaskIcon aria-hidden className="size-4" />}>
              {CREATE_TASK_LABEL}
            </SheetAction>
          )}
          {orbit.canAsk && (
            <SheetAction onClick={() => actAfterClose(orbit.ask)} icon={<SparkleIcon aria-hidden className="size-4" />}>
              {askLabel(message)}
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
          {canDelete && (!local || error) && (
            <SheetAction danger onClick={() => act(() => (local ? void remove(message) : setConfirming(true)))} icon={<TrashIcon aria-hidden className="size-4" />}>
              {local ? "Discard" : "Delete"}
            </SheetAction>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SheetAction({ children, icon, onClick, danger, ...rest }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean; "aria-expanded"?: boolean }) {
  return (
    <Button variant="ghost" size="md" onClick={onClick} {...rest} className={cn("h-12 w-full justify-start gap-3 rounded-xl px-4 text-[16px] font-normal", danger ? "text-danger hover:text-danger" : "text-foreground")}>
      {icon}
      {children}
    </Button>
  );
}

export default memo(ChatMessageRow);
