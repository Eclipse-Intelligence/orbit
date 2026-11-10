import { zonedParts, zonedTimeToDate } from "@/lib/time";

const RealDate = Date;

export function pinnedWednesday(from = new RealDate()) {
  const today = zonedParts(from, "Europe/London");
  const day = new RealDate(RealDate.UTC(today.year, today.month - 1, today.day));
  const back = (day.getUTCDay() + 7 - 3) % 7;
  const wednesday = new RealDate(day.getTime() - back * 86_400_000);
  return zonedTimeToDate({ year: wednesday.getUTCFullYear(), month: wednesday.getUTCMonth() + 1, day: wednesday.getUTCDate(), hour: 15, minute: 0, second: 0 }, "Europe/London");
}

export function installClock(at: Date) {
  const offset = at.getTime() - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string | number]));
    }

    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
