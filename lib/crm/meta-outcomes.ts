import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, isPgError, ShownError } from "@/lib/crm/errors";
import { leadPerson, readAnswers } from "@/lib/crm/meta-leads";
import { recordAudit } from "@/lib/crm/mutate";
import type { Actor, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { alertLink } from "@/lib/crm/workspaces";
import { query, type Db } from "@/lib/db/pool";
import { checkMetaDataset, cut, hashEmail, hashPhone, MetaError, metaDatasetToken, metaId, sendMetaEvents, type MetaOutcomeEvent } from "@/lib/meta";

const SETTINGS_HREF = "/settings/tools#meta-leads";
const SCAN_LEADS = 500;
const CLAIM_LEADS = 100;
const BATCH_EVENTS = 100;
const HASH_LEADS = 500;
const SEND_RESERVE_MS = 1_500;
const DEFAULT_BUDGET_MS = 8_000;
const LEAD_STAGE = "Lead";
const UNREACHABLE_DATASET = "Meta can't reach the dataset. Check the Dataset ID and that the token can use it.";
const NOTHING_ACCEPTED = "Meta rejected everything sent, and nothing has been accepted lately. Check the Dataset ID and the token.";

export type MetaOutcomeOptions = {
  deadline?: number;
  fetchImpl?: typeof fetch;
  contactId?: string | null;
  companyId?: string | null;
  leadIds?: string[];
  limit?: number;
};

export type MetaOutcomeReport = {
  skipped?: string;
  recorded: number;
  sent: number;
  failed: number;
  retried: number;
  errors: string[];
};

type DueRow = {
  lead_id: string;
  workspace_id: string;
  stage_name: string;
  stage_id: string | null;
  stage_position: number;
  occurred_at: Date;
  value: string | null;
  currency: string | null;
  opportunity_id: string | null;
};

type ClaimedRow = {
  id: string;
  workspace_id: string;
  dataset_id: string;
  leadgen_id: string;
  stage_name: string;
  position: number;
  occurred_at: Date;
  value: string | null;
  currency: string | null;
  email_hash: string | null;
  phone_hash: string | null;
  attempts: number;
  isolate: boolean;
};

type Tally = {
  sent: string[];
  suspects: { id: string; error: string }[];
  failed: { id: string; error: string }[];
  retry: string[];
  split: string[];
  release: string[];
  error: string | null;
};

type Delivery = { token: string; deadline: number; fetchImpl?: typeof fetch; blocked: Set<string>; stopped: boolean; accepted: boolean };

function emptyTally(): Tally {
  return { sent: [], suspects: [], failed: [], retry: [], split: [], release: [], error: null };
}

function logFailure(context: string, error: unknown) {
  const type = error instanceof CrmError ? `crm ${error.code}` : isPgError(error) ? `pg ${error.code}` : error instanceof Error ? error.name : typeof error;
  console.error(context, { type });
}

function timeLeft(deadline: number, reserve = SEND_RESERVE_MS) {
  return deadline - Date.now() > reserve;
}

export async function metaOutcomesDue() {
  if (!metaDatasetToken()) return false;
  const result = await query<{ due: boolean }>("select private.meta_outcomes_work_due() as due");
  return Boolean(result.rows[0]?.due);
}

async function fillHashes() {
  const waiting = await query<{ id: string; answers: unknown }>("select * from private.meta_leads_unhashed($1)", [HASH_LEADS]);
  for (const row of waiting.rows) {
    const person = leadPerson(readAnswers(Array.isArray(row.answers) ? row.answers : []));
    const email = hashEmail(person.email);
    const phone = hashPhone(person.phone);
    if (email || phone) await query("select private.meta_lead_hashes_set($1, $2, $3)", [row.id, email, phone]);
  }
}

async function recordDue(options: MetaOutcomeOptions) {
  const due = await query<DueRow>("select * from private.meta_lead_outcomes_due($1, $2, $3, $4::uuid[])", [
    options.limit ?? SCAN_LEADS,
    options.contactId ?? null,
    options.companyId ?? null,
    options.leadIds ?? null,
  ]);
  if (due.rows.length === 0) return 0;
  const rows = due.rows.map((row) => ({
    lead_id: row.lead_id,
    stage_name: row.stage_name,
    stage_id: row.stage_id,
    position: row.stage_position,
    occurred_at: new Date(row.occurred_at).toISOString(),
    value: row.value,
    currency: row.currency,
    opportunity_id: row.opportunity_id,
  }));
  const result = await query<{ count: number }>("select private.meta_lead_outcomes_record($1::jsonb) as count", [JSON.stringify(rows)]);
  return result.rows[0]?.count ?? 0;
}

function isEventError(error: unknown) {
  return error instanceof MetaError && error.code === 100 && error.subcode !== 33;
}

function workspaceMessage(error: unknown) {
  if (error instanceof MetaError && error.code === 100 && error.subcode === 33) return UNREACHABLE_DATASET;
  return error instanceof ShownError && error.message.trim() ? cut(error.message.replace(/\s+/g, " ").trim(), 500) : "Couldn't send to Meta. Try again.";
}

function toEvent(row: ClaimedRow): MetaOutcomeEvent {
  return {
    id: row.id,
    name: row.stage_name,
    time: new Date(row.occurred_at),
    leadId: row.leadgen_id,
    emailHash: row.email_hash,
    phoneHash: row.phone_hash,
    value: row.value === null ? null : Number(row.value),
    currency: row.currency,
  };
}

async function deliver(datasetId: string, rows: ClaimedRow[], context: Delivery, tally: Tally, splitting = false): Promise<void> {
  const live: ClaimedRow[] = [];
  for (const row of rows) {
    if (context.stopped || context.blocked.has(row.leadgen_id)) tally.release.push(row.id);
    else live.push(row);
  }
  if (live.length === 0) return;
  if (!timeLeft(context.deadline)) {
    (splitting ? tally.split : tally.release).push(...live.map((row) => row.id));
    return;
  }
  try {
    await sendMetaEvents(datasetId, live.map(toEvent), { token: context.token, fetchImpl: context.fetchImpl, deadline: context.deadline });
    tally.sent.push(...live.map((row) => row.id));
    context.accepted = true;
  } catch (error) {
    if (!isEventError(error)) {
      logFailure("Meta outcomes send failed", error);
      context.stopped = true;
      tally.error = workspaceMessage(error);
      tally.retry.push(...live.map((row) => row.id));
      return;
    }
    if (live.length === 1) {
      const detail = error instanceof MetaError ? error.detail : null;
      tally.suspects.push({ id: live[0].id, error: cut(detail ?? "Meta rejected the event.", 500) });
      context.blocked.add(live[0].leadgen_id);
      return;
    }
    const middle = Math.ceil(live.length / 2);
    await deliver(datasetId, live.slice(0, middle), context, tally, true);
    await deliver(datasetId, live.slice(middle), context, tally, true);
  }
}

async function acceptedLately(workspaceId: string) {
  try {
    const result = await query<{ proven: boolean }>("select private.meta_outcomes_proven($1) as proven", [workspaceId]);
    return Boolean(result.rows[0]?.proven);
  } catch (error) {
    logFailure("Meta outcomes proof not read", error);
    return false;
  }
}

async function judgeSuspects(workspaceId: string, context: Delivery, tally: Tally) {
  if (tally.suspects.length === 0) return;
  if (context.accepted || (await acceptedLately(workspaceId))) {
    tally.failed.push(...tally.suspects);
    return;
  }
  tally.retry.push(...tally.suspects.map((item) => item.id));
  tally.error = NOTHING_ACCEPTED;
  context.stopped = true;
}

function chunksOf(ordered: ClaimedRow[]) {
  const chunks: ClaimedRow[][] = [];
  let current: ClaimedRow[] = [];
  for (const row of ordered) {
    if (row.isolate) {
      if (current.length > 0) chunks.push(current);
      chunks.push([row]);
      current = [];
    } else {
      current.push(row);
      if (current.length >= BATCH_EVENTS) {
        chunks.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function sendWorkspace(workspaceId: string, datasetId: string, rows: ClaimedRow[], context: Delivery, report: MetaOutcomeReport) {
  const ordered = [...rows].sort((a, b) => (a.leadgen_id === b.leadgen_id ? a.position - b.position : a.leadgen_id < b.leadgen_id ? -1 : 1));
  let failure: string | null = null;
  let succeeded = false;
  for (const chunk of chunksOf(ordered)) {
    const tally = emptyTally();
    await deliver(datasetId, chunk, context, tally);
    await judgeSuspects(workspaceId, context, tally);
    try {
      await query("select private.meta_lead_outcomes_finish($1::uuid[], $2::jsonb, $3::uuid[], $4::uuid[], $5, $6::uuid[])", [
        tally.sent,
        JSON.stringify(tally.failed),
        tally.retry,
        tally.release,
        tally.error,
        tally.split,
      ]);
    } catch (error) {
      logFailure("Meta outcomes result not saved", error);
    }
    report.sent += tally.sent.length;
    report.failed += tally.failed.length;
    report.retried += tally.retry.length + tally.split.length;
    if (tally.sent.length > 0) succeeded = true;
    if (tally.error) failure = tally.error;
  }
  if (failure) {
    report.errors.push(failure);
    await query("select private.meta_outcomes_workspace_result($1, $2)", [workspaceId, failure]).catch((error) => logFailure("Meta outcomes status not saved", error));
  } else if (succeeded) {
    await query("select private.meta_outcomes_workspace_result($1, null)", [workspaceId]).catch((error) => logFailure("Meta outcomes status not saved", error));
  }
}

type OwnerRow = { workspace_id: string; workspace_name: string; user_id: string; role: WorkspaceRole; email: string | null; full_name: string | null };

async function alertStalled() {
  const stalled = await query<{ workspace_id: string; last_error: string }>("select * from private.meta_outcomes_alert_due()");
  if (stalled.rows.length === 0) return;
  const members = await query<OwnerRow>("select workspace_id, workspace_name, user_id, role, email, full_name from private.background_members()");
  for (const row of stalled.rows) {
    for (const member of members.rows.filter((item) => item.workspace_id === row.workspace_id && item.role === "owner")) {
      const actor = memberActor(member);
      try {
        const href = await alertLink(actor, SETTINGS_HREF);
        await withActor(actor, (db) =>
          db.query("insert into crm.notifications (workspace_id, user_id, title, body, href, source) values ($1, $2, $3, $4, $5, 'meta_outcomes')", [
            actor.workspaceId,
            actor.userId,
            "Meta outcomes aren't sending",
            cut(row.last_error, 4000),
            href,
          ]),
        );
      } catch (error) {
        logFailure("Meta outcomes alert failed", error);
      }
    }
  }
}

export async function runMetaOutcomes(options: MetaOutcomeOptions = {}): Promise<MetaOutcomeReport> {
  const report: MetaOutcomeReport = { recorded: 0, sent: 0, failed: 0, retried: 0, errors: [] };
  const token = metaDatasetToken();
  if (!token) return { ...report, skipped: "Meta outcomes isn't set up." };
  const deadline = Math.floor(options.deadline ?? Date.now() + DEFAULT_BUDGET_MS);
  try {
    await fillHashes();
    await query("select private.meta_outcomes_pipeline_status()");
    report.recorded = await recordDue(options);
  } catch (error) {
    logFailure("Meta outcomes not recorded", error);
    report.errors.push("Couldn't work out the stages.");
  }
  const context: Delivery = { token, deadline, fetchImpl: options.fetchImpl, blocked: new Set(), stopped: false, accepted: false };
  while (timeLeft(deadline)) {
    let claimed: ClaimedRow[];
    try {
      claimed = (await query<ClaimedRow>("select * from private.meta_lead_outcomes_claim($1)", [CLAIM_LEADS])).rows;
    } catch (error) {
      logFailure("Meta outcomes not claimed", error);
      report.errors.push("Couldn't read the stages to send.");
      break;
    }
    if (claimed.length === 0) break;
    const byWorkspace = new Map<string, ClaimedRow[]>();
    for (const row of claimed) byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row]);
    for (const [workspaceId, rows] of byWorkspace) {
      await sendWorkspace(workspaceId, rows[0].dataset_id, rows, { ...context, blocked: new Set(), stopped: false, accepted: false }, report);
    }
  }
  try {
    await alertStalled();
  } catch (error) {
    logFailure("Meta outcomes alert failed", error);
  }
  return report;
}

export type MetaOutcomesView = {
  tokenSet: boolean;
  enabled: boolean;
  datasetId: string;
  pipelineId: string | null;
  pipelines: { id: string; name: string }[];
  stages: { name: string; note: string }[];
  sent: number;
  failed: number;
  lastSentAt: string | null;
  lastError: string | null;
};

type SettingsRow = { dataset_id: string | null; pipeline_id: string | null; enabled: boolean; last_error: string | null };
type StageRow = { id: string; name: string; position: number; is_won: boolean; is_lost: boolean };

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

async function salesPipelines(db: Db, workspaceId: string) {
  const result = await db.query<{ id: string; name: string }>(
    "select id, name from crm.pipelines where workspace_id = $1 and kind = 'sales' and archived_at is null order by position, created_at",
    [workspaceId],
  );
  return result.rows;
}

function chosenPipeline(pipelines: { id: string }[], chosen: string | null) {
  if (chosen && pipelines.some((pipeline) => pipeline.id === chosen)) return chosen;
  return pipelines.length === 1 ? pipelines[0].id : null;
}

async function funnelStages(db: Db, pipelineId: string | null) {
  if (!pipelineId) return [];
  const result = await db.query<StageRow>(
    'select id, name, position, is_won, is_lost from crm.pipeline_stages where pipeline_id = $1 order by position',
    [pipelineId],
  );
  const stages = result.rows.slice(1).filter((stage) => stage.name.toLowerCase() !== LEAD_STAGE.toLowerCase());
  return [...stages.filter((stage) => !stage.is_lost), ...stages.filter((stage) => stage.is_lost)];
}

export async function getMetaOutcomesView(actor: Actor): Promise<MetaOutcomesView> {
  return withActor(actor, async (db) => {
    const settings = (await db.query<SettingsRow>("select dataset_id, pipeline_id, enabled, last_error from crm.meta_outcome_settings where workspace_id = $1", [actor.workspaceId])).rows[0];
    const pipelines = await salesPipelines(db, actor.workspaceId);
    const pipelineId = chosenPipeline(pipelines, settings?.pipeline_id ?? null);
    const stages = await funnelStages(db, pipelineId);
    const totals = (
      await db.query<{ sent: number; failed: number; last: Date | null }>(
        `select count(*) filter (where status = 'sent')::integer as sent, count(*) filter (where status = 'failed')::integer as failed, max(sent_at) as last
         from crm.meta_lead_outcomes where workspace_id = $1`,
        [actor.workspaceId],
      )
    ).rows[0];
    const admin = actor.type === "user" && (actor.role === "owner" || actor.role === "admin");
    return {
      tokenSet: Boolean(metaDatasetToken()),
      enabled: Boolean(settings?.enabled),
      datasetId: settings?.dataset_id ?? "",
      pipelineId,
      pipelines: pipelines.length > 1 ? pipelines : [],
      stages: [
        { name: LEAD_STAGE, note: "Lead arrives" },
        ...stages.map((stage) => ({ name: stage.name, note: stage.is_won ? "Opportunity won, with value" : stage.is_lost ? "Opportunity marked lost" : `Opportunity reaches ${stage.name}` })),
      ],
      sent: totals?.sent ?? 0,
      failed: admin ? (totals?.failed ?? 0) : 0,
      lastSentAt: iso(totals?.last ?? null),
      lastError: admin ? (settings?.last_error ?? null) : null,
    };
  });
}

function assertAdmin(actor: UserActor) {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new CrmError("forbidden", "Only owners and admins can change Meta lead ads.", 403);
  }
}

export type MetaOutcomesInput = { datasetId?: unknown; pipelineId?: unknown; enabled?: unknown };

export async function saveMetaOutcomes(actor: UserActor, input: MetaOutcomesInput, options: { fetchImpl?: typeof fetch } = {}) {
  assertAdmin(actor);
  const current = (
    await withActor(actor, (db) =>
      db.query<SettingsRow>("select dataset_id, pipeline_id, enabled, last_error from crm.meta_outcome_settings where workspace_id = $1", [actor.workspaceId]),
    )
  ).rows[0];
  const given = typeof input.datasetId === "string" ? input.datasetId.replace(/\s+/g, "") : null;
  const datasetId = given === null ? (current?.dataset_id ?? null) : given === "" ? null : metaId(given);
  if (given && !datasetId) throw new CrmError("invalid_input", "Enter the Dataset ID, digits only.", 400, { field: "datasetId" });
  const enabled = typeof input.enabled === "boolean" ? input.enabled : Boolean(current?.enabled);
  if (enabled && !datasetId) throw new CrmError("invalid_input", "Enter the Dataset ID first.", 400, { field: "datasetId" });
  if (enabled && !metaDatasetToken()) throw new CrmError("invalid_input", "Add META_DATASET_TOKEN to the environment.", 400);
  let pipelineId = current?.pipeline_id ?? null;
  if (input.pipelineId !== undefined) {
    pipelineId = typeof input.pipelineId === "string" && input.pipelineId ? input.pipelineId : null;
    if (pipelineId) {
      const pipelines = await withActor(actor, (db) => salesPipelines(db, actor.workspaceId));
      if (!pipelines.some((pipeline) => pipeline.id === pipelineId)) throw new CrmError("invalid_input", "Choose a sales pipeline.", 400, { field: "pipelineId" });
    }
  }
  const datasetChanged = datasetId !== (current?.dataset_id ?? null);
  const checkNeeded = Boolean(datasetId) && (datasetChanged || (enabled && !current?.enabled));
  if (checkNeeded && datasetId) {
    if (!metaDatasetToken()) throw new CrmError("invalid_input", "Add META_DATASET_TOKEN to the environment.", 400);
    try {
      await checkMetaDataset(datasetId, { fetchImpl: options.fetchImpl });
    } catch (error) {
      const sendOnlyToken = error instanceof MetaError && error.code === 100 && error.subcode !== 33;
      if (!sendOnlyToken) {
        if (error instanceof MetaError && error.code === 100) throw new CrmError("invalid_input", UNREACHABLE_DATASET, 400, { field: "datasetId" });
        throw new CrmError("invalid_input", error instanceof ShownError ? error.message : "Couldn't reach Meta. Try again.", 400, { field: "datasetId" });
      }
    }
  }
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.meta_outcome_settings (workspace_id, dataset_id, pipeline_id, enabled)
       values ($1, $2, $3, $4)
       on conflict (workspace_id) do update
         set dataset_id = excluded.dataset_id,
             pipeline_id = excluded.pipeline_id,
             enabled = excluded.enabled,
             last_error = case when excluded.dataset_id is distinct from crm.meta_outcome_settings.dataset_id or excluded.enabled or excluded.pipeline_id is distinct from crm.meta_outcome_settings.pipeline_id then null else crm.meta_outcome_settings.last_error end,
             last_error_at = case when excluded.dataset_id is distinct from crm.meta_outcome_settings.dataset_id or excluded.enabled or excluded.pipeline_id is distinct from crm.meta_outcome_settings.pipeline_id then null else crm.meta_outcome_settings.last_error_at end,
             alerted_at = case when excluded.dataset_id is distinct from crm.meta_outcome_settings.dataset_id or excluded.enabled or excluded.pipeline_id is distinct from crm.meta_outcome_settings.pipeline_id then null else crm.meta_outcome_settings.alerted_at end`,
      [actor.workspaceId, datasetId, pipelineId, enabled && Boolean(datasetId)],
    );
    await recordAudit(db, actor, "integration.updated", "integration", actor.workspaceId, { operation: "update_meta_outcomes", source: "web" }, {
      integration: "meta_lead_ads",
      enabled,
      datasetId,
      pipelineId,
    });
  });
}

export type MetaTrailStep = {
  name: string;
  state: "sent" | "retrying" | "waiting";
  at: string | null;
  value: number | null;
  currency: string | null;
};

type OutcomeRow = {
  lead_id: string;
  workspace_id: string;
  stage_name: string;
  position: number;
  occurred_at: Date;
  status: string;
  attempts: number;
  value: string | null;
  currency: string | null;
};

export async function metaLeadTrails(actor: Actor, leadIds: string[]): Promise<Record<string, MetaTrailStep[]>> {
  const ids = [...new Set(leadIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  if (ids.length === 0) return {};
  return withActor(actor, async (db) => {
    const rows = (
      await db.query<OutcomeRow>(
        `select lead_id, workspace_id, stage_name, "position", occurred_at, status, attempts, value, currency
         from crm.meta_lead_outcomes where lead_id = any($1::uuid[]) order by "position"`,
        [ids],
      )
    ).rows;
    const settings = (
      await db.query<{ pipeline_id: string | null; enabled: boolean }>("select pipeline_id, enabled from crm.meta_outcome_settings where workspace_id = $1", [actor.workspaceId])
    ).rows[0];
    const pipelines = await salesPipelines(db, actor.workspaceId);
    const stages = settings ? await funnelStages(db, chosenPipeline(pipelines, settings.pipeline_id)) : [];
    const trails: Record<string, MetaTrailStep[]> = {};
    for (const id of ids) {
      const mine = rows.filter((row) => row.lead_id === id);
      const here = mine.length === 0 || mine.every((row) => row.workspace_id === actor.workspaceId);
      if (mine.length === 0 && !settings?.enabled) continue;
      const slots = here
        ? [{ position: 0, name: LEAD_STAGE }, ...stages.filter((stage) => !stage.is_lost).map((stage) => ({ position: stage.position + 1, name: stage.name }))]
        : [];
      for (const row of mine) if (!slots.some((slot) => slot.position === row.position)) slots.push({ position: row.position, name: row.stage_name });
      slots.sort((a, b) => a.position - b.position);
      const lostNames = new Set(stages.filter((stage) => stage.is_lost).map((stage) => stage.name));
      const lost = mine.some((row) => lostNames.has(row.stage_name) || row.stage_name === "Lost");
      const shown = lost ? slots.filter((slot) => mine.some((row) => row.position === slot.position)) : slots;
      trails[id] = shown.map((slot): MetaTrailStep => {
        const row = mine.find((item) => item.position === slot.position);
        if (!row) return { name: slot.name, state: "waiting", at: null, value: null, currency: null };
        const state = row.status === "sent" ? "sent" : row.status === "pending" && row.attempts > 0 ? "retrying" : "waiting";
        return {
          name: row.stage_name,
          state,
          at: state === "sent" ? new Date(row.occurred_at).toISOString() : null,
          value: row.value === null ? null : Number(row.value),
          currency: row.value === null ? null : row.currency,
        };
      });
    }
    return trails;
  });
}
