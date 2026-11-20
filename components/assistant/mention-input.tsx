"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { MENTION_CLASS, MentionList, ROOM_OPTION, useMentionOptions, type MentionQuery } from "@/components/assistant/mention-list";
import type { MentionOption } from "@/lib/crm/mention-search";
import { liveMentions, roomMentionRanges, type Mention, type MentionKind } from "@/lib/mentions";
import { pickedMention, stripMention } from "@/lib/task-pad";
import { cn } from "@/lib/utils";

export type InputMark = { start: number; end: number; className: string };

function highlightPieces(text: string, mentions: Mention[], extra: InputMark[]) {
  const ranges: { start: number; end: number; className: string }[] = extra.map((mark) => ({ ...mark }));
  for (const mention of mentions) {
    const label = `@${mention.name}`;
    let from = 0;
    for (;;) {
      const index = text.indexOf(label, from);
      if (index < 0) break;
      ranges.push({ start: index, end: index + label.length, className: MENTION_CLASS });
      from = index + label.length;
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const pieces: { text: string; className: string | null }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) pieces.push({ text: text.slice(cursor, range.start), className: null });
    pieces.push({ text: text.slice(range.start, range.end), className: range.className });
    cursor = range.end;
  }
  pieces.push({ text: `${text.slice(cursor)}\u200b`, className: null });
  return pieces;
}

function tightenPunctuation(text: string, mentions: Mention[]) {
  let output = text;
  for (const mention of mentions) {
    const label = `@${mention.name}`;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`${escaped} ([,.;:!?])`, "g"), `${label}$1`);
  }
  return output;
}

function composing(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

export default function MentionInput({
  id,
  inputRef,
  value,
  mentions,
  placeholder,
  onChange,
  onSubmit,
  marks = [],
  kinds,
  listPlacement = "above",
  ariaLabel,
  onFocus,
  composeFocus,
  shortcut,
  autoFocus,
  autoSize,
  onKeyDown: onKey,
  onBlur,
  markdown,
  roomMention,
}: {
  id: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  mentions: Mention[];
  placeholder: string;
  onChange: (value: string, mentions: Mention[]) => void;
  onSubmit: () => void;
  marks?: InputMark[];
  kinds?: MentionKind[];
  listPlacement?: "above" | "below";
  ariaLabel?: string;
  onFocus?: () => void;
  composeFocus?: boolean;
  shortcut?: string;
  autoFocus?: boolean;
  autoSize?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  markdown?: boolean;
  roomMention?: boolean;
}) {
  const [open, setOpen] = useState<MentionQuery | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const picked = useRef<Mention[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const { options, highlight, setHighlight, clear } = useMentionOptions(open, kinds, roomMention);

  function refresh(text: string, caret: number, known: Mention[] = mentions) {
    const found = stripMention(text, caret, { afterMarkers: markdown });
    const tagged = found && [...known, ...picked.current].some((mention) => text.startsWith(`@${mention.name}`, found.start));
    setOpen(found && !tagged ? found : null);
  }

  function pick(option: MentionOption) {
    if (!open) return;
    const { inserted, after } = pickedMention(option.name, value.slice(open.end), { afterMarkers: markdown });
    const next = `${value.slice(0, open.start)}${inserted}${after}`;
    const caret = open.start + inserted.length;
    if (option === ROOM_OPTION) {
      picked.current = [...picked.current.slice(-20), ROOM_OPTION];
      onChange(next, liveMentions(next, mentions));
    } else {
      const chosen: Mention = { kind: option.kind, id: option.id, name: option.name };
      picked.current = [...picked.current.slice(-20), chosen];
      onChange(next, liveMentions(next, [...mentions.filter((mention) => mention.id !== option.id), chosen]));
    }
    setOpen(null);
    clear();
    const node = inputRef.current;
    if (node) {
      node.value = next;
      node.focus();
      node.setSelectionRange(caret, caret);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return;
      }
      if ((event.key === "Enter" && !composing(event)) || event.key === "Tab") {
        event.preventDefault();
        pick(options[Math.min(highlight, options.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        return;
      }
    }
    onKey?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !composing(event)) {
      event.preventDefault();
      onSubmit();
    }
  }

  const roomMarks = roomMention ? roomMentionRanges(value).map((range) => ({ ...range, className: MENTION_CLASS })) : [];
  const pieces = highlightPieces(value, mentions, [...roomMarks, ...marks]);
  const listId = `${id}-mentions`;
  const showList = open !== null && options.length > 0;
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!autoSize || !node) return;
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, autoSize)}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoSize, value, inputRef]);

  return (
    <div ref={box} className="relative min-w-0">
      <div
        aria-hidden
        className="text-foreground pointer-events-none absolute inset-0 overflow-hidden text-[14px] leading-6 break-words whitespace-pre-wrap [@media(pointer:coarse)]:text-[16px]"
      >
        <div style={{ transform: `translateY(-${scrollTop}px)` }}>
          {pieces.map((piece, index) =>
            piece.className ? (
              <mark key={index} className={cn("rounded-[4px]", piece.className)}>
                {piece.text}
              </mark>
            ) : (
              <span key={index}>{piece.text}</span>
            ),
          )}
        </div>
      </div>
      <textarea
        id={id}
        ref={inputRef}
        rows={1}
        value={value}
        role="combobox"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        data-compose-focus={composeFocus ? "" : undefined}
        data-shortcut={shortcut}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onChange={(event) => {
          const next = tightenPunctuation(event.target.value, mentions);
          const kept = liveMentions(next, mentions);
          onChange(next, kept);
          refresh(next, event.target.selectionStart ?? next.length, kept);
        }}
        onSelect={(event) => refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onBlur={() => {
          window.setTimeout(() => setOpen(null), 150);
          onBlur?.();
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="placeholder:text-subtle caret-foreground selection:bg-primary/40 relative block max-h-[200px] min-h-6 w-full resize-none bg-transparent text-[14px] leading-6 text-transparent outline-none"
      />
      {showList && <MentionList id={listId} anchor={box} options={options} highlight={highlight} kinds={kinds} listPlacement={listPlacement} onPick={pick} />}
    </div>
  );
}
