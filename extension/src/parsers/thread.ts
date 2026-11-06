import type { ThreadMessage } from "../../../lib/extension/protocol";
import { canonicalProfile } from "../urls";
import { clean, firstElement, firstText, realValue, safeAll, textOf } from "./text";

export type ThreadPartner = { name: string | null; profileUrl: string | null };

export type PageThread = { person: ThreadPartner; messages: ThreadMessage[] };

const THREAD = [".msg-thread", ".msg-convo-wrapper", ".msg-overlay-conversation-bubble"];
const LIST = [".msg-s-message-list", ".msg-s-message-list-content"];
const HEADER = [".msg-thread__link-to-profile", ".msg-title-bar", ".msg-overlay-bubble-header", ".msg-entity-lockup"];
const PARTNER_NAME = [".msg-entity-lockup__entity-title", ".msg-thread__link-to-profile h2", ".msg-title-bar h2", "h2"];
const EVENT = ".msg-s-event-listitem, [data-event-urn]";
const HEADING = ".msg-s-message-list__time-heading";
const SENDER = [".msg-s-message-group__name", ".msg-s-message-group__profile-link", "[data-sender-name]"];
const TIME = ["time.msg-s-message-group__timestamp", ".msg-s-message-group__timestamp", "time"];
const BODY = [".msg-s-event-listitem__body", ".msg-s-event__content p", "p"];
const CONVERSATION_LIST = ".msg-conversations-container, .msg-conversation-listitem, [class*='conversation-list']";
const EVENT_LIMIT = 200;
const TEXT_LIMIT = 5000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function sameName(left: string | null, right: string | null) {
  const fold = (value: string | null) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return Boolean(left && right && fold(left) === fold(right));
}

function dayFrom(text: string, now: Date): Date | null {
  const value = text.toLowerCase().trim();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "today") return start;
  if (value === "yesterday") return new Date(start.getTime() - 86_400_000);
  const weekday = WEEKDAYS.indexOf(value);
  if (weekday >= 0) {
    const back = (start.getDay() - weekday + 7) % 7 || 7;
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() - back);
  }
  const dayFirst = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?$/.exec(value);
  const monthFirst = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(value);
  const parts = dayFirst
    ? { day: Number(dayFirst[1]), month: MONTHS.indexOf(dayFirst[2]), year: dayFirst[3] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: MONTHS.indexOf(monthFirst[1]), year: monthFirst[3] }
      : null;
  if (!parts || parts.month < 0) return null;
  const year = parts.year ? Number(parts.year) : now.getFullYear();
  let date = new Date(year, parts.month, parts.day);
  if (!parts.year && date.getTime() > start.getTime() + 86_400_000) date = new Date(year - 1, parts.month, parts.day);
  return date;
}

export function parseWhen(day: string | null, time: string | null, now = new Date()): string | null {
  const date = day ? dayFrom(day, now) : null;
  const clock = time ? /(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i.exec(time) : null;
  if (!date && !clock) return null;
  const base = date ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let hours = clock ? Number(clock[1]) : 12;
  const minutes = clock ? Number(clock[2]) : 0;
  const meridiem = clock?.[3]?.toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  base.setHours(hours, minutes, 0, 0);
  return Number.isNaN(base.getTime()) ? null : base.toISOString();
}

function threadIn(root: ParentNode): Element | null {
  for (const selector of THREAD) {
    const found = safeAll(root, selector).find((element) => !element.closest(CONVERSATION_LIST));
    if (found) return found;
  }
  const main = safeAll(root, "main").find((element) => safeAll(element, EVENT).length > 0);
  return main ?? null;
}

function headerIn(scope: ParentNode | null, selectors = HEADER): Element | null {
  if (!scope) return null;
  for (const selector of selectors) {
    const found = safeAll(scope, selector).find((element) => !element.closest(CONVERSATION_LIST) && !element.closest(EVENT));
    if (found) return found;
  }
  return null;
}

export function readPartner(root: ParentNode, url: string): ThreadPartner {
  const thread = threadIn(root);
  const header = headerIn(thread, [...HEADER, "header", "[role='banner']"]) ?? (thread ? null : headerIn(root));
  const candidates = [
    ...(header && header.matches("a[href*='/in/']") ? [header] : []),
    ...safeAll(header, "a[href*='/in/']"),
    ...safeAll(thread, "a[href*='/in/']"),
  ];
  let profileUrl: string | null = null;
  let profileAnchor: Element | null = null;
  for (const anchor of candidates) {
    if (anchor.closest(EVENT) || anchor.closest(CONVERSATION_LIST)) continue;
    profileUrl = canonicalProfile(anchor.getAttribute("href"), url);
    profileAnchor = anchor;
    if (profileUrl) break;
  }
  const named = header ? firstText(header, PARTNER_NAME) : firstText(thread, PARTNER_NAME.slice(0, -1));
  const fromLink = header && profileUrl ? realValue(textOf(profileAnchor)) : null;
  return { name: realValue(named) ?? fromLink, profileUrl };
}

function eventsIn(root: ParentNode) {
  const thread = threadIn(root);
  const list = firstElement(thread ?? root, LIST);
  const scope = list && (thread ? thread.contains(list) : !list.closest(CONVERSATION_LIST)) ? list : thread;
  if (!scope) return { scope: null, events: [] };
  const events = safeAll(scope, EVENT);
  const outer = events.filter((event) => !events.some((other) => other !== event && event.contains(other)));
  if (outer.length > 0) return { scope, events: outer };
  const items = safeAll(scope, "[role='list'] li, ul li").filter((item) => item.querySelector("p") && !item.querySelector("li") && !item.closest(CONVERSATION_LIST));
  return { scope, events: items };
}

function directionOf(event: Element, sender: string | null, partner: string | null): "mine" | "theirs" | null {
  const className = event.getAttribute("class") ?? "";
  if (/--other\b/.test(className)) return "theirs";
  if (sender && sameName(sender, partner)) return "theirs";
  if (/msg-s-event-listitem/.test(className)) return "mine";
  return null;
}

export function readThread(root: ParentNode, url: string, now = new Date()): PageThread {
  const person = readPartner(root, url);
  const found = eventsIn(root);
  const events = found.events.slice(-EVENT_LIMIT);
  const headings = safeAll(found.scope, HEADING);
  const messages: ThreadMessage[] = [];
  let sender: string | null = null;
  let time: string | null = null;
  for (const event of events) {
    const heading = headings.filter((item) => item.compareDocumentPosition(event) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    const day = textOf(heading ?? null);
    const named = firstText(event, SENDER);
    if (named) {
      sender = named;
      time = firstText(event, TIME);
    }
    const text = clean(textOf(firstElement(event, BODY)))?.slice(0, TEXT_LIMIT);
    if (!text) continue;
    const direction = directionOf(event, sender, person.name);
    if (!direction) continue;
    const mine = direction === "mine";
    const from = mine ? (sender ?? "You") : (person.name ?? sender ?? "Unknown");
    messages.push({ from, mine, when: [day, time].filter(Boolean).join(", ") || null, at: parseWhen(day, time, now), text });
  }
  return { person, messages };
}
