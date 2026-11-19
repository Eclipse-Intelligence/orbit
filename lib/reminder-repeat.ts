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

export function laterBlocks(item: RepeatingBlock, fromDay: string, toDay: string, timeZone = appTimeZone()): LaterBlock[] {
  const ends: RepeatEnds = "count" in item.ends ? { count: countLeft(item.ends) ?? item.ends.count } : item.ends;
  const series = {
    startsOn: item.dueOn,
    at: clockLabel(item.dueAt, timeZone),
    rule: item.rule,
    ends,
    durationMinutes: item.durationMinutes,
    after: item.dueOn,
    changes: [],
  };
  return upcomingBetween(series, fromDay, toDay, fromDay, timeZone)
    .filter((occurrence) => occurrence.dueHasTime && occurrence.day > item.dueOn)
    .map((occurrence) => {
      const start = Date.parse(occurrence.dueAt);
      return { start, end: start + item.durationMinutes * MINUTE };
    });
}

export function laterBlocksBusy(items: RepeatingBlock[], from: number, to: number, fromDay: string, toDay: string, timeZone = appTimeZone()): LaterBlock[] {
  return items.flatMap((item) => laterBlocks(item, fromDay, toDay, timeZone)).filter((block) => block.end > from && block.start < to);
}
