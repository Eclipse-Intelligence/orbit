export type TaskKind = "call" | "email" | "meeting" | "todo";

const CALL = new Set(["call", "calls", "calling", "ring", "rings", "ringing", "phone", "phones", "phoning", "telephone", "callback"]);
const EMAIL = new Set(["email", "emails", "emailing", "mail", "reply", "replies", "send", "sends", "sending", "resend"]);
const MEETING = new Set(["meet", "meets", "meeting", "meetings", "book", "books", "booking", "schedule", "schedules", "scheduling", "demo", "demos"]);

const PHONE_THINGS = new Set(["bill", "bills", "number", "numbers", "charger", "case", "contract", "plan", "upgrade", "screen"]);
const BOOK_WITH = new Set(["a", "an", "in", "with", "time", "meeting", "call", "demo", "slot", "session", "intro", "catch", "catchup", "lunch", "coffee", "them", "him", "her"]);
const DEMO_THINGS = new Set(["data", "account", "accounts", "site", "environment", "deck", "video", "version", "login", "link", "script"]);

type Word = { text: string; lower: string; capital: boolean };

function words(title: string): Word[] {
  return (title.match(/[\p{L}]+(?:-[\p{L}]+)*/gu) ?? []).map((text) => ({ text, lower: text.toLowerCase(), capital: /^\p{Lu}/u.test(text) }));
}

function kindOf(word: string, next: Word | undefined): TaskKind | null {
  if (CALL.has(word)) {
    if ((word === "phone" || word === "phones" || word === "telephone") && next && PHONE_THINGS.has(next.lower)) return null;
    return "call";
  }
  if (EMAIL.has(word)) return "email";
  if (MEETING.has(word)) {
    if (word.startsWith("book") && !(next && (BOOK_WITH.has(next.lower) || next.capital))) return null;
    if (word.startsWith("demo") && next && DEMO_THINGS.has(next.lower)) return null;
    return "meeting";
  }
  return null;
}

export function taskKind(title: string | null | undefined): TaskKind {
  const list = words(title ?? "");
  for (const [index, word] of list.entries()) {
    const next = list[index + 1];
    const whole = kindOf(word.lower.replace(/-/g, ""), next);
    if (whole) return whole;
    const parts = word.lower.split("-");
    if (parts.length < 2) continue;
    if (parts[0] === "e" && parts[1] === "mail") return "email";
    if (parts[0] === "re" && kindOf(parts[1], next)) return kindOf(parts[1], next)!;
    for (const part of parts) {
      const found = kindOf(part, next);
      if (found) return found;
    }
  }
  return "todo";
}
