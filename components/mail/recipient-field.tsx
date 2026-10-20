"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { personName } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import { cn } from "@/lib/utils";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function parse(text: string): MailAddress | null {
  const value = text.trim().replace(/[,;]$/, "").trim();
  const angled = value.match(/^(.*)<([^>]+)>$/);
  const address = (angled ? angled[2] : value).trim().toLowerCase();
  if (!EMAIL.test(address)) return null;
  const name = angled ? angled[1].trim().replace(/^"|"$/g, "") : "";
  return { address, name: name || null };
}

export default function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  label: string;
  value: MailAddress[];
  onChange: (next: MailAddress[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<MailAddress[]>([]);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2 || term.includes(",")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/mail/people?q=${encodeURIComponent(term)}`, { signal: controller.signal, cache: "no-store" })
        .then((response) => (response.ok ? response.json() : { people: [] }))
        .then((body: { people: MailAddress[] }) => {
          setSuggestions(body.people.filter((person) => !value.some((item) => item.address === person.address)));
          setActive(0);
        })
        .catch(() => null);
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [text, value]);

  const open = text.trim().length >= 2 && suggestions.length > 0;

  function add(person: MailAddress) {
    if (!value.some((item) => item.address === person.address)) onChange([...value, person]);
    setText("");
    setSuggestions([]);
    setInvalid(false);
  }

  function commit() {
    const parts = text
      .split(/[,;\n]+/)
      .flatMap((part) => ((part.match(/@/g)?.length ?? 0) > 1 ? part.split(/\s+/) : [part]))
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return true;
    const parsed = parts.map(parse);
    if (parsed.some((item) => !item)) {
      setInvalid(true);
      return false;
    }
    const next = [...value];
    for (const item of parsed as MailAddress[]) if (!next.some((entry) => entry.address === item.address)) next.push(item);
    onChange(next);
    setText("");
    setSuggestions([]);
    setInvalid(false);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && open) {
      event.preventDefault();
      add(suggestions[active]);
      return;
    }
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      if (!text.trim()) return;
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="relative flex min-w-0 items-start gap-2">
      <label htmlFor={id} className="text-subtle w-8 shrink-0 pt-1.5 text-[13px]">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((person) => (
          <span key={person.address} title={person.address} className="bg-white/[0.06] text-foreground flex h-7 max-w-full items-center gap-1 rounded-full pr-1 pl-2.5 text-[13px]">
            <span className="min-w-0 truncate">{personName(person)}</span>
            <button
              type="button"
              aria-label={`Remove ${person.address}`}
              onClick={() => onChange(value.filter((item) => item.address !== person.address))}
              className="text-subtle hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <svg aria-hidden width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
            if (event.target.value.trim().length < 2) setSuggestions([]);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => commit(), 120)}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          autoComplete="off"
          className={cn(
            "text-foreground placeholder:text-subtle h-7 min-w-[8em] flex-1 bg-transparent text-[14px] outline-none",
            invalid && "text-danger",
          )}
          placeholder={value.length ? "" : "Name or email"}
        />
      </div>
      {trailing}
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="border-line-strong bg-popover shadow-overlay absolute top-full left-10 z-30 mt-1 w-[min(22rem,calc(100%-2.5rem))] overflow-hidden rounded-xl border p-1"
        >
          {suggestions.map((person, index) => (
            <li key={person.address} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(person);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left",
                  index === active ? "bg-white/[0.06]" : "",
                )}
              >
                <span className="text-foreground truncate text-[13px]">{person.name ?? person.address}</span>
                {person.name && <span className="text-subtle truncate text-[12px]">{person.address}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {invalid && (
        <p role="alert" className="sr-only">
          {text} isn&apos;t an email address.
        </p>
      )}
    </div>
  );
}
