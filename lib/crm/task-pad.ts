import { z } from "zod";
import { withActor } from "@/lib/crm/context";
import { REMINDER_MINUTES } from "@/lib/crm/reminder-options";
import type { UserActor } from "@/lib/crm/types";
import { completeJson } from "@/lib/llm";
import { londonParts } from "@/lib/task-pad";

export type PadRecord = { id: string; name: string };
export type PadDetection = { company: PadRecord | null; contact: (PadRecord & { company: PadRecord | null }) | null };

const MIN_NAME = 3;

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentioned(text: string, name: string) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function single<T extends { name: string }>(rows: T[], text: string) {
  const hits = rows.filter((row) => row.name.trim().length >= MIN_NAME && mentioned(text, row.name.trim()));
  const longest = Math.max(0, ...hits.map((row) => row.name.length));
  const best = hits.filter((row) => row.name.length === longest);
  return best.length === 1 ? best[0] : null;
}

export async function detectPadRecords(actor: UserActor, text: string): Promise<PadDetection> {
  const clean = text.trim().slice(0, 500);
  if (clean.length < MIN_NAME) return { company: null, contact: null };
  return withActor(actor, async (db) => {
    const companies = await db.query<{ id: string; name: string }>(
      `select id, name from crm.companies
       where workspace_id = $1 and archived_at is null and char_length(name) >= $3
         and strpos(lower($2), lower(name)) > 0
       order by char_length(name) desc limit 20`,
      [actor.workspaceId, clean, MIN_NAME],
    );
    const contacts = await db.query<{ id: string; name: string; company_id: string | null; company_name: string | null }>(
      `select c.id, trim(concat_ws(' ', c.first_name, c.last_name)) as name, c.company_id, co.name as company_name
       from crm.contacts c
       left join crm.companies co on co.id = c.company_id
       where c.workspace_id = $1 and c.archived_at is null
         and char_length(trim(concat_ws(' ', c.first_name, c.last_name))) >= $3
         and strpos(lower($2), lower(trim(concat_ws(' ', c.first_name, c.last_name)))) > 0
       order by char_length(trim(concat_ws(' ', c.first_name, c.last_name))) desc limit 20`,
      [actor.workspaceId, clean, MIN_NAME],
    );
    const company = single(companies.rows, clean);
    const contactRow = single(contacts.rows, clean);
    return {
      company: company ? { id: company.id, name: company.name } : null,
      contact: contactRow
        ? {
            id: contactRow.id,
            name: contactRow.name,
            company: contactRow.company_id && contactRow.company_name ? { id: contactRow.company_id, name: contactRow.company_name } : null,
          }
        : null,
    };
  });
}

const AI_SCHEMA = z.object({
  title: z.string(),
  due: z.string().nullable(),
  remindMinutes: z.number().nullable(),
});

export type PadAiParse = { title: string; due: string | null; remindMinutes: number | null };

function snapReminder(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return REMINDER_MINUTES.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best));
}

export async function parsePadWithAi(text: string, now = new Date()): Promise<PadAiParse | null> {
  const clean = text.trim().slice(0, 500);
  if (!clean) return null;
  const wall = londonParts(now);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Europe/London" }).format(now);
  const today = `${weekday} ${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
  const result = await completeJson({
    system:
      "You turn a short to-do written in UK English into JSON. Reply with JSON only: " +
      '{"title": string, "due": "YYYY-MM-DDTHH:mm" or null, "remindMinutes": number or null}. ' +
      "title is the task without the date, time and reminder words, starting with a capital letter. " +
      "due is in Europe/London local time. If a day is given without a time, use 09:00. If nothing says when, due is null. " +
      "remindMinutes is how many minutes before the due time to remind, or null if no reminder is asked for. " +
      `Now is ${today} in London.`,
    user: clean,
    schema: AI_SCHEMA,
    maxTokens: 300,
    timeoutMs: 12_000,
  });
  const due = result.data.due && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(result.data.due) ? result.data.due : null;
  return {
    title: result.data.title.trim().slice(0, 200) || clean,
    due,
    remindMinutes: due ? snapReminder(result.data.remindMinutes) : null,
  };
}
