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
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState(hours);
  if (source !== hours) {
    setSource(hours);
    if (!saving) setDays(hours);
  }
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const queued = useRef<WorkingHours | null>(null);
  const running = useRef(false);
  const confirmed = useRef(hours);

  async function flush() {
    running.current = true;
    setSaving(true);
    while (queued.current) {
      const next = queued.current;
      queued.current = null;
      const result = await saveWorkingHoursAction(next).catch(() => ({ error: SAVE_FAILED }));
      if (result.error) {
        queued.current = null;
        setDays(confirmed.current);
        setError(result.error);
        break;
      }
      confirmed.current = next;
      if (!queued.current) setStatus("Saved");
    }
    running.current = false;
    setSaving(false);
  }

  function change(weekday: number, patch: Partial<WorkingDay>) {
    const current = days[weekday];
    const next = { ...current, ...patch };
    if (patch.start !== undefined && next.end <= next.start) next.end = Math.min(DAY_LENGTH_MINUTES, next.start + 60);
    if (patch.end !== undefined && next.start >= next.end) next.start = Math.max(0, next.end - 60);
    const updated = days.map((day, index) => (index === weekday ? next : day));
    setDays(updated);
    setError(null);
    setStatus(null);
    queued.current = updated;
    if (!running.current) void flush();
  }

  return (
    <SettingsCard title="Working hours" description="Plan and Schedule only place tasks inside these. Booking pages keep their own hours.">
      <ul className="divide-border border-border flex flex-col divide-y rounded-lg border" aria-label="Working hours">
        {SETTINGS_WEEK.map((weekday) => {
          const day = days[weekday];
          const name = WEEKDAY_NAMES[weekday];
          return (
            <li key={weekday} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
              <Switch className="hit" checked={day.works} label={`Work on ${name}`} onChange={(works) => change(weekday, { works })} />
              <span className={cn("w-10 text-[14px] leading-none", !day.works && "text-subtle")}>{name.slice(0, 3)}</span>
              {day.works ? (
                <span className="flex items-center gap-2 max-[430px]:basis-full max-[430px]:pl-12">
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
