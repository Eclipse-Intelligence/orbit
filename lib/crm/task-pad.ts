import { z } from "zod";
import { withActor } from "@/lib/crm/context";
import { REMINDER_MINUTES } from "@/lib/crm/reminder-options";
import { detectTaskRecordsInDb, type DetectedTaskLinks } from "@/lib/crm/task-detect";
import type { UserActor } from "@/lib/crm/types";
import { completeJson } from "@/lib/llm";
import { londonParts } from "@/lib/task-pad";

export type PadRecord = { id: string; name: string };
export type PadDetection = DetectedTaskLinks;

export async function detectPadRecords(actor: UserActor, text: string): Promise<PadDetection> {
  return withActor(actor, (db) => detectTaskRecordsInDb(db, actor.workspaceId, text, { oneWordCompanies: true }));
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
