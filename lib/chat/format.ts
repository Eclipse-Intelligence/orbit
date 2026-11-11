import { dayKeyAt } from "@/lib/crm/working-days";
import { appTimeZone } from "@/lib/time";

const DAY_MS = 86_400_000;

function formatter(options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: appTimeZone(), ...options });
}

const CLOCK = formatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAY_LONG = formatter({ weekday: "long" });
const WEEKDAY_SHORT = formatter({ weekday: "short" });
const DAY_MONTH = formatter({ day: "numeric", month: "long" });
const DAY_MONTH_YEAR = formatter({ day: "numeric", month: "long", year: "numeric" });
const DAY_MONTH_SHORT = formatter({ day: "numeric", month: "short" });
const FULL = formatter({ weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function dayOf(iso: string) {
  return dayKeyAt(new Date(iso));
}

function daysBetween(iso: string, now: number) {
  const day = Date.parse(`${dayOf(iso)}T00:00:00Z`);
  const today = Date.parse(`${dayKeyAt(new Date(now))}T00:00:00Z`);
  return Math.round((today - day) / DAY_MS);
}

export function clockTime(iso: string) {
  return CLOCK.format(new Date(iso));
}

export function fullTime(iso: string) {
  return FULL.format(new Date(iso));
}

export function dayLabel(iso: string, now: number) {
  const days = daysBetween(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY_LONG.format(new Date(iso));
  const sameYear = dayOf(iso).slice(0, 4) === dayKeyAt(new Date(now)).slice(0, 4);
  return (sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(new Date(iso));
}

export function shortWhen(iso: string, now: number) {
  const days = daysBetween(iso, now);
  if (days <= 0) return clockTime(iso);
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY_SHORT.format(new Date(iso));
  return DAY_MONTH_SHORT.format(new Date(iso));
}

export function stampWhen(iso: string, now: number) {
  const days = daysBetween(iso, now);
  if (days <= 0) return clockTime(iso);
  return `${shortWhen(iso, now)} ${clockTime(iso)}`;
}
