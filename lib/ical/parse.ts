import { isTimeZone } from "@/lib/time";

export type IcsProperty = { name: string; params: Record<string, string[]>; value: string };
export type IcsComponent = { name: string; properties: IcsProperty[]; components: IcsComponent[] };

export type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };
export type IcsTime = { allDay: boolean; wall: Wall; zone: string };

const MAX_DEPTH = 8;
const DATE_VALUE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i;

const WINDOWS_ZONES: Record<string, string> = {
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kyiv",
  "gtb standard time": "Europe/Bucharest",
  "russian standard time": "Europe/Moscow",
  "turkey standard time": "Europe/Istanbul",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "arabian standard time": "Asia/Dubai",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "w. australia standard time": "Australia/Perth",
  "new zealand standard time": "Pacific/Auckland",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax",
  "canada central standard time": "America/Regina",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "sa pacific standard time": "America/Bogota",
  "central standard time (mexico)": "America/Mexico_City",
  utc: "UTC",
  "coordinated universal time": "UTC",
};

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsParseError";
  }
}

export function unfoldLines(text: string) {
  const lines: string[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      lines.push(raw);
    }
  }
  return lines;
}

export function parseContentLine(line: string): IcsProperty | null {
  let index = 0;
  while (index < line.length && line[index] !== ";" && line[index] !== ":") index += 1;
  const name = line.slice(0, index).trim().toUpperCase();
  if (!name || index >= line.length) return null;
  const params: Record<string, string[]> = {};
  while (line[index] === ";") {
    index += 1;
    const equals = line.indexOf("=", index);
    if (equals < 0) return null;
    const key = line.slice(index, equals).trim().toUpperCase();
    index = equals + 1;
    const values: string[] = [];
    for (;;) {
      if (line[index] === '"') {
        const close = line.indexOf('"', index + 1);
        if (close < 0) return null;
        values.push(line.slice(index + 1, close));
        index = close + 1;
      } else {
        let end = index;
        while (end < line.length && line[end] !== "," && line[end] !== ";" && line[end] !== ":") end += 1;
        values.push(line.slice(index, end));
        index = end;
      }
      if (line[index] === ",") {
        index += 1;
        continue;
      }
      break;
    }
    if (key) params[key] = [...(params[key] ?? []), ...values];
  }
  if (line[index] !== ":") return null;
  return { name, params, value: line.slice(index + 1) };
}

export function parseIcs(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfoldLines(text)) {
    const property = parseContentLine(line);
    if (!property) continue;
    if (property.name === "BEGIN") {
      const component: IcsComponent = { name: property.value.trim().toUpperCase(), properties: [], components: [] };
      if (stack.length >= MAX_DEPTH) throw new IcsParseError("That calendar file is nested too deeply to read.");
      if (stack.length > 0) stack[stack.length - 1].components.push(component);
      else roots.push(component);
      stack.push(component);
      continue;
    }
    if (property.name === "END") {
      const name = property.value.trim().toUpperCase();
      const at = stack.map((component) => component.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1].properties.push(property);
  }
  return roots;
}

export function unescapeText(value: string) {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

export function param(property: IcsProperty | undefined, key: string) {
  return property?.params[key.toUpperCase()]?.[0] ?? null;
}

export function first(component: IcsComponent, name: string) {
  return component.properties.find((property) => property.name === name);
}

export function all(component: IcsComponent, name: string) {
  return component.properties.filter((property) => property.name === name);
}

export function textOf(component: IcsComponent, name: string) {
  const property = first(component, name);
  return property ? unescapeText(property.value) : null;
}

function knownZone(value: string) {
  return isTimeZone(value);
}

export function resolveZone(tzid: string | null | undefined): string | null {
  const raw = tzid?.trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  if (knownZone(raw)) return raw;
  const windows = WINDOWS_ZONES[raw.toLowerCase()];
  if (windows) return windows;
  const segments = raw.split("/").filter(Boolean);
  for (const size of [2, 3, 1]) {
    if (segments.length < size) continue;
    const candidate = segments.slice(-size).join("/");
    if (knownZone(candidate)) return candidate;
  }
  return null;
}

function validWall(wall: Wall) {
  const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  return (
    check.getUTCFullYear() === wall.year &&
    check.getUTCMonth() === wall.month - 1 &&
    check.getUTCDate() === wall.day &&
    wall.hour < 24 &&
    wall.minute < 60 &&
    wall.second <= 60
  );
}

export function parseTimeValue(value: string, options: { tzid?: string | null; date?: boolean; fallbackZone: string }) {
  const trimmed = value.trim();
  const dateMatch = DATE_VALUE.exec(trimmed);
  if (dateMatch || options.date) {
    const match = dateMatch ?? DATE_TIME_VALUE.exec(trimmed);
    if (!match) return null;
    const wall = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
    return validWall(wall) ? ({ allDay: true, wall, zone: "UTC" } satisfies IcsTime) : null;
  }
  const match = DATE_TIME_VALUE.exec(trimmed);
  if (!match) return null;
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Math.min(Number(match[6]), 59),
  };
  if (!validWall(wall)) return null;
  const zone = match[7] ? "UTC" : (resolveZone(options.tzid) ?? (options.tzid ? "UTC" : options.fallbackZone));
  return { allDay: false, wall, zone } satisfies IcsTime;
}

export function parseTimeProperty(property: IcsProperty | undefined, fallbackZone: string): IcsTime | null {
  if (!property) return null;
  return parseTimeValue(property.value.split(",")[0], {
    tzid: param(property, "TZID"),
    date: param(property, "VALUE")?.toUpperCase() === "DATE",
    fallbackZone,
  });
}

export function parseTimeList(properties: IcsProperty[], fallbackZone: string) {
  const times: IcsTime[] = [];
  for (const property of properties) {
    if (param(property, "VALUE")?.toUpperCase() === "PERIOD") continue;
    for (const part of property.value.split(",")) {
      const time = parseTimeValue(part, {
        tzid: param(property, "TZID"),
        date: param(property, "VALUE")?.toUpperCase() === "DATE",
        fallbackZone,
      });
      if (time) times.push(time);
      if (times.length >= 5000) return times;
    }
  }
  return times;
}

export function parseDuration(value: string | null | undefined) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value?.trim() ?? "");
  if (!match || value?.trim().toUpperCase().replace(/^[+-]/, "") === "P") return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const totalDays = Number(weeks ?? 0) * 7 + Number(days ?? 0);
  const ms = ((totalDays * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60_000 + Number(seconds ?? 0) * 1000;
  return { ms: sign === "-" ? -ms : ms, days: sign === "-" ? -totalDays : totalDays };
}
