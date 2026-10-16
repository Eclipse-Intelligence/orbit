"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { listGroups } from "@/components/crm/clickup";
import ReminderSelect from "@/components/crm/reminder-select";
import { searchCompaniesAction } from "@/app/(crm)/actions";
import { searchContactsToFileAction } from "@/app/(crm)/search";
import { addPadTaskAction, detectTaskRecordsAction, parseTaskWithAiAction } from "@/app/(crm)/task-pad";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { PadAiParse, PadDetection, PadRecord } from "@/lib/crm/task-pad";
import { mergeMarks, nameMarks, parseTaskText, stripMention, type PadMark } from "@/lib/task-pad";
import { cn } from "@/lib/utils";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";

type Mention = { start: number; end: number; query: string };
type Suggestion = { kind: "company" | "contact"; id: string; name: string; detail: string | null; company: PadRecord | null };
type Override<T> = { set: boolean; value: T };

const CHIP =
  "h-7 w-auto max-w-full min-w-0 gap-1.5 rounded-full border-transparent bg-white/[0.06] px-2.5 text-[12.5px] leading-none text-soft hover:bg-white/10 hover:text-foreground";

const unset = <T,>(): Override<T> => ({ set: false, value: undefined as T });

function RecordChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="text-soft inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full bg-white/[0.06] pr-1 pl-2.5 text-[12.5px]">
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="text-subtle hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
      >
        <svg aria-hidden width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M6 6 18 18M18 6 6 18" />
        </svg>
      </button>
    </span>
  );
}

function ClickUpChip({
  picker,
  listId,
  onChange,
}: {
  picker: ClickUpPicker;
  listId: string | null;
  onChange: (listId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = picker.lists.find((list) => list.id === listId) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex cursor-pointer items-center", CHIP, !current && "text-subtle")}>
          <span className="truncate">{current ? `ClickUp · ${current.name}` : "ClickUp off"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,calc(100vw-2rem))] p-1.5">
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {listGroups(picker.lists).map((group) => (
            <div key={group.label} className="flex flex-col">
              <span className="caption-style text-faint px-2.5 pt-2 pb-1">{group.label}</span>
              {group.lists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => {
                    onChange(list.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "text-soft hover:text-foreground cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13.5px] hover:bg-white/5",
                    list.id === listId && "text-foreground bg-white/5",
                  )}
                >
                  {list.name}
                </button>
              ))}
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="text-subtle hover:text-foreground mt-1 cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13.5px] hover:bg-white/5"
          >
            Don&apos;t add to ClickUp
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function TaskPad({
  clickup,
  company: fixedCompany = null,
  className,
  placeholder = "Add a task, e.g. Call Jane Monday 3pm, remind me 1 hour before",
  initialContact = null,
  initialCompany = null,
  autoFocus = false,
  onAdded,
}: {
  clickup: ClickUpPicker | null;
  company?: PadRecord | null;
  className?: string;
  placeholder?: string;
  initialContact?: PadRecord | null;
  initialCompany?: PadRecord | null;
  autoFocus?: boolean;
  onAdded?: (result: { warning?: string }) => void;
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [mention, setMention] = useState<Mention | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [detected, setDetected] = useState<{ text: string; value: PadDetection } | null>(null);
  const [ai, setAi] = useState<{ text: string; value: PadAiParse } | null>(null);
  const [reading, setReading] = useState(false);
  const [due, setDue] = useState<Override<string | null>>(unset);
  const [reminder, setReminder] = useState<Override<number | null>>(unset);
  const startCompany = (): Override<PadRecord | null> => (initialCompany ? { set: true, value: initialCompany } : unset());
  const startContact = (): Override<PadRecord | null> => (initialContact ? { set: true, value: initialContact } : unset());
  const [company, setCompany] = useState<Override<PadRecord | null>>(startCompany);
  const [contact, setContact] = useState<Override<PadRecord | null>>(startContact);
  const [list, setList] = useState<Override<string | null>>(unset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const parsed = useMemo(() => parseTaskText(text), [text]);
  const aiFits = ai !== null && ai.text === text && parsed.unsure;
  const title = aiFits ? ai.value.title : parsed.title;
  const autoDue = aiFits ? (ai.value.due ?? parsed.due) : parsed.due;
  const finalDue = due.set ? due.value : autoDue;
  const autoReminder = aiFits ? ai.value.remindMinutes : parsed.remindMinutes;
  const finalReminder = finalDue ? (reminder.set ? reminder.value : autoReminder) : null;
  const seen = text.trim().length >= 3 ? (detected?.value ?? null) : null;
  const finalContact = contact.set ? contact.value : (seen?.contact ?? null);
  const finalCompany = fixedCompany ?? (company.set ? company.value : (seen?.company ?? seen?.contact?.company ?? null));
  const finalList = clickup ? (list.set ? list.value : clickup.listId) : null;

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    if (text.trim().length < 3) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void detectTaskRecordsAction(text).then(
        (value) => !cancelled && setDetected({ text, value }),
        () => undefined,
      );
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text]);

  useEffect(() => {
    if (!parsed.unsure || text.trim().length < 4) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setReading(true);
      void parseTaskWithAiAction(text)
        .then(
          (value) => {
            if (!cancelled && value) setAi({ text, value });
          },
          () => undefined,
        )
        .finally(() => !cancelled && setReading(false));
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setReading(false);
    };
  }, [text, parsed.unsure]);

  useEffect(() => {
    if (!mention) return;
    let cancelled = false;
    const query = mention.query.trim();
    const timer = window.setTimeout(() => {
      void Promise.all([
        fixedCompany ? Promise.resolve([]) : searchCompaniesAction(query),
        searchContactsToFileAction(query),
      ]).then(([companies, people]) => {
        if (cancelled) return;
        const next: Suggestion[] = [
          ...people.contacts.slice(0, 5).map((person) => ({
            kind: "contact" as const,
            id: person.id,
            name: person.name,
            detail: person.companyName,
            company: person.companyId && person.companyName ? { id: person.companyId, name: person.companyName } : null,
          })),
          ...companies.slice(0, 5).map((item) => ({
            kind: "company" as const,
            id: item.id,
            name: item.name,
            detail: item.domain,
            company: null,
          })),
        ];
        setSuggestions(next);
        setHighlight(0);
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mention, fixedCompany]);

  function refreshMention(value: string, caret: number) {
    setMention(stripMention(value, caret));
  }

  function pick(suggestion: Suggestion) {
    if (!mention) return;
    const after = text.slice(mention.end).replace(/^\s+/, "");
    const inserted = `${suggestion.name} `;
    const next = `${text.slice(0, mention.start)}${inserted}${after}`;
    const caret = mention.start + inserted.length;
    setText(next);
    setMention(null);
    setSuggestions([]);
    if (suggestion.kind === "company") setCompany({ set: true, value: { id: suggestion.id, name: suggestion.name } });
    else {
      setContact({ set: true, value: { id: suggestion.id, name: suggestion.name } });
      if (!fixedCompany && suggestion.company && !(company.set && company.value)) setCompany({ set: true, value: suggestion.company });
    }
    window.requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }

  function clearChoices() {
    setDetected(null);
    setAi(null);
    setDue(unset());
    setReminder(unset());
    setCompany(startCompany());
    setContact(startContact());
    setList(unset());
  }

  function reset() {
    setText("");
    setMention(null);
    setSuggestions([]);
    setDetected(null);
    setAi(null);
    setDue(unset());
    setReminder(unset());
    setCompany(startCompany());
    setContact(startContact());
    setList(unset());
  }

  async function submit() {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    const result = await addPadTaskAction({
      title,
      dueAt: finalDue,
      remindMinutes: finalReminder,
      companyId: finalCompany?.id ?? null,
      contactId: finalContact?.id ?? null,
      clickupListId: finalList,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    reset();
    router.refresh();
    if (onAdded) {
      onAdded({ warning: result.warning });
      return;
    }
    setWarning(result.warning ?? null);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  const showChips = text.trim() !== "" || Boolean(initialContact || initialCompany);
  const names = [finalContact?.name, finalCompany?.name].filter((name): name is string => Boolean(name));
  const marks = mergeMarks([...parsed.marks, ...nameMarks(text, names)]);
  const pieces: { text: string; kind: PadMark["kind"] | null }[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) pieces.push({ text: text.slice(cursor, mark.start), kind: null });
    pieces.push({ text: text.slice(mark.start, mark.end), kind: mark.kind });
    cursor = mark.end;
  }
  pieces.push({ text: `${text.slice(cursor)}\u200b`, kind: null });

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <div className="bg-secondary focus-within:border-ring border-line-strong flex items-end gap-2 rounded-2xl border py-1.5 pr-1.5 pl-3.5 transition-[border-color] duration-150">
          <label htmlFor={`${id}-text`} className="sr-only">
            New task
          </label>
          <div className="relative min-w-0 flex-1">
            <div
              aria-hidden
              className="text-foreground pointer-events-none absolute inset-0 overflow-hidden py-1 text-[14px] leading-5 break-words whitespace-pre-wrap [@media(pointer:coarse)]:text-[16px]"
            >
              <div style={{ transform: `translateY(-${scrollTop}px)` }}>
                {pieces.map((piece, index) =>
                  piece.kind ? (
                    <mark
                      key={index}
                      className={cn(
                        "rounded-[4px] text-inherit",
                        piece.kind === "record"
                          ? "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]"
                          : "bg-[var(--tag-blue-bg)] text-[var(--tag-blue-text)] shadow-[0_0_0_2px_var(--tag-blue-bg)]",
                      )}
                    >
                      {piece.text}
                    </mark>
                  ) : (
                    <span key={index}>{piece.text}</span>
                  ),
                )}
              </div>
            </div>
            <textarea
              id={`${id}-text`}
              ref={input}
              rows={1}
              autoFocus={autoFocus}
              value={text}
              data-shortcut="add-record"
              placeholder={placeholder}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
                if (!event.target.value.trim()) clearChoices();
                refreshMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
              }}
              onSelect={(event) => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              onBlur={() => window.setTimeout(() => setMention(null), 150)}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              className="placeholder:text-subtle caret-foreground selection:bg-primary/40 relative m-0 block max-h-40 min-h-7 w-full resize-none border-0 bg-transparent px-0 py-1 text-[14px] leading-5 text-transparent outline-none"
            />
          </div>
          <Button
            variant="primary"
            size="icon"
            type="button"
            aria-label="Add task"
            title="Add task (Enter)"
            disabled={busy || !title.trim()}
            onClick={() => void submit()}
            className="shrink-0"
          >
            <ArrowUpIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
        {mention && suggestions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Link a person or company"
            className="bg-popover border-line-strong shadow-overlay absolute top-full left-0 z-30 mt-1 w-[min(22rem,100%)] overflow-hidden rounded-xl border p-1"
          >
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.kind}-${suggestion.id}`} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(suggestion)}
                  className={cn(
                    "flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left",
                    index === highlight ? "bg-white/[0.07]" : "hover:bg-white/5",
                  )}
                >
                  <span className="text-foreground truncate text-[13.5px] leading-5">{suggestion.name}</span>
                  <span className="caption-style text-subtle truncate">
                    {suggestion.kind === "company" ? "Company" : "Person"}
                    {suggestion.detail ? ` · ${suggestion.detail}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {showChips && (
        <div className="flex flex-wrap items-center gap-1.5">
          <DateTimePicker
            id={`${id}-due`}
            aria-label="Due date"
            placeholder="No due date"
            value={finalDue ?? ""}
            onChange={(value) => setDue({ set: true, value: value || null })}
            className={cn(CHIP, "[&_svg]:size-3.5", !finalDue && "text-subtle")}
          />
          {finalDue && (
            <ReminderSelect
              id={`${id}-reminder`}
              value={finalReminder === null ? "none" : String(finalReminder)}
              onChange={(value) => setReminder({ set: true, value: value === "none" ? null : Number(value) })}
              className={cn(CHIP, finalReminder === null && "text-subtle")}
            />
          )}
          {finalContact && <RecordChip label={finalContact.name} onRemove={() => setContact({ set: true, value: null })} />}
          {!fixedCompany && finalCompany && (
            <RecordChip label={finalCompany.name} onRemove={() => setCompany({ set: true, value: null })} />
          )}
          {clickup && <ClickUpChip picker={clickup} listId={finalList} onChange={(value) => setList({ set: true, value })} />}
          {reading && <span className="caption-style text-subtle px-1">Reading…</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {warning && !error && (
        <p role="status" className="caption-style text-soft">
          {warning}
        </p>
      )}
    </div>
  );
}
