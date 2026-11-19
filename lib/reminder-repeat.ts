import { clockLabel } from "@/lib/crm/task-time";
import { countLeft, upcomingBetween, type RepeatEnds, type RepeatRule } from "@/lib/task-repeat";
import { appTimeZone } from "@/lib/time";

const MINUTE = 60_000;

export type RepeatingBlock = {
  dueOn: string;
  dueAt: string;
  durationMinutes: number;
  rule: RepeatRule;
  ends: RepeatEnds;
};

export type LaterBlock = { start: number; end: number };

export function laterBlocks(item: RepeatingBlock, fromDay: string, toDay: string, today: string, timeZone = appTimeZone()): LaterBlock[] {
  const after = item.dueOn > today ? item.dueOn : today;
  const left = "count" in item.ends ? (countLeft(item.ends) ?? item.ends.count) - 1 : null;
  if (left !== null && left <= 0) return [];
  const series = {
    startsOn: item.dueOn,
    at: clockLabel(item.dueAt, timeZone),
    rule: item.rule,
    ends: "count" in item.ends ? ({ never: true } as RepeatEnds) : item.ends,
    durationMinutes: item.durationMinutes,
    after,
    changes: [],
  };
  const timed = upcomingBetween(series, after, toDay, after, timeZone).filter((occurrence) => occurrence.dueHasTime && occurrence.day > after);
  return (left === null ? timed : timed.slice(0, left))
    .filter((occurrence) => occurrence.day >= fromDay)
    .map((occurrence) => {
      const start = Date.parse(occurrence.dueAt);
      return { start, end: start + item.durationMinutes * MINUTE };
    });
}

export function laterBlocksBusy(items: RepeatingBlock[], from: number, to: number, fromDay: string, toDay: string, today: string, timeZone = appTimeZone()): LaterBlock[] {
  return items.flatMap((item) => laterBlocks(item, fromDay, toDay, today, timeZone)).filter((block) => block.end > from && block.start < to);
}
