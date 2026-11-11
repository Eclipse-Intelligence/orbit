"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import ChatMessageRow from "@/components/chat/chat-message";
import { useChat, type ChatPane } from "@/components/chat/chat-context";
import { dayLabel, dayOf } from "@/lib/chat/format";
import { isLocal, startsGroup } from "@/lib/chat/timeline";
import type { ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const EDGE_PX = 240;
const BOTTOM_PX = 48;
const JUMP_PX = 600;

type Snapshot = { first: string | null; last: string | null; height: number; top: number; atBottom: boolean; hidden: boolean };

function hidden(node: HTMLElement) {
  return node.clientHeight === 0 || node.getClientRects().length === 0;
}

export default function MessageList({
  messages,
  ready,
  dividerId,
  days,
  pane,
  align = "end",
  hasOlder,
  hasNewer,
  focusId,
  bottomSignal = 0,
  header,
  empty,
  label,
  onOlder,
  onNewer,
  onLatest,
  onBottom,
}: {
  messages: ChatMessage[];
  ready: boolean;
  dividerId: string | null;
  days: boolean;
  pane: ChatPane;
  align?: "start" | "end";
  hasOlder: boolean;
  hasNewer: boolean;
  focusId: string | null;
  bottomSignal?: number;
  header?: ReactNode;
  empty?: ReactNode;
  label: string;
  onOlder: () => void;
  onNewer: () => void;
  onLatest: () => void;
  onBottom: (atBottom: boolean) => void;
}) {
  const { viewer, now } = useChat();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const snapshot = useRef<Snapshot>({ first: null, last: null, height: 0, top: 0, atBottom: true, hidden: false });
  const placed = useRef(false);
  const toBottom = useRef(false);
  const signal = useRef(bottomSignal);
  const [far, setFar] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  const [highlight, setHighlight] = useState<string | null>(focusId);
  const bottomRef = useRef(onBottom);
  const edges = useRef({ hasOlder, hasNewer, onOlder, onNewer });
  useLayoutEffect(() => {
    bottomRef.current = onBottom;
    edges.current = { hasOlder, hasNewer, onOlder, onNewer };
  });

  const report = useCallback((node: HTMLElement) => {
    if (hidden(node)) {
      bottomRef.current(false);
      return false;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distance < BOTTOM_PX;
    snapshot.current = { ...snapshot.current, height: node.scrollHeight, top: node.scrollTop, atBottom, hidden: false };
    setFar(distance > JUMP_PX);
    if (atBottom) setUnseen(false);
    bottomRef.current(atBottom && !edges.current.hasNewer);
    return true;
  }, []);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node || !report(node)) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (node.scrollTop < EDGE_PX && edges.current.hasOlder) edges.current.onOlder();
    if (distance < EDGE_PX && edges.current.hasNewer) edges.current.onNewer();
  }, [report]);

  const target = useRef({ focusId, dividerId, ready });
  useLayoutEffect(() => {
    target.current = { focusId, dividerId, ready };
  });

  const place = useCallback((node: HTMLElement) => {
    placed.current = true;
    const { focusId: focus, dividerId: divider } = target.current;
    const element = focus ? node.querySelector<HTMLElement>(`[data-chat-message="${focus}"]`) : divider ? node.querySelector<HTMLElement>("[data-chat-divider]") : null;
    if (element) node.scrollTop = Math.max(0, element.offsetTop - (focus ? node.clientHeight / 3 : 24));
    else node.scrollTop = node.scrollHeight;
  }, []);

  const first = messages[0]?.id ?? null;
  const last = messages[messages.length - 1] ?? null;

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (bottomSignal !== signal.current) {
      signal.current = bottomSignal;
      toBottom.current = true;
    }
    if (hidden(node)) {
      bottomRef.current(false);
      return;
    }
    const previous = snapshot.current;
    let arrived: ChatMessage | null = null;
    if (ready && !placed.current) {
      place(node);
    } else if (ready) {
      const prepended = first !== previous.first && previous.first !== null && messages.some((message) => message.id === previous.first);
      const appended = (last?.id ?? null) !== previous.last;
      const ownNew = appended && last !== null && last.author.id === viewer.id && isLocal(last);
      if (toBottom.current && !hasNewer) {
        toBottom.current = false;
        node.scrollTop = node.scrollHeight;
      } else if (prepended) node.scrollTop = previous.top + (node.scrollHeight - previous.height);
      else if (appended && (previous.atBottom || ownNew)) node.scrollTop = node.scrollHeight;
      if (appended && last && previous.last !== null && last.author.id !== viewer.id && !isLocal(last)) arrived = last;
    }
    snapshot.current = { ...snapshot.current, first, last: last?.id ?? null };
    report(node);
    if (arrived) {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const name = arrived.author.name;
      setAnnouncement((current) => ({ text: `New message from ${name}`, count: current.count + 1 }));
      if (distance >= BOTTOM_PX) setUnseen(true);
    }
    if (!ready) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (hasOlder && node.scrollTop < EDGE_PX) edges.current.onOlder();
    if (hasNewer && distance < EDGE_PX) edges.current.onNewer();
  }, [messages, first, last, ready, focusId, dividerId, viewer.id, hasNewer, hasOlder, bottomSignal, report, place]);

  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (hidden(node)) {
        snapshot.current = { ...snapshot.current, hidden: true };
        bottomRef.current(false);
        return;
      }
      const wasHidden = snapshot.current.hidden;
      if (!placed.current) {
        if (target.current.ready) place(node);
      } else if (snapshot.current.atBottom) node.scrollTop = node.scrollHeight;
      else if (wasHidden) node.scrollTop = snapshot.current.top;
      report(node);
    });
    observer.observe(node);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [report, place]);

  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-message]");
    if (!current || current !== event.target) return;
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? [])];
    const index = rows.indexOf(current);
    const next = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  function jump() {
    setUnseen(false);
    if (hasNewer) {
      toBottom.current = true;
      onLatest();
      return;
    }
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  const lastIndex = messages.length - 1;
  const rows = messages.map((message, index) => {
    const previous = index > 0 ? messages[index - 1] : null;
    const day = dayOf(message.createdAt);
    const sameDay = previous !== null && dayOf(previous.createdAt) === day;
    const newDay = days && !sameDay;
    const divider = message.id === dividerId;
    return { message, newDay, divider, continuation: !newDay && !divider && !startsGroup(previous, message, sameDay) };
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={measure} onKeyDown={onKeyDown} role="log" aria-label={label} aria-live="off" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={content} className={cn("flex min-h-full flex-col pt-3 pb-2", align === "end" ? "justify-end" : "justify-start")}>
          {hasOlder && ready && (
            <p className="caption-style text-subtle py-2 text-center" role="status">
              Loading earlier messages…
            </p>
          )}
          {!hasOlder && header}
          {ready && messages.length === 0 && empty}
          {rows.map(({ message, newDay, divider, continuation }, index) => (
            <Fragment key={message.id}>
              {divider && (
                <div data-chat-divider className="text-violet mx-5 my-2.5 flex items-center gap-2 text-[11.5px] font-medium max-md:mx-3.5" role="separator" aria-label="New messages">
                  New
                  <span aria-hidden className="bg-violet/55 h-px flex-1" />
                </div>
              )}
              {newDay && (
                <div className="caption-style text-subtle mx-5 mt-3.5 mb-1.5 flex items-center gap-2.5 max-md:mx-3.5" role="separator" aria-label={dayLabel(message.createdAt, now)}>
                  <span aria-hidden className="bg-line-subtle h-px flex-1" />
                  {dayLabel(message.createdAt, now)}
                  <span aria-hidden className="bg-line-subtle h-px flex-1" />
                </div>
              )}
              <ChatMessageRow message={message} continuation={continuation} inThread={pane !== "room"} pane={pane} highlighted={highlight === message.id} tabStop={index === lastIndex} />
            </Fragment>
          ))}
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement.text}
        {announcement.count % 2 === 1 ? "\u00a0" : ""}
      </span>
      {(far || hasNewer || unseen) && ready && (
        <Button
          variant="secondary"
          size="none"
          onClick={jump}
          className="bg-popover border-line-strong shadow-overlay absolute bottom-3 left-1/2 h-8 -translate-x-1/2 gap-1.5 border px-3.5 text-[13px] max-md:h-11"
        >
          <ChevronDownIcon aria-hidden className="size-3" />
          {unseen ? "New messages" : "Jump to latest"}
        </Button>
      )}
    </div>
  );
}
