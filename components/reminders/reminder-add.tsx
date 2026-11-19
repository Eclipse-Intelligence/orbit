"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addReminderAction } from "@/app/(crm)/reminders";
import Button from "@/components/_ui/button";
import { DurationMenu } from "@/components/crm/task-timing";
import { usePadAiRead, useReadWhenUnsure } from "@/hooks/use-pad-ai-read";
import type { Reminder } from "@/lib/crm/reminders";
import { addKeyFor, blockChoice, dayLabel, EMPTY_DRAFT, readAddLine, reminderInputOf, withoutStaleBlock, type AddDraft } from "@/lib/reminders-card";
import { backspaceKeeps, padDueHasTime } from "@/lib/task-pad";
import { repeatChip } from "@/lib/task-repeat";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const CHIP = "inline-flex h-5 items-center gap-1 rounded-full px-[7px] text-[11.5px] leading-none whitespace-nowrap";

export type ReminderAddHandle = { focus: () => void };

type AddProps = { today: string; large: boolean; draft: AddDraft; onDraft: (change: (draft: AddDraft) => AddDraft) => void; onAdded: (reminder: Reminder) => void };

const ReminderAdd = forwardRef<ReminderAddHandle, AddProps>(function ReminderAdd({ today, large, draft, onDraft, onAdded }, ref) {
  const field = useRef<HTMLTextAreaElement>(null);
  const { text, kept, block } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const { ai, setAi, forgetAiReads, latestRead } = usePadAiRead();
  const reading = useMemo(() => readAddLine(text, { kept, ai, block }, new Date()), [text, kept, ai, block]);
  useReadWhenUnsure(latestRead, reading.source, reading.unsure);

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus({ preventScroll: true }) }), []);

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [text]);

  function change(next: (current: AddDraft) => AddDraft) {
    onDraft((current) => withoutStaleBlock(next(current), new Date(), ai));
  }

  function keep(key: string) {
    if (!key) return;
    change((current) => ({ ...current, kept: current.kept.includes(key) ? current.kept : [...current.kept, key] }));
  }

  function focusField() {
    field.current?.focus({ preventScroll: true });
  }

  function toggleBlock() {
    const on = reading.durationMinutes !== null;
    if (on && reading.length) {
      const typed = reading.length.key;
      onDraft((current) => ({ ...current, block: null, kept: current.kept.includes(typed) ? current.kept : [...current.kept, typed] }));
      return;
    }
    onDraft((current) => ({ ...current, block: blockChoice(reading, !on, reading.blockMinutes) }));
  }

  function changeLength(minutes: number) {
    onDraft((current) => ({ ...current, block: blockChoice(reading, true, minutes) }));
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
    setAi(null);
    forgetAiReads();
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
  const blocking = reading.durationMinutes !== null;
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
            if (!value.trim()) setAi(null);
            change((current) => (value.trim() ? { ...current, text: value } : { ...EMPTY_DRAFT, text: value }));
          }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
          className={cn("caret-foreground placeholder:text-faint relative block w-full resize-none bg-transparent text-transparent outline-none", typeClass)}
        />
      </div>
      <p role="status" className="sr-only">
        {reading.phrase ? `Date read from “${reading.phrase}”.` : ""}
      </p>
      {(text.trim() || error) && (
        <div className="flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-x-3 [@media(pointer:coarse)]:gap-y-2">
          {due && (
            <>
              <span className={cn(CHIP, "bg-surface-selected text-[#c9c0ff]")}>{dayLabel(due.slice(0, 10), today)}</span>
              {timed && <span className={cn(CHIP, "bg-surface-raised text-soft tabular-nums")}>{timed}</span>}
              {reading.repeat && (
                <span className={cn(CHIP, "bg-surface-raised text-soft max-w-[14em] truncate")}>
                  {repeatChip({ startsOn: due.slice(0, 10), at: timed, rule: reading.repeat.rule, ends: reading.repeat.ends })}
                </span>
              )}
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
              {timed && (
                <span className={cn("inline-flex items-center rounded-full", blocking ? "bg-surface-raised" : "ring-line-subtle ring-1 ring-inset")}>
                  <Button
                    variant="chip"
                    size="none"
                    aria-pressed={blocking}
                    aria-label="Block time"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={toggleBlock}
                    className={cn(CHIP, "hit", blocking ? "text-soft hover:text-foreground pr-1 hover:bg-transparent" : "text-faint hover:text-soft hover:bg-surface-hover")}
                  >
                    {blocking ? "Block time," : "Block time"}
                  </Button>
                  {blocking && reading.durationMinutes !== null && (
                    <DurationMenu
                      compact
                      value={reading.durationMinutes}
                      onChange={changeLength}
                      onClosed={focusField}
                      className={cn(CHIP, "text-soft hover:text-foreground gap-0.5 pl-0 hover:bg-transparent [&>svg]:size-3")}
                    />
                  )}
                </span>
              )}
            </>
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
