import { dateKey } from "@/lib/calendar-view";
import { appTimeZone } from "@/lib/time";
import type { MailAddress } from "@/lib/mail/types";

export function personName(address: MailAddress | null | undefined) {
  if (!address) return "Unknown sender";
  return address.name?.trim() || address.address;
}

export function mailListWhen(iso: string | null, now: number) {
  if (!iso) return "";
  const at = new Date(iso);
  const timeZone = appTimeZone();
  if (dateKey(at, timeZone) === dateKey(now, timeZone)) {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
  }
  const sameYear = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(at) ===
    new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(now);
  return new Intl.DateTimeFormat("en-GB", sameYear ? { day: "numeric", month: "short", timeZone } : { day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}

export function mailDayWhen(iso: string, now: number) {
  const at = new Date(iso);
  const timeZone = appTimeZone();
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
  if (dateKey(at, timeZone) === dateKey(now, timeZone)) return `Today ${time}`;
  if (dateKey(at, timeZone) === dateKey(now - 86_400_000, timeZone)) return `Yesterday ${time}`;
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(at)} ${time}`;
}

export function mailFullWhen(iso: string | null) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appTimeZone(),
  }).format(new Date(iso));
}

export function firstName(address: MailAddress | null | undefined) {
  if (!address) return "them";
  const name = address.name?.trim().split(/\s+/)[0];
  if (name && !name.includes("@")) return name;
  const local = address.address.split("@")[0].split(/[._+-]/)[0] || address.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function firstNames(list: MailAddress[]) {
  const names = list.map(firstName);
  if (names.length === 0) return "them";
  if (names.length === 1) return names[0];
  if (names.length > 3) return `${names[0]} and ${names.length - 1} others`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function followUpDay(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: appTimeZone() }).format(new Date(iso));
}

export function followUpWhen(iso: string) {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: appTimeZone() }).format(new Date(iso));
  return `${followUpDay(iso)} at ${time}`;
}

export function afterSending(openedAt: string, sentAt: string | null) {
  if (!sentAt) return null;
  const seconds = Math.floor((Date.parse(openedAt) - Date.parse(sentAt)) / 1000);
  if (!Number.isFinite(seconds)) return null;
  const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;
  const span =
    seconds < 60
      ? count(Math.max(0, seconds), "second")
      : seconds < 3600
        ? count(Math.floor(seconds / 60), "minute")
        : seconds < 86400
          ? count(Math.floor(seconds / 3600), "hour")
          : count(Math.floor(seconds / 86400), "day");
  return `${span} after sending`;
}

export function recipientList(addresses: MailAddress[], own: string[]) {
  const mine = new Set(own.map((item) => item.toLowerCase()));
  return addresses.map((address) => (mine.has(address.address.toLowerCase()) ? "me" : personName(address))).join(", ");
}

export function snippetCore(snippet: string | null) {
  if (!snippet) return "";
  const cut = snippet.search(/\s(?:_{8,}|-{5,}\s*Original Message|On \S[^]{2,200}? wrote:)/);
  return (cut > 0 ? snippet.slice(0, cut) : snippet).trim();
}

const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFEFF\uFFA0]/g;

export function visibleText(text: string) {
  return text
    .replace(INVISIBLE, "")
    .replace(/[ \t\u00A0]{2,}/g, " ")
    .replace(/[ \t\u00A0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapePattern(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SIGNATURE_LINES = 8;

export function stripSignature(text: string, options: { signature?: string | null; name?: string | null } = {}) {
  let lines = text.split("\n");
  const dashes = lines.findLastIndex((line) => /^-- ?$/.test(line));
  if (dashes > 0 && lines.length - dashes <= SIGNATURE_LINES) lines = lines.slice(0, dashes);
  const signatureLine = (options.signature ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 4);
  if (signatureLine) {
    const at = lines.findLastIndex((line) => line.trim().toLowerCase() === signatureLine.toLowerCase());
    if (at > 0) lines = lines.slice(0, at);
  }
  const first = options.name?.trim().split(/\s+/)[0] ?? "";
  if (first.length >= 2) {
    const signOff = new RegExp(`^\\s*${escapePattern(first)}[.!,]?\\s*$`, "i");
    const index = lines.findLastIndex((line, position) => position > 0 && signOff.test(line));
    if (index > 0) lines = lines.slice(0, index + 1);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripQuoted(text: string) {
  const clean = visibleText(text);
  const cut = clean.search(/^(On .{3,200}wrote:|From: .+|-{3,}\s*Original Message\s*-{3,}|_{20,})\s*$/m);
  return (cut > 0 ? clean.slice(0, cut) : clean).replace(/\n{3,}/g, "\n\n").trim();
}
