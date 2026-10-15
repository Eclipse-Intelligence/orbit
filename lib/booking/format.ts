import { dateKey, shiftDateKey, weekday } from "@/lib/calendar-view";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, options: Intl.DateTimeFormatOptions) {
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, found);
  }
  return found;
}

function noon(key: string) {
  return new Date(`${key}T12:00:00Z`);
}

export function monthTitle(month: string) {
  return formatter("month", { month: "long", year: "numeric", timeZone: "UTC" }).format(noon(`${month}-01`));
}

export function dayTitle(key: string) {
  return formatter("day", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(noon(key));
}

export function shortDay(key: string) {
  return formatter("short-day", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(noon(key));
}

export function timeOf(iso: string, timeZone: string) {
  return formatter(`time:${timeZone}`, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function fullWhen(startIso: string, endIso: string, timeZone: string) {
  const day = formatter(`full:${timeZone}`, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(new Date(startIso));
  return `${day}, ${timeOf(startIso, timeZone)} – ${timeOf(endIso, timeZone)}`;
}

export function zoneOffset(timeZone: string, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

export function zoneName(timeZone: string) {
  const city = timeZone.split("/").pop() ?? timeZone;
  return city.replace(/_/g, " ");
}

export function zoneLabel(timeZone: string, at = new Date()) {
  const offset = zoneOffset(timeZone, at);
  return offset ? `${zoneName(timeZone)} (${offset})` : zoneName(timeZone);
}

export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function allZones(current: string | null) {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const set = new Set(zones);
  for (const zone of [current, "Europe/London", "UTC"]) if (zone) set.add(zone);
  return [...set].sort();
}

export function monthGrid(month: string) {
  const first = `${month}-01`;
  const start = shiftDateKey(first, -weekday(first));
  const cells: { key: string; inMonth: boolean }[] = [];
  for (let index = 0; index < 42; index += 1) {
    const key = shiftDateKey(start, index);
    cells.push({ key, inMonth: key.startsWith(month) });
  }
  while (cells.length > 35 && cells.slice(-7).every((cell) => !cell.inMonth)) cells.splice(-7);
  return cells;
}

export function todayKey(timeZone: string) {
  return dateKey(Date.now(), timeZone);
}

export const WEEKDAY_INITIALS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
