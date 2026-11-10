import { z } from "zod";
import { brandOrEmpty } from "@/lib/crm/brand";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { getPersonalContext } from "@/lib/crm/personal-context";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { askJev, jevConfigured } from "@/lib/jev";
import { completeJson } from "@/lib/llm";
import { domainOf, listedSender, type ListedCategory } from "@/lib/mail/senders";

import {
  RELEVANCE_CATEGORIES,
  SENSITIVE_CATEGORIES,
  type RelevanceCategory,
  type RelevanceEngine,
  type SkippedCategory,
  type StoredCategory,
} from "@/lib/mail/relevance-labels";

export { RELEVANCE_CATEGORIES, SENSITIVE_CATEGORIES, SKIPPED_LABELS } from "@/lib/mail/relevance-labels";
export type { RelevanceCategory, RelevanceEngine, SkippedCategory, StoredCategory } from "@/lib/mail/relevance-labels";

export const CLASSIFIER_MODEL = "claude-haiku-5-5";

export const CACHE_MS = 60 * 24 * 60 * 60_000;
export const RETRY_MS = 30 * 60_000;
export const PENDING_MS = 5 * 60_000;
export const CONFIDENT = 0.8;

const CERTAIN_ENGINES = new Set<RelevanceEngine>(["listed", "headers", "history", "rule", "filed", "shown"]);

export type Candidate = {
  key: string;
  messageId: string;
  email: string;
  name: string | null;
  subject: string | null;
  snippet: string | null;
  address: string;
  workspaceId: string;
  at: string;
};

export type Verdict =
  | { state: "shown"; engine: RelevanceEngine | null }
  | { state: "skipped"; category: SkippedCategory; engine: RelevanceEngine; reason: string | null }
  | { state: "pending" };

export type Judged<T extends Candidate> = { item: T; verdict: Verdict; retry: boolean; copy: Decision | null; hint: ListedCategory | null; stored: StoredCategory | null };

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

type ThreadRow = StoredRow & { source_id: string; thread_key: string; message_id: string | null };

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

export function verdictFor(row: Pick<StoredRow, "category" | "confidence" | "reason">, engine: RelevanceEngine): Verdict {
  if (!row.category || row.category === "business") return { state: "shown", engine };
  if (row.category !== "muted" && !CERTAIN_ENGINES.has(engine) && (row.confidence === null || row.confidence < CONFIDENT)) return { state: "shown", engine };
  return { state: "skipped", category: row.category, engine, reason: row.reason };
}

export function pendingIsFresh(at: string, now = Date.now()) {
  return now - new Date(at).getTime() < PENDING_MS;
}

type Facts = { wroteSender: Set<string>; wroteDomain: Set<string>; met: Set<string>; crm: Set<string> };

async function contactFacts(db: Db, actor: UserActor, items: Candidate[]): Promise<Facts> {
  const senders = [...new Set(items.map((item) => item.email.toLowerCase()))];
  const facts: Facts = { wroteSender: new Set(), wroteDomain: new Set(), met: new Set(), crm: new Set() };
  if (senders.length === 0) return facts;
  const domains = [...new Set(senders.map(domainOf).filter((domain) => domain && !isFreeMailDomain(domain)))];
  const result = await db.query<{ kind: "sent" | "domain" | "met" | "crm"; workspace_id: string | null; value: string }>(
    `select 'sent' as kind, null::uuid as workspace_id, k.address as value
     from crm.mail_known_addresses k where k.user_id = $1 and k.address = any($2::text[]) and k.sent_count > 0
     union all
     select 'met', null, k.address
     from crm.mail_known_addresses k where k.user_id = $1 and k.address = any($2::text[]) and k.met_first <= now()
     union all
     select distinct 'domain', null::uuid, k.domain
     from crm.mail_known_addresses k where k.user_id = $1 and k.domain = any($3::text[]) and k.sent_count > 0
     union all
     select distinct 'crm', c.workspace_id, split_part(c.normalized_email, '@', 2)
     from crm.contacts c
     join crm.activities a on a.contact_id = c.id and a.archived_at is null
     where c.workspace_id = any($4::uuid[]) and c.archived_at is null
       and split_part(c.normalized_email, '@', 2) = any($3::text[])`,
    [actor.userId, senders, domains, [...new Set(items.map((item) => item.workspaceId))]],
  );
  for (const row of result.rows) {
    if (row.kind === "sent") facts.wroteSender.add(row.value);
    else if (row.kind === "domain") facts.wroteDomain.add(row.value);
    else if (row.kind === "met") facts.met.add(row.value);
    else facts.crm.add(`${row.workspace_id}|${row.value}`);
  }
  return facts;
}

export async function judgeInDb<T extends Candidate>(db: Db, actor: UserActor, items: T[], now = Date.now()): Promise<Judged<T>[]> {
  if (items.length === 0) return [];
  const workspaceIds = [...new Set(items.map((item) => item.workspaceId))];
  const senders = [...new Set(items.flatMap((item) => [item.email, ruleTarget(item.email)]))];
  const keys = items.map((item) => splitKey(item.key));
  const [stored, threads, facts] = await Promise.all([
    db.query<StoredRow>(
      `select workspace_id, sender, category, engine, confidence, reason, rule, decided_at from crm.mail_sender_relevance
       where user_id = $1 and workspace_id = any($2::uuid[]) and sender = any($3::text[])`,
      [actor.userId, workspaceIds, senders],
    ),
    db.query<ThreadRow>(
      `select t.source_id, t.thread_key, t.workspace_id, t.sender, t.message_id, t.category, t.engine, t.confidence, t.reason, t.decided_at
       from crm.mail_thread_relevance t
       join unnest($2::uuid[], $3::text[]) as k(source_id, thread_key) on k.source_id = t.source_id and k.thread_key = t.thread_key
       where t.user_id = $1`,
      [actor.userId, keys.map((key) => key.sourceId), keys.map((key) => key.threadKey)],
    ),
    contactFacts(db, actor, items),
  ]);
  const bySender = new Map(stored.rows.map((row) => [`${row.workspace_id}|${row.sender}`, row]));
  const byThread = new Map(threads.rows.map((row) => [`${row.source_id}|${row.thread_key}`, row]));
  const configured = classifierConfigured();
  return items.map((item) => {
    const email = item.email.toLowerCase();
    const domain = domainOf(email);
    const exact = bySender.get(`${item.workspaceId}|${email}`);
    const target = ruleTarget(email);
    const domainRule = target === email ? undefined : bySender.get(`${item.workspaceId}|${target}`);
    const listed = listedSender(email);
    const listUsable = listed && !facts.wroteDomain.has(domain) && !facts.crm.has(`${item.workspaceId}|${domain}`);
    const thread = byThread.get(item.key);
    const current =
      thread &&
      thread.workspace_id === item.workspaceId &&
      thread.sender === email &&
      (thread.message_id ? thread.message_id === item.messageId : new Date(thread.decided_at).getTime() >= new Date(item.at).getTime()) &&
      !(thread.engine === "history") &&
      !(thread.engine === "listed" && !(listUsable && listed.hide))
        ? thread
        : undefined;
    const hint = listUsable && !listed.hide ? listed.category : null;
    const stored = thread && thread.workspace_id === item.workspaceId ? thread.category : null;
    const judged = (verdict: Verdict, copy: Decision | null = null, retry = false): Judged<T> => ({ item, verdict, retry, copy: current ? null : copy, hint, stored });
    if (exact?.rule) return judged(verdictFor(exact, exact.engine));
    if (domainRule?.rule) return judged(verdictFor(domainRule, domainRule.engine));
    if (facts.wroteSender.has(email) || facts.met.has(email)) {
      return judged({ state: "shown", engine: "history" }, thread?.engine === "history" && thread.workspace_id === item.workspaceId ? null : { category: "business", engine: "history", confidence: null, reason: null });
    }
    if (listUsable && listed.hide) {
      return judged({ state: "skipped", category: listed.category, engine: "listed", reason: null }, { category: listed.category, engine: "listed", confidence: null, reason: null });
    }
    if (current) {
      if (current.category === null) return judged({ state: "shown", engine: "failed" }, null, now - new Date(current.decided_at).getTime() > RETRY_MS && configured);
      return judged(verdictFor(current, current.engine));
    }
    if (exact && exact.category === "business" && now - new Date(exact.decided_at).getTime() < CACHE_MS) {
      return judged(verdictFor(exact, "cached"), { category: exact.category, engine: "cached", confidence: exact.confidence, reason: exact.reason });
    }
    if (!configured) return judged({ state: "shown", engine: null });
    return judged({ state: "pending" });
  });
}

export async function storeThreadDecision(
  db: Db,
  actor: UserActor,
  item: Pick<Candidate, "key" | "email" | "workspaceId"> & { messageId?: string | null },
  decision: Decision,
) {
  const { sourceId, threadKey } = splitKey(item.key);
  await db.query(
    `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, message_id, category, engine, confidence, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (user_id, source_id, thread_key) do update set workspace_id = excluded.workspace_id, sender = excluded.sender,
       message_id = excluded.message_id, category = excluded.category, engine = excluded.engine, confidence = excluded.confidence,
       reason = excluded.reason, decided_at = now(), updated_at = now()`,
    [
      item.workspaceId,
      actor.userId,
      sourceId,
      threadKey,
      item.email.toLowerCase(),
      item.messageId ?? null,
      decision.category,
      decision.engine,
      decision.confidence,
      decision.reason?.slice(0, 300) ?? null,
    ],
  );
}

export async function cacheSenderDecision(db: Db, actor: UserActor, workspaceId: string, sender: string, decision: Decision) {
  if (decision.category !== "business" || (decision.engine !== "jev" && decision.engine !== "haiku")) return;
  await db.query(
    `insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine, confidence, reason, rule)
     values ($1, $2, $3, $4, $5, $6, $7, false)
     on conflict (user_id, workspace_id, sender) do update set category = excluded.category, engine = excluded.engine,
       confidence = excluded.confidence, reason = excluded.reason, decided_at = now(), updated_at = now()
     where not crm.mail_sender_relevance.rule`,
    [workspaceId, actor.userId, sender.toLowerCase(), decision.category, decision.engine, decision.confidence, decision.reason?.slice(0, 300) ?? null],
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

export async function markSenderThreadsBusiness(db: Db, actor: UserActor, workspaceId: string, email: string, engine: "filed" | "shown") {
  await db.query(
    `update crm.mail_thread_relevance set category = 'business', engine = $4, confidence = null, reason = null, decided_at = now(), updated_at = now()
     where user_id = $1 and workspace_id = $2 and sender = $3`,
    [actor.userId, workspaceId, email.toLowerCase(), engine],
  );
}

export async function recordFiledInDb(db: Db, actor: UserActor, workspaceId: string, email: string) {
  const sender = email.toLowerCase();
  await setSenderRule(db, actor, workspaceId, sender, "business", "filed");
  const target = ruleTarget(sender);
  if (target !== sender && !listedSender(sender)) {
    await db.query(
      `insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine, rule)
       values ($1, $2, $3, 'business', 'filed', true)
       on conflict (user_id, workspace_id, sender) do nothing`,
      [workspaceId, actor.userId, target],
    );
  }
  await markSenderThreadsBusiness(db, actor, workspaceId, sender, "filed");
}

export type SenderRule = { sender: string; kind: "never" | "always" };

export async function listSenderRulesInDb(db: Db, actor: UserActor): Promise<SenderRule[]> {
  const result = await db.query<{ sender: string; category: StoredCategory }>(
    `select sender, category from crm.mail_sender_relevance
     where user_id = $1 and workspace_id = $2 and rule and (category = 'muted' or engine = 'shown' or (engine = 'filed' and sender like '@%'))
     order by category = 'muted' desc, sender
     limit 200`,
    [actor.userId, actor.workspaceId],
  );
  return result.rows.map((row) => ({ sender: row.sender, kind: row.category === "muted" ? "never" : "always" }));
}

export async function removeSenderRuleInDb(db: Db, actor: UserActor, sender: string) {
  await db.query(
    "delete from crm.mail_sender_relevance where user_id = $1 and workspace_id = $2 and sender = $3 and rule and (category = 'muted' or engine = 'shown' or (engine = 'filed' and sender like '@%'))",
    [actor.userId, actor.workspaceId, sender.trim().toLowerCase()],
  );
}

const CONFIDENTLY_SENSITIVE = `sensitive.category in ('personal', 'collections')
      and (sensitive.engine in ('listed', 'headers') or coalesce(sensitive.confidence, 0) >= ${CONFIDENT})`;

function noBusinessRuleSql(userExpr: string, workspaceExpr: string) {
  return `not exists (
      select 1 from crm.mail_sender_relevance kept
      where kept.user_id = ${userExpr} and kept.workspace_id = ${workspaceExpr} and kept.rule and kept.category = 'business'
        and kept.sender = sensitive.sender
    )`;
}

export function notSensitiveThreadSql(userExpr: string, workspaceExpr: string, sourceExpr: string, threadExpr: string) {
  return `not exists (
    select 1 from crm.mail_thread_relevance sensitive
    where sensitive.user_id = ${userExpr} and sensitive.workspace_id = ${workspaceExpr}
      and sensitive.source_id = ${sourceExpr} and sensitive.thread_key = ${threadExpr}
      and ${CONFIDENTLY_SENSITIVE}
      and ${noBusinessRuleSql(userExpr, workspaceExpr)}
  )`;
}

export function noSensitivePeopleSql(userExpr: string, workspaceExpr: string, peopleExpr: string) {
  return `not exists (
    select 1 from crm.mail_sender_relevance chosen
    where chosen.user_id = ${userExpr} and chosen.workspace_id = ${workspaceExpr} and chosen.rule
      and chosen.sender = any(${peopleExpr}) and chosen.category in ('personal', 'collections')
  )`;
}

export function sensitiveAddress(email: string | null | undefined) {
  const listed = email ? listedSender(email) : null;
  return Boolean(listed?.hide && (listed.category === "personal" || listed.category === "collections"));
}


export function sensitiveCategory(category: StoredCategory | null | undefined) {
  return Boolean(category && SENSITIVE_CATEGORIES.includes(category));
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
  metSender: boolean;
  metAtDomain: number;
  firstMet: string | null;
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
  met_sender: boolean;
  met_at_domain: number;
  first_met: Date | null;
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
  const hosts = [...new Set(senders.map(domainOf).filter(Boolean))];
  const companyDomains = [...new Set(domains.filter((domain): domain is string => Boolean(domain)))];
  const result = await db.query<HistoryRow>(
    `with wanted as (
       select w.sender, w.domain from unnest($2::text[], $3::text[]) as w(sender, domain)
     ),
     received as (
       select lower(m.from_email) as address, m.from_domain as host, coalesce(m.received_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and m.from_domain = any($5::text[]) and not m.is_draft and f.role not in ('sent', 'drafts', 'outbox')
     ),
     known as (
       select k.address, k.domain, k.sent_count, k.sent_first, k.sent_last, k.met_first
       from crm.mail_known_addresses k
       where k.user_id = $1 and (k.address = any($2::text[]) or k.domain = any($6::text[]))
     ),
     activity as (
       select w.sender, count(distinct a.id)::int as n, max(a.occurred_at) as last
       from wanted w
       join crm.contacts c on c.workspace_id = $4 and c.archived_at is null
         and (c.normalized_email = w.sender or (w.domain is not null and c.normalized_email like '%@' || w.domain))
       join crm.activities a on a.contact_id = c.id and a.archived_at is null
       group by w.sender
     )
     select w.sender,
       (select count(*)::int from received r where r.address = w.sender) as from_sender,
       coalesce((select k.sent_count from known k where k.address = w.sender), 0) as to_sender,
       least((select min(r.at) from received r where r.address = w.sender), (select k.sent_first from known k where k.address = w.sender)) as sender_first,
       greatest((select max(r.at) from received r where r.address = w.sender), (select k.sent_last from known k where k.address = w.sender)) as sender_last,
       case when w.domain is null then null else (select count(*)::int from received r where r.host = w.domain) end as from_domain,
       case when w.domain is null then null else (select coalesce(sum(k.sent_count), 0)::int from known k where k.domain = w.domain) end as to_domain,
       case when w.domain is null then null else least((select min(r.at) from received r where r.host = w.domain), (select min(k.sent_first) from known k where k.domain = w.domain)) end as domain_first,
       case when w.domain is null then null else greatest((select max(r.at) from received r where r.host = w.domain), (select max(k.sent_last) from known k where k.domain = w.domain)) end as domain_last,
       coalesce((select a.n from activity a where a.sender = w.sender), 0) as activities,
       (select a.last from activity a where a.sender = w.sender) as last_activity,
       exists (select 1 from known k where k.address = w.sender and k.met_first <= now()) as met_sender,
       (select count(*)::int from known k where (k.address = w.sender or (w.domain is not null and k.domain = w.domain)) and k.met_first <= now()) as met_at_domain,
       (select min(k.met_first) from known k where (k.address = w.sender or (w.domain is not null and k.domain = w.domain)) and k.met_first <= now()) as first_met
     from wanted w`,
    [actor.userId, senders, domains, workspaceId, hosts, companyDomains],
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
        metSender: row.met_sender,
        metAtDomain: row.met_at_domain,
        firstMet: day(row.first_met),
      },
    ]),
  );
}

export type WorkspaceContext = {
  business: { name: string; sells: string; idealCustomer: string; formerNames: string[] };
  person: { name: string; role: string; about: string };
};

export async function workspaceContext(actor: UserActor): Promise<WorkspaceContext> {
  const [brand, personal] = await Promise.all([brandOrEmpty(actor), getPersonalContext(actor).catch(() => null)]);
  return {
    business: { name: actor.workspaceName, sells: brand.whatYouSell, idealCustomer: brand.whoItsFor, formerNames: brand.formerNames },
    person: { name: actor.fullName || actor.email, role: personal?.jobTitle ?? "", about: personal?.about ?? "" },
  };
}

export type EmailFacts = {
  fromName: string | null;
  fromAddress: string;
  receivedBy: string;
  subject: string | null;
  snippet: string | null;
  signature: string | null;
  listedAs?: ListedCategory | null;
};

function historyFacts(history: History | undefined) {
  if (!history) return { mailWithSender: "none", mailWithDomain: "none", userHasWrittenToSender: false, userHasWrittenToDomain: false, crmActivityAtDomain: 0, userHasMetSender: false, peopleMetAtDomain: 0 };
  const range = (first: string | null, last: string | null) => (first ? `, first ${first}, last ${last}` : "");
  return {
    mailWithSender: `${history.fromSender} from them, ${history.toSender} from the user${range(history.senderFirst, history.senderLast)}`,
    mailWithDomain:
      history.fromDomain === null ? "free mail address, not counted" : `${history.fromDomain} from the domain, ${history.toDomain} from the user to it${range(history.domainFirst, history.domainLast)}`,
    userHasWrittenToSender: history.toSender > 0,
    userHasWrittenToDomain: (history.toDomain ?? 0) > 0,
    crmActivityAtDomain: history.activities,
    ...(history.lastActivity ? { lastCrmActivity: history.lastActivity } : {}),
    userHasMetSender: history.metSender,
    peopleMetAtDomain: history.metAtDomain,
    ...(history.firstMet ? { firstMet: history.firstMet } : {}),
  };
}

const LISTED_HINT: Record<ListedCategory, string> = {
  service: "a platform or service company",
  supplier: "a billing, payments, telecoms or utilities company",
  personal: "a bank, insurer, health or public sector body",
  collections: "a debt collection firm",
};

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
      ...(email.listedAs ? { senderDomainIs: LISTED_HINT[email.listedAs] } : {}),
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
  "- email.senderDomainIs, when given, says what kind of organisation the domain belongs to. A real person there writing about work, such as a partner manager or a public sector buyer, is still business.",
  "- A vendor pitching their own product or service to the business is supplier, unless they fit who the business sells to.",
  "- When unsure whether it is business, answer business with a low confidence.",
].join("\n");

const ANSWER = z.object({
  category: z.enum(RELEVANCE_CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

export type DecideOptions = { fetchImpl?: typeof fetch; deadline: number };

type DecisionState = ReturnType<typeof decisionState>;

async function decideWithJev(state: DecisionState, options: DecideOptions): Promise<Decision> {
  const answers = await askJev(
    state,
    {
      category: {
        type: "choice",
        instructions:
          "Classify the sender of this email for business.name, given person and history. Someone the user has written to or met leans to business. email.senderDomainIs, when given, describes the organisation; a real person there writing about work is still business.",
        criteria: CATEGORY_CRITERIA,
      },
      could_do_business: {
        type: "noul",
        instructions:
          "Could business.name do business with the sender of this email, as a prospect, client, partner, investor, recruiter about work or peer? If history shows the user wrote to or met them, lean yes.",
        criteria: { true: "A real person or firm the business could work with.", false: "A service, supplier, personal, bulk or unwanted sender." },
      },
    },
    { fetchImpl: options.fetchImpl, timeoutMs: Math.min(10_000, (options.deadline - Date.now()) / (process.env.LLM_API_KEY?.trim() ? 2 : 1)) },
  );
  const choice = answers.category?.choice;
  const category = RELEVANCE_CATEGORIES.find((item) => item === choice);
  if (!category) throw new Error("Jev gave no category.");
  const rawFit = answers.could_do_business?.noul;
  const fit = typeof rawFit === "number" && rawFit >= 0 && rawFit <= 1 ? rawFit : undefined;
  const raw = typeof fit === "number" ? (category === "business" ? fit : 1 - fit) : typeof answers.category?.confidence === "number" && answers.category.confidence >= 0 && answers.category.confidence <= 1 ? answers.category.confidence : null;
  return {
    category,
    engine: "jev",
    confidence: raw === null ? null : Math.min(1, Math.max(0, raw)),
    reason: typeof fit === "number" ? `Could do business: ${Math.round(fit * 100)}%.` : null,
  };
}

async function decideWithHaiku(state: DecisionState, options: DecideOptions): Promise<Decision> {
  const remaining = options.deadline - Date.now();
  const result = await completeJson({
    system: CLASSIFIER_PROMPT,
    user: JSON.stringify(state, null, 2),
    schema: ANSWER,
    model: CLASSIFIER_MODEL,
    maxTokens: 400,
    fetchImpl: options.fetchImpl,
    ...(remaining >= 8_000 ? { deadline: options.deadline } : { timeoutMs: Math.max(1_000, remaining - 250), attempts: 1 }),
  });
  return { category: result.data.category, engine: "haiku", confidence: result.data.confidence, reason: result.data.reason.trim() || null };
}

export async function decideRelevance(state: DecisionState, options: DecideOptions): Promise<Decision> {
  if (state.history.userHasWrittenToSender) return { category: "business", engine: "history", confidence: null, reason: null };
  if (jevConfigured() && options.deadline - Date.now() > 1_000) {
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
  const own = (quoted >= 0 ? text.slice(0, quoted) : text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(">"));
  const tail = own.slice(-8).join("\n");
  return tail ? tail.slice(-600) : null;
}
