import { scheduleIndexing } from "@/lib/knowledge/background";
import { addCallToKnowledge } from "@/lib/knowledge/calls";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, errorText } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { detectTaskRecordsInDb } from "@/lib/crm/task-detect";
import { createTaskInDb } from "@/lib/crm/tasks";
import {
  ACCOUNT_HEALTH,
  CALL_INSIGHT_SOURCES,
  CALL_INSIGHT_STALE_MS,
  type AccountHealth,
  type Actor,
  type CallActionItem,
  type CallActionOwner,
  type CallInsight,
  type CallInsightSource,
  type CallInsightStatus,
  type Provenance,
  type Task,
} from "@/lib/crm/types";
import { completeJson, LlmError, MODEL_WINDOW_CHARS, OUT_OF_TIME } from "@/lib/llm";
import { appTimeZone, zonedParts } from "@/lib/time";

export const TRANSCRIPT_PAGE_LENGTH = 80_000;
const TRANSCRIPT_OFFSET_MAX = 2_000_000_000;
const PART_CONCURRENCY = 3;
const PART_SIZE = 40_000;
const PART_NOTES_TOKENS = 4_000;
const PART_START_MARGIN_MS = 10_000;
const DEADLINE_SLACK_MS = 8_000;
export const TRANSCRIPT_TOOL = "get_call_transcript";
const PROMPT_ROOM = 8_000;
const PART_LENGTH = MODEL_WINDOW_CHARS - PROMPT_ROOM;
export const PENDING_STALE_MS = CALL_INSIGHT_STALE_MS;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const INSIGHT_COLUMNS = `
  i.id,
  i.workspace_id,
  i.activity_id,
  i.contact_id,
  i.company_id,
  i.source,
  i.summary,
  i.key_points,
  i.action_items,
  i.model,
  i.status,
  i.error,
  i.sentiment,
  i.sentiment_reason,
  char_length(i.transcript)::int as transcript_length,
  i.created_at,
  i.updated_at
`;

type InsightRow = {
  id: string;
  workspace_id: string;
  activity_id: string;
  contact_id: string | null;
  company_id: string | null;
  source: CallInsightSource;
  summary: string | null;
  key_points: unknown;
  action_items: unknown;
  model: string | null;
  status: CallInsightStatus;
  error: string | null;
  sentiment: AccountHealth | null;
  sentiment_reason: string | null;
  transcript_length: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type CallRow = {
  id: string;
  type: string;
  title: string | null;
  occurred_at: Date | string;
  contact_id: string | null;
  company_id: string | null;
  contact_name: string | null;
  contact_job_title: string | null;
  contact_company_id: string | null;
  company_name: string | null;
};

function mapItems(value: unknown): CallActionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CallActionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") continue;
    items.push({
      id: item.id,
      title: item.title,
      owner: item.owner === "me" || item.owner === "them" ? item.owner : null,
      dueDate: typeof item.dueDate === "string" ? item.dueDate : null,
      status:
        item.status === "accepted" || item.status === "dismissed" ? item.status : "suggested",
      taskId: typeof item.taskId === "string" ? item.taskId : null,
    });
  }
  return items;
}

function mapInsight(row: InsightRow): CallInsight {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    activityId: row.activity_id,
    contactId: row.contact_id,
    companyId: row.company_id,
    source: row.source,
    summary: row.summary,
    keyPoints: Array.isArray(row.key_points)
      ? row.key_points.filter((point): point is string => typeof point === "string")
      : [],
    actionItems: mapItems(row.action_items),
    model: row.model,
    status: row.status,
    error: row.error,
    sentiment: row.sentiment,
    sentimentReason: row.sentiment_reason,
    transcriptLength: row.transcript_length,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function cueText(text: string) {
  return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function isVtt(text: string) {
  return /^WEBVTT/.test(text) || /^\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+/m.test(text);
}

export function transcriptToText(raw: string) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!isVtt(text)) return text;
  const turns: { speaker: string | null; text: string }[] = [];
  const push = (speaker: string | null, line: string) => {
    if (!line) return;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text = `${last.text} ${line}`;
    else turns.push({ speaker, text: line });
  };
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing === -1) continue;
    const body = lines.slice(timing + 1).join("\n");
    const voices = [...body.matchAll(/<v(?:\.[^\s>]*)?\s+([^>]+)>([\s\S]*?)(?:<\/v>|(?=<v[\s.])|$)/g)];
    if (voices.length === 0) {
      push(null, cueText(body));
      continue;
    }
    for (const voice of voices) {
      push(cueText(voice[1]) || null, cueText(voice[2]));
    }
  }
  return turns
    .map((turn) => (turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text))
    .join("\n");
}

function utcDay(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

function dayString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function validDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = utcDay(year, month, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function callDay(occurredAt: string, timeZone = appTimeZone()) {
  const parts = zonedParts(new Date(occurredAt), timeZone);
  return utcDay(parts.year, parts.month, parts.day);
}

export function resolveDueDate(
  value: string | null | undefined,
  occurredAt: string,
  timeZone = appTimeZone(),
) {
  if (!value) return null;
  const text = value.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  if (!text) return null;
  const exact = validDay(text);
  if (exact) return exact;
  const base = callDay(occurredAt, timeZone);
  const shift = (days: number) => dayString(new Date(base.getTime() + days * DAY_MS));
  if (text === "today" || text === "tonight" || text === "end of day" || text === "eod") return shift(0);
  if (text === "tomorrow") return shift(1);
  if (text === "day after tomorrow" || text === "the day after tomorrow") return shift(2);
  const weekday = base.getUTCDay();
  if (text === "next week") return shift(((8 - weekday) % 7) || 7);
  if (/^(?:by )?(?:the )?end of (?:the |this )?week$|^eow$/.test(text)) {
    return shift(weekday <= 5 ? 5 - weekday : 6);
  }
  if (/^(?:by )?(?:the )?end of (?:the |this )?month$|^eom$/.test(text)) {
    return dayString(utcDay(base.getUTCFullYear(), base.getUTCMonth() + 2, 0));
  }
  const inDays = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(text);
  if (inDays) {
    const count = Number(inDays[1]);
    return shift(inDays[2].startsWith("week") ? count * 7 : count);
  }
  const named = /^(?:by |on )?(?:(this|next) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text);
  if (named) {
    const target = WEEKDAYS.indexOf(named[2]);
    const ahead = (target - weekday + 7) % 7 || 7;
    return shift(ahead);
  }
  return null;
}

function longDay(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function shortDay(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

const HEALTH_RULES = `- health: how the relationship with the other party stands after this call, judged from their side (their mood, commitment and intent), not from how polite the call was.
  - "healthy": engaged and positive, things are on track or moving forward.
  - "watch": mixed signals: concerns, hesitation, slipping timelines, unanswered objections, a new decision maker, or lukewarm engagement.
  - "at_risk": clear frustration or dissatisfaction, talk of cancelling, not renewing, pausing, cutting back or looking at competitors, or a serious unresolved complaint.
  - null only when the call holds no signal at all about the relationship (for example an internal call or a few words of small talk).
- healthReason: one plain sentence, at most 200 characters, naming the specific thing said that decided the health. null when health is null.`;

const SYSTEM_PROMPT = `You summarise sales and relationship calls and meetings for a personal CRM called Orbit.

Read the call transcript and reply with a single JSON object and nothing else: no prose, no Markdown, no code fences. Use exactly this shape:
{"summary": string, "keyPoints": string[], "actionItems": [{"title": string, "owner": "me" | "them" | null, "dueDate": "YYYY-MM-DD" | null}], "health": "healthy" | "watch" | "at_risk" | null, "healthReason": string | null}

Rules:
- Write in British English. Be concise and factual. Use only what the transcript says; never invent names, figures, dates or commitments. If something is unclear, leave it out.
- summary: 2 to 4 plain sentences on who spoke, what the call was about and where things were left.
- keyPoints: at most 6 short bullet points (no leading dashes or numbering) covering decisions, needs, objections, figures and dates that were actually mentioned. Use an empty array if there is nothing worth noting.
- actionItems: only concrete commitments someone made to do something after the call. Do not turn general discussion, hopes or vague ideas into action items. Use an empty array if nobody committed to anything.
  - title: a short imperative next step of at most 120 characters, written so it makes sense on its own as a to-do in the Orbit user's list. For something the other party committed to, name them, for example "Sarah to send the signed order form".
  - owner: "me" when the Orbit user committed to it, "them" when the other party did, null when it is genuinely unclear.
  - dueDate: only when a date or relative day was actually stated for that item ("Friday", "tomorrow", "next week", "by the 14th"). Resolve it against the call date given below in London time and write it as YYYY-MM-DD. "Next week" with no day means the Monday of the following week. Use null when no timing was stated; never guess one.
${HEALTH_RULES}
- The transcript may be machine generated, with errors and speaker labels such as "Name: text". Lines may be unlabelled.`;

const llmSchema = z.object({
  summary: z.string().trim().min(1),
  keyPoints: z.array(z.unknown()).catch([]),
  actionItems: z
    .array(
      z.object({
        title: z.string(),
        owner: z.enum(["me", "them"]).nullable().optional().catch(null),
        dueDate: z.string().nullable().optional().catch(null),
      }).nullable().catch(null),
    )
    .catch([]),
  health: z.enum(ACCOUNT_HEALTH).nullable().optional().catch(null),
  healthReason: z.string().nullable().optional().catch(null),
});

type LlmSummary = z.infer<typeof llmSchema>;

type Reading = { text: string; notes: boolean };

const LONG_CALL_LABEL = "The transcript:";

const LONG_CALL_NOTE = "(This transcript is too long to read again. The summary, key points and actions below were written from every part of it, so judge from them.)";

const NOTES_LABEL = "Notes on the transcript, in order:";

const NOTES_RULE = `
- You are given notes, in order, from consecutive parts of the same call, because the whole transcript was too long for one pass. Read them as the whole call. Each note covers its own part, so combine them and keep every commitment, figure and date.`;

const PART_PROMPT = `You read one part of a long call transcript, or of notes on one, for a personal CRM called Orbit, and write notes that a later summary will be built from.

Reply with a single JSON object and nothing else: {"notes": string}

Rules:
- Write in British English. Use only what this part says; never invent names, figures, dates or commitments.
- Keep everything a summary could need, in the order it was said: who spoke, the topics, decisions, needs, objections, figures and dates, every commitment (who will do what, with any timing in the speaker's words), and any sign of how the other party feels about the relationship.
- Plain text in short lines, no Markdown, under 1,500 words.
- Lines may be labelled "Name: text" or unlabelled. The part may start or end in the middle of a conversation.`;

const notesSchema = z.object({ notes: z.string().trim().min(1) });

function safeCut(text: string, at: number) {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

export function splitTranscript(text: string, size: number) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const line = rest.lastIndexOf("\n", size);
    if (line > size / 2) {
      parts.push(rest.slice(0, line));
      rest = rest.slice(line + 1);
    } else {
      const at = safeCut(rest, size);
      parts.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
  }
  if (rest) parts.push(rest);
  return parts;
}

function ranOutOfTime(error: unknown, deadline: number | undefined) {
  if (!(error instanceof LlmError)) return false;
  if (error.message === OUT_OF_TIME) return true;
  return error.retryable && deadline !== undefined && Date.now() >= deadline - DEADLINE_SLACK_MS;
}

type Progress = { hash: string; size: number; levels: (string | null)[][] };

type Report = { progressed: boolean };

function timeShort(deadline: number | undefined) {
  return deadline !== undefined && deadline - Date.now() < PART_START_MARGIN_MS;
}

function savedProgress(value: unknown, hash: string): Progress | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<Progress>;
  if (saved.hash !== hash || saved.size !== PART_SIZE || !Array.isArray(saved.levels)) return null;
  const levels = saved.levels.map((level) =>
    Array.isArray(level) ? level.map((note) => (typeof note === "string" && note ? note : null)) : [],
  );
  return { hash, size: PART_SIZE, levels };
}

async function readTranscript(
  call: CallRow,
  transcript: string,
  actor: Actor,
  options: { fetchImpl?: typeof fetch; deadline?: number },
  saved: unknown,
  save: (progress: Progress) => Promise<void>,
  report: Report,
): Promise<Reading | null> {
  if (transcript.length <= PART_LENGTH) return { text: transcript, notes: false };
  const hash = createHash("sha256").update(transcript).digest("hex");
  const progress = savedProgress(saved, hash) ?? { hash, size: PART_SIZE, levels: [] };
  let queue: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(progress);
    const run = queue.then(() => save(snapshot));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      () => true,
      () => false,
    );
  };
  let input = transcript;
  let size = transcript.length;
  for (let level = 0; ; level += 1) {
    const parts = splitTranscript(input, PART_SIZE);
    let slots = progress.levels[level];
    if (!slots || slots.length !== parts.length) {
      slots = parts.map(() => null);
      progress.levels[level] = slots;
      progress.levels.length = level + 1;
    }
    const todo = slots.flatMap((note, index) => (note === null ? [index] : []));
    let next = 0;
    let stopped = false;
    let failed = false;
    let failure: unknown;
    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length && !stopped && !failed) {
        if (timeShort(options.deadline)) {
          stopped = true;
          return;
        }
        const index = todo[next];
        next += 1;
        try {
          const result = await completeJson({
            system: PART_PROMPT,
            user: buildPrompt(call, parts[index], actorName(actor), `Part ${index + 1} of ${parts.length}:`),
            schema: notesSchema,
            maxTokens: PART_NOTES_TOKENS,
            fetchImpl: options.fetchImpl,
            deadline: options.deadline,
          });
          slots[index] = result.data.notes;
          if (await persist()) report.progressed = true;
          else stopped = true;
        } catch (error) {
          if (ranOutOfTime(error, options.deadline)) stopped = true;
          else {
            failed = true;
            failure = error;
          }
        }
      }
    });
    await Promise.all(workers);
    await queue;
    if (failed) throw failure;
    if (stopped || slots.some((note) => note === null)) return null;
    const joined = slots.map((note, index) => `Part ${index + 1} of ${slots.length}:\n${note}`).join("\n\n");
    if (joined.length <= PART_LENGTH) return { text: joined, notes: true };
    if (joined.length >= size) throw new CrmError("internal_error", "Couldn't summarise the call. Try again.", 500);
    size = joined.length;
    input = joined;
  }
}

function buildPrompt(call: CallRow, transcript: string, actorName: string | null, label = "Transcript:") {
  const day = callDay(iso(call.occurred_at) ?? new Date().toISOString());
  const them = [
    call.contact_name,
    call.contact_job_title ? `(${call.contact_job_title})` : null,
    call.company_name ? `at ${call.company_name}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const kind = call.type === "meeting" ? "Meeting" : "Call";
  return [
    `${kind} details:`,
    `- ${kind} date: ${longDay(day)} (${dayString(day)}), London time`,
    `- The Orbit user ("me"): ${actorName || "the Orbit user"}`,
    `- The other party ("them"): ${them || "unknown"}`,
    call.title ? `- Logged as: ${call.title}` : null,
    "",
    label,
    "<transcript>",
    transcript,
    "</transcript>",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function cleanSummary(data: LlmSummary, occurredAt: string) {
  const keyPoints = data.keyPoints
    .filter((point): point is string => typeof point === "string")
    .map((point) => point.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((point) => point.slice(0, 500));
  const actionItems: CallActionItem[] = [];
  for (const item of data.actionItems) {
    const title = item?.title.trim().slice(0, 200);
    if (!item || !title) continue;
    actionItems.push({
      id: randomUUID(),
      title,
      owner: (item.owner ?? null) as CallActionOwner | null,
      dueDate: resolveDueDate(item.dueDate, occurredAt),
      status: "suggested",
      taskId: null,
    });
    if (actionItems.length === 10) break;
  }
  return { summary: data.summary.trim().slice(0, 4000), keyPoints, actionItems, ...cleanHealth(data) };
}

function cleanHealth(data: { health?: AccountHealth | null; healthReason?: string | null }) {
  const sentiment = data.health ?? null;
  const reason = sentiment ? data.healthReason?.replace(/\s+/g, " ").trim().slice(0, 500) || null : null;
  return { sentiment, sentimentReason: reason };
}

async function readCall(db: Db, actor: Actor, activityId: string) {
  const result = await db.query<CallRow>(
    `select
       a.id,
       a.type,
       a.title,
       a.occurred_at,
       a.contact_id,
       a.company_id,
       coalesce(
         nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
         ct.email,
         ct.phone
       ) as contact_name,
       ct.job_title as contact_job_title,
       ct.company_id as contact_company_id,
       coalesce(co.name, cco.name) as company_name
     from crm.activities a
     left join crm.contacts ct on ct.id = a.contact_id
     left join crm.companies co on co.id = a.company_id
     left join crm.companies cco on cco.id = ct.company_id
     where a.id = $1 and a.workspace_id = $2 and a.archived_at is null`,
    [activityId, actor.workspaceId],
  );
  return result.rows[0] ?? null;
}

async function lockInsight(db: Db, where: string, values: unknown[]) {
  const result = await db.query<InsightRow>(
    `select ${INSIGHT_COLUMNS} from crm.call_insights i where ${where} for update`,
    values,
  );
  return result.rows[0] ?? null;
}

async function lockInsightWithTranscript(db: Db, activityId: string, workspaceId: string) {
  const result = await db.query<InsightRow & { transcript: string; part_notes: unknown }>(
    `select ${INSIGHT_COLUMNS}, i.transcript, i.part_notes
     from crm.call_insights i
     where i.activity_id = $1 and i.workspace_id = $2
     for update`,
    [activityId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function finishInsight(
  db: Db,
  id: string,
  values: {
    status: CallInsightStatus;
    summary?: string | null;
    keyPoints?: string[];
    actionItems?: CallActionItem[];
    model?: string | null;
    error?: string | null;
    sentiment?: AccountHealth | null;
    sentimentReason?: string | null;
  },
) {
  const result = await db.query<InsightRow>(
    `update crm.call_insights i
     set status = $2,
         summary = case when $2 = 'ready' then $3 else i.summary end,
         key_points = case when $2 = 'ready' then $4::jsonb else i.key_points end,
         action_items = case when $2 = 'ready' then $5::jsonb else i.action_items end,
         model = coalesce($6, i.model),
         error = $7,
         sentiment = case when $2 = 'ready' then $8 else i.sentiment end,
         sentiment_reason = case when $2 = 'ready' then $9 else i.sentiment_reason end,
         sentiment_checked_at = case when $2 = 'ready' then now() else i.sentiment_checked_at end,
         part_notes = case when $2 = 'ready' then null else i.part_notes end
     where i.id = $1
     returning ${INSIGHT_COLUMNS}`,
    [
      id,
      values.status,
      values.summary ?? null,
      JSON.stringify(values.keyPoints ?? []),
      JSON.stringify(values.actionItems ?? []),
      values.model ?? null,
      values.error ?? null,
      values.sentiment ?? null,
      values.sentimentReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Call summary not found.", 404);
  return mapInsight(row);
}

async function applyCallHealth(db: Db, actor: Actor, call: CallRow, insight: CallInsight, source: string) {
  if (!insight.sentiment || !actor.scopes.includes("companies:write")) return;
  const companyId = call.company_id ?? call.contact_company_id;
  if (!companyId) return;
  const occurredAt = iso(call.occurred_at) ?? new Date().toISOString();
  const result = await db.query<{ health: AccountHealth | null; health_reason: string | null; health_at: Date | string | null }>(
    `select health, health_reason, health_at from crm.companies
     where id = $1 and workspace_id = $2 and archived_at is null
     for update`,
    [companyId, actor.workspaceId],
  );
  const current = result.rows[0];
  if (!current) return;
  const setAt = iso(current.health_at);
  if (setAt && new Date(setAt).getTime() > new Date(occurredAt).getTime()) return;
  await db.query(
    `update crm.companies
     set health = $2, health_reason = $3, health_at = $4, health_activity_id = $5
     where id = $1`,
    [companyId, insight.sentiment, insight.sentimentReason, occurredAt, insight.activityId],
  );
  const fields = [
    current.health !== insight.sentiment ? "health" : null,
    current.health_reason !== insight.sentimentReason ? "healthReason" : null,
  ].filter((field): field is string => field !== null);
  if (!fields.length) return;
  await recordAudit(db, actor, "company.updated", "company", companyId, { operation: "call_health", source }, {
    fields,
    before: { health: current.health, healthReason: current.health_reason },
    after: { health: insight.sentiment, healthReason: insight.sentimentReason },
    activityId: insight.activityId,
  });
}

const SENTIMENT_PROMPT = `You judge how a client relationship stands after a call, for a personal CRM called Orbit.

Read the call and reply with a single JSON object and nothing else: {"health": "healthy" | "watch" | "at_risk" | null, "healthReason": string | null}

Rules:
- Write in British English. Use only what the call says.
${HEALTH_RULES}`;

const sentimentSchema = z.object({
  health: z.enum(ACCOUNT_HEALTH).nullable().optional().catch(null),
  healthReason: z.string().nullable().optional().catch(null),
});

export async function judgeCallSentiment(
  actor: Actor,
  activityId: string,
  options: { fetchImpl?: typeof fetch; deadline?: number } = {},
): Promise<CallInsight> {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(activityId)) throw new CrmError("not_found", "Call not found.", 404);
  const prepared = await withActor(actor, async (db) => {
    const call = await readCall(db, actor, activityId);
    const insight = await lockInsightWithTranscript(db, activityId, actor.workspaceId);
    if (!call || !insight || insight.status !== "ready") throw new CrmError("not_found", "Call summary not found.", 404);
    return { call, insight };
  });
  const { call, insight } = prepared;
  const long = insight.transcript.length > PART_LENGTH;
  const written = mapInsight(insight);
  const user = [
    buildPrompt(call, long ? LONG_CALL_NOTE : insight.transcript, actorName(actor), long ? LONG_CALL_LABEL : undefined),
    "",
    "Summary already written:",
    insight.summary ?? "",
    ...(long
      ? [
          "",
          "Key points:",
          ...written.keyPoints.map((point) => `- ${point}`),
          "",
          "Actions:",
          ...written.actionItems.map((item) => `- ${item.title}`),
        ]
      : []),
  ].join("\n");
  const result = await completeJson({
    system: SENTIMENT_PROMPT,
    user,
    schema: sentimentSchema,
    maxTokens: 400,
    fetchImpl: options.fetchImpl,
    deadline: options.deadline,
  });
  const judged = cleanHealth(result.data);
  return withActor(actor, async (db) => {
    const updated = await db.query<InsightRow>(
      `update crm.call_insights i
       set sentiment = $2, sentiment_reason = $3, sentiment_checked_at = now()
       where i.id = $1
       returning ${INSIGHT_COLUMNS}`,
      [insight.id, judged.sentiment, judged.sentimentReason],
    );
    const saved = mapInsight(updated.rows[0]);
    await applyCallHealth(db, actor, call, saved, insight.source);
    return saved;
  });
}

function actorName(actor: Actor) {
  return actor.type === "user" ? actor.fullName || actor.email : null;
}

function failureMessage(error: unknown) {
  return errorText(error, "Couldn't summarise the call. Try again.");
}

export type ReusedSummary = {
  summary: string;
  keyPoints: string[];
  actionItems: CallActionItem[];
  model: string | null;
  sentiment: AccountHealth | null;
  sentimentReason: string | null;
};

function reusedOutcome(reuse: ReusedSummary) {
  return {
    status: "ready" as const,
    summary: reuse.summary,
    keyPoints: reuse.keyPoints,
    actionItems: reuse.actionItems
      .filter((item) => item && typeof item.title === "string" && item.title.trim())
      .slice(0, 10)
      .map((item) => ({ ...item, id: randomUUID(), status: "suggested" as const, taskId: null })),
    model: reuse.model,
    sentiment: reuse.sentiment,
    sentimentReason: reuse.sentimentReason,
    error: null,
  };
}

async function saveProgress(actor: Actor, insightId: string, progress: Progress) {
  await withActor(actor, async (db) => {
    await db.query("update crm.call_insights set part_notes = $2::jsonb where id = $1", [insightId, JSON.stringify(progress)]);
  });
}

async function summaryOutcome(
  actor: Actor,
  call: Parameters<typeof buildPrompt>[0],
  transcript: string,
  occurredAt: string,
  options: { fetchImpl?: typeof fetch; deadline?: number },
  progress: { insightId: string; saved: unknown; report: Report },
): Promise<Parameters<typeof finishInsight>[2]> {
  try {
    const reading = await readTranscript(
      call,
      transcript,
      actor,
      options,
      progress.saved,
      (snapshot) => saveProgress(actor, progress.insightId, snapshot),
      progress.report,
    );
    if (!reading || timeShort(options.deadline)) return { status: "pending", error: null };
    const result = await completeJson({
      system: reading.notes ? SYSTEM_PROMPT + NOTES_RULE : SYSTEM_PROMPT,
      user: buildPrompt(call, reading.text, actorName(actor), reading.notes ? NOTES_LABEL : undefined),
      schema: llmSchema,
      maxTokens: 4000,
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
    });
    return {
      status: "ready",
      ...cleanSummary(result.data, occurredAt),
      model: result.model.slice(0, 200),
      error: null,
    };
  } catch (error) {
    if (ranOutOfTime(error, options.deadline)) return { status: "pending", error: null };
    return { status: "failed", error: failureMessage(error) };
  }
}

export async function summariseCall(
  actor: Actor,
  activityId: string,
  transcript: string,
  options: {
    source?: CallInsightSource;
    fetchImpl?: typeof fetch;
    deadline?: number;
    autoAccept?: boolean;
    reuse?: ReusedSummary | null;
    report?: Report;
  } = {},
): Promise<CallInsight> {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(activityId)) throw new CrmError("not_found", "Call not found.", 404);
  const source = options.source ?? "manual";
  if (!(CALL_INSIGHT_SOURCES as readonly string[]).includes(source)) {
    throw new CrmError("invalid_input", "Unknown transcript source.", 400, {
      field: "source",
    });
  }
  const text = transcriptToText(transcript);
  const prepared = await withActor(actor, async (db) => {
    const call = await readCall(db, actor, activityId);
    if (!call) throw new CrmError("not_found", "Call not found.", 404);
    if (call.type !== "call" && call.type !== "meeting") {
      throw new CrmError("invalid_input", "Only calls and meetings can be summarised.", 400, {
        field: "activityId",
      });
    }
    let current = await lockInsightWithTranscript(db, activityId, actor.workspaceId);
    if (!current) {
      if (!text) {
        throw new CrmError("invalid_input", "Paste a transcript.", 400, { field: "transcript" });
      }
      const inserted = await db.query<{ id: string }>(
        `insert into crm.call_insights (
           workspace_id, activity_id, contact_id, company_id, source, transcript, status
         ) values ($1, $2, $3, $4, $5, $6, 'pending')
         on conflict (activity_id) do nothing
         returning id`,
        [actor.workspaceId, activityId, call.contact_id, call.company_id, source, text],
      );
      current = await lockInsightWithTranscript(db, activityId, actor.workspaceId);
      if (!current) throw new CrmError("internal_error", "Couldn't save. Try again.", 500);
      if (inserted.rows[0]) return { call, insight: mapInsight(current), transcript: text, saved: null as unknown, run: true };
    }
    if (text && text !== current.transcript) {
      throw new CrmError("conflict", "This call already has a transcript.", 409, {
        field: "transcript",
      });
    }
    const stored = current.transcript;
    if (current.status === "ready") return { call, insight: mapInsight(current), transcript: stored, saved: null as unknown, run: false };
    const updatedAt = new Date(iso(current.updated_at) ?? 0).getTime();
    if (current.status === "pending" && Date.now() - updatedAt < PENDING_STALE_MS) {
      return { call, insight: mapInsight(current), transcript: stored, saved: null as unknown, run: false };
    }
    const insight = await finishInsight(db, current.id, { status: "pending" });
    return { call, insight, transcript: stored, saved: current.part_notes as unknown, run: true };
  });
  if (!prepared.run) return prepared.insight;

  const occurredAt = iso(prepared.call.occurred_at) ?? new Date().toISOString();
  const outcome = options.reuse ? reusedOutcome(options.reuse) : await summaryOutcome(actor, prepared.call, prepared.transcript, occurredAt, options, {
        insightId: prepared.insight.id,
        saved: prepared.saved,
        report: options.report ?? { progressed: false },
      });
  const finished = await withActor(actor, async (db) => {
    const saved = await finishInsight(db, prepared.insight.id, outcome);
    if (saved.status === "ready") {
      await applyCallHealth(db, actor, prepared.call, saved, source);
      await recordAudit(db, actor, "call_summary.ready", "call_insight", saved.id, { operation: "summarise_call", source: source }, {
        activityId: saved.activityId,
        companyId: saved.companyId,
        contactId: saved.contactId,
      });
    }
    return saved;
  });
  if (finished.status === "ready" && actor.type === "user") {
    try {
      const added = await addCallToKnowledge(actor, finished.id);
      if (added?.created) scheduleIndexing(actor, [added.item.id]);
    } catch (error) {
      console.error("Call transcript wasn't added to Knowledge", error);
    }
  }
  return options.autoAccept === false ? finished : acceptAllActionItems(actor, finished);
}

async function readItem(db: Db, actor: Actor, insightId: string, itemId: string) {
  if (!isUuid(insightId)) throw new CrmError("not_found", "Call summary not found.", 404);
  const current = await lockInsight(db, "i.id = $1 and i.workspace_id = $2", [
    insightId,
    actor.workspaceId,
  ]);
  if (!current) throw new CrmError("not_found", "Call summary not found.", 404);
  const items = mapItems(current.action_items);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw new CrmError("not_found", "Suggested action not found.", 404);
  return { current, items, item };
}

async function saveItems(db: Db, id: string, items: CallActionItem[]) {
  const result = await db.query<InsightRow>(
    `update crm.call_insights i set action_items = $2::jsonb where i.id = $1 returning ${INSIGHT_COLUMNS}`,
    [id, JSON.stringify(items)],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Call summary not found.", 404);
  return mapInsight(row);
}

export async function acceptActionItem(
  actor: Actor,
  insightId: string,
  itemId: string,
  overrides: { title?: string; dueDate?: string | null } = {},
  options: { provenance?: Provenance } = {},
): Promise<{ insight: CallInsight; task: Task | null }> {
  assertScope(actor.scopes, "tasks:write");
  const result = await withActor(actor, async (db) => {
    const { current, items, item } = await readItem(db, actor, insightId, itemId);
    if (item.status === "accepted" && item.taskId) {
      return { insight: mapInsight(current), task: null };
    }
    const title = overrides.title?.trim() || item.title;
    let dueDate = item.dueDate;
    if (overrides.dueDate !== undefined) {
      dueDate = overrides.dueDate ? validDay(overrides.dueDate.trim()) : null;
      if (overrides.dueDate && !dueDate) {
        throw new CrmError("invalid_input", "Enter a valid due date.", 400, { field: "dueDate" });
      }
    }
    const call = await readCall(db, actor, current.activity_id);
    if (!call) throw new CrmError("not_found", "Call not found.", 404);
    const detection = await detectTaskRecordsInDb(db, actor.workspaceId, title);
    const named = detection.contact;
    const someoneElse = named && named.id !== call.contact_id ? named : null;
    const companyId =
      call.contact_id && call.contact_company_id && call.contact_company_id !== call.company_id
        ? undefined
        : call.company_id;
    const day = callDay(iso(call.occurred_at) ?? new Date().toISOString());
    const task = await createTaskInDb(
      db,
      actor,
      {
        title,
        description: call.title
          ? `From the call on ${shortDay(day)}: ${call.title}`
          : `From the call on ${shortDay(day)}.`,
        dueDate: dueDate ?? null,
        ...(someoneElse
          ? { contactId: someoneElse.id }
          : call.contact_id || call.company_id
            ? { contactId: call.contact_id, ...(companyId !== undefined ? { companyId } : {}) }
            : {}),
      },
      options.provenance ?? { operation: "accept_call_action" },
      someoneElse ? { detectedLinks: { contactId: someoneElse.id, ...(someoneElse.company ? { companyId: someoneElse.company.id } : {}) } } : { detection },
    );
    const next = items.map((entry) =>
      entry.id === item.id
        ? { ...entry, title, dueDate, status: "accepted" as const, taskId: task.id }
        : entry,
    );
    return { insight: await saveItems(db, current.id, next), task };
  });
  if (result.task && actor.type === "user") {
    try {
      const { sendTaskToDefaultList } = await import("@/lib/crm/clickup");
      await sendTaskToDefaultList(actor, result.task.id);
    } catch (error) {
      console.error("Could not send the task to ClickUp", error);
    }
  }
  return result;
}

async function acceptAllActionItems(
  actor: Actor,
  insight: CallInsight,
): Promise<CallInsight> {
  if (insight.status !== "ready" || !actor.scopes.includes("tasks:write")) return insight;
  let latest = insight;
  for (const item of insight.actionItems) {
    if (item.status !== "suggested" || item.owner !== "me") continue;
    try {
      latest = (await acceptActionItem(actor, insight.id, item.id, {}, {
        provenance: { operation: "auto_accept_call_action" },
      })).insight;
    } catch (error) {
      console.error("Could not add a task from the call", error);
    }
  }
  return latest;
}

export async function dismissActionItem(
  actor: Actor,
  insightId: string,
  itemId: string,
): Promise<CallInsight> {
  assertScope(actor.scopes, "activities:write");
  return withActor(actor, async (db) => {
    const { current, items, item } = await readItem(db, actor, insightId, itemId);
    if (item.status !== "suggested") return mapInsight(current);
    const next = items.map((entry) =>
      entry.id === item.id ? { ...entry, status: "dismissed" as const } : entry,
    );
    return saveItems(db, current.id, next);
  });
}

export async function getInsightsForActivities(
  actor: Actor,
  activityIds: string[],
): Promise<Record<string, CallInsight>> {
  assertScope(actor.scopes, "crm:read");
  const ids = [...new Set(activityIds.filter((id) => isUuid(id)))];
  if (ids.length === 0) return {};
  return withActor(actor, async (db) => {
    const result = await db.query<InsightRow>(
      `select ${INSIGHT_COLUMNS}
       from crm.call_insights i
       where i.workspace_id = $1 and i.activity_id = any($2::uuid[])`,
      [actor.workspaceId, ids],
    );
    const grouped: Record<string, CallInsight> = {};
    for (const row of result.rows) grouped[row.activity_id] = mapInsight(row);
    return grouped;
  });
}

export async function getInsightTranscript(actor: Actor, insightId: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(insightId)) throw new CrmError("not_found", "Call summary not found.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<{ transcript: string }>(
      "select transcript from crm.call_insights where id = $1 and workspace_id = $2",
      [insightId, actor.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "Call summary not found.", 404);
    return row.transcript;
  });
}

function jsonLength(text: string) {
  return JSON.stringify(text).length - 2;
}

function fitJson(text: string, limit: number) {
  let fitted = text;
  for (let size = jsonLength(fitted); size > limit; size = jsonLength(fitted)) {
    const at = Math.max(1, Math.floor((fitted.length * limit * 0.98) / size));
    fitted = fitted.slice(0, safeCut(fitted, at));
  }
  return fitted;
}

export type TranscriptPage = {
  insightId: string;
  text: string;
  totalLength: number;
  offset: number;
  nextOffset: number | null;
};

export async function getInsightTranscriptPage(actor: Actor, insightId: string, offset = 0): Promise<TranscriptPage> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(insightId)) throw new CrmError("not_found", "Call summary not found.", 404);
  const start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.floor(offset), TRANSCRIPT_OFFSET_MAX) : 0;
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number; text: string }>(
      `select char_length(transcript)::int as total, substr(transcript, $3::int + 1, $4::int) as text
       from crm.call_insights where id = $1 and workspace_id = $2`,
      [insightId, actor.workspaceId, start, TRANSCRIPT_PAGE_LENGTH],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "Call summary not found.", 404);
    let text = fitJson(row.text, TRANSCRIPT_PAGE_LENGTH);
    let length = Array.from(text).length;
    if (start + length < row.total) {
      const line = text.lastIndexOf("\n");
      if (line > text.length / 2) {
        text = text.slice(0, line + 1);
        length = Array.from(text).length;
      }
    }
    const end = start + length;
    return { insightId, text, totalLength: row.total, offset: start, nextOffset: end < row.total ? end : null };
  });
}

export function withTranscriptHint<T extends { transcriptLength: number }>(insight: T) {
  return { ...insight, transcript: { length: insight.transcriptLength, tool: TRANSCRIPT_TOOL } };
}

export function withTranscriptHints<T extends { transcriptLength: number }>(insights: Record<string, T>) {
  return Object.fromEntries(Object.entries(insights).map(([key, insight]) => [key, withTranscriptHint(insight)]));
}
