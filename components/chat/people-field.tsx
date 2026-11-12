"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChatAvatar } from "@/components/chat/chat-context";
import type { ChatPerson } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export type ChatCandidate = ChatPerson & { email: string | null };

const MAX_SHOWN = 8;

export function matchPeople<T extends ChatCandidate>(people: T[], query: string, exclude: Set<string>): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return people.filter((person) => {
    if (exclude.has(person.id)) return false;
    const haystack = `${person.name} ${person.email ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function pickerOpen() {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.chatPicker !== undefined && active.getAttribute("aria-expanded") === "true";
}

export default function PeopleField({
  inputId,
  people,
  selected,
  onChange,
  loading,
  autoFocus,
}: {
  inputId: string;
  people: ChatCandidate[];
  selected: ChatCandidate[];
  onChange: (selected: ChatCandidate[]) => void;
  loading?: boolean;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const chosen = new Set(selected.map((person) => person.id));
  const options = matchPeople(people, query, chosen).slice(0, MAX_SHOWN);
  const showList = open && (options.length > 0 || loading || query.trim().length > 0);
  const active = highlight === null ? (query.trim() ? 0 : null) : Math.min(highlight, Math.max(0, options.length - 1));
  const activeId = showList && active !== null && options[active] ? `${listId}-${options[active].id}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function add(person: ChatCandidate) {
    onChange([...selected, person]);
    setQuery("");
    setHighlight(null);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const from = active ?? (event.key === "ArrowDown" ? -1 : 0);
      setHighlight((from + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Enter") {
      if (!showList || active === null || !options[active]) return;
      event.preventDefault();
      add(options[active]);
    } else if (event.key === "Backspace" && query === "" && selected.length > 0) {
      onChange(selected.slice(0, -1));
    } else if (event.key === "Escape" && showList) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="border-line-strong bg-secondary focus-within:border-ring focus-within:ring-ring/25 flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border px-1.5 py-1 focus-within:ring-2"
        onClick={() => input.current?.focus()}
      >
        {selected.map((person) => (
          <span key={person.id} className="text-soft flex h-7 max-w-full items-center gap-1.5 rounded-full bg-white/6 pr-1 pl-2 text-[12.5px] max-md:h-11 max-md:pr-0">
            <ChatAvatar person={person} size="xs" />
            <span className="truncate">{person.name}</span>
            <button
              type="button"
              aria-label={`Remove ${person.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(selected.filter((item) => item.id !== person.id));
              }}
              className="text-subtle hover:text-foreground flex size-5 items-center justify-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring/60 max-md:size-11"
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          ref={input}
          value={query}
          role="combobox"
          data-chat-picker=""
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder={selected.length ? "" : "Add people…"}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setHighlight(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className="placeholder:text-subtle h-7 min-w-[8em] flex-1 bg-transparent px-1.5 text-[14px] outline-none max-md:h-11"
        />
      </div>
      {showList && (
        <ul id={listId} role="listbox" aria-label="People" className="bg-popover border-line-strong max-h-56 overflow-y-auto overscroll-contain rounded-xl border p-1">
          {options.map((person, index) => (
            <li key={person.id} id={`${listId}-${person.id}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(person)}
                onMouseEnter={() => setHighlight(index)}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left max-md:min-h-11", index === active ? "bg-white/[0.07]" : "hover:bg-white/5")}
              >
                <ChatAvatar person={person} size="md" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13.5px] leading-5">{person.name}</span>
                  {person.email && <span className="caption-style text-subtle truncate">{person.email}</span>}
                </span>
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li role="presentation" className="caption-style text-subtle px-2.5 py-2">
              {loading ? "Loading people…" : "No one matches."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
