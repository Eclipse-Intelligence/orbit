"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { chatApi } from "@/lib/chat/client";
import { searchReady } from "@/lib/chat/search";
import { CHAT_SEARCH_TEXT_MAX, type ChatMessage } from "@/lib/chat/types";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import RemoveIcon from "@/public/assets/images/chat/remove.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";

const FIND_DEBOUNCE_MS = 250;
const FIND_PAGE = 30;
const KEEP_FOCUS_MS = 150;

type Found = { key: string; messages: ChatMessage[]; error: string | null };

export default function FindBar({ conversationId, focusSignal, onJump, onClose }: { conversationId: string; focusSignal: number; onJump: (message: ChatMessage) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [position, setPosition] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const jump = useRef(onJump);
  const goTo = useRef((message: ChatMessage) => {
    jump.current(message);
    window.setTimeout(() => input.current?.focus({ preventScroll: true }), KEEP_FOCUS_MS);
  });
  const wanted = text.trim();
  const ready = searchReady(wanted);
  const key = `${conversationId}:${wanted}`;
  const current = ready && found?.key === key ? found : null;
  const messages = current?.messages ?? [];

  useEffect(() => {
    jump.current = onJump;
  });

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      chatApi
        .find(conversationId, wanted)
        .then((result) => {
          if (stale) return;
          setFound({ key, messages: result.messages, error: null });
          setPosition(0);
          if (result.messages[0]) goTo.current(result.messages[0]);
        })
        .catch((failure: Error) => {
          if (!stale) setFound({ key, messages: [], error: failure.message });
        });
    }, FIND_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [conversationId, wanted, key, ready]);

  function step(direction: 1 | -1) {
    if (messages.length === 0) return;
    const next = (position + direction + messages.length) % messages.length;
    setPosition(next);
    goTo.current(messages[next]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  }

  const status = !ready ? (wanted ? "Type at least 3 characters" : "") : current === null ? "Searching…" : current.error ? current.error : messages.length === 0 ? "No matches" : `${position + 1} of ${messages.length}${messages.length >= FIND_PAGE ? "+" : ""}`;

  return (
    <div role="search" aria-label="Find in this conversation" className="bg-surface-raised mx-4 mb-2 flex items-center gap-1.5 rounded-[10px] py-1 pr-1 pl-3 max-md:mx-2">
      <SearchIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
      <Input
        ref={input}
        type="search"
        role="searchbox"
        value={text}
        maxLength={CHAT_SEARCH_TEXT_MAX}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        autoComplete="off"
        spellCheck={false}
        className="h-7 min-w-0 flex-1 bg-transparent px-1 text-[13px] hover:bg-transparent focus-visible:bg-transparent focus-visible:border-transparent [&::-webkit-search-cancel-button]:hidden"
      />
      <span role="status" className="caption-style text-subtle shrink-0 px-1 tabular-nums">
        {status}
      </span>
      <span className="flex shrink-0 items-center gap-1 pointer-coarse:gap-5">
        <Button variant="ghost" size="icon-sm" aria-label="Previous match" title="Previous match" disabled={messages.length === 0} onClick={() => step(-1)} className="hit">
          <ChevronDownIcon aria-hidden className="size-3 rotate-180" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next match" title="Next match" disabled={messages.length === 0} onClick={() => step(1)} className="hit">
          <ChevronDownIcon aria-hidden className="size-3" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close find" title="Close find" onClick={onClose} className="hit">
          <RemoveIcon aria-hidden className="size-3" />
        </Button>
      </span>
    </div>
  );
}
