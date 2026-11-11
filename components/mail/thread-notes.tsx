"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Button from "@/components/_ui/button";
import { DiscussionComposer, DiscussionMessages, DiscussionNotice, DiscussionProvider, DiscussionThread } from "@/components/chat/discussion";
import { caretToEnd } from "@/components/chat/composer";
import { useDiscussion, type Discussion } from "@/components/chat/use-discussion";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import type { ChatPerson } from "@/lib/chat/types";
import { addPeopleQuestion } from "@/lib/mail/share-view";

const STICK_PX = 64;
const SIDE_MIN_PX = 760;

export function useNotesLayout(container: RefObject<HTMLElement | null>, active: boolean) {
  const [side, setSide] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!active || !element) return;
    const measure = () => setSide(element.clientWidth >= SIDE_MIN_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, active]);
  return side ? "side" : "below";
}

export type AddPeople = (userIds: string[]) => Promise<string | null>;

function AddPrompt({ discussion, onAdd }: { discussion: Discussion; onAdd: AddPeople }) {
  const prompt = discussion.needsShare;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (!prompt) return null;

  function settle(added: boolean) {
    const pane = box.current?.closest("[data-chat-room-pane]") ?? null;
    discussion.settleNeedsShare(added);
    window.setTimeout(() => {
      const area = pane?.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea");
      area?.focus({ preventScroll: true });
      caretToEnd(area);
    }, 0);
  }
  const question = addPeopleQuestion(prompt.people);

  async function add() {
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    const problem = await onAdd(prompt.people.map((person) => person.id));
    setBusy(false);
    if (problem) setError(problem);
    else settle(true);
  }

  return (
    <div ref={box} role="group" aria-label={question} className="bg-surface-raised border-line-subtle flex flex-col gap-2 rounded-xl border px-3.5 py-3">
      <p role="status" className="ui-style text-foreground">
        {question}
      </p>
      <p className="caption-style text-subtle">They will see the thread, its attachments and notes.</p>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => settle(false)} disabled={busy} className="pointer-coarse:h-11 pointer-coarse:px-4">
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void add()} disabled={busy} className="pointer-coarse:h-11 pointer-coarse:px-4">
          {busy ? "Adding…" : "Add to this thread"}
        </Button>
      </div>
    </div>
  );
}

function NotesBody({ discussion, side }: { discussion: Discussion; side: boolean }) {
  return discussion.threadId ? (
    <DiscussionThread discussion={discussion} backLabel="Notes" />
  ) : (
    <DiscussionMessages discussion={discussion} empty="No notes yet." label="Notes" className={side ? "pt-1" : undefined} />
  );
}

function NotesComposer({ discussion, onAdd }: { discussion: Discussion; onAdd?: AddPeople }) {
  const thread = discussion.threadId;
  return (
    <div className="flex flex-col gap-2">
      <DiscussionNotice discussion={discussion} />
      {onAdd && discussion.needsShare && discussion.needsShare.parentId === thread && <AddPrompt key={discussion.composerVersion} discussion={discussion} onAdd={onAdd} />}
      {thread ? (
        <DiscussionComposer key={thread} discussion={discussion} parentId={thread} noun="note" onEscape={discussion.context.closeThread} />
      ) : (
        <DiscussionComposer discussion={discussion} noun="note" />
      )}
    </div>
  );
}

export default function ThreadNotes({
  shareId,
  viewer,
  layout,
  reveal = false,
  onAdd,
}: {
  shareId: string;
  viewer: ChatPerson;
  layout: "side" | "below";
  reveal?: boolean;
  onAdd?: AddPeople;
}) {
  const discussion = useDiscussion("mail_thread", shareId, viewer);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const thread = discussion.threadId;
  const messages = thread ? discussion.thread?.timeline.messages : discussion.timeline?.messages;
  const size = messages?.length ?? 0;
  const last = messages?.[size - 1]?.id ?? null;

  useShortcut("back", () => {
    if (!discussion.threadId) return false;
    discussion.context.closeThread();
  });

  useLayoutEffect(() => {
    stuck.current = true;
  }, [thread]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (layout === "side" && node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [layout, size, last, thread, discussion.status]);

  const count = discussion.count;
  const section = useRef<HTMLElement>(null);
  const revealed = useRef(false);
  useEffect(() => {
    if (!reveal || revealed.current || discussion.status !== "ready") return;
    revealed.current = true;
    section.current?.scrollIntoView({ block: "nearest" });
    section.current?.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.focus({ preventScroll: true });
  }, [reveal, discussion.status]);

  if (layout === "below") {
    return (
      <DiscussionProvider discussion={discussion}>
        <section ref={section} data-chat-room-pane aria-labelledby={`notes-${shareId}`} className="border-line-subtle mt-2 flex flex-col gap-2 border-t px-4 pt-4">
          <div className="flex items-baseline gap-2">
            <h3 id={`notes-${shareId}`} className="flex-1">
              Notes
            </h3>
            {count > 0 && <span className="caption-style text-subtle tabular-nums">{count}</span>}
          </div>
          <p className="caption-style text-subtle -mt-1">Only people in this thread</p>
          <div className="px-5 max-md:px-3.5">
            <NotesBody discussion={discussion} side={false} />
          </div>
          <NotesComposer discussion={discussion} onAdd={onAdd} />
        </section>
      </DiscussionProvider>
    );
  }

  return (
    <DiscussionProvider discussion={discussion}>
      <aside ref={section} data-chat-room-pane data-quick-add-hide="" aria-labelledby={`notes-${shareId}`} className="border-line-subtle flex min-h-0 w-[19rem] shrink-0 flex-col border-l xl:w-[21rem]">
        <div className="flex shrink-0 items-baseline gap-2 px-5 pt-3 pb-2">
          <h3 id={`notes-${shareId}`} className="flex-1">
            Notes
          </h3>
          <span className="caption-style text-subtle">Only people in this thread</span>
        </div>
        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2"
        >
          <NotesBody discussion={discussion} side />
        </div>
        <div className="shrink-0 px-3 pt-1 pb-3">
          <NotesComposer discussion={discussion} onAdd={onAdd} />
        </div>
      </aside>
    </DiscussionProvider>
  );
}
