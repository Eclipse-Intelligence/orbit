import { CrmError } from "@/lib/crm/errors";
import type { ReminderInput } from "@/lib/crm/reminders";

const FIELDS = ["title", "dueOn", "dueAt", "blocksTime", "durationMinutes", "repeat"] as const;

function objectOf(body: unknown, strict: boolean) {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (strict) throw new CrmError("invalid_input", "Send the reminder as a JSON object.", 400);
  return {};
}

export function readReminderInput(body: unknown, options: { strict?: boolean } = {}): ReminderInput {
  const source = objectOf(body, options.strict === true);
  if (options.strict) {
    const unknown = Object.keys(source).find((key) => !(FIELDS as readonly string[]).includes(key));
    if (unknown) throw new CrmError("invalid_input", `Reminders don't take ${unknown}. Send ${FIELDS.join(", ")}.`, 400, { field: unknown });
  }
  const input: Record<string, unknown> = {};
  for (const field of FIELDS) if (source[field] !== undefined) input[field] = source[field];
  return input as ReminderInput;
}

export function readTickDay(body: unknown): string | undefined {
  const source = objectOf(body, true);
  const unknown = Object.keys(source).find((key) => key !== "dueOn");
  if (unknown) throw new CrmError("invalid_input", `Ticking takes only dueOn, not ${unknown}.`, 400, { field: unknown });
  return source.dueOn === undefined || source.dueOn === null ? undefined : (source.dueOn as string);
}
