import { z } from "zod";
import { withActor } from "@/lib/crm/context";
import { likePattern } from "@/lib/crm/normalize";
import { REMINDER_MINUTES } from "@/lib/crm/reminder-options";
import { assertScope } from "@/lib/crm/scopes";
import { detectTaskRecordsInDb, folded, memberNames, mentionsName, TEXT_LIMIT, type DetectedTaskLinks, type LinkedRecord } from "@/lib/crm/task-detect";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { completeJson } from "@/lib/llm";
import { londonParts, parseTaskText } from "@/lib/task-pad";

export type PadRecord = { id: string; name: string };

export type PadOption = { id: string; name: string; detail: string | null; company: LinkedRecord | null };

export type PadAsk = { word: string; candidates: PadOption[] };

export type PadDetection = DetectedTaskLinks & {
  contactTitle: string | null;
  companyDomain: string | null;
  matchedBy: "full" | "name" | null;
  word: string | null;
  ask: PadAsk | null;
};

export type PadSearchKind = "contact" | "company" | "opportunity";

export const NO_PAD_DETECTION: PadDetection = {
  company: null,
  contact: null,
  opportunity: null,
  contactTitle: null,
  companyDomain: null,
  matchedBy: null,
  word: null,
  ask: null,
};

const ASK_LIMIT = 6;
const NAME_WORD = /\p{Lu}[\p{L}'’-]*/gu;

type Range = { start: number; end: number };

function blank(text: string, ranges: Range[]) {
  let result = text;
  for (const range of ranges) result = `${result.slice(0, range.start)}${" ".repeat(range.end - range.start)}${result.slice(range.end)}`;
  return result;
}

function nameRanges(text: string, names: Iterable<string>) {
  const ranges: Range[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (!clean) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}-])(${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}-])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[1].length;
      ranges.push({ start, end: start + match[2].length });
    }
  }
  return ranges;
}

export function padNameWords(text: string) {
  const words: string[] = [];
  for (const match of text.matchAll(NAME_WORD)) {
    const word = match[0].replace(/['’]s$/u, "").replace(/['’-]+$/u, "");
    if (word.length >= 2 && !words.includes(word)) words.push(word);
  }
  return words;
}

type NameRow = {
  id: string;
  name: string;
  first: string | null;
  last: string | null;
  job_title: string | null;
  company_id: string | null;
  company_name: string | null;
};

const NAME_ROW_SQL = `select c.id, trim(concat_ws(' ', nullif(trim(c.first_name), ''), nullif(trim(c.last_name), ''))) as name,
    trim(c.first_name) as first, trim(c.last_name) as last, c.job_title, c.company_id, co.name as company_name
  from crm.contacts c
  left join crm.companies co on co.id = c.company_id`;

function option(row: NameRow): PadOption {
  return {
    id: row.id,
    name: row.name,
    detail: [row.job_title?.trim(), row.company_name].filter(Boolean).join(" · ") || null,
    company: row.company_id && row.company_name ? { id: row.company_id, name: row.company_name } : null,
  };
}

async function memberFirstNames(db: Db, workspaceId: string) {
  const result = await db.query<{ first: string | null }>(
    `select split_part(trim(p.full_name), ' ', 1) as first
     from crm.workspace_members m
     join crm.profiles p on p.id = m.user_id
     where m.workspace_id = $1`,
    [workspaceId],
  );
  return new Set(result.rows.flatMap((row) => (row.first ? [folded(row.first)] : [])));
}

async function nameMatches(db: Db, workspaceId: string, text: string, companyId: string | null, members: Set<string>) {
  const words = padNameWords(text);
  if (words.length === 0) return { contact: null, ask: null };
  const teammates = await memberFirstNames(db, workspaceId);
  const rows = await db.query<NameRow>(
    `${NAME_ROW_SQL}
     where c.workspace_id = $1 and c.archived_at is null
       and (trim(c.first_name) = any($2::text[]) or trim(c.last_name) = any($2::text[]))
     order by c.updated_at desc, c.id
     limit 60`,
    [workspaceId, words],
  );
  const people = rows.rows.filter((row) => row.name && !members.has(folded(row.name)));
  const groups = words.map((word) => {
    const all = people.filter((row) => row.first === word || row.last === word);
    const atCompany = companyId ? all.filter((row) => row.company_id === companyId) : [];
    return { word, rows: atCompany.length > 0 ? atCompany : all, shared: teammates.has(folded(word)) };
  });
  const sure = groups.find(
    (group) => group.rows.length === 1 && !group.shared && (!companyId || !group.rows[0].company_id || group.rows[0].company_id === companyId),
  );
  if (sure) return { contact: { row: sure.rows[0], word: sure.word }, ask: null };
  const unsure = groups.find((group) => group.rows.length > 0);
  if (!unsure) return { contact: null, ask: null };
  return { contact: null, ask: { word: unsure.word, candidates: unsure.rows.slice(0, ASK_LIMIT).map(option) } };
}

export async function detectPadRecordsInDb(db: Db, workspaceId: string, text: string, now = new Date()): Promise<PadDetection> {
  const clean = text.slice(0, TEXT_LIMIT);
  const dates = parseTaskText(clean, now).marks.filter((mark) => mark.kind !== "record");
  const plain = blank(clean, dates);
  const found = await detectTaskRecordsInDb(db, workspaceId, plain, { oneWordCompanies: true });
  const result: PadDetection = { ...NO_PAD_DETECTION, ...found, matchedBy: found.contact ? "full" : null };
  if (!found.contact && plain.trim().length >= 2) {
    const members = await memberNames(db, workspaceId);
    const named = [found.company?.name, found.opportunity?.name].filter((name): name is string => Boolean(name));
    const rest = blank(plain, [...nameRanges(plain, named), ...nameRanges(plain, members)]);
    const matched = await nameMatches(db, workspaceId, rest, found.company?.id ?? null, members);
    if (matched.contact) {
      const row = matched.contact.row;
      const company = row.company_id && row.company_name ? { id: row.company_id, name: row.company_name } : null;
      result.contact = { id: row.id, name: row.name, company };
      result.matchedBy = "name";
      result.word = matched.contact.word;
      if (!result.company && company) result.company = company;
      if (result.opportunity && result.company && result.opportunity.companyId !== result.company.id) result.opportunity = null;
    }
    result.ask = matched.ask;
  }
  if (result.contact) {
    const title = await db.query<{ job_title: string | null }>("select job_title from crm.contacts where id = $1", [result.contact.id]);
    result.contactTitle = title.rows[0]?.job_title?.trim() || null;
  }
  if (result.company) {
    const domain = await db.query<{ domain: string | null }>("select domain from crm.companies where id = $1", [result.company.id]);
    result.companyDomain = domain.rows[0]?.domain?.trim() || null;
    const name = result.company.name.trim();
    if (!result.contact && !/\s/.test(name) && mentionsName(plain, name, { exact: true })) result.word = name;
  }
  return result;
}

export async function detectPadRecords(actor: UserActor, text: string, now = new Date()): Promise<PadDetection> {
  return withActor(actor, (db) => detectPadRecordsInDb(db, actor.workspaceId, text, now));
}

export async function searchPadRecords(actor: UserActor, kind: PadSearchKind, query: string, companyId: string | null = null): Promise<PadOption[]> {
  assertScope(actor.scopes, "crm:read");
  const text = query.trim().slice(0, 200);
  const pattern = text ? likePattern(text) : null;
  return withActor(actor, async (db) => {
    if (kind === "company") {
      const rows = await db.query<{ id: string; name: string; domain: string | null }>(
        `select id, name, domain from crm.companies
         where workspace_id = $1 and archived_at is null
           and ($2::text is null or name ilike $2 escape '\\' or coalesce(domain, '') ilike $2 escape '\\')
         order by updated_at desc, id
         limit 8`,
        [actor.workspaceId, pattern],
      );
      return rows.rows.map((row) => ({ id: row.id, name: row.name, detail: row.domain, company: null }));
    }
    if (kind === "opportunity") {
      const rows = await db.query<{ id: string; name: string; company_id: string; company_name: string; stage: string | null }>(
        `select o.id, o.name, o.company_id, co.name as company_name, s.name as stage
         from crm.opportunities o
         join crm.companies co on co.id = o.company_id
         left join crm.pipeline_stages s on s.id = o.stage_id
         where o.workspace_id = $1 and o.archived_at is null
           and ($2::uuid is null or o.company_id = $2::uuid)
           and ($3::text is null or o.name ilike $3 escape '\\' or co.name ilike $3 escape '\\')
         order by (o.status = 'open') desc, o.updated_at desc, o.id
         limit 8`,
        [actor.workspaceId, companyId, pattern],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        name: row.name,
        detail: [row.company_name, row.stage].filter(Boolean).join(" · ") || null,
        company: { id: row.company_id, name: row.company_name },
      }));
    }
    const members = await memberNames(db, actor.workspaceId);
    const rows = await db.query<NameRow>(
      `${NAME_ROW_SQL}
       where c.workspace_id = $1 and c.archived_at is null
         and ($2::uuid is null or c.company_id = $2::uuid)
         and ($3::text is null or concat_ws(' ', c.first_name, c.last_name) ilike $3 escape '\\' or coalesce(c.email, '') ilike $3 escape '\\')
       order by c.updated_at desc, c.id
       limit 20`,
      [actor.workspaceId, companyId, pattern],
    );
    return rows.rows
      .filter((row) => row.name && !members.has(folded(row.name)))
      .slice(0, 8)
      .map(option);
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
