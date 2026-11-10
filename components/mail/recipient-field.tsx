"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { useComposer } from "@/components/mail/compose-dock";
import { personName } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import CloseIcon from "@/public/assets/images/mail/close.svg";

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
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const { showToast } = useComposer();
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<MailAddress[]>([]);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const [closed, setClosed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ value, onChange });

  useEffect(() => {
    latest.current = { value, onChange };
  });

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2 || term.includes(",")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/mail/people?q=${encodeURIComponent(term)}`, { signal: controller.signal, cache: "no-store" })
        .then((response) => (response.ok ? response.json() : { people: [] }))
        .then((body: { people: MailAddress[] }) => {
          setSuggestions(body.people.filter((person) => !latest.current.value.some((item) => item.address === person.address)));
          setActive(0);
        })
        .catch(() => null);
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [text]);

  const shown = suggestions.filter((person) => !value.some((item) => item.address === person.address));
  const open = !closed && text.trim().length >= 2 && shown.length > 0;
  const current = open ? Math.min(active, shown.length - 1) : -1;
  const optionId = (index: number) => `${id}-option-${index}`;

  function add(person: MailAddress) {
    if (!value.some((item) => item.address === person.address)) {
      onChange([...value, person]);
      setAnnouncement(`Added ${personName(person)} to ${label}.`);
    }
    setText("");
    setSuggestions([]);
    setInvalid(false);
  }

  function remove(person: MailAddress) {
    const index = value.findIndex((item) => item.address === person.address);
    if (index < 0) return;
    onChange(value.filter((item) => item.address !== person.address));
    const name = personName(person);
    setAnnouncement(`Removed ${name} from ${label}.`);
    showToast({
      message: `Removed ${name}.`,
      action: {
        label: "Undo",
        run: () => {
          const { value: now, onChange: change } = latest.current;
          if (now.some((item) => item.address === person.address)) return;
          const next = [...now];
          next.splice(Math.min(index, next.length), 0, person);
          change(next);
          setAnnouncement(`Put ${name} back in ${label}.`);
        },
      },
    });
    input.current?.focus();
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
    const added: MailAddress[] = [];
    for (const item of parsed as MailAddress[]) {
      if (next.some((entry) => entry.address === item.address)) continue;
      next.push(item);
      added.push(item);
    }
    onChange(next);
    if (added.length) setAnnouncement(`Added ${added.map(personName).join(", ")} to ${label}.`);
    setText("");
    setSuggestions([]);
    setInvalid(false);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!shown.length || text.trim().length < 2) return;
      event.preventDefault();
      if (closed) {
        setClosed(false);
        setActive(event.key === "ArrowDown" ? 0 : shown.length - 1);
        return;
      }
      setActive((index) => (Math.min(index, shown.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
      return;
    }
    if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : shown.length - 1);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setClosed(true);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && open) {
      event.preventDefault();
      add(shown[current]);
      return;
    }
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      if (!text.trim()) return;
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Backspace" && !text && value.length) {
      event.preventDefault();
      remove(value[value.length - 1]);
    }
  }

  return (
    <div className="relative flex min-w-0 items-start gap-2">
      <label htmlFor={id} className="text-subtle w-8 shrink-0 pt-1.5 text-[13px]">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.length > 0 && (
          <ul aria-label={`${label} recipients`} className="contents">
            {value.map((person) => (
              <li key={person.address} title={person.address} className="bg-surface-raised text-foreground flex h-7 max-w-full items-center gap-1 rounded-full pr-1 pl-2.5 text-[13px]">
                <span className="min-w-0 truncate">{personName(person)}</span>
                <Button
                  variant="ghost"
                  size="none"
                  aria-label={`Remove ${personName(person)} (${person.address}) from ${label}`}
                  onClick={() => remove(person)}
                  className="relative size-5 hover:bg-surface-active pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
                >
                  <CloseIcon aria-hidden className="size-2" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={input}
          id={id}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
            setClosed(false);
            if (event.target.value.trim().length < 2) setSuggestions([]);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => commit(), 120)}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open ? optionId(current) : undefined}
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
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label} suggestions`}
        hidden={!open}
        className="border-line-strong bg-popover shadow-overlay absolute top-full left-10 z-30 mt-1 w-[min(22rem,calc(100%-2.5rem))] overflow-hidden rounded-xl border p-1"
      >
        {open &&
          shown.map((person, index) => (
            <li
              key={person.address}
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              onMouseDown={(event) => {
                event.preventDefault();
                add(person);
              }}
              onMouseEnter={() => setActive(index)}
              className={cn("flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left pointer-coarse:py-2.5", index === current ? "bg-surface-active" : "")}
            >
              <span className="text-foreground truncate text-[13px]">{person.name ?? person.address}</span>
              {person.name && <span className="text-subtle truncate text-[12px]">{person.address}</span>}
            </li>
          ))}
      </ul>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {invalid && (
        <p role="alert" className="sr-only">
          {text} isn&apos;t an email address.
        </p>
      )}
    </div>
  );
}
