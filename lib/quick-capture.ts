import { authenticatePersonal, consumePersonalRateLimit, isPersonalToken } from "@/lib/auth/personal";
import { CrmError } from "@/lib/crm/errors";
import { createTask } from "@/lib/crm/tasks";
import { localTime } from "@/lib/docs/daily";
import { appendToDailyNote } from "@/lib/docs/daily-notes";

export const QUICK_TEXT_MAX = 4000;

export type QuickCapture = { to: "daily" | "task"; text: string };

const TASK_WORDS = new Set(["task", "tasks", "todo", "to do", "to-do"]);
const DAILY_WORDS = new Set(["daily", "note", "daily note", "journal", "jot", ""]);

export function readQuickCapture(input: unknown): QuickCapture {
  const source = typeof input === "string" ? { text: input } : input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = typeof source.text === "string" ? source.text.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new CrmError("invalid_input", "Nothing to add. Type or say something first.", 400, { field: "text" });
  if (text.length > QUICK_TEXT_MAX) throw new CrmError("invalid_input", `That's too long to add in one go (${QUICK_TEXT_MAX.toLocaleString("en-GB")} characters at most).`, 400, { field: "text" });
  const target = typeof source.to === "string" ? source.to.trim().toLowerCase() : "";
  if (TASK_WORDS.has(target)) return { to: "task", text };
  if (DAILY_WORDS.has(target)) return { to: "daily", text };
  throw new CrmError("invalid_input", 'Choose where it goes: "daily" or "task".', 400, { field: "to" });
}

export async function quickActor(request: Request) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!isPersonalToken(bearer)) throw new CrmError("unauthorized", "Add your Orbit personal token as the Authorization header (Bearer orbit_…). Create one in Settings, API and webhooks.", 401);
  const found = await authenticatePersonal(bearer);
  await consumePersonalRateLimit(found.tokenId);
  return found.actor;
}

export async function quickCapture(request: Request, input: QuickCapture, now = new Date()) {
  const actor = await quickActor(request);
  const provenance = { operation: "quick_capture", source: "shortcut" };
  if (input.to === "task") {
    const title = input.text.split("\n")[0].slice(0, 200);
    const rest = input.text.slice(title.length).trim();
    await createTask(actor, { title, description: rest || null, ownerId: actor.userId }, { provenance });
    return `Added a task: ${title}`;
  }
  await appendToDailyNote(actor, { text: input.text, now }, provenance);
  return `Added to today's note at ${localTime(now)}.`;
}
