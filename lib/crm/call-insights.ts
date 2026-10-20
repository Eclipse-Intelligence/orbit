import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
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
import { completeJson, LlmError } from "@/lib/llm";
import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

export const TRANSCRIPT_MAX_LENGTH = 200_000;
const RAW_TRANSCRIPT_MAX_LENGTH = 1_000_000;
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

export function dueAtForDay(day: string, timeZone = appTimeZone()) {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTimeToDate({ year, month, day: date, hour: 9, minute: 0, second: 0 }, timeZone).toISOString();
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

function buildPrompt(call: CallRow, transcript: string, actorName: string | null) {
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
    "Transcript:",
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
     where a.id = $1 and a.workspace_id = $2`,
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
  const result = await db.query<InsightRow & { transcript: string }>(
    `select ${INSIGHT_COLUMNS}, i.transcript
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
         sentiment_checked_at = case when $2 = 'ready' then now() else i.sentiment_checked_at end
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
  const user = [
    buildPrompt(call, insight.transcript.slice(0, TRANSCRIPT_MAX_LENGTH), actorName(actor)),
    "",
    "Summary already written:",
    insight.summary ?? "",
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
  if (error instanceof LlmError) return error.message.slice(0, 1000);
  console.error("Call summary failed", error);
  return "Could not summarise the call.";
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
  } = {},
): Promise<CallInsight> {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(activityId)) throw new CrmError("not_found", "Call not found.", 404);
  const source = options.source ?? "manual";
  if (!(CALL_INSIGHT_SOURCES as readonly string[]).includes(source)) {
    throw new CrmError("invalid_input", "Transcript source is not recognised.", 400, {
      field: "source",
    });
  }
  if (transcript.length > RAW_TRANSCRIPT_MAX_LENGTH) {
    throw new CrmError("invalid_input", "The transcript is too long.", 400, {
      field: "transcript",
    });
  }
  const text = transcriptToText(transcript);
  if (text.length > TRANSCRIPT_MAX_LENGTH) {
    throw new CrmError(
      "invalid_input",
      "The transcript is too long. Keep it under 200,000 characters.",
      400,
      { field: "transcript" },
    );
  }
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
      if (!current) throw new CrmError("internal_error", "Call summary was not saved.", 500);
      if (inserted.rows[0]) return { call, insight: mapInsight(current), transcript: text, run: true };
    }
    if (text && text !== current.transcript) {
      throw new CrmError("conflict", "This call already has a transcript.", 409, {
        field: "transcript",
      });
    }
    const stored = current.transcript;
    if (current.status === "ready") return { call, insight: mapInsight(current), transcript: stored, run: false };
    const updatedAt = new Date(iso(current.updated_at) ?? 0).getTime();
    if (current.status === "pending" && Date.now() - updatedAt < PENDING_STALE_MS) {
      return { call, insight: mapInsight(current), transcript: stored, run: false };
    }
    const insight = await finishInsight(db, current.id, { status: "pending" });
    return { call, insight, transcript: stored, run: true };
  });
  if (!prepared.run) return prepared.insight;

  const occurredAt = iso(prepared.call.occurred_at) ?? new Date().toISOString();
  let outcome: Parameters<typeof finishInsight>[2];
  try {
    const result = await completeJson({
      system: SYSTEM_PROMPT,
      user: buildPrompt(prepared.call, prepared.transcript, actorName(actor)),
      schema: llmSchema,
      maxTokens: 4000,
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
    });
    outcome = {
      status: "ready",
      ...cleanSummary(result.data, occurredAt),
      model: result.model.slice(0, 200),
      error: null,
    };
  } catch (error) {
    outcome = { status: "failed", error: failureMessage(error) };
  }
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
        dueAt: dueDate ? dueAtForDay(dueDate) : null,
        contactId: call.contact_id,
        ...(companyId !== undefined ? { companyId } : {}),
      },
      options.provenance ?? { operation: "accept_call_action" },
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
