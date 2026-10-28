"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { searchMentionsAction, type MentionOption } from "@/app/(crm)/search";
import { liveMentions, type Mention, type MentionKind } from "@/lib/mentions";
import { stripMention } from "@/lib/task-pad";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<MentionKind, string> = { contact: "Person", company: "Company", task: "Task", opportunity: "Opportunity", proposal: "Proposal" };

type Open = { start: number; end: number; query: string };

export type InputMark = { start: number; end: number; className: string };

const MENTION_CLASS = "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]";

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
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [found, setFound] = useState<{ query: string; options: MentionOption[] }>({ query: "", options: [] });
  const [highlight, setHighlight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const picked = useRef<Mention[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchMentionsAction(open.query)
        .then((options) => {
          if (!live) return;
          setFound({ query: open.query, options: kinds ? options.filter((option) => kinds.includes(option.kind)) : options });
          setHighlight(0);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, kinds]);

  function refresh(text: string, caret: number, known: Mention[] = mentions) {
    const found = stripMention(text, caret);
    const tagged = found && [...known, ...picked.current].some((mention) => text.startsWith(`@${mention.name}`, found.start));
    setOpen(found && !tagged ? found : null);
  }

  function pick(option: MentionOption) {
    if (!open) return;
    const after = value.slice(open.end).replace(/^\s+/, "");
    const inserted = `@${option.name} `;
    const next = `${value.slice(0, open.start)}${inserted}${after}`;
    const caret = open.start + inserted.length;
    const chosen: Mention = { kind: option.kind, id: option.id, name: option.name };
    picked.current = [...picked.current.slice(-20), chosen];
    onChange(next, liveMentions(next, [...mentions.filter((mention) => mention.id !== option.id), chosen]));
    setOpen(null);
    setFound({ query: "", options: [] });
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
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(options[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  }

  const options = open && found.query === open.query ? found.options : [];
  const pieces = highlightPieces(value, mentions, marks);
  const listId = `${id}-mentions`;
  const showList = open !== null && options.length > 0;

  useLayoutEffect(() => {
    if (!showList) return;
    const measure = () => {
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.round(Math.min(352, Math.max(rect.width, 240), window.innerWidth - 16));
      const left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)));
      const next =
        listPlacement === "above"
          ? { left, width, top: undefined, bottom: Math.round(window.innerHeight - rect.top + 8), maxHeight: Math.round(Math.min(288, rect.top - 16)) }
          : { left, width, top: Math.round(rect.bottom + 8), bottom: undefined, maxHeight: Math.round(Math.min(288, window.innerHeight - rect.bottom - 16)) };
      setPlace((current) =>
        current && current.left === next.left && current.width === next.width && current.top === next.top && current.bottom === next.bottom && current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && list.current?.contains(event.target)) return;
      measure();
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [showList, listPlacement]);

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
        onBlur={() => window.setTimeout(() => setOpen(null), 150)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="placeholder:text-subtle caret-foreground selection:bg-primary/40 relative block max-h-[200px] min-h-6 w-full resize-none bg-transparent text-[14px] leading-6 text-transparent outline-none"
      />
      {showList && place && createPortal(
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={kinds ? "Tag a person or company" : "Tag a person, company, task, opportunity or proposal"}
          style={place}
          className="bg-popover border-line-strong shadow-overlay fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border p-1"
        >
          {options.map((option, index) => (
            <li key={`${option.kind}-${option.id}`} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left",
                  index === highlight ? "bg-white/[0.07]" : "hover:bg-white/5",
                )}
              >
                <span className="text-foreground w-full truncate text-[13.5px] leading-5">{option.name}</span>
                <span className="caption-style text-subtle w-full truncate">
                  {KIND_LABELS[option.kind]}
                  {option.detail ? ` · ${option.detail}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
