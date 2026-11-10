import { z } from "zod";
import { brandOrEmpty } from "@/lib/crm/brand";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { getPersonalContext } from "@/lib/crm/personal-context";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { askJev, jevConfigured } from "@/lib/jev";
import { completeJson } from "@/lib/llm";
import { domainOf, listedCategory } from "@/lib/mail/senders";

import {
  RELEVANCE_CATEGORIES,
  type RelevanceCategory,
  type RelevanceEngine,
  type SkippedCategory,
  type StoredCategory,
} from "@/lib/mail/relevance-labels";

export { RELEVANCE_CATEGORIES, SENSITIVE_CATEGORIES, SKIPPED_LABELS } from "@/lib/mail/relevance-labels";
export type { RelevanceCategory, RelevanceEngine, SkippedCategory, StoredCategory } from "@/lib/mail/relevance-labels";

export const CLASSIFIER_MODEL = "claude-haiku-5-5";

const CACHE_MS = 60 * 24 * 60 * 60_000;
export const RETRY_MS = 30 * 60_000;
const CONFIDENT = 0.5;

export type Candidate = {
  key: string;
  messageId: string;
  email: string;
  name: string | null;
  subject: string | null;
  snippet: string | null;
  address: string;
  workspaceId: string;
};

export type Verdict =
  | { state: "shown"; engine: RelevanceEngine | null }
  | { state: "skipped"; category: SkippedCategory; engine: RelevanceEngine; reason: string | null }
  | { state: "pending" };

export type Judged<T extends Candidate> = { item: T; verdict: Verdict; retry: boolean; copy: Decision | null };

export type Decision = { category: StoredCategory | null; engine: RelevanceEngine; confidence: number | null; reason: string | null };

type StoredRow = {
  workspace_id: string;
  sender: string;
  category: StoredCategory | null;
  engine: RelevanceEngine;
  confidence: number | null;
  reason: string | null;
  rule?: boolean;
  decided_at: Date;
};

type ThreadRow = StoredRow & { source_id: string; thread_key: string };

export function classifierConfigured() {
  return jevConfigured() || Boolean(process.env.LLM_API_KEY?.trim());
}

export function ruleTarget(email: string) {
  const domain = domainOf(email);
  return !domain || isFreeMailDomain(domain) ? email.toLowerCase() : `@${domain}`;
}

export function neverAskLabel(email: string) {
  const target = ruleTarget(email);
  return target.startsWith("@") ? target : "this sender";
}

function splitKey(key: string) {
  const split = key.indexOf("|");
  return { sourceId: key.slice(0, split), threadKey: key.slice(split + 1) };
}

function fromStored(row: Pick<StoredRow, "category" | "confidence" | "reason">, engine: RelevanceEngine): Verdict {
  if (!row.category || row.category === "business") return { state: "shown", engine };
  if (row.category !== "muted" && row.confidence !== null && row.confidence < CONFIDENT) return { state: "shown", engine };
  return { state: "skipped", category: row.category, engine, reason: row.reason };
}

async function wroteTo(db: Db, actor: UserActor, emails: string[]) {
  if (emails.length === 0) return new Set<string>();
  const result = await db.query<{ address: string }>(
    `select distinct lower(r->>'address') as address
     from crm.mail_messages m
     join crm.mail_folders f on f.id = m.folder_id
     cross join lateral jsonb_array_elements(coalesce(m.to_recipients, '[]'::jsonb) || coalesce(m.cc_recipients, '[]'::jsonb)) r
     where m.user_id = $1 and f.role = 'sent' and not m.is_draft and jsonb_typeof(r) = 'object' and lower(r->>'address') = any($2::text[])`,
    [actor.userId, emails],
  );
  return new Set(result.rows.map((row) => row.address));
}

export async function judgeInDb<T extends Candidate>(db: Db, actor: UserActor, items: T[], now = Date.now()): Promise<Judged<T>[]> {
  if (items.length === 0) return [];
  const workspaceIds = [...new Set(items.map((item) => item.workspaceId))];
  const senders = [...new Set(items.flatMap((item) => [item.email, ruleTarget(item.email)]))];
  const keys = items.map((item) => splitKey(item.key));
  const [stored, threads] = await Promise.all([
    db.query<StoredRow>(
      `select workspace_id, sender, category, engine, confidence, reason, rule, decided_at from crm.mail_sender_relevance
       where user_id = $1 and workspace_id = any($2::uuid[]) and sender = any($3::text[])`,
      [actor.userId, workspaceIds, senders],
    ),
    db.query<ThreadRow>(
      `select t.source_id, t.thread_key, t.workspace_id, t.sender, t.category, t.engine, t.confidence, t.reason, t.decided_at
       from crm.mail_thread_relevance t
       join unnest($2::uuid[], $3::text[]) as k(source_id, thread_key) on k.source_id = t.source_id and k.thread_key = t.thread_key
       where t.user_id = $1`,
      [actor.userId, keys.map((key) => key.sourceId), keys.map((key) => key.threadKey)],
    ),
  ]);
  const bySender = new Map(stored.rows.map((row) => [`${row.workspace_id}|${row.sender}`, row]));
  const byThread = new Map(threads.rows.map((row) => [`${row.source_id}|${row.thread_key}`, row]));
  const settled = (item: T) => {
    const row = byThread.get(item.key);
    return row && row.workspace_id === item.workspaceId && (row.engine === "listed" || row.engine === "history") ? row : undefined;
  };
  const listed = items.filter((item) => listedCategory(item.email) && !settled(item)).map((item) => item.email);
  const wrote = await wroteTo(db, actor, [...new Set(listed)]);
  const configured = classifierConfigured();
  return items.map((item) => {
    const exact = bySender.get(`${item.workspaceId}|${item.email}`);
    const target = ruleTarget(item.email);
    const domainRule = target === item.email ? undefined : bySender.get(`${item.workspaceId}|${target}`);
    const thread = byThread.get(item.key);
    const own = thread && thread.workspace_id === item.workspaceId ? thread : undefined;
    const judged = (verdict: Verdict, copy: Decision | null = null, retry = false): Judged<T> => ({ item, verdict, retry, copy: own ? null : copy });
    if (exact?.rule) return judged(fromStored(exact, exact.engine));
    if (domainRule?.rule) return judged(fromStored(domainRule, domainRule.engine));
    const category = listedCategory(item.email);
    const known = category ? settled(item) : undefined;
    if (known) return judged(fromStored(known, known.engine));
    if (category && wrote.has(item.email)) return judged({ state: "shown", engine: "history" }, { category: "business", engine: "history", confidence: null, reason: null });
    if (category) return judged({ state: "skipped", category, engine: "listed", reason: null }, { category, engine: "listed", confidence: null, reason: null });
    if (own) {
      if (own.category === null) return judged({ state: "shown", engine: "failed" }, null, now - new Date(own.decided_at).getTime() > RETRY_MS && configured);
      return judged(fromStored(own, own.engine));
    }
    if (exact && now - new Date(exact.decided_at).getTime() < CACHE_MS) {
      return judged(fromStored(exact, "cached"), { category: exact.category, engine: "cached", confidence: exact.confidence, reason: exact.reason });
    }
    if (!configured) return judged({ state: "shown", engine: null });
    return judged({ state: "pending" });
  });
}

export async function storeThreadDecision(db: Db, actor: UserActor, item: Candidate, decision: Decision) {
  const { sourceId, threadKey } = splitKey(item.key);
  await db.query(
    `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, category, engine, confidence, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (user_id, source_id, thread_key) do update set workspace_id = excluded.workspace_id, sender = excluded.sender,
       category = excluded.category, engine = excluded.engine, confidence = excluded.confidence, reason = excluded.reason,
       decided_at = now(), updated_at = now()`,
    [item.workspaceId, actor.userId, sourceId, threadKey, item.email, decision.category, decision.engine, decision.confidence, decision.reason?.slice(0, 300) ?? null],
  );
}

export async function cacheSenderDecision(db: Db, actor: UserActor, workspaceId: string, sender: string, decision: Decision) {
  if (!decision.category) return;
  await db.query(
    `insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine, confidence, reason, rule)
     values ($1, $2, $3, $4, $5, $6, $7, false)
     on conflict (user_id, workspace_id, sender) do update set category = excluded.category, engine = excluded.engine,
       confidence = excluded.confidence, reason = excluded.reason, decided_at = now(), updated_at = now()
     where not crm.mail_sender_relevance.rule`,
    [workspaceId, actor.userId, sender, decision.category, decision.engine, decision.confidence, decision.reason?.slice(0, 300) ?? null],
  );
}

export async function setSenderRule(db: Db, actor: UserActor, workspaceId: string, sender: string, category: StoredCategory, engine: "rule" | "filed" | "shown") {
  await db.query(
    `insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine, rule)
     values ($1, $2, $3, $4, $5, true)
     on conflict (user_id, workspace_id, sender) do update set category = excluded.category, engine = excluded.engine,
       confidence = null, reason = null, rule = true, decided_at = now(), updated_at = now()`,
    [workspaceId, actor.userId, sender.toLowerCase(), category, engine],
  );
}

export async function recordFiledInDb(db: Db, actor: UserActor, workspaceId: string, email: string) {
  const sender = email.toLowerCase();
  await setSenderRule(db, actor, workspaceId, sender, "business", "filed");
  const target = ruleTarget(sender);
  if (target !== sender) await setSenderRule(db, actor, workspaceId, target, "business", "filed");
}

export function notSensitiveThreadSql(userExpr: string, sourceExpr: string, threadExpr: string) {
  return `not exists (
    select 1 from crm.mail_thread_relevance sensitive
    where sensitive.user_id = ${userExpr} and sensitive.source_id = ${sourceExpr} and sensitive.thread_key = ${threadExpr}
      and sensitive.category in ('personal', 'collections')
  )`;
}

export function sensitiveAddress(email: string | null | undefined) {
  const category = email ? listedCategory(email) : null;
  return category === "personal" || category === "collections";
}

export type History = {
  fromSender: number;
  toSender: number;
  senderFirst: string | null;
  senderLast: string | null;
  fromDomain: number | null;
  toDomain: number | null;
  domainFirst: string | null;
  domainLast: string | null;
  activities: number;
  lastActivity: string | null;
  meetings: number;
  lastMeeting: string | null;
};

type HistoryRow = {
  sender: string;
  from_sender: number;
  to_sender: number;
  sender_first: Date | null;
  sender_last: Date | null;
  from_domain: number | null;
  to_domain: number | null;
  domain_first: Date | null;
  domain_last: Date | null;
  activities: number;
  last_activity: Date | null;
  meetings: number;
  last_meeting: Date | null;
};

function day(value: Date | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

export async function historyInDb(db: Db, actor: UserActor, workspaceId: string, emails: string[]): Promise<Map<string, History>> {
  const senders = [...new Set(emails.map((email) => email.toLowerCase()))];
  if (senders.length === 0) return new Map();
  const domains = senders.map((email) => {
    const domain = domainOf(email);
    return domain && !isFreeMailDomain(domain) ? domain : null;
  });
  const result = await db.query<HistoryRow>(
    `with wanted as (
       select w.sender, w.domain, split_part(w.sender, '@', 2) as host from unnest($2::text[], $3::text[]) as w(sender, domain)
     ),
     received as (
       select lower(m.from_email) as address, coalesce(m.received_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and not m.is_draft and f.role not in ('sent', 'drafts', 'outbox')
         and split_part(lower(m.from_email), '@', 2) in (select host from wanted)
     ),
     sent as (
       select lower(r->>'address') as address, coalesce(m.sent_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       cross join lateral jsonb_array_elements(coalesce(m.to_recipients, '[]'::jsonb) || coalesce(m.cc_recipients, '[]'::jsonb)) r
       where m.user_id = $1 and not m.is_draft and f.role = 'sent' and jsonb_typeof(r) = 'object'
         and split_part(lower(r->>'address'), '@', 2) in (select host from wanted)
     ),
     mail as (
       select address, at, 'in' as way from received union all select address, at, 'out' from sent
     ),
     activity as (
       select w.sender, count(distinct a.id)::int as n, max(a.occurred_at) as last
       from wanted w
       join crm.contacts c on c.workspace_id = $4 and c.archived_at is null
         and (c.normalized_email = w.sender or (w.domain is not null and split_part(c.normalized_email, '@', 2) = w.domain))
       join crm.activities a on a.contact_id = c.id and a.archived_at is null
       group by w.sender
     ),
     meetings as (
       select w.sender, count(distinct e.id)::int as n, max(e.starts_at) filter (where e.starts_at <= now()) as last
       from wanted w
       join crm.calendar_events e on e.user_id = $1 and not e.is_cancelled
       cross join lateral jsonb_array_elements(
         (case when jsonb_typeof(e.attendees) = 'array' then e.attendees else '[]'::jsonb end)
         || (case when jsonb_typeof(e.organizer) = 'object' then jsonb_build_array(e.organizer) else '[]'::jsonb end)
       ) p
       where jsonb_typeof(p) = 'object'
         and (lower(p->>'email') = w.sender or (w.domain is not null and split_part(lower(p->>'email'), '@', 2) = w.domain))
       group by w.sender
     )
     select w.sender,
       (select count(*)::int from mail x where x.way = 'in' and x.address = w.sender) as from_sender,
       (select count(*)::int from mail x where x.way = 'out' and x.address = w.sender) as to_sender,
       (select min(x.at) from mail x where x.address = w.sender) as sender_first,
       (select max(x.at) from mail x where x.address = w.sender) as sender_last,
       case when w.domain is null then null else (select count(*)::int from mail x where x.way = 'in' and split_part(x.address, '@', 2) = w.domain) end as from_domain,
       case when w.domain is null then null else (select count(*)::int from mail x where x.way = 'out' and split_part(x.address, '@', 2) = w.domain) end as to_domain,
       case when w.domain is null then null else (select min(x.at) from mail x where split_part(x.address, '@', 2) = w.domain) end as domain_first,
       case when w.domain is null then null else (select max(x.at) from mail x where split_part(x.address, '@', 2) = w.domain) end as domain_last,
       coalesce((select a.n from activity a where a.sender = w.sender), 0) as activities,
       (select a.last from activity a where a.sender = w.sender) as last_activity,
       coalesce((select e.n from meetings e where e.sender = w.sender), 0) as meetings,
       (select e.last from meetings e where e.sender = w.sender) as last_meeting
     from wanted w`,
    [actor.userId, senders, domains, workspaceId],
  );
  return new Map(
    result.rows.map((row) => [
      row.sender,
      {
        fromSender: row.from_sender,
        toSender: row.to_sender,
        senderFirst: day(row.sender_first),
        senderLast: day(row.sender_last),
        fromDomain: row.from_domain,
        toDomain: row.to_domain,
        domainFirst: day(row.domain_first),
        domainLast: day(row.domain_last),
        activities: row.activities,
        lastActivity: day(row.last_activity),
        meetings: row.meetings,
        lastMeeting: day(row.last_meeting),
      },
    ]),
  );
}

export type WorkspaceContext = {
  business: { name: string; sells: string; idealCustomer: string; formerNames: string[] };
  person: { name: string; role: string; about: string };
};

export async function workspaceContext(actor: UserActor): Promise<WorkspaceContext> {
  const [brand, personal] = await Promise.all([
    brandOrEmpty(actor),
    getPersonalContext(actor).catch(() => null),
  ]);
  return {
    business: { name: actor.workspaceName, sells: brand.whatYouSell, idealCustomer: brand.whoItsFor, formerNames: brand.formerNames },
    person: { name: actor.fullName || actor.email, role: personal?.jobTitle ?? "", about: personal?.about ?? "" },
  };
}

export type EmailFacts = { fromName: string | null; fromAddress: string; receivedBy: string; subject: string | null; snippet: string | null; signature: string | null };

function historyFacts(history: History | undefined) {
  if (!history) return { mailWithSender: "none", mailWithDomain: "none", userHasWrittenToSender: false, userHasWrittenToDomain: false, crmActivityAtDomain: 0, meetings: 0 };
  const range = (first: string | null, last: string | null) => (first ? `, first ${first}, last ${last}` : "");
  return {
    mailWithSender: `${history.fromSender} from them, ${history.toSender} from the user${range(history.senderFirst, history.senderLast)}`,
    mailWithDomain:
      history.fromDomain === null ? "free mail address, not counted" : `${history.fromDomain} from the domain, ${history.toDomain} from the user to it${range(history.domainFirst, history.domainLast)}`,
    userHasWrittenToSender: history.toSender > 0,
    userHasWrittenToDomain: (history.toDomain ?? 0) > 0,
    crmActivityAtDomain: history.activities,
    ...(history.lastActivity ? { lastCrmActivity: history.lastActivity } : {}),
    meetings: history.meetings,
    ...(history.lastMeeting ? { lastMeeting: history.lastMeeting } : {}),
  };
}

export function decisionState(context: WorkspaceContext, email: EmailFacts, history: History | undefined) {
  return {
    business: {
      name: context.business.name,
      whatItSells: context.business.sells || "not given",
      idealCustomer: context.business.idealCustomer || "not given",
      ...(context.business.formerNames.length ? { formerNames: context.business.formerNames } : {}),
    },
    person: {
      name: context.person.name,
      role: context.person.role || "not given",
      ...(context.person.about ? { aboutYou: context.person.about } : {}),
    },
    history: historyFacts(history),
    email: {
      fromName: email.fromName,
      fromAddress: email.fromAddress,
      receivedBy: email.receivedBy,
      subject: email.subject,
      snippet: email.snippet,
      ...(email.signature ? { signature: email.signature } : {}),
    },
  };
}

export const CATEGORY_CRITERIA: Record<RelevanceCategory, string> = {
  business: "A real person the business could do business with: a prospect, client, partner, investor, a recruiter about work, or a peer. Includes cold enquiries and people writing about work from free mail addresses.",
  supplier: "A vendor selling to or billing the business: invoices, receipts, quotes, renewals and billing.",
  service: "An account or platform notice: security alerts, sign in codes, verification and product updates from a tool they use.",
  personal: "Health, banking, family, home and personal admin.",
  collections: "Debt collection, payment demands and legal demands.",
  spam: "Spam, scams and phishing.",
  newsletter: "Marketing, promotions and bulk mail.",
};

export const CLASSIFIER_PROMPT = [
  "You decide whether an email belongs in a CRM for one business. Judge only for the business and person given, using what the business sells and who it is for.",
  'Reply with JSON only: {"category": string, "confidence": number from 0 to 1, "reason": string of at most 12 words}.',
  "Categories:",
  ...RELEVANCE_CATEGORIES.map((category) => `- ${category}: ${CATEGORY_CRITERIA[category]}`),
  "Rules:",
  "- history counts past mail between the user and this sender or their domain. If the user has written to them or met them, lean to business.",
  "- A vendor pitching their own product or service to the business is supplier, unless they fit who the business sells to.",
  "- When unsure whether it is business, answer business with a low confidence.",
].join("\n");

const ANSWER = z.object({
  category: z.enum(RELEVANCE_CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

export type DecideOptions = { fetchImpl?: typeof fetch; deadline: number };

async function decideWithJev(state: ReturnType<typeof decisionState>, options: DecideOptions): Promise<Decision> {
  const answers = await askJev(
    state,
    {
      category: {
        type: "choice",
        instructions: "Classify the sender of this email for business.name, given person and history. Someone the user has written to or met leans to business.",
        criteria: CATEGORY_CRITERIA,
      },
      could_do_business: {
        type: "noul",
        instructions:
          "Could business.name do business with the sender of this email, as a prospect, client, partner, investor, recruiter about work or peer? If history shows the user wrote to or met them, lean yes.",
        criteria: { true: "A real person or firm the business could work with.", false: "A service, supplier, personal, bulk or unwanted sender." },
      },
    },
    { fetchImpl: options.fetchImpl, timeoutMs: Math.min(10_000, options.deadline - Date.now()) },
  );
  const choice = answers.category?.choice;
  const category = RELEVANCE_CATEGORIES.find((item) => item === choice);
  if (!category) throw new Error("Jev gave no category.");
  const fit = answers.could_do_business?.noul;
  const confidence = typeof fit === "number" ? (category === "business" ? fit : 1 - fit) : (answers.category?.confidence ?? null);
  return {
    category,
    engine: "jev",
    confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)),
    reason: typeof fit === "number" ? `Could do business: ${Math.round(fit * 100)}%.` : null,
  };
}

async function decideWithHaiku(state: ReturnType<typeof decisionState>, options: DecideOptions): Promise<Decision> {
  const remaining = options.deadline - Date.now();
  const result = await completeJson({
    system: CLASSIFIER_PROMPT,
    user: JSON.stringify(state, null, 2),
    schema: ANSWER,
    model: CLASSIFIER_MODEL,
    maxTokens: 400,
    fetchImpl: options.fetchImpl,
    ...(remaining >= 8_000 ? { deadline: options.deadline } : { timeoutMs: Math.max(1_000, remaining) }),
  });
  return { category: result.data.category, engine: "haiku", confidence: result.data.confidence, reason: result.data.reason.trim() || null };
}

export async function decideRelevance(state: ReturnType<typeof decisionState>, options: DecideOptions): Promise<Decision> {
  if (state.history.userHasWrittenToSender) return { category: "business", engine: "history", confidence: null, reason: null };
  if (jevConfigured()) {
    try {
      return await decideWithJev(state, options);
    } catch (error) {
      console.error("Jev couldn't sort a Capture email", error instanceof Error ? error.message : error);
    }
  }
  if (process.env.LLM_API_KEY?.trim() && options.deadline - Date.now() > 1_000) {
    try {
      return await decideWithHaiku(state, options);
    } catch (error) {
      console.error("The AI couldn't sort a Capture email", error instanceof Error ? error.message : error);
    }
  }
  return { category: null, engine: "failed", confidence: null, reason: null };
}

const QUOTED = /^(on .{3,200} wrote:|from: .+|-{2,}\s*original message\s*-{2,}|_{5,})$/im;

export function signatureOf(body: string | null) {
  if (!body) return null;
  const text = body.replace(/\r\n/g, "\n");
  const quoted = text.search(QUOTED);
  const own = (quoted > 0 ? text.slice(0, quoted) : text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(">"));
  const tail = own.slice(-8).join("\n");
  return tail ? tail.slice(-600) : null;
}
