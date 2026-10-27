import { editCompanyTags, getCompany, updateCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { normalizeTag } from "@/lib/crm/normalize";
import type { Actor, Company, Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { getEnrichmentSettings, icpHashOf } from "@/lib/enrichment/settings";
import { fitLabel } from "@/lib/enrichment/fit";
import { decide, parallelKey, ParallelError, type DecisionCitation, type DecisionQuestion } from "@/lib/parallel";

export type WebCheckKind = "tag" | "signal";
export type SignalNoteKind = "funding" | "hire" | "launch" | "signal";
export type WebCheck = { id: string; kind: WebCheckKind; label: string; question: string; noteKind: SignalNoteKind };

export const TAG_THRESHOLD = 0.85;
export const GAP_THRESHOLD = 0.7;
export const SIGNAL_THRESHOLD = 0.8;
export const SIGNAL_REPEAT_DAYS = 90;
export const SIGNAL_INTERVAL_DAYS = 7;
const SIGNAL_BATCH = 15;
const BACKFILL_BATCH = 25;
const CLAIM_MINUTES = 2;
export const RULES_MAX = 50;
const TAG_QUESTIONS_MAX = 96;
const INDUSTRY_OPTIONS_MAX = 100;
const INDUSTRY_CHARS_MAX = 4000;
const CONCURRENCY = 5;
const NOTE_KINDS: SignalNoteKind[] = ["funding", "hire", "launch", "signal"];
const PROVENANCE: Provenance = { operation: "web_check", source: "parallel" };

export const DEFAULT_SIGNALS: Omit<WebCheck, "id">[] = [
  { kind: "signal", label: "Raised money", noteKind: "funding", question: "Has the company announced a new funding round or investment in the last 30 days?" },
  {
    kind: "signal",
    label: "New leader",
    noteKind: "hire",
    question: "Has the company announced a new CEO, managing director, or head of marketing, growth or content in the last 30 days?",
  },
  { kind: "signal", label: "Acquired or merged", noteKind: "signal", question: "Has the company been acquired, merged with another business, or announced a sale in the last 30 days?" },
  { kind: "signal", label: "Layoffs", noteKind: "signal", question: "Has the company announced layoffs, redundancies or office closures in the last 30 days?" },
  { kind: "signal", label: "Launch", noteKind: "launch", question: "Has the company launched a new product, service, brand or website in the last 30 days?" },
  { kind: "signal", label: "Hiring in marketing", noteKind: "hire", question: "Is the company currently advertising jobs in marketing, content or SEO?" },
];

const SIZE_OPTIONS: Record<string, { value: string; description: string }> = {
  s1: { value: "1-10", description: "1 to 10 employees" },
  s2: { value: "11-50", description: "11 to 50 employees" },
  s3: { value: "51-200", description: "51 to 200 employees" },
  s4: { value: "201-1000", description: "201 to 1,000 employees" },
  s5: { value: "1000+", description: "More than 1,000 employees" },
};

type CheckRow = { id: string; kind: WebCheckKind; label: string; question: string; note_kind: SignalNoteKind };

function toCheck(row: CheckRow): WebCheck {
  return { id: row.id, kind: row.kind, label: row.label, question: row.question, noteKind: row.note_kind };
}

function invalid(message: string, field?: string) {
  return new CrmError("invalid_input", message, 400, field ? { field } : undefined);
}

function assertAdmin(actor: UserActor) {
  if (actor.role !== "owner" && actor.role !== "admin") throw new CrmError("forbidden", "Only workspace owners and admins can change web checks.", 403);
}

export function webChecksConfigured(env: Record<string, string | undefined> = process.env) {
  return Boolean(parallelKey(env));
}

async function readChecks(db: Db, workspaceId: string, kind?: WebCheckKind) {
  const result = await db.query<CheckRow>(
    `select id, kind, label, question, note_kind from crm.web_checks where workspace_id = $1 and ($2::text is null or kind = $2) order by kind, created_at, label`,
    [workspaceId, kind ?? null],
  );
  return result.rows.map(toCheck);
}

export async function listWebChecks(actor: Actor, kind?: WebCheckKind) {
  return withActor(actor, (db) => readChecks(db, actor.workspaceId, kind));
}

export async function saveWebCheck(actor: UserActor, input: { id?: unknown; kind?: unknown; label?: unknown; question?: unknown; noteKind?: unknown }) {
  assertAdmin(actor);
  const kind: WebCheckKind = input.kind === "signal" ? "signal" : "tag";
  const raw = typeof input.label === "string" ? input.label.replace(/\s+/g, " ").trim() : "";
  const label = kind === "tag" ? normalizeTag(raw) : raw;
  if (!label || label.length > 60) throw invalid(kind === "tag" ? "Give the tag a name of up to 60 characters." : "Give the signal a name of up to 60 characters.", "label");
  const question = typeof input.question === "string" ? input.question.replace(/\s+/g, " ").trim() : "";
  if (question.length < 10 || question.length > 1000) throw invalid("Write the question in 10 to 1,000 characters.", "question");
  const noteKind = NOTE_KINDS.find((item) => item === input.noteKind) ?? "signal";
  const editing = typeof input.id === "string" && isUuid(input.id) ? input.id : null;
  return withActor(actor, async (db) => {
    try {
      const before = editing
        ? (await db.query<{ question: string }>("select question from crm.web_checks where id = $1 and workspace_id = $2", [editing, actor.workspaceId])).rows[0] ?? null
        : null;
      if (!editing) {
        const count = await db.query<{ total: number }>("select count(*)::int as total from crm.web_checks where workspace_id = $1 and kind = $2", [actor.workspaceId, kind]);
        if ((count.rows[0]?.total ?? 0) >= RULES_MAX) throw invalid(`You can have up to ${RULES_MAX} ${kind === "tag" ? "tag rules" : "signals"}.`);
      }
      const result =
        editing
          ? await db.query<CheckRow>(
              `update crm.web_checks set label = $3, question = $4, note_kind = $5 where id = $1 and workspace_id = $2
               returning id, kind, label, question, note_kind`,
              [editing, actor.workspaceId, label, question, noteKind],
            )
          : await db.query<CheckRow>(
              `insert into crm.web_checks (workspace_id, kind, label, question, note_kind, created_by_user_id)
               values ($1, $2, $3, $4, $5, $6) returning id, kind, label, question, note_kind`,
              [actor.workspaceId, kind, label, question, noteKind, actor.userId],
            );
      if (!result.rows[0]) throw new CrmError("not_found", "That check no longer exists.", 404);
      if (result.rows[0].kind === "tag" && (!editing || before?.question !== question)) await resetChecked(db, actor.workspaceId);
      return toCheck(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new CrmError("conflict", `There's already a check for ${label}.`, 409, { field: "label" });
      throw error;
    }
  });
}

async function resetChecked(db: Db, workspaceId: string) {
  await db.query("update crm.company_web_state set checked_at = null where workspace_id = $1 and checked_at is not null", [workspaceId]);
}

export async function markAllDue(actor: UserActor) {
  assertAdmin(actor);
  await withActor(actor, (db) => resetChecked(db, actor.workspaceId));
}

export async function removeWebCheck(actor: UserActor, id: string) {
  assertAdmin(actor);
  if (!isUuid(id)) throw new CrmError("not_found", "That check no longer exists.", 404);
  await withActor(actor, (db) => db.query("delete from crm.web_checks where id = $1 and workspace_id = $2", [id, actor.workspaceId]));
}

export async function ensureDefaultSignals(actor: UserActor) {
  assertAdmin(actor);
  return withActor(actor, async (db) => {
    const existing = await readChecks(db, actor.workspaceId, "signal");
    if (existing.length > 0) return existing;
    for (const [index, signal] of DEFAULT_SIGNALS.entries()) {
      await db.query(
        `insert into crm.web_checks (workspace_id, kind, label, question, note_kind, created_by_user_id, created_at)
         values ($1, 'signal', $2, $3, $4, $5, now() + make_interval(secs => $6)) on conflict do nothing`,
        [actor.workspaceId, signal.label, signal.question, signal.noteKind, actor.userId, index / 1000],
      );
    }
    return readChecks(db, actor.workspaceId, "signal");
  });
}

function publicState(company: Company) {
  return {
    company: company.name,
    ...(company.domain ? { domain: company.domain } : {}),
    ...(company.website ? { website: company.website } : {}),
    today: new Date().toISOString().slice(0, 10),
  };
}

async function workspaceIndustries(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ industry: string }>(
      `select industry from crm.companies where workspace_id = $1 and archived_at is null and industry is not null
       group by industry order by count(*) desc, industry limit $2`,
      [actor.workspaceId, INDUSTRY_OPTIONS_MAX],
    );
    const picked: string[] = [];
    let used = 0;
    for (const row of result.rows) {
      const industry = row.industry.slice(0, 120);
      if (used + industry.length > INDUSTRY_CHARS_MAX) break;
      picked.push(industry);
      used += industry.length + 10;
    }
    return picked;
  });
}

function bestChoice(answer: { type: string; choice?: string; probabilities?: Record<string, number> } | undefined) {
  if (!answer || answer.type !== "choice" || !answer.choice) return null;
  const probability = answer.probabilities?.[answer.choice] ?? 0;
  return probability >= GAP_THRESHOLD ? answer.choice : null;
}

async function markChecked(actor: Actor, companyId: string, summary: string | null, found: boolean, asked = true) {
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.company_web_state (company_id, workspace_id, checked_at) values ($1, $2, now())
       on conflict (company_id) do update set checked_at = now(), check_claimed_at = null`,
      [companyId, actor.workspaceId],
    );
    if (!asked) return;
    await db.query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_by_user_id)
       values ($1, 'company', $2, 'company', $3, 'parallel', $4, $5)`,
      [actor.workspaceId, companyId, found ? "found" : "not_found", summary?.slice(0, 1000) ?? null, actor.type === "user" ? actor.userId : null],
    );
  });
}

export const ICP_LEVELS = [
  "Not a fit: it fails the most important parts of the profile.",
  "Weak fit: it matches only a small part of the profile.",
  "Partial fit: it matches some important parts of the profile and misses others.",
  "Good fit: it matches most of the profile.",
  "Strong fit: it matches the profile closely.",
];
const ICP_KINDS = ["icp", "audience", "win_pattern", "loss_pattern"];

export type IcpProfile = { text: string; hash: string };

export async function learnedIcp(actor: Actor) {
  const notes = await withActor(actor, async (db) => {
    const result = await db.query<{ kind: string; title: string; body: string }>(
      `select kind, title, body from crm.memories
       where workspace_id = $1 and scope = 'business' and archived_at is null and kind = any($2::text[])
       order by array_position($2::text[], kind), pinned desc, updated_at desc`,
      [actor.workspaceId, ICP_KINDS],
    );
    return result.rows;
  }).catch(() => []);
  const text = notes
    .map((note) => `- ${note.kind === "icp" ? "Ideal customer" : note.kind === "audience" ? "Audience" : note.kind === "win_pattern" ? "Why we win" : "Why we lose"}: ${note.title}. ${note.body}`)
    .join("\n");
  return text || null;
}

export async function icpProfile(actor: Actor): Promise<IcpProfile | null> {
  const settings = await getEnrichmentSettings(actor);
  const text = settings.icpText?.trim();
  if (text) return { text, hash: settings.icpHash ?? icpHashOf(text) };
  if (!settings.webIcp) return null;
  const learned = (await learnedIcp(actor))?.slice(0, 20_000);
  if (!learned) return null;
  const hash = icpHashOf(learned);
  await withActor(actor, (db) =>
    db.query("update crm.enrichment_settings set icp_text = $2, icp_hash = $3 where workspace_id = $1 and icp_text is null", [actor.workspaceId, learned, hash]),
  ).catch(() => undefined);
  return { text: learned, hash };
}

export type CompanyFit = { score: number; label: string; checkedAt: string; sources: { url: string; title: string | null }[]; stale: boolean } | null;

export async function getCompanyFit(actor: Actor, companyId: string): Promise<CompanyFit> {
  if (!isUuid(companyId)) return null;
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ icp_score: number | null; icp_checked_at: Date | null; icp_hash: string | null; icp_sources: { url: string; title: string | null }[] }>(
      "select icp_score, icp_checked_at, icp_hash, icp_sources from crm.company_web_state where company_id = $1 and workspace_id = $2",
      [companyId, actor.workspaceId],
    );
    return result.rows[0] ?? null;
  });
  if (!row || row.icp_score === null || !row.icp_checked_at) return null;
  const settings = await getEnrichmentSettings(actor);
  if (!settings.webIcp) return null;
  const profile = await icpProfile(actor);
  const score = Math.round(Number(row.icp_score) * 10) / 10;
  return { score, label: fitLabel(score), checkedAt: new Date(row.icp_checked_at).toISOString(), sources: row.icp_sources ?? [], stale: Boolean(profile && profile.hash !== row.icp_hash) };
}

async function saveFit(actor: Actor, companyId: string, score: number | null, hash: string, citations: DecisionCitation[]) {
  const sources = citations.slice(0, 8).map((citation) => ({ url: citation.url, title: citation.title }));
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.company_web_state (company_id, workspace_id, icp_score, icp_checked_at, icp_hash, icp_sources)
       values ($1, $2, $3, now(), $4, $5::jsonb)
       on conflict (company_id) do update set icp_score = excluded.icp_score, icp_checked_at = now(), icp_hash = excluded.icp_hash, icp_sources = excluded.icp_sources`,
      [companyId, actor.workspaceId, score, hash, JSON.stringify(sources)],
    ),
  );
}

export type CompanyCheck = { status: "updated" | "unchanged" | "skipped" | "failed"; message: string; tags: string[]; filled: string[] };

export async function checkCompany(
  actor: Actor,
  companyId: string,
  options: { tags: boolean; gaps: boolean; icp?: IcpProfile | null; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<CompanyCheck> {
  if (!parallelKey(options.env)) return { status: "skipped", message: "Add PARALLEL_API_KEY in Vercel to run web checks.", tags: [], filled: [] };
  const company = await getCompany(actor, companyId);
  if (!company.domain && !company.website) return { status: "skipped", message: "Add the company's website first.", tags: [], filled: [] };
  const questions: Record<string, DecisionQuestion> = {};
  const tagRules = options.tags ? (await listWebChecks(actor, "tag")).filter((rule) => !company.tags.includes(rule.label)).slice(0, TAG_QUESTIONS_MAX) : [];
  tagRules.forEach((rule, index) => {
    questions[`tag_${index}`] = { type: "noul", instructions: rule.question };
  });
  if (options.gaps && !company.sizeCategory) {
    questions.size = {
      type: "choice",
      instructions: "How many people work at the company? Select unknown when the evidence doesn't show it.",
      criteria: { ...Object.fromEntries(Object.entries(SIZE_OPTIONS).map(([key, option]) => [key, option.description])), unknown: "The evidence doesn't show how many people work there." },
    };
  }
  const industries = options.gaps && !company.industry ? await workspaceIndustries(actor) : [];
  if (industries.length >= 2) {
    questions.industry = {
      type: "choice",
      instructions: "Which of these best describes what the company does? Select other when none of them fit.",
      criteria: { ...Object.fromEntries(industries.map((industry, index) => [`i${index}`, industry])), other: "None of these describe the company." },
    };
  }
  if (options.icp) {
    questions.icp = {
      type: "score",
      instructions: "How well does the company fit the ideal customer profile given in ideal_customer_profile? Judge from what the company does, who it serves, its size and where it works.",
      criteria: ICP_LEVELS,
    };
  }
  if (Object.keys(questions).length === 0) {
    await markChecked(actor, companyId, null, false, false);
    return { status: "unchanged", message: "Nothing to check.", tags: [], filled: [] };
  }

  let decision;
  try {
    const state = options.icp ? { ...publicState(company), ideal_customer_profile: options.icp.text } : publicState(company);
    decision = await decide(state, questions, { fetchImpl: options.fetchImpl, env: options.env });
  } catch (error) {
    return { status: "failed", message: error instanceof ParallelError ? error.message : "The web check failed.", tags: [], filled: [] };
  }
  const tags = tagRules.filter((_, index) => {
    const answer = decision.answers[`tag_${index}`];
    return answer?.type === "noul" && answer.noul >= TAG_THRESHOLD;
  }).map((rule) => rule.label);
  const write: { sizeCategory?: string; industry?: string } = {};
  let fit: string | null = null;
  let failure: unknown = null;
  try {
    if (tags.length > 0) await editCompanyTags(actor, companyId, (current) => [...current, ...tags], PROVENANCE);
    const size = bestChoice(decision.answers.size);
    if (size && SIZE_OPTIONS[size]) write.sizeCategory = SIZE_OPTIONS[size].value;
    const industry = bestChoice(decision.answers.industry);
    if (industry && industry !== "other") write.industry = industries[Number(industry.slice(1))];
    const latest = Object.keys(write).length > 0 ? await getCompany(actor, companyId) : company;
    if (latest.sizeCategory) delete write.sizeCategory;
    if (latest.industry) delete write.industry;
    if (Object.keys(write).length > 0) await updateCompany(actor, companyId, write, { provenance: PROVENANCE });
    if (options.icp) {
      const answer = decision.answers.icp;
      const score = answer?.type === "score" ? Math.min(4, Math.max(0, answer.score)) : null;
      await saveFit(actor, companyId, score, options.icp.hash, decision.citations);
      if (score !== null) fit = `fit: ${fitLabel(score).toLowerCase()} (${score.toFixed(1)})`;
    }
  } catch (error) {
    failure = error;
  }
  const filled = failure ? [] : Object.keys(write);
  const parts = failure
    ? []
    : [tags.length ? `tags: ${tags.join(", ")}` : null, write.sizeCategory ? `size: ${write.sizeCategory}` : null, write.industry ? `industry: ${write.industry}` : null, fit].filter(Boolean);
  await markChecked(actor, companyId, failure ? "couldn't save the result" : parts.join("; ") || null, parts.length > 0);
  if (failure) {
    if (!(failure instanceof CrmError)) console.error("Saving a web check failed", failure);
    return { status: "failed", message: failure instanceof CrmError ? failure.message : "The result couldn't be saved.", tags: [], filled: [] };
  }
  return parts.length > 0
    ? { status: "updated", message: `Added ${parts.join(", ")}.`, tags, filled }
    : { status: "unchanged", message: "Nothing confident enough to add.", tags, filled };
}

export async function autoCheckCompany(actor: Actor, companyId: string) {
  try {
    if (!parallelKey()) return;
    const settings = await getEnrichmentSettings(actor);
    if (!settings.webTags && !settings.webGaps && !settings.webIcp) return;
    const icp = settings.webIcp ? await icpProfile(actor) : null;
    await checkCompany(actor, companyId, { tags: settings.webTags, gaps: settings.webGaps, icp });
  } catch (error) {
    if (!(error instanceof CrmError)) console.error("Web check failed", error);
  }
}

const UNCHECKED_SQL = `
  from crm.companies c
  left join crm.company_web_state s on s.company_id = c.id
  where c.workspace_id = $1 and c.archived_at is null and (c.domain is not null or c.website is not null)
    and (($2 and s.checked_at is null) or ($3::text is not null and s.icp_hash is distinct from $3))`;

async function dueParams(actor: Actor) {
  const settings = await getEnrichmentSettings(actor);
  const icp = settings.webIcp ? await icpProfile(actor) : null;
  return { settings, icp, values: [actor.workspaceId, settings.webTags || settings.webGaps, icp?.hash ?? null] };
}

export async function uncheckedCompanyCount(actor: Actor) {
  const { values } = await dueParams(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(`select count(*)::int as total ${UNCHECKED_SQL}`, values);
    return result.rows[0]?.total ?? 0;
  });
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

export async function backfillWebChecks(actor: UserActor, options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}) {
  assertAdmin(actor);
  const { settings, icp, values } = await dueParams(actor);
  if (!settings.webTags && !settings.webGaps && !settings.webIcp) throw invalid("Turn on tagging, filling gaps or ICP fit first.");
  if (settings.webIcp && !settings.webTags && !settings.webGaps && !icp) throw invalid("Describe your ideal customer first.");
  const ids = await withActor(actor, async (db) => {
    const result = await db.query<{ company_id: string }>(
      `with due as (
         select c.id ${UNCHECKED_SQL}
           and (s.check_claimed_at is null or s.check_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
         order by c.created_at
         limit ${BACKFILL_BATCH}
       )
       insert into crm.company_web_state (company_id, workspace_id, check_claimed_at)
       select id, $1, now() from due
       on conflict (company_id) do update set check_claimed_at = now()
         where crm.company_web_state.check_claimed_at is null
            or crm.company_web_state.check_claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES})
       returning company_id`,
      values,
    );
    return result.rows.map((row) => row.company_id);
  });
  const results = await inBatches(ids, async (id) => {
    try {
      return { companyId: id, ...(await checkCompany(actor, id, { tags: settings.webTags, gaps: settings.webGaps, icp, ...options })) };
    } catch (error) {
      return { companyId: id, status: "failed" as const, message: error instanceof CrmError ? error.message : "That check failed.", tags: [], filled: [] };
    }
  });
  const failed = results.find((result) => result.status === "failed");
  const limited = results.find((result) => result.status === "failed" && /rate limiting|rejected the key/i.test(result.message));
  if (limited) throw new CrmError("upstream_error", limited.message, 502);
  if (failed && results.every((result) => result.status === "failed")) throw new CrmError("upstream_error", failed.message, 502);
  return { results, remaining: await uncheckedCompanyCount(actor) };
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function evidence(citations: DecisionCitation[], domain: string | null) {
  const own = (url: string) => {
    const name = host(url);
    return Boolean(domain) && (name === domain || name.endsWith(`.${domain}`));
  };
  const outside = citations.find((citation) => !own(citation.url));
  return outside ?? citations[0] ?? null;
}

async function claimDue(actor: Actor, limit: number) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ company_id: string }>(
      `with due as (
         select c.id from crm.companies c
         left join crm.company_web_state s on s.company_id = c.id
         where c.workspace_id = $1 and c.archived_at is null and (c.domain is not null or c.website is not null)
           and (c.lifecycle in ('customer', 'prospect')
             or exists (select 1 from crm.opportunities o where o.company_id = c.id and o.status = 'open' and o.archived_at is null))
           and (s.signals_checked_at is null or s.signals_checked_at < now() - make_interval(days => $3))
         order by s.signals_checked_at nulls first, c.created_at
         limit $2
       )
       insert into crm.company_web_state (company_id, workspace_id, signals_checked_at)
       select id, $1, now() from due
       on conflict (company_id) do update set signals_checked_at = excluded.signals_checked_at
         where crm.company_web_state.signals_checked_at is null
            or crm.company_web_state.signals_checked_at < now() - make_interval(days => $3)
       returning company_id`,
      [actor.workspaceId, limit, SIGNAL_INTERVAL_DAYS],
    );
    return result.rows.map((row) => row.company_id);
  });
}

async function recentlyFlagged(db: Db, companyId: string, checkIds: string[]) {
  const result = await db.query<{ check_id: string }>(
    `select distinct check_id from crm.company_signals
     where company_id = $1 and check_id = any($2::uuid[]) and flagged_at > now() - make_interval(days => $3)`,
    [companyId, checkIds, SIGNAL_REPEAT_DAYS],
  );
  return new Set(result.rows.map((row) => row.check_id));
}

async function flag(actor: Actor, company: Company, found: { check: WebCheck; probability: number }[], citation: DecisionCitation | null) {
  await withActor(actor, async (db) => {
    const summary = [`Web check: ${found.map((item) => `${item.check.label} (${Math.round(item.probability * 100)}% likely)`).join(", ")}.`, citation?.title ? `Source: ${citation.title}` : null]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 1500);
    const headline = `${company.name}: ${found.map((item) => item.check.label).join(", ")}`.slice(0, 300);
    const insert = (url: string | null) =>
      db.query<{ id: string }>(
        `insert into crm.market_notes (workspace_id, kind, headline, summary, url, about, company_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (workspace_id, url) where url is not null do nothing
         returning id`,
        [actor.workspaceId, found[0].check.noteKind, headline, summary, url, company.name.slice(0, 200), company.id, actor.type === "user" ? actor.userId : null],
      );
    let note = await insert(citation?.url ?? null);
    if (!note.rows[0] && citation?.url) note = await insert(null);
    for (const item of found) {
      await db.query(
        `insert into crm.company_signals (workspace_id, company_id, check_id, probability, url, note_id) values ($1, $2, $3, $4, $5, $6)`,
        [actor.workspaceId, company.id, item.check.id, item.probability, citation?.url ?? null, note.rows[0]?.id ?? null],
      );
    }
  });
}

async function release(actor: Actor, ids: string[], retryInHours: number) {
  if (ids.length === 0) return;
  await withActor(actor, (db) =>
    db.query(
      `update crm.company_web_state set signals_checked_at = now() - make_interval(days => $3) + make_interval(hours => $4)
       where workspace_id = $1 and company_id = any($2::uuid[])`,
      [actor.workspaceId, ids, SIGNAL_INTERVAL_DAYS, retryInHours],
    ),
  );
}

export async function runWebSignals(actor: Actor, options: { deadline: number; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }) {
  if (!parallelKey(options.env)) return { skipped: "No PARALLEL_API_KEY." };
  const settings = await getEnrichmentSettings(actor);
  if (!settings.webSignals) return { skipped: "Weekly signals are off." };
  const checks = await listWebChecks(actor, "signal");
  if (checks.length === 0) return { skipped: "No signals to check." };
  let checked = 0;
  let flagged = 0;
  let failed = 0;
  while (options.deadline - Date.now() > 5_000) {
    const ids = await claimDue(actor, SIGNAL_BATCH);
    if (ids.length === 0) break;
    for (const [position, id] of ids.entries()) {
      if (options.deadline - Date.now() < 3_000) {
        await release(actor, ids.slice(position), 0);
        return { checked, flagged, failed };
      }
      try {
        const company = await getCompany(actor, id);
        const skip = await withActor(actor, (db) => recentlyFlagged(db, id, checks.map((check) => check.id)));
        const open = checks.filter((check) => !skip.has(check.id)).slice(0, 100);
        if (open.length === 0) continue;
        const decision = await decide(publicState(company), Object.fromEntries(open.map((check, index) => [`signal_${index}`, { type: "noul", instructions: check.question }])), {
          fetchImpl: options.fetchImpl,
          env: options.env,
          excerpts: false,
        });
        checked += 1;
        const found = open.flatMap((check, index) => {
          const answer = decision.answers[`signal_${index}`];
          return answer?.type === "noul" && answer.noul >= SIGNAL_THRESHOLD ? [{ check, probability: answer.noul }] : [];
        });
        if (found.length > 0) {
          await flag(actor, company, found, evidence(decision.citations, company.domain));
          flagged += found.length;
        }
      } catch (error) {
        failed += 1;
        await release(actor, [id], 1);
        if (!(error instanceof ParallelError) && !(error instanceof CrmError)) console.error("Signal check failed", error);
        if (error instanceof ParallelError && /key|rate/i.test(error.message)) {
          await release(actor, ids.slice(position + 1), 1);
          return { checked, flagged, failed, error: error.message };
        }
      }
    }
  }
  return { checked, flagged, failed };
}
