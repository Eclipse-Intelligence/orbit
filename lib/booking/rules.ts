export const BOOKING_DURATIONS = [15, 20, 30, 45, 60] as const;
export const BOOKING_NOTICE_OPTIONS = [0, 30, 60, 120, 240, 480, 1440, 2880] as const;
export const BOOKING_BUFFER_MAX = 60;
export const BOOKING_HORIZON_MAX = 90;
export const BOOKING_TITLE_MAX = 120;
export const BOOKING_INTRO_MAX = 500;
export const BOOKING_NAME_MAX = 120;
export const BOOKING_NOTE_MAX = 1000;
export const BOOKING_VIDEO_URL_MAX = 1000;
export const BOOKING_IMAGE_MAX_BYTES = 1024 * 1024;
export const BOOKING_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const BOOKING_SLUG_MIN = 3;
export const BOOKING_SLUG_MAX = 40;
export const BOOKING_TIME_ZONE = "Europe/London";
const BOOKING_PATH = "/book";

export type BookingImageKind = "avatar" | "poster";
type BookingImageType = (typeof BOOKING_IMAGE_TYPES)[number];

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type HoursRange = { start: string; end: string };
export type WeeklyHours = Record<Weekday, HoursRange[]>;

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const DEFAULT_HOURS: HoursRange = { start: "09:00", end: "17:30" };

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [DEFAULT_HOURS],
  tue: [DEFAULT_HOURS],
  wed: [DEFAULT_HOURS],
  thu: [DEFAULT_HOURS],
  fri: [DEFAULT_HOURS],
  sat: [],
  sun: [],
};

export const RESERVED_SLUGS = new Set([
  "about",
  "account",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "book",
  "booking",
  "bookings",
  "calendar",
  "callback",
  "contact",
  "contacts",
  "companies",
  "cron",
  "dashboard",
  "docs",
  "edit",
  "help",
  "home",
  "inbox",
  "index",
  "login",
  "logout",
  "mail",
  "new",
  "null",
  "orbit",
  "privacy",
  "public",
  "root",
  "settings",
  "signin",
  "signout",
  "signup",
  "static",
  "status",
  "support",
  "system",
  "terms",
  "test",
  "undefined",
  "user",
  "users",
  "webhook",
  "webhooks",
  "www",
]);

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_CLOCK = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkSlug(raw: string): Check<string> {
  const slug = raw.trim().toLowerCase();
  if (slug.length < BOOKING_SLUG_MIN) {
    return { ok: false, error: `Use at least ${BOOKING_SLUG_MIN} characters.` };
  }
  if (slug.length > BOOKING_SLUG_MAX) {
    return { ok: false, error: `Keep it under ${BOOKING_SLUG_MAX + 1} characters.` };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error: "Use lowercase letters, numbers and single hyphens, starting and ending with a letter or number.",
    };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: `“${slug}” is reserved. Pick another.` };
  return { ok: true, value: slug };
}

export function suggestSlug(name: string | null | undefined) {
  const base = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s+/)[0]
    ?.replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BOOKING_SLUG_MAX);
  if (base && checkSlug(base).ok) return base;
  return "meet";
}

export function firstName(name: string | null | undefined) {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const local = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  return local.split(/\s+/)[0] || null;
}

export function defaultTitle(name: string | null | undefined) {
  const first = firstName(name);
  return first ? `Book a call with ${first}` : "Book a call";
}

export function clockMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function checkWeeklyHours(value: unknown): Check<WeeklyHours> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Set your weekly hours." };
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) return { ok: false, error: "Set your weekly hours." };
  }
  const hours = {} as WeeklyHours;
  for (const day of WEEKDAYS) {
    const ranges = source[day] ?? [];
    if (!Array.isArray(ranges) || ranges.length > 4) return { ok: false, error: "Set your weekly hours." };
    const cleaned: HoursRange[] = [];
    for (const range of ranges) {
      const item = range && typeof range === "object" ? (range as Record<string, unknown>) : {};
      const start = typeof item.start === "string" ? item.start : "";
      const end = typeof item.end === "string" ? item.end : "";
      if (!CLOCK.test(start) || !END_CLOCK.test(end)) {
        return { ok: false, error: `Use 24-hour times like 09:00 for ${WEEKDAY_LABELS[day]}.` };
      }
      if (clockMinutes(end) <= clockMinutes(start)) {
        return { ok: false, error: `${WEEKDAY_LABELS[day]} needs to end after it starts.` };
      }
      cleaned.push({ start, end });
    }
    cleaned.sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start));
    for (let index = 1; index < cleaned.length; index += 1) {
      if (clockMinutes(cleaned[index].start) < clockMinutes(cleaned[index - 1].end)) {
        return { ok: false, error: `${WEEKDAY_LABELS[day]} has overlapping hours.` };
      }
    }
    hours[day] = cleaned;
  }
  return { ok: true, value: hours };
}

export function readWeeklyHours(value: unknown): WeeklyHours {
  const checked = checkWeeklyHours(value);
  return checked.ok ? checked.value : DEFAULT_WEEKLY_HOURS;
}

export function checkVideoUrl(raw: string): Check<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > BOOKING_VIDEO_URL_MAX) {
    return { ok: false, error: `Keep the link under ${BOOKING_VIDEO_URL_MAX} characters.` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter the full link, starting with https://." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use a secure link that starts with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the sign-in details from the link." };
  if (!url.hostname.includes(".")) return { ok: false, error: "Enter the full link, starting with https://." };
  if (url.href.length > BOOKING_VIDEO_URL_MAX || /\s/.test(url.href)) {
    return { ok: false, error: "Enter the full link, starting with https://." };
  }
  return { ok: true, value: url.href };
}

export function imageType(bytes: Uint8Array): BookingImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function noticeLabel(minutes: number) {
  if (minutes === 0) return "No notice";
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
}

export function bookingPath(slug: string) {
  return `${BOOKING_PATH}/${slug}`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}
