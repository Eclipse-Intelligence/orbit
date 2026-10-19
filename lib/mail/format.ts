import { dateKey } from "@/lib/calendar-view";
import { appTimeZone } from "@/lib/time";
import type { MailAddress } from "@/lib/mail/types";

export function personName(address: MailAddress | null | undefined) {
  if (!address) return "Unknown sender";
  return address.name?.trim() || address.address;
}

export function firstName(address: MailAddress | null | undefined) {
  const name = personName(address);
  if (name.includes("@")) return name.split("@")[0];
  return name.split(/\s+/)[0] ?? name;
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

export function recipientList(addresses: MailAddress[], own: string[]) {
  const mine = new Set(own.map((item) => item.toLowerCase()));
  return addresses.map((address) => (mine.has(address.address.toLowerCase()) ? "me" : personName(address))).join(", ");
}
