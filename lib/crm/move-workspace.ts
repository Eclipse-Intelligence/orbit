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

const MOVE_SCOPES: Scope[] = ["companies:write", "contacts:write", "opportunities:write", "activities:write", "tasks:write"];

type PlanRecord = {
  id: string;
  name: string;
  targetId: string | null;
  merged: boolean;
  targetName: string | null;
  selected?: boolean;
  archived?: boolean;
};

type Plan = {
  source: WorkspaceRef;
  target: WorkspaceRef;
  copy: boolean;
  companies: PlanRecord[];
  links: PlanRecord[];
  contacts: PlanRecord[];
  deals: number;
  dealIds: string[];
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
  boardConflict: string | null;
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
  boardConflict: string | null;
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

async function moveActors(actor: Actor, workspace: unknown) {
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
  return { source: actor, target };
}

function moveFailure(error: unknown): never {
  if (error instanceof CrmError) throw error;
  if (isPgError(error)) {
    if (error.code === "P0002") throw new CrmError("not_found", error.message, 404);
    if (error.code === "22023") throw new CrmError("invalid_input", error.message, 400);
    if (error.code === "42501") throw new CrmError("forbidden", error.message, 403);
    if (error.code === "23505") throw new CrmError("conflict", "Something in the other workspace changed at the same time. Try again.", 409);
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
    moveFailure(error);
  }
}

async function visibleTasks(actor: UserActor, companyIds: string[], contactIds: string[]) {
  if (companyIds.length + contactIds.length === 0) return 0;
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.tasks
       where workspace_id = $1 and (company_id = any($2::uuid[]) or contact_id = any($3::uuid[]))`,
      [actor.workspaceId, companyIds, contactIds],
    );
    return result.rows[0]?.total ?? 0;
  });
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
  const { source, target } = await moveActors(actor, request.workspaceId);
  const input = moveInput(request);
  const plan = await runPlan(null, source, target, input, true);
  const companyIds = plan.companies.map((item) => item.id);
  const contactIds = plan.contacts.map((item) => item.id);
  const [tasks, aiFields, pipelines] = await Promise.all([
    plan.copy ? 0 : visibleTasks(source, companyIds, contactIds),
    aiFieldsLeftBehind(source, target, companyIds),
    targetPipelines(target),
  ]);
  return {
    source: plan.source,
    target: plan.target,
    copy: plan.copy,
    names: selectedNames(plan),
    contacts: plan.contacts.filter((item) => !item.selected && !item.archived).length,
    deals: plan.deals,
    dealsAvailable: plan.dealsAvailable,
    activities: plan.activities,
    tasks,
    files: plan.documents + plan.knowledge,
    companiesAlong: plan.companies.filter((item) => !item.selected).map((item) => item.name),
    merges: [...plan.companies, ...plan.contacts]
      .filter((item) => item.merged)
      .map((item) => ({ name: item.name, into: item.targetName ?? item.name })),
    links: plan.links.map((item) => ({ name: item.name, into: item.targetName ?? item.name, matched: item.merged })),
    boards: plan.copy ? [] : plan.boards,
    aiFields,
    dealStages: plan.dealStages,
    pipelines,
    pipelineId: plan.pipelineId,
    boardConflict: plan.boardConflict,
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

async function auditMove(db: Db, source: UserActor, target: UserActor, plan: Plan, fills: Map<string, GapFill>, provenance: Provenance) {
  const toWorkspace = plan.target;
  const fromWorkspace = plan.source;
  for (const [entity, records] of [
    ["company", plan.companies],
    ["contact", plan.contacts],
  ] as const) {
    for (const record of records) {
      if (!record.targetId) continue;
      const fill = fills.get(record.id);
      await recordAudit(db, source, `${entity}.moved_out`, entity, record.id, provenance, {
        name: record.name,
        toWorkspace,
        targetId: record.targetId,
        mergedInto: record.merged ? record.targetId : null,
      });
      await recordAudit(db, target, `${entity}.moved_in`, entity, record.targetId, provenance, {
        name: record.merged ? (record.targetName ?? record.name) : record.name,
        fromWorkspace,
        fromId: record.id,
        merged: record.merged,
        ...(fill ? { filled: fill.filled, tagsAdded: fill.tagsAdded, before: fill.before, after: fill.after } : {}),
      });
    }
  }
  for (const link of plan.links) {
    if (link.merged || !link.targetId) continue;
    await recordAudit(db, target, "company.moved_in", "company", link.targetId, provenance, {
      name: link.name,
      fromWorkspace,
      fromId: link.id,
      merged: false,
      copy: true,
    });
  }
}

async function auditCopy(db: Db, source: UserActor, target: UserActor, plan: Plan, fills: Map<string, GapFill>, provenance: Provenance) {
  const copiedFrom = (id: string) => ({ workspaceId: plan.source.id, workspaceName: plan.source.name, id });
  const companies = [...plan.companies, ...plan.links.filter((item) => !item.merged)];
  for (const [entity, records] of [
    ["company", companies],
    ["contact", plan.contacts],
  ] as const) {
    for (const record of records) {
      if (!record.targetId) continue;
      const fill = fills.get(record.id);
      if (record.merged) {
        if (fill && (fill.filled.length > 0 || fill.tagsAdded.length > 0)) {
          await recordAudit(db, target, `${entity}.updated`, entity, record.targetId, provenance, {
            fields: [...fill.filled, ...(fill.tagsAdded.length > 0 ? ["tags"] : [])],
            before: fill.before,
            after: fill.after,
            copiedFrom: copiedFrom(record.id),
          });
        }
      } else {
        const created = entity === "company" ? await readCompanyInDb(db, record.targetId, target.workspaceId) : await readContactInDb(db, record.targetId, target.workspaceId);
        await recordAudit(db, target, `${entity}.created`, entity, record.targetId, provenance, { after: created, copiedFrom: copiedFrom(record.id) });
      }
      if (plan.companies.includes(record) || plan.contacts.includes(record)) {
        await recordAudit(db, source, `${entity}.copied`, entity, record.id, provenance, {
          name: record.name,
          toWorkspace: plan.target,
          targetId: record.targetId,
          merged: record.merged,
        });
      }
    }
  }
  for (const id of plan.dealIds) {
    const opportunity = await readOpportunityInDb(db, id);
    if (opportunity) await recordAudit(db, target, "opportunity.created", "opportunity", id, provenance, { after: opportunity, copied: true });
  }
}

function moved(records: PlanRecord[]): MovedRecord[] {
  return records
    .filter((item): item is PlanRecord & { targetId: string } => Boolean(item.targetId))
    .map((item) => ({ id: item.id, name: item.name, targetId: item.targetId, merged: item.merged }));
}

export async function moveRecordsToWorkspace(actor: Actor, request: MoveRequest, provenance: Provenance): Promise<MoveResult> {
  const { source, target } = await moveActors(actor, request.workspaceId);
  const input = moveInput(request);
  let plan: Plan | null = null;
  return withActorAfterAppStep(
    source,
    async (db) => {
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
  );
}
