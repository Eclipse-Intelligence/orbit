"use client";

import { useEffect, useId, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { DueDatePicker } from "@/components/_ui/date-picker";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import Switch from "@/components/_ui/switch";
import { DurationMenu } from "@/components/crm/task-timing";
import { RepeatIcon, RepeatPicker } from "@/components/crm/task-repeat";
import type { Reminder, ReminderInput } from "@/lib/crm/reminders";
import { localInstant } from "@/lib/crm/task-time";
import { TIME_OPTIONS } from "@/lib/date-input";
import { draftOfRepeat, dueChange, REMINDER_NOT_REMOVED, repeatWords } from "@/lib/reminders-card";
import { padDueHasTime } from "@/lib/task-pad";
import { repeatInputOf } from "@/lib/task-repeat";
import { cn } from "@/lib/utils";

function cleanTitle(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

const FIELD = "bg-surface-field text-foreground hover:bg-surface-raised flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left text-[14px] leading-none";

export default function ReminderDetails({
  reminder,
  today,
  error,
  onSave,
  onDelete,
  onTurnIntoTask,
  stuck = false,
  onRetryRemove,
}: {
  reminder: Reminder;
  today: string;
  error: string | null;
  onSave: (id: string, change: ReminderInput) => void;
  onDelete: () => void;
  onTurnIntoTask: () => void;
  stuck?: boolean;
  onRetryRemove?: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(reminder.title);
  const [shownFor, setShownFor] = useState(reminder.title);
  if (shownFor !== reminder.title) {
    setShownFor(reminder.title);
    setTitle(reminder.title);
  }
  const times = reminder.time && !TIME_OPTIONS.includes(reminder.time) ? [...TIME_OPTIONS, reminder.time].sort() : TIME_OPTIONS;
  const draft = draftOfRepeat(reminder.repeat, reminder.dueOn);
  const repeats = repeatWords(reminder);
  const pending = useRef({ id: reminder.id, title, sent: reminder.title, onSave });

  useEffect(() => {
    Object.assign(pending.current, { id: reminder.id, title, onSave });
  });

  useEffect(() => {
    const latest = pending.current;
    return () => {
      const next = cleanTitle(latest.title);
      if (next && next !== latest.sent) latest.onSave(latest.id, { title: next });
    };
  }, []);

  function save(change: ReminderInput) {
    onSave(reminder.id, change);
  }

  function saveTitle() {
    const next = cleanTitle(title);
    if (!next) {
      setTitle(reminder.title);
      return;
    }
    if (next === reminder.title || next === pending.current.sent) return;
    pending.current.sent = next;
    save({ title: next });
  }

  return (
    <div className="flex flex-col gap-2.5 px-3.5 pt-1 pb-3.5">
      <label htmlFor={`${id}-title`} className="sr-only">
        Reminder
      </label>
      <Input
        id={`${id}-title`}
        value={title}
        maxLength={500}
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            saveTitle();
          }
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-date`} className="caption-style text-subtle">
            Date
          </label>
          <DueDatePicker
            id={`${id}-date`}
            value={reminder.dueOn ?? ""}
            placeholder="No date"
            onChange={(value) => save(value && !padDueHasTime(value) ? { dueOn: value } : dueChange(value || null))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={`${id}-time`} className="caption-style text-subtle">
            Time
          </label>
          <NativeSelect
            id={`${id}-time`}
            value={reminder.time ?? ""}
            disabled={!reminder.dueOn}
            onChange={(event) => {
              const time = event.target.value;
              if (!reminder.dueOn) return;
              save(time ? { dueAt: localInstant(`${reminder.dueOn}T${time}`) } : { dueOn: reminder.dueOn, dueAt: null });
            }}
          >
            <option value="">No time</option>
            {times.map((time) => (
              <option key={time} value={time}>
                {time}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span id={`${id}-repeat`} className="caption-style text-subtle">
          Repeat
        </span>
        <RepeatPicker
          anchor={reminder.dueOn ?? today}
          at={reminder.time}
          value={draft}
          onChange={(next) => save({ repeat: next ? repeatInputOf(next.rule, next.ends) : null })}
          trigger={
            <button type="button" aria-labelledby={`${id}-repeat ${id}-repeat-value`} className={cn(FIELD, "focus-visible:ring-ring/60 cursor-pointer outline-none focus-visible:ring-2")}>
              <RepeatIcon aria-hidden className="text-soft size-4 shrink-0" />
              <span id={`${id}-repeat-value`} className={cn("min-w-0 flex-1 truncate", !repeats && "text-subtle")}>
                {repeats ?? "Never"}
              </span>
            </button>
          }
        />
      </div>
      <div className="flex items-center justify-between gap-3 pt-1">
        <label htmlFor={`${id}-block`} className="flex min-w-0 flex-col gap-0.5">
          <span className="ui-style text-foreground">Block time</span>
          <span className="caption-style text-subtle">Puts it in your calendar and Outlook as busy.</span>
        </label>
        <Switch id={`${id}-block`} label="Block time" checked={reminder.blocksTime} onChange={(value) => save({ blocksTime: value })} />
      </div>
      {reminder.blocksTime && (
        <div className="flex items-center justify-between gap-3">
          <span className="ui-style text-subtle">Length</span>
          <DurationMenu value={reminder.durationMinutes} onChange={(minutes) => save({ durationMinutes: minutes })} />
        </div>
      )}
      {(error || stuck) && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="caption-style text-danger">
            {error ?? REMINDER_NOT_REMOVED}
          </p>
          {stuck && onRetryRemove && (
            <Button variant="secondary" size="sm" onClick={onRetryRemove}>
              Try again
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1">
        {stuck ? (
          <span />
        ) : (
          <Button variant="secondary" size="sm" data-turn-into-task="" onClick={onTurnIntoTask}>
            Turn into task
          </Button>
        )}
        <HoldButton onConfirm={onDelete}>Hold to delete</HoldButton>
      </div>
    </div>
  );
}
