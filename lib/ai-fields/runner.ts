import { after } from "next/server";
import { getCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { FIT_JOINS } from "@/lib/crm/company-query";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, Company } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { GAP_THRESHOLD, TAG_THRESHOLD } from "@/lib/enrichment/web-checks";
import { createTaskRun, decide, getTaskResult, getTaskRun, parallelKey, ParallelError, type DecisionCitation, type DecisionQuestion, type TaskField, type TaskFieldBasis } from "@/lib/parallel";
import { BACKGROUND_PROVENANCE, fillSizeFromStaff, recordAnswerChange, type StoredValue } from "@/lib/ai-fields/answers";
import { readFields, scopeSql, spendThisMonth, type StoredField } from "@/lib/ai-fields/fields";
import { DECISION_COST, MONTHLY_LIMIT_USD, TASK_COST, usesDecisions, type AiSource } from "@/lib/ai-fields/types";

export const YES_THRESHOLD = TAG_THRESHOLD;
export const NO_THRESHOLD = 1 - TAG_THRESHOLD;
export const PICK_THRESHOLD = GAP_THRESHOLD;
export const CLAIM_MINUTES = 3;
const COMPANIES_PER_RUN = 40;
const TASKS_PER_RUN = 25;
const RUNS_PER_COLLECT = 25;
const CONCURRENCY = 5;
const QUESTIONS_MAX = 100;
const RETRY_HOURS = 6;
const RUN_GIVE_UP_HOURS = 3;
const SOURCES_MAX = 6;
const POLL_PAUSE_MS = 4_000;

type RunOptions = {
  deadline: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  companyId?: string;
  fieldIds?: string[];
  waitForTasks?: boolean;
  pollPauseMs?: number;
};

export type AiFieldsReport = { checked: number; answered: number; started: number; collected: number; failed: number; skipped?: string; error?: string };

type Parsed = { state: "answered" | "unknown"; bool?: boolean; number?: number; text?: string; options?: string[]; likelihood: number | null; confidence: "high" | "medium" | "low" | null; reason: string | null; sources: AiSource[] };

function days(field: StoredField) {
  return field.refresh === "weekly" ? 7 : field.refresh === "monthly" ? 30 : null;
}

function nextCheck(field: StoredField) {
  const interval = days(field);
  return interval === null ? null : new Date(Date.now() + interval * 86_400_000).toISOString();
}

function publicState(company: Company) {
  return {
    company: company.name,
    ...(company.domain ? { domain: company.domain } : {}),
    ...(company.website ? { website: company.website } : {}),
    today: new Date().toISOString().slice(0, 10),
  };
}

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4),
  );
}

export function bestExcerpt(citations: DecisionCitation[], about: string) {
  const wanted = words(about);
  let best: { text: string; score: number } | null = null;
  for (const citation of citations) {
    for (const excerpt of citation.excerpts) {
      const clean = excerpt.replace(/\s+/g, " ").trim();
      for (const part of clean.split(/(?<=[.!?])\s+/)) {
        const text = part.replace(/^[#>*\-\s]+/, "").trim();
        if (text.length < 12) continue;
        let score = 0;
        for (const word of words(text)) if (wanted.has(word)) score += 1;
        if (!best || score > best.score) best = { text, score };
      }
    }
  }
  if (!best) return null;
  return best.text.length > 220 ? `${best.text.slice(0, 217).trimEnd()}…` : best.text;
}

function sourcesOf(citations: DecisionCitation[]): AiSource[] {
  const seen = new Set<string>();
  const out: AiSource[] = [];
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push({ title: citation.title, url: citation.url });
    if (out.length >= SOURCES_MAX) break;
  }
  return out;
}

export function decisionQuestions(fields: StoredField[]) {
  const questions: Record<string, DecisionQuestion> = {};
  const used: StoredField[] = [];
  for (const [index, field] of fields.entries()) {
    const entries: [string, DecisionQuestion][] = [];
    if (field.kind === "yes_no") entries.push([`q${index}`, { type: "noul", instructions: field.question }]);
    else if (field.kind === "pick" && !field.multiple) {
      entries.push([
        `q${index}`,
        {
          type: "choice",
          instructions: `${field.question} Select unknown when the evidence doesn't show which applies.`,
          criteria: { ...Object.fromEntries(field.options.map((option, position) => [`o${position}`, option])), unknown: "The evidence doesn't show which of these applies." },
        },
      ]);
    } else if (field.kind === "pick") {
      field.options.forEach((option, position) => {
        entries.push([`q${index}_o${position}`, { type: "noul", instructions: `${field.question} Does this apply to the company: ${option}?` }]);
      });
    }
    if (Object.keys(questions).length + entries.length > QUESTIONS_MAX) break;
    for (const [key, question] of entries) questions[key] = question;
    used.push(field);
  }
  return { questions, used };
}

export function readDecision(field: StoredField, index: number, decision: { answers: Record<string, { type: string; noul?: number; choice?: string; probabilities?: Record<string, number> }>; citations: DecisionCitation[] }): Parsed {
  const sources = sourcesOf(decision.citations);
  const unknown = (likelihood: number | null): Parsed => ({ state: "unknown", likelihood, confidence: null, reason: null, sources });
  if (field.kind === "yes_no") {
    const answer = decision.answers[`q${index}`];
    if (answer?.type !== "noul" || typeof answer.noul !== "number") return unknown(null);
    const p = answer.noul;
    if (p >= YES_THRESHOLD) return { state: "answered", bool: true, likelihood: p, confidence: null, reason: bestExcerpt(decision.citations, `${field.question} yes`), sources };
    if (p <= NO_THRESHOLD) return { state: "answered", bool: false, likelihood: 1 - p, confidence: null, reason: bestExcerpt(decision.citations, `${field.question} no`), sources };
    return unknown(p);
  }
  if (!field.multiple) {
    const answer = decision.answers[`q${index}`];
    if (answer?.type !== "choice" || !answer.choice || answer.choice === "unknown") return unknown(null);
    const probability = answer.probabilities?.[answer.choice] ?? 0;
    const option = field.options[Number(answer.choice.slice(1))];
    if (!option || probability < PICK_THRESHOLD) return unknown(probability || null);
    return { state: "answered", options: [option], likelihood: probability, confidence: null, reason: bestExcerpt(decision.citations, `${field.question} ${option}`), sources };
  }
  const picked: { option: string; p: number }[] = [];
  field.options.forEach((option, position) => {
    const answer = decision.answers[`q${index}_o${position}`];
    if (answer?.type === "noul" && typeof answer.noul === "number" && answer.noul >= PICK_THRESHOLD) picked.push({ option, p: answer.noul });
  });
  if (picked.length === 0) return unknown(null);
  return {
    state: "answered",
    options: picked.map((item) => item.option),
    likelihood: Math.min(...picked.map((item) => item.p)),
    confidence: null,
    reason: bestExcerpt(decision.citations, `${field.question} ${picked.map((item) => item.option).join(" ")}`),
    sources,
  };
}

export function taskKeyFor(field: Pick<StoredField, "id">) {
  return `f_${field.id.replace(/-/g, "")}`;
}

export function taskFields(fields: StoredField[]) {
  const out: Record<string, TaskField> = {};
  for (const field of fields) {
    out[taskKeyFor(field)] =
      field.kind === "number"
        ? { type: "number", description: `${field.question} Answer with a single number (for a range, its middle). Use null when the evidence doesn't show it.` }
        : { type: "string", description: `${field.question} Answer in a few words, at most 12. Use null when the evidence doesn't show it.` };
  }
  return out;
}

export function readTaskAnswer(field: StoredField, content: Record<string, unknown>, basis: TaskFieldBasis[]): Parsed {
  const key = taskKeyFor(field);
  const entry = basis.find((item) => item.field === key);
  const sources = sourcesOf(entry?.citations ?? []);
  const confidence = entry?.confidence ?? null;
  const unknown: Parsed = { state: "unknown", likelihood: null, confidence, reason: null, sources };
  if (confidence === "low") return unknown;
  const raw = content[key];
  const reason = bestExcerpt(entry?.citations ?? [], `${field.question} ${String(raw ?? "")}`) ?? (entry?.reasoning ? entry.reasoning.replace(/\s+/g, " ").slice(0, 220) : null);
  if (field.kind === "number") {
    const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,\s]/g, "").replace(/[^0-9.-].*$/, "")) : NaN;
    if (!Number.isFinite(number) || (typeof raw === "string" && !raw.trim())) return unknown;
    return { state: "answered", number, likelihood: null, confidence, reason, sources };
  }
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 300) : typeof raw === "number" ? String(raw) : "";
  if (!text || /^(null|unknown|n\/a|none)$/i.test(text)) return unknown;
  return { state: "answered", text, likelihood: null, confidence, reason, sources };
}

async function saveParsed(actor: Actor, field: StoredField, companyId: string, parsed: Parsed) {
  const result = await query<{ change: { existed: boolean; before: StoredValue; after: StoredValue } | null }>("select private.ai_field_save($1, $2, $3, $4::jsonb) as change", [
    actor.workspaceId,
    field.id,
    companyId,
    JSON.stringify({
      state: parsed.state,
      bool: parsed.bool ?? null,
      number: parsed.number ?? null,
      text: parsed.text ?? null,
      options: parsed.options ?? null,
      likelihood: parsed.likelihood,
      confidence: parsed.confidence,
      reason: parsed.reason,
      sources: parsed.sources,
      nextCheckAt: nextCheck(field),
    }),
  ]);
  const change = result.rows[0]?.change;
  if (!change) return false;
  await withActor(actor, (db) => recordAnswerChange(db, actor, field, companyId, change.before, change.after, BACKGROUND_PROVENANCE));
  if (parsed.state === "answered" && typeof parsed.number === "number") await fillSizeFromStaff(actor, field, companyId, parsed.number, BACKGROUND_PROVENANCE);
  return parsed.state === "answered";
}

async function fail(actor: Actor, fieldIds: string[], companyId: string, message: string | null, retryHours = RETRY_HOURS) {
  await query("select private.ai_field_fail($1, $2::uuid[], $3, $4, $5)", [actor.workspaceId, fieldIds, companyId, message, retryHours]);
}

async function spend(actor: Actor, decisions: number, tasks: number) {
  if (decisions === 0 && tasks === 0) return;
  await query("select private.ai_field_spend($1, $2, $3)", [actor.workspaceId, decisions, tasks]);
}

async function note(actor: Actor, fieldIds: string[], error: string | null) {
  if (fieldIds.length === 0) return;
  await query("select private.ai_field_note($1, $2::uuid[], $3)", [actor.workspaceId, fieldIds, error]);
}

async function dueCompanies(actor: Actor, field: StoredField, limit: number, companyId?: string) {
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId, field.id];
    const scope = scopeSql(field, values);
    values.push(limit);
    const limitRef = `$${values.length}`;
    let only = "";
    if (companyId) {
      values.push(companyId);
      only = ` and c.id = $${values.length}`;
    }
    const result = await db.query<{ id: string }>(
      `select c.id from crm.companies c ${FIT_JOINS}
       left join crm.ai_field_answers a on a.company_id = c.id and a.field_id = $2
       where c.workspace_id = $1 and ${scope}${only}
         and (a.field_id is null or (not a.manual and a.next_check_at is not null and a.next_check_at <= now()
           and (a.claimed_at is null or a.claimed_at < now() - make_interval(mins => ${CLAIM_MINUTES}))
           and (a.run_id is null or a.run_started_at < now() - make_interval(hours => ${RUN_GIVE_UP_HOURS}))))
       order by (a.field_id is null) desc, a.next_check_at nulls first, c.created_at, c.id
       limit ${limitRef}`,
      values,
    );
    return result.rows.map((row) => row.id);
  });
}

async function claim(actor: Actor, field: StoredField, companyIds: string[]) {
  if (companyIds.length === 0) return [];
  const result = await query<{ company_id: string }>("select private.ai_field_claim($1, $2, $3::uuid[], $4) as company_id", [actor.workspaceId, field.id, companyIds, CLAIM_MINUTES]);
  return result.rows.map((row) => row.company_id);
}

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  await run(items[0]);
  let next = 1;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

type PendingRun = { run_id: string; company_id: string; field_ids: string[]; started: Date };

async function pendingRuns(actor: Actor, limit: number, companyId?: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<PendingRun>(
      `select run_id, company_id, array_agg(field_id) as field_ids, min(run_started_at) as started
       from crm.ai_field_answers
       where workspace_id = $1 and run_id is not null and ($3::uuid is null or company_id = $3)
       group by run_id, company_id
       order by min(run_started_at)
       limit $2`,
      [actor.workspaceId, limit, companyId ?? null],
    );
    return result.rows;
  });
}

class StopRun extends Error {}

function stopsEverything(error: unknown) {
  return error instanceof ParallelError && /key|rate|credit/i.test(error.message);
}

export async function collectTaskRuns(actor: Actor, fields: StoredField[], options: RunOptions, report: AiFieldsReport) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const runs = await pendingRuns(actor, RUNS_PER_COLLECT, options.companyId);
  for (const run of runs) {
    if (options.deadline - Date.now() < 3_000) break;
    const runFields = run.field_ids.map((id) => byId.get(id)).filter((field): field is StoredField => Boolean(field));
    try {
      const status = await getTaskRun(run.run_id, { fetchImpl: options.fetchImpl, env: options.env, timeoutMs: Math.min(10_000, options.deadline - Date.now()) });
      if (!status) continue;
      if (status.status === "completed") {
        const result = await getTaskResult(run.run_id, { fetchImpl: options.fetchImpl, env: options.env, waitSeconds: 2 });
        if (!result) continue;
        if (result.run.status !== "completed") {
          await fail(actor, run.field_ids, run.company_id, result.run.error ?? "The check failed.");
          report.failed += 1;
          continue;
        }
        await spend(actor, 0, 1);
        report.collected += 1;
        for (const field of runFields) {
          if (await saveParsed(actor, field, run.company_id, readTaskAnswer(field, result.content, result.basis))) report.answered += 1;
        }
        const orphaned = run.field_ids.filter((id) => !byId.has(id));
        if (orphaned.length > 0) await fail(actor, orphaned, run.company_id, "The field changed.", 0);
      } else if (!status.active && status.status !== "action_required") {
        await fail(actor, run.field_ids, run.company_id, status.error ?? "The check didn't finish.");
        report.failed += 1;
      } else if (Date.now() - new Date(run.started).getTime() > RUN_GIVE_UP_HOURS * 3_600_000) {
        await fail(actor, run.field_ids, run.company_id, "The check took too long.", 1);
        report.failed += 1;
      }
    } catch (error) {
      if (stopsEverything(error)) throw error;
      if (!(error instanceof ParallelError)) console.error("Collecting an AI field check failed", error);
    }
  }
  return runs.length;
}

async function checkCompany(actor: Actor, companyId: string, fields: StoredField[], options: RunOptions, report: AiFieldsReport, budget: { tasks: number }) {
  let company: Company;
  try {
    company = await getCompany(actor, companyId);
  } catch {
    await fail(actor, fields.map((field) => field.id), companyId, "Company not found.", 24);
    return;
  }
  if (!company.domain && !company.website) {
    await fail(actor, fields.map((field) => field.id), companyId, "Add the company's website first.", 24);
    return;
  }
  const decisionFields = fields.filter((field) => usesDecisions(field.kind));
  const taskOnes = fields.filter((field) => !usesDecisions(field.kind));
  if (decisionFields.length > 0) {
    const { questions, used } = decisionQuestions(decisionFields);
    try {
      const decision = await decide(publicState(company), questions, { fetchImpl: options.fetchImpl, env: options.env });
      await spend(actor, 1, 0);
      report.checked += 1;
      for (const [index, field] of used.entries()) {
        if (await saveParsed(actor, field, companyId, readDecision(field, index, decision))) report.answered += 1;
      }
    } catch (error) {
      report.failed += 1;
      await fail(actor, used.map((field) => field.id), companyId, error instanceof ParallelError ? error.message : "The check failed.");
      if (stopsEverything(error)) throw new StopRun(error instanceof Error ? error.message : "Parallel stopped.");
      if (!(error instanceof ParallelError) && !(error instanceof CrmError)) console.error("AI field check failed", error);
    }
  }
  if (taskOnes.length > 0) {
    if (budget.tasks <= 0) return;
    budget.tasks -= 1;
    try {
      const run = await createTaskRun(publicState(company), taskFields(taskOnes), { fetchImpl: options.fetchImpl, env: options.env, metadata: { orbit: "ai_fields" } });
      await query("select private.ai_field_run_start($1, $2::uuid[], $3, $4)", [actor.workspaceId, taskOnes.map((field) => field.id), companyId, run.runId]);
      report.started += 1;
    } catch (error) {
      report.failed += 1;
      await fail(actor, taskOnes.map((field) => field.id), companyId, error instanceof ParallelError ? error.message : "The check failed.");
      if (stopsEverything(error)) throw new StopRun(error instanceof Error ? error.message : "Parallel stopped.");
      if (!(error instanceof ParallelError) && !(error instanceof CrmError)) console.error("AI field task failed", error);
    }
  }
}

export async function runAiFields(actor: Actor, options: RunOptions): Promise<AiFieldsReport> {
  const report: AiFieldsReport = { checked: 0, answered: 0, started: 0, collected: 0, failed: 0 };
  if (!parallelKey(options.env)) return { ...report, skipped: "No PARALLEL_API_KEY." };
  const all = await withActor(actor, (db) => readFields(db, actor.workspaceId));
  const wanted = options.fieldIds?.filter(isUuid);
  const fields = all.filter((field) => !field.paused && (!wanted || wanted.includes(field.id)));
  if (all.length === 0) return { ...report, skipped: "No AI fields." };
  const touched = new Set<string>();
  try {
    await collectTaskRuns(actor, all, options, report);
    const spent = await spendThisMonth(actor);
    if (spent.amount >= MONTHLY_LIMIT_USD) {
      await note(actor, fields.map((field) => field.id), `Paused until next month: this month's checks reached $${MONTHLY_LIMIT_USD}.`);
      return { ...report, skipped: "Monthly limit reached." };
    }
    let room = Math.max(0, Math.floor((MONTHLY_LIMIT_USD - spent.amount) / (DECISION_COST + TASK_COST)));
    const budget = { tasks: Math.min(TASKS_PER_RUN, room) };
    while (options.deadline - Date.now() > 5_000 && room > 0) {
      const plan = new Map<string, StoredField[]>();
      for (const field of fields) {
        if (plan.size >= COMPANIES_PER_RUN) break;
        if (!usesDecisions(field.kind) && budget.tasks <= 0) continue;
        const due = await dueCompanies(actor, field, Math.min(COMPANIES_PER_RUN, room), options.companyId);
        const claimed = await claim(actor, field, due.slice(0, COMPANIES_PER_RUN));
        for (const companyId of claimed) {
          if (!plan.has(companyId) && plan.size >= COMPANIES_PER_RUN) {
            await fail(actor, [field.id], companyId, null, 0);
            continue;
          }
          plan.set(companyId, [...(plan.get(companyId) ?? []), field]);
        }
      }
      if (plan.size === 0) break;
      room -= plan.size;
      const entries = [...plan.entries()];
      let stopped: StopRun | null = null;
      await inBatches(entries, async ([companyId, companyFields]) => {
        if (stopped) return;
        if (options.deadline - Date.now() < 3_000) {
          await fail(actor, companyFields.map((field) => field.id), companyId, null, 0);
          return;
        }
        for (const field of companyFields) touched.add(field.id);
        try {
          await checkCompany(actor, companyId, companyFields, options, report, budget);
        } catch (error) {
          if (error instanceof StopRun) stopped = error;
          else throw error;
        }
      });
      if (stopped) throw stopped;
      if (options.companyId) break;
    }
    if (options.waitForTasks) {
      while (options.deadline - Date.now() > 8_000) {
        const pending = await pendingRuns(actor, 1, options.companyId);
        if (pending.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, options.pollPauseMs ?? POLL_PAUSE_MS));
        await collectTaskRuns(actor, all, options, report);
      }
    }
    await note(actor, [...touched], null);
    return report;
  } catch (error) {
    const message = error instanceof Error && (error instanceof StopRun || error instanceof ParallelError) ? error.message : "AI fields couldn't run.";
    if (!(error instanceof StopRun) && !(error instanceof ParallelError)) console.error("AI fields run failed", error);
    await note(actor, [...(touched.size > 0 ? touched : new Set(fields.map((field) => field.id)))], message).catch(() => undefined);
    return { ...report, error: message };
  }
}

export function kickAiFields(actor: Actor, options: { companyId?: string; fieldIds?: string[]; budgetMs?: number } = {}) {
  if (!parallelKey()) return;
  const run = async () => {
    try {
      await runAiFields(actor, { deadline: Date.now() + (options.budgetMs ?? 50_000), companyId: options.companyId, fieldIds: options.fieldIds, waitForTasks: true });
    } catch (error) {
      console.error("AI fields run failed", error);
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function checkCompanyNow(actor: Actor, companyId: string, options: { fieldIds?: string[]; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}) {
  const report = await runAiFields(actor, { deadline: Date.now() + 15_000, companyId, fieldIds: options.fieldIds, fetchImpl: options.fetchImpl, env: options.env });
  if (report.started > 0) kickAiFields(actor, { companyId, budgetMs: 55_000 });
  return report;
}

export async function autoAiFields(actor: Actor, companyId: string) {
  try {
    if (!parallelKey()) return;
    await runAiFields(actor, { deadline: Date.now() + 20_000, companyId });
  } catch (error) {
    if (!(error instanceof CrmError)) console.error("AI fields for a new company failed", error);
  }
}
