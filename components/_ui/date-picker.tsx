"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import {
  DEFAULT_TIME,
  TIME_OPTIONS,
  WEEKDAY_LABELS,
  dateValue,
  formatDateLabel,
  formatDateTimeLabel,
  joinDateTime,
  monthGrid,
  monthLabel,
  nextQuarterHour,
  parseDateValue,
  quickDates,
  splitDateTime,
} from "@/lib/date-input";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

type PickerProps = {
  id: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

export function DatePicker(props: PickerProps) {
  return <PickerField {...props} withTime={false} />;
}

export function DateTimePicker(props: PickerProps) {
  return <PickerField {...props} withTime />;
}

function PickerField({
  id,
  name,
  value,
  defaultValue = "",
  onChange,
  placeholder,
  disabled,
  className,
  withTime,
  ...aria
}: PickerProps & { withTime: boolean }) {
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const [open, setOpen] = useState(false);
  const parts = withTime ? splitDateTime(current) : null;
  const selectedDate = withTime ? (parts?.date ?? null) : parseDateValue(current) ? current : null;
  const selectedTime = parts?.time ?? DEFAULT_TIME;
  const [view, setView] = useState(() => monthOf(selectedDate));

  function commit(next: string) {
    if (value === undefined) setInner(next);
    onChange?.(next);
  }

  function pickDate(date: string) {
    if (!withTime) {
      commit(date);
      setOpen(false);
      return;
    }
    const today = dateValue(new Date());
    const time =
      parts?.time ?? (date === today && DEFAULT_TIME <= currentTime() ? (nextQuarterHour() ?? "23:45") : DEFAULT_TIME);
    commit(joinDateTime(date, time));
  }

  const label = selectedDate
    ? withTime && parts
      ? formatDateTimeLabel(current)
      : formatDateLabel(selectedDate)
    : (placeholder ?? (withTime ? "Pick a date and time" : "Pick a date"));
  const today = dateValue(new Date());

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setView(monthOf(selectedDate));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          data-invalid={aria["aria-invalid"] ? true : undefined}
          aria-describedby={aria["aria-describedby"]}
          aria-label={aria["aria-label"]}
          className={cn(
            "border-line-strong bg-secondary text-foreground focus-visible:border-ring ease-power3-out flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-left text-[14px] leading-none outline-none transition-[border-color] duration-150 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid=true]:border-danger",
            className,
          )}
        >
          <CalendarIcon aria-hidden className="text-soft size-4 shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate", !selectedDate && "text-subtle")}>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[18.5em] p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {quickDates().map((quick) => (
              <Button
                key={quick.label}
                variant={selectedDate === quick.value ? "muted" : "subtle"}
                size="sm"
                type="button"
                onClick={() => pickDate(quick.value)}
              >
                {quick.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Previous month"
              onClick={() => setView((month) => shiftMonth(month, -1))}
            >
              <ChevronLeftIcon aria-hidden className="size-3" />
            </Button>
            <span className="text-[14px] leading-5 font-medium" aria-live="polite">
              {monthLabel(view.year, view.month)}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Next month"
              onClick={() => setView((month) => shiftMonth(month, 1))}
            >
              <ChevronRightIcon aria-hidden className="size-3" />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-y-1 text-center">
            {WEEKDAY_LABELS.map((day) => (
              <span key={day} aria-hidden className="caption-style text-subtle py-1">
                {day}
              </span>
            ))}
            {monthGrid(view.year, view.month).flat().map((day) => {
              const selected = day.value === selectedDate;
              return (
                <button
                  key={day.value}
                  type="button"
                  aria-label={formatDateLabel(day.value)}
                  aria-pressed={selected}
                  onClick={() => pickDate(day.value)}
                  className={cn(
                    "ease-power3-out mx-auto flex size-8 cursor-pointer items-center justify-center rounded-full text-[13px] tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : day.inMonth
                        ? "text-foreground hover:bg-white/8"
                        : "text-faint hover:bg-white/6",
                    !selected && day.value === today && "shadow-[inset_0px_0px_0px_1px_var(--line-strong)]",
                  )}
                >
                  {day.day}
                </button>
              );
            })}
          </div>
          {withTime && (
            <div className="flex items-center gap-3">
              <span className="caption-style text-subtle shrink-0">Time</span>
              <Select
                value={selectedTime}
                disabled={!selectedDate}
                onValueChange={(time) => selectedDate && commit(joinDateTime(selectedDate, time))}
              >
                <SelectTrigger aria-label="Time" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(TIME_OPTIONS.includes(selectedTime) ? TIME_OPTIONS : [...TIME_OPTIONS, selectedTime].sort()).map(
                    (time) => (
                      <SelectItem key={time} value={time}>
                        {time}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={!current}
              onClick={() => {
                commit("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
      {name && <input type="hidden" name={name} value={current} />}
    </Popover>
  );
}

function currentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function monthOf(date: string | null) {
  const parsed = parseDateValue(date) ?? new Date();
  return { year: parsed.getFullYear(), month: parsed.getMonth() };
}

function shiftMonth(view: { year: number; month: number }, by: number) {
  const next = new Date(view.year, view.month + by, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}
