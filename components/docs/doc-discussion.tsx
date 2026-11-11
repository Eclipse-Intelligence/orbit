"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/_ui/sheet";
import { DiscussionComposer, DiscussionMessages, DiscussionNotice, DiscussionProvider, DiscussionThread, holdEscape } from "@/components/chat/discussion";
import { useKeyboardFit } from "@/components/chat/use-keyboard-fit";
import type { Discussion } from "@/components/chat/use-discussion";
import { cn } from "@/lib/utils";
import ChatIcon from "@/public/assets/images/chat/chat.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const STICK_PX = 64;

export function DiscussionButton({ discussion, pressed, compact, onClick }: { discussion: Discussion; pressed: boolean; compact?: boolean; onClick: () => void }) {
  const count = discussion.count;
  const label = count > 0 ? `Discussion, ${count} ${count === 1 ? "comment" : "comments"}` : "Discussion";
  if (compact) {
    return (
      <Button variant="secondary" size="icon" aria-label={label} aria-pressed={pressed} title="Discussion" onClick={onClick} className="relative size-11">
        <ChatIcon aria-hidden className="size-3.5" />
        {count > 0 && <span className="caption-style text-subtle absolute right-1 bottom-0.5 tabular-nums">{count}</span>}
      </Button>
    );
  }
  return (
    <Button
      variant={pressed ? "secondary" : "ghost"}
      size="sm"
      aria-label={label}
      aria-pressed={pressed}
      title="Discussion"
      onClick={onClick}
      className={cn("h-[30px] gap-1.5 px-2.5", pressed && "text-foreground")}
    >
      <ChatIcon aria-hidden className="size-3.5" />
      Discussion
      {count > 0 && <span className="text-subtle tabular-nums">{count}</span>}
    </Button>
  );
}

export function DocDiscussionPanel({ discussion, title, phone, onClose }: { discussion: Discussion; title: string; phone?: boolean; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const thread = discussion.threadId;
  const messages = thread ? discussion.thread?.timeline.messages : discussion.timeline?.messages;
  const size = messages?.length ?? 0;
  const last = messages?.[size - 1]?.id ?? null;

  useLayoutEffect(() => {
    stuck.current = true;
  }, [thread]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [size, last, thread, discussion.status]);

  return (
    <DiscussionProvider discussion={discussion}>
      <div data-chat-room-pane className="flex min-h-0 flex-1 flex-col">
        <div className={cn("flex shrink-0 items-center gap-2 px-5 pt-3 pb-2", phone && "border-border border-b px-3.5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2.5")}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3>Discussion</h3>
            {phone && <span className="caption-style text-subtle truncate">{title}</span>}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close discussion" title="Close discussion" onClick={onClose} className="max-md:size-11">
            <XIcon aria-hidden className="size-4" />
          </Button>
        </div>
        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2 max-md:px-3.5"
        >
          {thread ? <DiscussionThread discussion={discussion} backLabel="Discussion" /> : <DiscussionMessages discussion={discussion} className="pt-1" />}
        </div>
        <div className="flex shrink-0 flex-col gap-2 px-4 pt-1 pb-4 max-md:px-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <DiscussionNotice discussion={discussion} />
          {thread ? (
            <DiscussionComposer key={thread} discussion={discussion} parentId={thread} autoFocus onEscape={discussion.context.closeThread} />
          ) : (
            <DiscussionComposer discussion={discussion} autoFocus={!phone} onEscape={onClose} />
          )}
        </div>
      </div>
    </DiscussionProvider>
  );
}

function PhoneSheetBody({ discussion, title, onClose }: { discussion: Discussion; title: string; onClose: () => void }) {
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const sheetRef = useMemo(() => ({ current: sheet }), [sheet]);
  useKeyboardFit(sheetRef, Boolean(sheet));
  return (
    <SheetContent
      ref={setSheet}
      side="right"
      className="w-full"
      aria-describedby={undefined}
      onEscapeKeyDown={(event) => {
        if (holdEscape(discussion)) event.preventDefault();
      }}
    >
      <SheetTitle className="sr-only">Discussion</SheetTitle>
      <DocDiscussionPanel discussion={discussion} title={title} phone onClose={onClose} />
    </SheetContent>
  );
}

export function PhoneDiscussionSheet({ open, discussion, title, onClose }: { open: boolean; discussion: Discussion; title: string; onClose: () => void }) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <PhoneSheetBody discussion={discussion} title={title} onClose={onClose} />
    </Sheet>
  );
}
