import { instantDateLabel } from "@/lib/date-input";
import { appTimeZone } from "@/lib/time";

type Kind = "email" | "call" | "meeting";

const KIND_NAMES: Record<Kind, string> = { call: "Call", email: "Email", meeting: "Meeting" };
const CLOSED_AFTER: Record<Kind, string> = { call: "the call", email: "your email", meeting: "the meeting" };
const OPEN_LABELS: Record<Kind, string> = { call: "Open call notes", email: "Open email", meeting: "Open meeting" };

export function activityWhen(iso: string, now = new Date(), timeZone = appTimeZone()) {
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(iso));
  return `${instantDateLabel(iso, now, timeZone)} ${time}`;
}

export function looksDoneWhat(offer: { kind: Kind; activityAt: string }, now = new Date()) {
  return `${KIND_NAMES[offer.kind]}, ${activityWhen(offer.activityAt, now)}`;
}

export function looksDoneOpenLabel(kind: Kind) {
  return OPEN_LABELS[kind];
}

export function closedAfterText(reason: { kind: Kind; at: string }, now = new Date()) {
  return `Closed after ${CLOSED_AFTER[reason.kind]} on ${activityWhen(reason.at, now)}`;
}
