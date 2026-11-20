"use client";

import Button from "@/components/_ui/button";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { MessageAttachments } from "@/components/chat/attachments";
import { ChatAvatar, roomLabel, useChat } from "@/components/chat/chat-context";
import { HookAvatar, HookCardBody } from "@/components/chat/hook-message";
import MessageBody from "@/components/chat/message-body";
import QuotedMessage from "@/components/chat/quoted-message";
import { fullTime, stampWhen } from "@/lib/chat/format";
import type { ChatConversation, ChatPin } from "@/lib/chat/types";
import { useChatPins } from "@/stores/chat-pins-store";

function PinRow({ pin, canUnpin, onOpen }: { pin: ChatPin; canUnpin: boolean; onOpen: (pin: ChatPin) => void }) {
  const { viewer, now, memberNames, pins } = useChat();
  const { message } = pin;
  const author = { id: message.author.id ?? `former:${message.author.name}`, name: message.author.name };
  return (
    <li className="border-border flex gap-3 border-b px-6 py-3 last:border-b-0 max-md:px-4">
      {message.hook ? <HookAvatar /> : <ChatAvatar person={author} size="lg" />}
      <article aria-label={`Pinned message from ${message.author.name}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[14px] font-medium">
            {message.author.name}
            {message.via && <span className="text-subtle font-normal"> via {message.via.name}</span>}
          </span>
          <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="caption-style text-subtle shrink-0 tabular-nums">
            {stampWhen(message.createdAt, now)}
          </time>
        </div>
        {message.hook ? (
          <HookCardBody card={message.hook} body={message.body} />
        ) : (
          <>
            {message.body && (
              <div className="max-h-[11.5em] overflow-hidden">
                <MessageBody body={message.body} format={message.format} viewerId={viewer.id} names={memberNames} everyone={message.everyone} />
              </div>
            )}
            {message.quotedId && <QuotedMessage id={message.quotedId} />}
            <MessageAttachments message={message} />
          </>
        )}
        <span className="caption-style text-faint">
          Pinned{pin.pinnedBy ? ` by ${pin.pinnedBy.id === viewer.id ? "you" : pin.pinnedBy.name}` : ""}
        </span>
        <div className="-ml-2 flex flex-wrap items-center gap-1 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpen(pin)} className="hit max-md:h-11">
            Open
          </Button>
          {canUnpin && (
            <Button variant="ghost" size="sm" aria-label="Unpin" onClick={() => pins.pin(message, false)} className="hit max-md:h-11">
              Unpin
            </Button>
          )}
        </div>
      </article>
    </li>
  );
}

export default function PinnedPanel({ open, onOpenChange, conversation }: { open: boolean; onOpenChange: (open: boolean) => void; conversation: ChatConversation }) {
  const { go } = useChat();
  const pins = useChatPins((store) => store.rooms[conversation.id]);
  const failed = useChatPins((store) => store.failed[conversation.id]);
  const archived = Boolean(conversation.archivedAt);
  const place = roomLabel(conversation);

  function openPin(pin: ChatPin) {
    onOpenChange(false);
    go({ view: { kind: "room", id: conversation.id }, thread: pin.message.parentId, message: pin.message.id });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full md:w-[440px] md:max-w-[440px]">
        <SheetHeader className="max-md:pt-[env(safe-area-inset-top)] max-md:h-auto max-md:min-h-14">
          <SheetTitle className="h3-style truncate">Pinned in {place}</SheetTitle>
          <SheetDescription className="sr-only">Messages pinned in {place}. Anyone in the conversation can pin and unpin.</SheetDescription>
          <SheetCloseButton label="Close" className="hit max-md:size-11" />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {!pins ? (
            failed ? (
              <p role="alert" className="text-danger px-6 py-5 max-md:px-4">
                {failed}
              </p>
            ) : (
              <p role="status" className="text-subtle px-6 py-5 max-md:px-4">
                Loading…
              </p>
            )
          ) : pins.length === 0 ? (
            <p className="text-subtle px-6 py-5 max-md:px-4">Nothing is pinned here yet.</p>
          ) : (
            <ul>
              {pins.map((pin) => (
                <PinRow key={pin.message.id} pin={pin} canUnpin={!archived} onOpen={openPin} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
