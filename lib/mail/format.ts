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

export function stripQuoted(text: string) {
  const cut = text.search(/^(On .{3,200}wrote:|From: .+|-{3,}\s*Original Message\s*-{3,}|_{20,})\s*$/m);
  return (cut > 0 ? text.slice(0, cut) : text).replace(/\n{3,}/g, "\n\n").trim();
}
