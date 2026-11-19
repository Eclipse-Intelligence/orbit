"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addReminderAction } from "@/app/(crm)/reminders";
import type { Reminder } from "@/lib/crm/reminders";
import { durationLabel } from "@/lib/crm/task-time";
import { addKeyFor, dayLabel, EMPTY_DRAFT, readAddLine, reminderInputOf, type AddDraft } from "@/lib/reminders-card";
import { backspaceKeeps, padDueHasTime } from "@/lib/task-pad";
import { repeatChip } from "@/lib/task-repeat";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const CHIP = "inline-flex h-5 items-center gap-1 rounded-full px-[7px] text-[11.5px] leading-none whitespace-nowrap";

export type ReminderAddHandle = { focus: () => void };

type AddProps = { today: string; large: boolean; draft: AddDraft; onDraft: (change: (draft: AddDraft) => AddDraft) => void; onAdded: (reminder: Reminder) => void };

const ReminderAdd = forwardRef<ReminderAddHandle, AddProps>(function ReminderAdd({ today, large, draft, onDraft, onAdded }, ref) {
  const field = useRef<HTMLTextAreaElement>(null);
  const { text, confirmed, kept } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const reading = useMemo(() => readAddLine(text, { confirmed, kept }, new Date()), [text, confirmed, kept]);

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus({ preventScroll: true }) }), []);

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [text]);

  function keep(key: string) {
    if (!key) return;
    onDraft((current) => ({ ...current, kept: current.kept.includes(key) ? current.kept : [...current.kept, key], confirmed: null }));
  }

  function keepAsText() {
    keep(reading.key);
  }

  async function submit() {
    if (busy || !reading.title.trim()) return;
    setBusy(true);
    setError(null);
    const input = reminderInputOf(reading);
    const attempt = addKeyFor(draft.key, input, () => crypto.randomUUID());
    onDraft((current) => ({ ...current, key: attempt }));
    const result = await addReminderAction(input, attempt.key).catch(() => null);
    setBusy(false);
    if (!result || "error" in result) {
      setError(result?.error ?? "Couldn't add the reminder. Try again.");
      field.current?.focus({ preventScroll: true });
      return;
    }
    onDraft(() => EMPTY_DRAFT);
    onAdded(result.reminder);
    field.current?.focus({ preventScroll: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" && !event.metaKey && !event.altKey && !event.ctrlKey && reading.phrase) {
      const node = event.currentTarget;
      if (backspaceKeeps(reading.marks, node.selectionStart, node.selectionEnd)) {
        event.preventDefault();
        if (reading.length && reading.length.end === node.selectionStart) keep(reading.length.key);
        else keepAsText();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const pieces: { text: string; marked: boolean }[] = [];
  let cursor = 0;
  for (const mark of [...reading.marks].sort((left, right) => left.start - right.start)) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) pieces.push({ text: text.slice(cursor, mark.start), marked: false });
    pieces.push({ text: text.slice(mark.start, mark.end), marked: true });
    cursor = mark.end;
  }
  pieces.push({ text: `${text.slice(cursor)}​`, marked: false });

  const due = reading.due;
  const timed = due && padDueHasTime(due) ? due.slice(11, 16) : null;
  const guess = reading.guess;
  const guessLabel = guess ? `${dayLabel(guess.due.slice(0, 10), today)}${padDueHasTime(guess.due) ? `, ${guess.due.slice(11, 16)}` : ""}` : null;
  const typeClass = large ? "text-[16px] leading-[22px]" : "text-[13px] leading-5 [@media(pointer:coarse)]:text-[16px] [@media(pointer:coarse)]:leading-[22px]";

  return (
    <div className={cn("bg-surface-field flex flex-col gap-1.5 rounded-[10px] px-2.5 py-2", large ? "mx-1.5 mb-1.5" : "mx-2.5 mt-0.5 mb-1.5")}>
      <div className="relative min-w-0">
        <div aria-hidden className={cn("text-foreground pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap", typeClass)}>
          <div style={scrollTop ? { transform: `translateY(-${scrollTop}px)` } : undefined}>
            {pieces.map((piece, index) =>
              piece.marked ? (
                <mark key={index} className="rounded-[4px] bg-[var(--tag-blue-bg)] text-[var(--tag-blue-text)] shadow-[0_0_0_2px_var(--tag-blue-bg)]">
                  {piece.text}
                </mark>
              ) : (
                <span key={index}>{piece.text}</span>
              ),
            )}
          </div>
        </div>
        <label htmlFor="reminder-add" className="sr-only">
          Add reminder
        </label>
        <textarea
          id="reminder-add"
          ref={field}
          rows={1}
          value={text}
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder="Add a reminder"
          enterKeyHint="done"
          autoComplete="off"
          onChange={(event) => {
            const value = event.target.value;
            setError(null);
            onDraft((current) => (value.trim() ? { ...current, text: value } : { ...EMPTY_DRAFT, text: value }));
          }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
          className={cn("caret-foreground placeholder:text-faint relative block w-full resize-none bg-transparent text-transparent outline-none", typeClass)}
        />
      </div>
      <p role="status" className="sr-only">
        {reading.phrase ? `Date read from “${reading.phrase}”.` : guess ? `Did you mean ${guessLabel}?` : ""}
      </p>
      {(text.trim() || error) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {due && (
            <>
              <span className={cn(CHIP, "bg-surface-selected text-[#c9c0ff]")}>{dayLabel(due.slice(0, 10), today)}</span>
              {timed && <span className={cn(CHIP, "bg-surface-raised text-soft tabular-nums")}>{timed}</span>}
              {reading.repeat && (
                <span className={cn(CHIP, "bg-surface-raised text-soft max-w-[14em] truncate")}>
                  {repeatChip({ startsOn: due.slice(0, 10), at: timed, rule: reading.repeat.rule, ends: reading.repeat.ends })}
                </span>
              )}
              {reading.durationMinutes && !reading.length && <span className={cn(CHIP, "bg-surface-raised text-soft")}>Block time, {durationLabel(reading.durationMinutes)}</span>}
              <button
                type="button"
                aria-label={`Keep as text: ${reading.phrase}`}
                title="Keep these words in the reminder and drop the date"
                onMouseDown={(event) => event.preventDefault()}
                onClick={keepAsText}
                className="hit text-subtle hover:text-foreground flex size-5 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
              {reading.length && (
                <span className={cn(CHIP, "bg-surface-raised text-soft gap-0.5 pr-0.5")}>
                  Block time, {durationLabel(reading.length.minutes)}
                  <button
                    type="button"
                    aria-label={`Keep as text: ${reading.length.phrase}`}
                    title="Keep these words in the reminder and don't block time"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => reading.length && keep(reading.length.key)}
                    className="hit text-subtle hover:text-foreground flex size-4 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
                  >
                    <XIcon aria-hidden className="size-2.5" />
                  </button>
                </span>
              )}
            </>
          )}
          {!due && guess && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onDraft((current) => ({ ...current, confirmed: guess.key }))}
              aria-label={`Use ${guessLabel} from “${guess.phrase}”`}
              className={cn(CHIP, "hit cursor-pointer bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[inset_0_0_0_1px_var(--tag-amber-border)]")}
            >
              {guessLabel}?
            </button>
          )}
          {text.trim() && <span className="caption-style text-faint ml-auto [@media(pointer:coarse)]:hidden">Enter to add</span>}
        </div>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
});

export default ReminderAdd;
