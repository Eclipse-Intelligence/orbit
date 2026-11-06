import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { readCompanyInDb } from "@/lib/crm/companies";
import { readContactInDb } from "@/lib/crm/contacts";
import { withActor, withActorAfterAppStep } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { fillCompanyGaps, fillContactGaps, type GapFill } from "@/lib/crm/merge";
import { isUuid, lockNamespace, recordAudit } from "@/lib/crm/mutate";
import { readOpportunityInDb } from "@/lib/crm/opportunities";
import { assertScope, type Scope } from "@/lib/crm/scopes";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import { workspaceActors, type WorkspaceRef } from "@/lib/crm/workspaces";

export const MOVE_LIMIT = 100;

export const MOVE_TOO_LONG = "That took too long. Move fewer records at a time.";

const MOVE_TIMEOUT = "60s";

const MOVE_SCOPES: Scope[] = ["companies:write", "contacts:write", "opportunities:write", "activities:write", "tasks:write"];

type PlanDeal = { id: string; targetId: string; name: string; stage: string | null };

type PlanRecord = {
  id: string;
  name: string;
  targetId: string | null;
  merged: boolean;
  targetName: string | null;
  selected?: boolean;
  archived?: boolean;
  deals?: PlanDeal[];
  boardCards?: number;
};

type Plan = {
  source: WorkspaceRef;
  target: WorkspaceRef;
  copy: boolean;
  companies: PlanRecord[];
  links: PlanRecord[];
  contacts: PlanRecord[];
  deals: number;
  dealsAvailable: number;
  dealStages: string[];
  boardCards: number;
  boards: string[];
  activities: number;
  tasks: number;
  documents: number;
  knowledge: number;
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKind: string | null;
  stageName: string | null;
  boardConflict: string | null;
  canMove: boolean;
};

export type MoveRequest = {
  companyIds?: unknown;
  contactIds?: unknown;
  workspaceId?: unknown;
  copy?: unknown;
  copyDeals?: unknown;
  pipelineId?: unknown;
  stageId?: unknown;
};

type MoveInput = {
  companyIds: string[];
  contactIds: string[];
  copy: boolean;
  copyDeals: boolean;
  pipelineId: string | null;
  stageId: string | null;
};

export type MovePipeline = { id: string; name: string; kind: string; isDefault: boolean; stages: { id: string; name: string }[] };

export type MovePreview = {
  source: WorkspaceRef;
  target: WorkspaceRef;
  copy: boolean;
  names: string[];
  contacts: number;
  deals: number;
  dealsAvailable: number;
  activities: number;
  tasks: number;
  files: number;
  companiesAlong: string[];
  merges: { name: string; into: string }[];
  links: { name: string; into: string; matched: boolean }[];
  boards: string[];
  aiFields: string[];
  dealStages: string[];
  pipelines: MovePipeline[];
  pipelineId: string | null;
  pipelineName: string | null;
  pipelineKind: string | null;
  stageName: string | null;
  boardConflict: string | null;
  canMove: boolean;
};

export type MovedRecord = { id: string; name: string; targetId: string; merged: boolean };

export type MoveResult = {
  copy: boolean;
  source: WorkspaceRef;
  target: WorkspaceRef;
  companies: MovedRecord[];
  contacts: MovedRecord[];
  deals: number;
  activities: number;
  tasks: number;
  message: string;
};

function idList(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CrmError("invalid_input", `${label} must be a list of ids.`, 400);
  const ids = [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")))];
  if (ids.some((id) => !isUuid(id))) throw new CrmError("not_found", `Some of these ${label.toLowerCase()} weren't found.`, 404);
  return ids;
}

function optionalId(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value.trim())) throw new CrmError("invalid_input", "Pick a board and stage from the list.", 400, { field });
  return value.trim();
}

function moveInput(request: MoveRequest): MoveInput {
  const companyIds = idList(request.companyIds, "Companies");
  const contactIds = idList(request.contactIds, "People");
  if (companyIds.length + contactIds.length === 0) throw new CrmError("invalid_input", "Pick a company or contact to move.", 400);
  if (companyIds.length + contactIds.length > MOVE_LIMIT) throw new CrmError("invalid_input", `Move up to ${MOVE_LIMIT} records at a time.`, 400);
  return {
    companyIds,
    contactIds,
    copy: request.copy === true,
    copyDeals: request.copyDeals === true,
    pipelineId: optionalId(request.pipelineId, "pipelineId"),
    stageId: optionalId(request.stageId, "stageId"),
  };
}

function findWorkspace(actors: UserActor[], wanted: string) {
  const plain = wanted.trim().toLowerCase();
  const exact = actors.find((item) => item.workspaceId === wanted.trim() || item.workspaceName.trim().toLowerCase() === plain);
  if (exact) return exact;
  const partial = actors.filter((item) => item.workspaceName.toLowerCase().includes(plain));
  return partial.length === 1 ? partial[0] : null;
}

export async function moveTargetNamed(actor: Actor, value: string): Promise<WorkspaceRef | null> {
  if (actor.type !== "user" || !value.trim()) return null;
  const others = (await workspaceActors(actor)).filter((item) => item.workspaceId !== actor.workspaceId);
  const found = findWorkspace(others, value);
  return found ? { id: found.workspaceId, name: found.workspaceName } : null;
}

export async function moveTargets(actor: Actor): Promise<WorkspaceRef[]> {
  if (actor.type !== "user") return [];
  const actors = await workspaceActors(actor);
  if (actors.length < 2) return [];
  return actors.filter((item) => item.workspaceId !== actor.workspaceId).map((item) => ({ id: item.workspaceId, name: item.workspaceName }));
}

function canMoveOut(actor: UserActor) {
  return actor.role === "owner" || actor.role === "admin";
}

export function moveNeedsAdmin(workspaceName: string) {
  return `Only an owner or admin of ${workspaceName} can move records out of it. You can copy them instead.`;
}

async function moveActors(actor: Actor, workspace: unknown, options: { moving: boolean }) {
  if (actor.type !== "user") throw new CrmError("forbidden", "Only a person can move records between workspaces.", 403);
  const actors = await workspaceActors(actor);
  if (actors.length < 2) throw new CrmError("forbidden", "You're only in one workspace.", 403);
  const wanted = typeof workspace === "string" ? workspace.trim() : "";
  if (!wanted) throw new CrmError("invalid_input", "Pick a workspace.", 400, { field: "workspaceId" });
  const target = findWorkspace(actors, wanted);
  if (!target) {
    throw new CrmError(
      "forbidden",
      `You're not in a workspace called ${wanted.slice(0, 80)}. Your workspaces are ${actors.map((item) => item.workspaceName).join(", ")}.`,
      403,
      { field: "workspaceId" },
    );
  }
  if (target.workspaceId === actor.workspaceId) throw new CrmError("invalid_input", "Pick another workspace.", 400, { field: "workspaceId" });
  for (const scope of MOVE_SCOPES) {
    assertScope(actor.scopes, scope);
    assertScope(target.scopes, scope);
  }
  const current = actors.find((item) => item.workspaceId === actor.workspaceId) ?? actor;
  if (options.moving && !canMoveOut(current)) throw new CrmError("forbidden", moveNeedsAdmin(actor.workspaceName), 403);
  return { source: actor, target };
}

export function moveFailure(error: unknown, targetName: string): never {
  if (error instanceof CrmError) throw error;
  if (isPgError(error)) {
    if (error.code === "P0002") throw new CrmError("not_found", error.message, 404);
    if (error.code === "22023") throw new CrmError("invalid_input", error.message, 400);
    if (error.code === "42501") throw new CrmError("forbidden", error.message, 403);
    if (error.code === "57014" || error.code === "40P01") throw new CrmError("timeout", MOVE_TOO_LONG, 503);
    if (error.code === "23505") {
      throw new CrmError(
        "conflict",
        `${targetName} already has a record with the same domain, email, LinkedIn or name that Orbit didn't match. Merge or archive it in ${targetName}, then try again.`,
        409,
      );
    }
  }
  throw error;
}

async function runPlan(db: Db | null, source: UserActor, target: UserActor, input: MoveInput, dryRun: boolean) {
  const text = "select private.move_records_to_workspace($1, $2, $3, $4::jsonb, $5) as plan";
  const values = [source.userId, source.workspaceId, target.workspaceId, JSON.stringify(input), dryRun];
  try {
    const result = db ? await db.query<{ plan: Plan }>(text, values) : await query<{ plan: Plan }>(text, values);
    return result.rows[0].plan;
  } catch (error) {
    moveFailure(error, target.workspaceName);
  }
}

async function aiFieldsLeftBehind(source: UserActor, target: UserActor, companyIds: string[]) {
  if (companyIds.length === 0) return [];
  return withActor(source, async (db) => {
    const result = await db.query<{ label: string }>(
      `select distinct f.label from crm.ai_fields f
       join crm.ai_field_answers a on a.field_id = f.id
       where f.workspace_id = $1 and a.company_id = any($2::uuid[])
         and not exists (select 1 from crm.ai_fields t where t.workspace_id = $3 and lower(btrim(t.label)) = lower(btrim(f.label)))
       order by f.label`,
      [source.workspaceId, companyIds, target.workspaceId],
    );
    return result.rows.map((row) => row.label);
  });
}

async function targetPipelines(target: UserActor): Promise<MovePipeline[]> {
  return withActor(target, async (db) => {
    const result = await db.query<{ id: string; name: string; kind: string; is_default: boolean; stages: { id: string; name: string }[] }>(
      `select p.id, p.name, p.kind, p.is_default,
         coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name) order by s.position)
                   from crm.pipeline_stages s where s.pipeline_id = p.id), '[]'::json) as stages
       from crm.pipelines p
       where p.workspace_id = $1 and p.archived_at is null
       order by p.is_default desc, (p.kind = 'sales') desc, p.position, p.created_at`,
      [target.workspaceId],
    );
    return result.rows
      .filter((row) => row.stages.length > 0)
      .map((row) => ({ id: row.id, name: row.name, kind: row.kind, isDefault: row.is_default, stages: row.stages }));
  });
}

function selectedNames(plan: Plan) {
  return [...plan.companies.filter((item) => item.selected), ...plan.contacts.filter((item) => item.selected)].map((item) => item.name);
}

export async function previewMoveToWorkspace(actor: Actor, request: MoveRequest): Promise<MovePreview> {
  const { source, target } = await moveActors(actor, request.workspaceId, { moving: false });
  const input = moveInput(request);
  const plan = await runPlan(null, source, target, input, true);
  const companyIds = plan.companies.map((item) => item.id);
  const [aiFields, pipelines] = await Promise.all([aiFieldsLeftBehind(source, target, companyIds), targetPipelines(target)]);
  return {
    source: plan.source,
    target: plan.target,
    copy: plan.copy,
    names: selectedNames(plan),
    contacts: plan.contacts.filter((item) => !item.selected && !item.archived).length,
    deals: plan.deals,
    dealsAvailable: plan.dealsAvailable,
    activities: plan.activities,
    tasks: plan.tasks,
    files: plan.documents + plan.knowledge,
    companiesAlong: plan.companies.filter((item) => !item.selected).map((item) => item.name),
    merges: [...plan.companies, ...plan.contacts]
      .filter((item) => item.merged && !item.archived)
      .map((item) => ({ name: item.name, into: item.targetName ?? item.name })),
    links: plan.links.map((item) => ({ name: item.name, into: item.targetName ?? item.name, matched: item.merged })),
    boards: plan.copy ? [] : plan.boards,
    aiFields,
    dealStages: plan.dealStages,
    pipelines,
    pipelineId: plan.pipelineId,
    pipelineName: plan.pipelineName,
    pipelineKind: plan.pipelineKind,
    stageName: plan.stageName,
    boardConflict: plan.boardConflict,
    canMove: plan.canMove,
  };
}

function lockKeys(...workspaceIds: string[]) {
  return workspaceIds.flatMap((id) => [`${id}:companies`, `${id}:contacts`]).sort();
}

function counted(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

function resultMessage(plan: Plan) {
  const names = selectedNames(plan);
  const what = names.length === 1 ? names[0] : counted(names.length, "record", "records");
  return `${plan.copy ? "Copied" : "Moved"} ${what} to ${plan.target.name}.`;
}

type CopiedFrom = { workspaceId: string; workspaceName: string; id: string };

function copiedFrom(plan: Plan, id: string): CopiedFrom {
  return { workspaceId: plan.source.id, workspaceName: plan.source.name, id };
}

async function auditCreated(db: Db, target: UserActor, entity: "company" | "contact", id: string, from: CopiedFrom, provenance: Provenance) {
  const created = entity === "company" ? await readCompanyInDb(db, id, target.workspaceId) : await readContactInDb(db, id, target.workspaceId);
  await recordAudit(db, target, `${entity}.created`, entity, id, provenance, { after: created, copiedFrom: from });
}

async function auditFilled(db: Db, target: UserActor, entity: "company" | "contact", id: string, fill: GapFill | undefined, from: CopiedFrom, provenance: Provenance) {
  if (!fill || (fill.filled.length === 0 && fill.tagsAdded.length === 0)) return;
  await recordAudit(db, target, `${entity}.updated`, entity, id, provenance, {
    fields: [...fill.filled, ...(fill.tagsAdded.length > 0 ? ["tags"] : [])],
    before: fill.before,
    after: fill.after,
    copiedFrom: from,
  });
}

async function auditLinks(db: Db, source: UserActor, target: UserActor, plan: Plan, fills: Map<string, GapFill>, provenance: Provenance) {
  for (const link of plan.links) {
    if (!link.targetId) continue;
    const from = copiedFrom(plan, link.id);
    if (link.merged) {
      await auditFilled(db, target, "company", link.targetId, fills.get(link.id), from, provenance);
      continue;
    }
    await auditCreated(db, target, "company", link.targetId, from, provenance);
    await recordAudit(db, source, "company.copied", "company", link.id, provenance, {
      name: link.name,
      toWorkspace: plan.target,
      targetId: link.targetId,
      merged: false,
    });
  }
}

function dealDetails(record: PlanRecord) {
  return record.deals ?? [];
}

async function auditMove(db: Db, source: UserActor, target: UserActor, plan: Plan, fills: Map<string, GapFill>, provenance: Provenance) {
  for (const [entity, records] of [
    ["company", plan.companies],
    ["contact", plan.contacts],
  ] as const) {
    for (const record of records) {
      if (!record.targetId) continue;
      const fill = fills.get(record.id);
      const deals = entity === "company" ? { deals: dealDetails(record), boardCardsRemoved: record.boardCards ?? 0 } : {};
      await recordAudit(db, source, `${entity}.moved_out`, entity, record.id, provenance, {
        name: record.name,
        toWorkspace: plan.target,
        targetId: record.targetId,
        mergedInto: record.merged ? record.targetId : null,
        ...deals,
      });
      await recordAudit(db, target, `${entity}.moved_in`, entity, record.targetId, provenance, {
        name: record.merged ? (record.targetName ?? record.name) : record.name,
        fromWorkspace: plan.source,
        fromId: record.id,
        merged: record.merged,
        ...deals,
        ...(fill ? { filled: fill.filled, tagsAdded: fill.tagsAdded, before: fill.before, after: fill.after } : {}),
      });
    }
  }
  await auditLinks(db, source, target, plan, fills, provenance);
}

async function auditCopy(db: Db, source: UserActor, target: UserActor, plan: Plan, fills: Map<string, GapFill>, provenance: Provenance) {
  for (const [entity, records] of [
    ["company", plan.companies],
    ["contact", plan.contacts],
  ] as const) {
    for (const record of records) {
      if (!record.targetId) continue;
      const from = copiedFrom(plan, record.id);
      if (record.merged) await auditFilled(db, target, entity, record.targetId, fills.get(record.id), from, provenance);
      else await auditCreated(db, target, entity, record.targetId, from, provenance);
      await recordAudit(db, source, `${entity}.copied`, entity, record.id, provenance, {
        name: record.name,
        toWorkspace: plan.target,
        targetId: record.targetId,
        merged: record.merged,
        ...(entity === "company" ? { deals: dealDetails(record) } : {}),
      });
    }
  }
  await auditLinks(db, source, target, plan, fills, provenance);
  for (const company of plan.companies) {
    for (const deal of dealDetails(company)) {
      const opportunity = await readOpportunityInDb(db, deal.targetId);
      if (!opportunity) continue;
      await recordAudit(db, target, "opportunity.created", "opportunity", deal.targetId, provenance, {
        after: opportunity,
        copiedFrom: copiedFrom(plan, deal.id),
      });
    }
  }
}

function moved(records: PlanRecord[]): MovedRecord[] {
  return records
    .filter((item): item is PlanRecord & { targetId: string } => Boolean(item.targetId))
    .map((item) => ({ id: item.id, name: item.name, targetId: item.targetId, merged: item.merged }));
}

export async function moveRecordsToWorkspace(actor: Actor, request: MoveRequest, provenance: Provenance): Promise<MoveResult> {
  const { source, target } = await moveActors(actor, request.workspaceId, { moving: request.copy !== true });
  const input = moveInput(request);
  let plan: Plan | null = null;
  return withActorAfterAppStep(
    source,
    async (db) => {
      await db.query(`set local statement_timeout = '${MOVE_TIMEOUT}'`);
      for (const key of lockKeys(source.workspaceId, target.workspaceId)) {
        const [workspaceId, name] = key.split(":");
        await lockNamespace(db, workspaceId, name);
      }
      plan = await runPlan(db, source, target, input, false);
    },
    async (db) => {
      const done = plan as Plan | null;
      if (!done) throw new CrmError("internal_error", "The move didn't run.", 500);
      const fills = new Map<string, GapFill>();
      const fromSource = done.copy ? { fromWorkspaceId: source.workspaceId } : {};
      for (const company of done.companies) {
        if (!company.merged || !company.targetId) continue;
        fills.set(company.id, await fillCompanyGaps(db, target.workspaceId, company.targetId, company.id, { ...fromSource, skip: done.copy ? ["health"] : [] }));
      }
      for (const link of done.links) {
        if (!link.merged || !link.targetId) continue;
        fills.set(link.id, await fillCompanyGaps(db, target.workspaceId, link.targetId, link.id, { fromWorkspaceId: source.workspaceId, skip: ["health"] }));
      }
      for (const contact of done.contacts) {
        if (!contact.merged || !contact.targetId) continue;
        fills.set(contact.id, await fillContactGaps(db, target.workspaceId, contact.targetId, contact.id, { ...fromSource, skip: done.copy ? ["companyId"] : [] }));
      }
      if (done.copy) await auditCopy(db, source, target, done, fills, provenance);
      else await auditMove(db, source, target, done, fills, provenance);
      return {
        copy: done.copy,
        source: done.source,
        target: done.target,
        companies: moved(done.companies),
        contacts: moved(done.contacts),
        deals: done.deals,
        activities: done.activities,
        tasks: done.tasks,
        message: resultMessage(done),
      };
    },
  ).catch((error: unknown) => moveFailure(error, target.workspaceName));
}
