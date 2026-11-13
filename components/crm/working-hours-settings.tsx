"use client";

import { useRef, useState } from "react";
import Switch from "@/components/_ui/switch";
import { NativeSelect } from "@/components/_ui/native-select";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveWorkingHoursAction } from "@/app/(crm)/calendar/actions";
import {
  clockText,
  DAY_LENGTH_MINUTES,
  SETTINGS_WEEK,
  WEEKDAY_NAMES,
  WORKING_HOURS_STEP,
  type WorkingDay,
  type WorkingHours,
} from "@/lib/working-hours";
import { cn } from "@/lib/utils";

const SAVE_FAILED = "Couldn't save your working hours. Try again.";
const STARTS = Array.from({ length: DAY_LENGTH_MINUTES / WORKING_HOURS_STEP }, (_, index) => index * WORKING_HOURS_STEP);
const ENDS = STARTS.map((minutes) => minutes + WORKING_HOURS_STEP);

export default function WorkingHoursSettings({ hours }: { hours: WorkingHours }) {
  const [days, setDays] = useState(hours);
  const [source, setSource] = useState(hours);
  if (source !== hours) {
    setSource(hours);
    setDays(hours);
  }
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const saving = useRef(0);

  function change(weekday: number, patch: Partial<WorkingDay>) {
    const previous = days;
    const current = days[weekday];
    const next = { ...current, ...patch };
    if (patch.start !== undefined && next.end <= next.start) next.end = Math.min(DAY_LENGTH_MINUTES, next.start + 60);
    if (patch.end !== undefined && next.start >= next.end) next.start = Math.max(0, next.end - 60);
    const updated = days.map((day, index) => (index === weekday ? next : day));
    setDays(updated);
    setError(null);
    setStatus(null);
    const seq = (saving.current += 1);
    void saveWorkingHoursAction(updated)
      .catch(() => ({ error: SAVE_FAILED }))
      .then((result) => {
        if (saving.current !== seq) return;
        if (result.error) {
          setDays(previous);
          setError(result.error);
          return;
        }
        setStatus("Saved");
      });
  }

  return (
    <SettingsCard title="Working hours" description="Plan and Schedule only place tasks inside these. Booking pages keep their own hours.">
      <ul className="divide-border border-border flex flex-col divide-y rounded-lg border" aria-label="Working hours">
        {SETTINGS_WEEK.map((weekday) => {
          const day = days[weekday];
          const name = WEEKDAY_NAMES[weekday];
          return (
            <li key={weekday} className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2">
              <Switch className="hit" checked={day.works} label={`Work on ${name}`} onChange={(works) => change(weekday, { works })} />
              <span className={cn("w-10 text-[14px] leading-none", !day.works && "text-subtle")}>{name.slice(0, 3)}</span>
              {day.works ? (
                <span className="flex items-center gap-2">
                  <NativeSelect
                    aria-label={`${name} start`}
                    value={day.start}
                    className="w-[6.5em] tabular-nums"
                    onChange={(event) => change(weekday, { start: Number(event.target.value) })}
                  >
                    {STARTS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {clockText(minutes)}
                      </option>
                    ))}
                  </NativeSelect>
                  <span aria-hidden className="text-subtle">
                    to
                  </span>
                  <NativeSelect
                    aria-label={`${name} finish`}
                    value={day.end}
                    className="w-[6.5em] tabular-nums"
                    onChange={(event) => change(weekday, { end: Number(event.target.value) })}
                  >
                    {ENDS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {clockText(minutes)}
                      </option>
                    ))}
                  </NativeSelect>
                </span>
              ) : (
                <span className="text-subtle text-[13px] leading-none">Off</span>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      ) : (
        <p role="status" className="caption-style text-subtle">
          {status}
        </p>
      )}
    </SettingsCard>
  );
}
