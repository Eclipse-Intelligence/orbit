import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { requireCompany } from "@/lib/crm/links";
import {
  actorIds,
  assertOwner,
  assignColumns,
  changedFields,
  constraintError,
  iso,
  isUuid,
  lockNamespace,
  pageWindow,
  recordAudit,
  replayOrRun,
  requestHash,
  type MutationOptions,
  type MutationOutcome,
} from "@/lib/crm/mutate";
import { cleanText, likePattern } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type {
  Actor,
  Opportunity,
  OpportunityListQuery,
  OpportunityStatus,
  OpportunityWrite,
  PipelineStage,
  Provenance,
} from "@/lib/crm/types";

const OPPORTUNITY_SQL = `
  select
    o.id,
    o.workspace_id,
    o.company_id,
    co.name as company_name,
    o.primary_contact_id,
    coalesce(
      nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
      ct.email,
      ct.phone
    ) as primary_contact_name,
    o.pipeline_id,
    o.stage_id,
    s.name as stage_name,
    o.name,
    o.value::text as value,
    o.currency,
    o.probability,
    o.expected_close_date::text as expected_close_date,
    o.owner_id,
    p.full_name as owner_name,
    o.status,
    o.source,
    o.created_by_user_id,
    o.created_by_agent_id,
    o.archived_at,
    o.created_at,
    o.updated_at
  from crm.opportunities o
  join crm.companies co on co.id = o.company_id
  left join crm.contacts ct on ct.id = o.primary_contact_id
  left join crm.pipeline_stages s on s.id = o.stage_id
  left join crm.profiles p on p.id = o.owner_id
`;

type OpportunityRow = {
  id: string;
  workspace_id: string;
  company_id: string;
  company_name: string | null;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  stage_name: string | null;
  name: string;
  value: string | null;
  currency: string;
  probability: number | null;
  expected_close_date: string | null;
  owner_id: string | null;
  owner_name: string | null;
  status: OpportunityStatus;
  source: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type StageRow = {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
};

type PreparedOpportunity = {
  companyId?: string;
  primaryContactId?: string | null;
  stageId?: string | null;
  name?: string;
  value?: string | null;
  currency?: string;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerId?: string | null;
  status?: OpportunityStatus;
  source?: string | null;
};

function mapStage(row: StageRow): PipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    name: row.name,
    position: row.position,
    probability: row.probability,
    isWon: row.is_won,
    isLost: row.is_lost,
  };
}

function mapOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    companyName: row.company_name,
    primaryContactId: row.primary_contact_id,
    primaryContactName: row.primary_contact_name,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    stageName: row.stage_name,
    name: row.name,
    value: row.value,
    currency: row.currency,
    probability: row.probability,
    expectedCloseDate: row.expected_close_date,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    status: row.status,
    source: row.source,
    createdByUserId: row.created_by_user_id,
    createdByAgentId: row.created_by_agent_id,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function money(value: string | number | null | undefined, field = "value") {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) {
    throw new CrmError("invalid_input", "Enter an amount with up to two decimal places.", 400, {
      field,
    });
  }
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function prepareOpportunity(
  input: OpportunityWrite,
  mode: "create" | "patch",
): PreparedOpportunity {
  const next: PreparedOpportunity = {};
  if (input.companyId !== undefined) {
    if (!input.companyId) {
      throw new CrmError("invalid_input", "Choose a company.", 400, { field: "companyId" });
    }
    next.companyId = input.companyId;
  } else if (mode === "create") {
    throw new CrmError("invalid_input", "Choose a company.", 400, { field: "companyId" });
  }
  if (input.name !== undefined) {
    const name = cleanText(input.name, 200, "name");
    if (!name) throw new CrmError("invalid_input", "Enter an opportunity name.", 400, { field: "name" });
    next.name = name;
  } else if (mode === "create") {
    throw new CrmError("invalid_input", "Enter an opportunity name.", 400, { field: "name" });
  }
  if (input.primaryContactId !== undefined) next.primaryContactId = input.primaryContactId || null;
  if (input.stageId !== undefined) {
    if (!input.stageId) {
      throw new CrmError("invalid_input", "Choose a stage.", 400, { field: "stageId" });
    }
    next.stageId = input.stageId;
  }
  if (input.value !== undefined) next.value = money(input.value);
  if (input.currency !== undefined) {
    if (!input.currency || !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
      throw new CrmError("invalid_input", "Use a three-letter currency code.", 400, {
        field: "currency",
      });
    }
    next.currency = input.currency.trim().toUpperCase();
  }
  if (input.probability !== undefined) {
    if (input.probability === null) next.probability = null;
    else if (!Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100) {
      throw new CrmError("invalid_input", "Probability must be a whole number from 0 to 100.", 400, {
        field: "probability",
      });
    } else next.probability = input.probability;
  }
  if (input.expectedCloseDate !== undefined) {
    if (input.expectedCloseDate === null || input.expectedCloseDate.trim() === "") {
      next.expectedCloseDate = null;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expectedCloseDate.trim())) {
      throw new CrmError("invalid_input", "Use a close date like 2026-10-05.", 400, {
        field: "expectedCloseDate",
      });
    } else next.expectedCloseDate = input.expectedCloseDate.trim();
  }
  if (input.ownerId !== undefined) next.ownerId = input.ownerId || null;
  if (input.status !== undefined) next.status = input.status;
  if (input.source !== undefined) next.source = cleanText(input.source, 120, "source");
  return next;
}

async function readOpportunity(db: Db, id: string) {
  const result = await db.query<OpportunityRow>(`${OPPORTUNITY_SQL} where o.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function loadStages(db: Db, workspaceId: string) {
  const result = await db.query<StageRow>(
    `select s.id, s.pipeline_id, s.name, s.position, s.probability, s.is_won, s.is_lost
     from crm.pipeline_stages s
     join crm.pipelines p on p.id = s.pipeline_id
     where s.workspace_id = $1 and p.is_default and p.archived_at is null
     order by s.position asc`,
    [workspaceId],
  );
  if (result.rows.length === 0) {
    throw new CrmError("invalid_input", "This workspace has no pipeline.", 400);
  }
  return result.rows;
}

function statusFor(stage: StageRow): OpportunityStatus {
  if (stage.is_won) return "won";
  if (stage.is_lost) return "lost";
  return "open";
}

async function assertContactCompany(
  db: Db,
  workspaceId: string,
  contactId: string | null | undefined,
  companyId: string,
) {
  if (!contactId) return;
  const result = await db.query<{ company_id: string | null }>(
    "select company_id from crm.contacts where id = $1 and workspace_id = $2",
    [contactId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Contact not found.", 404);
  if (row.company_id && row.company_id !== companyId) {
    throw new CrmError(
      "invalid_input",
      "That contact belongs to a different company.",
      400,
      { field: "primaryContactId" },
    );
  }
}

function pickStage(stages: StageRow[], status: OpportunityStatus | undefined, stageId?: string | null) {
  if (stageId) {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) throw new CrmError("not_found", "Stage not found.", 404);
    if (status && statusFor(stage) !== status) {
      throw new CrmError("invalid_input", "Status does not match that stage.", 400, {
        field: "status",
      });
    }
    return stage;
  }
  if (status === "won") {
    const stage = stages.find((item) => item.is_won);
    if (!stage) throw new CrmError("invalid_input", "This pipeline has no won stage.", 400);
    return stage;
  }
  if (status === "lost") {
    const stage = stages.find((item) => item.is_lost);
    if (!stage) throw new CrmError("invalid_input", "This pipeline has no lost stage.", 400);
    return stage;
  }
  return stages.find((item) => !item.is_won && !item.is_lost) ?? stages[0];
}

async function insertOpportunity(
  db: Db,
  actor: Actor,
  write: PreparedOpportunity,
  provenance: Provenance | undefined,
  fallbackName?: string,
) {
  const name = write.name ?? cleanText(fallbackName, 200, "name");
  if (!name) throw new CrmError("invalid_input", "Enter an opportunity name.", 400, { field: "name" });
  if (!write.companyId) {
    throw new CrmError("invalid_input", "Choose a company.", 400, { field: "companyId" });
  }
  await requireCompany(db, actor.workspaceId, write.companyId);
  await assertOwner(db, actor.workspaceId, write.ownerId);
  await assertContactCompany(db, actor.workspaceId, write.primaryContactId, write.companyId);
  const stages = await loadStages(db, actor.workspaceId);
  const stage = pickStage(stages, write.status, write.stageId);
  const status = write.status ?? statusFor(stage);
  const actorRef = actorIds(actor);
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.opportunities (
        workspace_id, company_id, primary_contact_id, pipeline_id, stage_id, name,
        value, currency, probability, expected_close_date, owner_id, status, source,
        created_by_user_id, created_by_agent_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      ) returning id`,
      [
        actor.workspaceId,
        write.companyId,
        write.primaryContactId ?? null,
        stage.pipeline_id,
        stage.id,
        name,
        write.value ?? null,
        write.currency ?? "USD",
        write.probability === undefined ? stage.probability : write.probability,
        write.expectedCloseDate ?? null,
        write.ownerId ?? null,
        status,
        write.source ?? null,
        actorRef.userId,
        actorRef.agentId,
      ],
    );
    const saved = await readOpportunity(db, inserted.rows[0].id);
    if (!saved) throw new CrmError("internal_error", "Opportunity was not saved.", 500);
    const opportunity = mapOpportunity(saved);
    await recordAudit(
      db,
      actor,
      "opportunity.created",
      "opportunity",
      opportunity.id,
      provenance,
      { after: opportunity },
    );
    return opportunity;
  } catch (error) {
    constraintError(error, "duplicate_opportunity", "A matching opportunity already exists.");
  }
}

async function applyOpportunity(
  db: Db,
  actor: Actor,
  current: OpportunityRow,
  write: PreparedOpportunity,
  provenance: Provenance | undefined,
) {
  const companyId = write.companyId ?? current.company_id;
  await requireCompany(db, actor.workspaceId, companyId);
  await assertOwner(db, actor.workspaceId, write.ownerId);
  const contactId =
    write.primaryContactId === undefined ? current.primary_contact_id : write.primaryContactId;
  await assertContactCompany(db, actor.workspaceId, contactId, companyId);

  let stage: StageRow | null = null;
  if (write.stageId || write.status === "won" || write.status === "lost" || (write.status === "open" && current.status !== "open")) {
    const stages = await loadStages(db, actor.workspaceId);
    const inPipeline = current.pipeline_id
      ? stages.filter((item) => item.pipeline_id === current.pipeline_id)
      : stages;
    const pool = inPipeline.length > 0 ? inPipeline : stages;
    stage = pickStage(pool, write.status, write.stageId);
  }
  const nextStatus = stage ? (write.status ?? statusFor(stage)) : (write.status ?? current.status);
  const stageMoved = Boolean(stage && stage.id !== current.stage_id);
  const statusMoved = nextStatus !== current.status;

  const change = assignColumns([
    [write.companyId !== undefined, "company_id", "companyId", companyId],
    [write.primaryContactId !== undefined, "primary_contact_id", "primaryContactId", contactId],
    [stageMoved, "pipeline_id", "pipelineId", stage?.pipeline_id ?? null],
    [stageMoved, "stage_id", "stageId", stage?.id ?? null],
    [stageMoved || statusMoved, "status", "status", nextStatus],
    [stageMoved && write.probability === undefined, "probability", "probability", stage?.probability ?? null],
    [write.name !== undefined, "name", "name", write.name ?? null],
    [write.value !== undefined, "value", "value", write.value ?? null],
    [write.currency !== undefined, "currency", "currency", write.currency ?? null],
    [write.probability !== undefined, "probability", "probability", write.probability ?? null],
    [
      write.expectedCloseDate !== undefined,
      "expected_close_date",
      "expectedCloseDate",
      write.expectedCloseDate ?? null,
    ],
    [write.ownerId !== undefined, "owner_id", "ownerId", write.ownerId ?? null],
    [write.source !== undefined, "source", "source", write.source ?? null],
  ]);
  const before = mapOpportunity(current);
  if (change.sets.length === 0) return { opportunity: before, changed: false };
  change.values.push(current.id);
  try {
    await db.query(
      `update crm.opportunities set ${change.sets.join(", ")} where id = $${change.values.length}`,
      change.values,
    );
  } catch (error) {
    constraintError(error, "duplicate_opportunity", "A matching opportunity already exists.");
  }
  const saved = await readOpportunity(db, current.id);
  if (!saved) throw new CrmError("not_found", "Opportunity not found.", 404);
  const opportunity = mapOpportunity(saved);
  const diff = changedFields(
    before as unknown as Record<string, unknown>,
    opportunity as unknown as Record<string, unknown>,
    change.fields,
  );
  const stageChanged = before.stageId !== opportunity.stageId || before.status !== opportunity.status;
  if (stageChanged) {
    await recordAudit(
      db,
      actor,
      "opportunity.stage_changed",
      "opportunity",
      opportunity.id,
      provenance,
      {
        before: { stageId: before.stageId, stageName: before.stageName, status: before.status },
        after: {
          stageId: opportunity.stageId,
          stageName: opportunity.stageName,
          status: opportunity.status,
        },
      },
    );
  }
  const otherFields = diff.fields.filter(
    (field) => !["stageId", "pipelineId", "status", "probability"].includes(field),
  );
  if (!stageChanged || otherFields.length > 0) {
    await recordAudit(
      db,
      actor,
      "opportunity.updated",
      "opportunity",
      opportunity.id,
      provenance,
      stageChanged ? { ...diff, fields: otherFields } : diff,
    );
  }
  return { opportunity, changed: true };
}

export async function createOpportunityInDb(
  db: Db,
  actor: Actor,
  input: OpportunityWrite,
  provenance?: Provenance,
  fallbackName?: string,
) {
  const write = prepareOpportunity(
    fallbackName && input.name === undefined ? { ...input, name: fallbackName } : input,
    "create",
  );
  await lockNamespace(db, actor.workspaceId, "opportunities");
  return insertOpportunity(db, actor, write, provenance, fallbackName);
}

export async function listPipeline(actor: Actor) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const stages = await loadStages(db, actor.workspaceId);
    return {
      id: stages[0].pipeline_id,
      name: "Default",
      stages: stages.map(mapStage),
    };
  });
}

export async function listOpportunities(actor: Actor, query: OpportunityListQuery = {}) {
  assertScope(actor.scopes, "crm:read");
  const page = pageWindow(query.limit, query.offset);
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["o.workspace_id = $1"];
    if (!query.includeArchived) where.push("o.archived_at is null");
    if (query.companyId) {
      values.push(query.companyId);
      where.push(`o.company_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`o.status = $${values.length}`);
    }
    const text = query.query?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(`(
        o.name ilike ${ref} escape '\\'
        or coalesce(co.name, '') ilike ${ref} escape '\\'
        or coalesce(s.name, '') ilike ${ref} escape '\\'
      )`);
    }
    const whereSql = where.join(" and ");
    const count = await db.query<{ total: number }>(
      `select count(*)::int as total
       from crm.opportunities o
       join crm.companies co on co.id = o.company_id
       left join crm.pipeline_stages s on s.id = o.stage_id
       where ${whereSql}`,
      values,
    );
    const listed = [...values, page.limit, page.offset];
    const rows = await db.query<OpportunityRow>(
      `${OPPORTUNITY_SQL}
       where ${whereSql}
       order by o.updated_at desc, o.id asc
       limit $${listed.length - 1} offset $${listed.length}`,
      listed,
    );
    return {
      data: rows.rows.map(mapOpportunity),
      total: count.rows[0]?.total ?? 0,
      limit: page.limit,
      offset: page.offset,
    };
  });
}

export async function getOpportunity(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Opportunity not found.", 404);
  return withActor(actor, async (db) => {
    const row = await readOpportunity(db, id);
    if (!row) throw new CrmError("not_found", "Opportunity not found.", 404);
    return mapOpportunity(row);
  });
}

export async function createOpportunity(
  actor: Actor,
  input: OpportunityWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ opportunity: Opportunity }>> {
  assertScope(actor.scopes, "opportunities:write");
  const provenance = options.provenance ?? { operation: "create_opportunity" };
  const hash = requestHash("create_opportunity", { input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 201, async () => ({
      opportunity: await createOpportunityInDb(db, actor, input, provenance),
    })),
  );
}

export async function updateOpportunity(
  actor: Actor,
  id: string,
  input: OpportunityWrite,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ opportunity: Opportunity }>> {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Opportunity not found.", 404);
  const provenance = options.provenance ?? { operation: "update_opportunity" };
  const hash = requestHash("update_opportunity", { id, input, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      await lockNamespace(db, actor.workspaceId, "opportunities");
      const current = await readOpportunity(db, id);
      if (!current) throw new CrmError("not_found", "Opportunity not found.", 404);
      const write = prepareOpportunity(input, "patch");
      const updated = await applyOpportunity(db, actor, current, write, provenance);
      return { opportunity: updated.opportunity };
    }),
  );
}

export async function archiveOpportunity(
  actor: Actor,
  id: string,
  options: MutationOptions = {},
): Promise<MutationOutcome<{ opportunity: Opportunity }>> {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Opportunity not found.", 404);
  const provenance = options.provenance ?? { operation: "archive_opportunity" };
  const hash = requestHash("archive_opportunity", { id, provenance });
  return withActor(actor, (db) =>
    replayOrRun(db, actor, options.idempotencyKey, hash, 200, async () => {
      const current = await readOpportunity(db, id);
      if (!current) throw new CrmError("not_found", "Opportunity not found.", 404);
      if (current.archived_at) return { opportunity: mapOpportunity(current) };
      await db.query("update crm.opportunities set archived_at = now() where id = $1", [id]);
      const saved = await readOpportunity(db, id);
      if (!saved) throw new CrmError("not_found", "Opportunity not found.", 404);
      const opportunity = mapOpportunity(saved);
      await recordAudit(
        db,
        actor,
        "opportunity.archived",
        "opportunity",
        opportunity.id,
        provenance,
        { before: { archivedAt: null }, after: { archivedAt: opportunity.archivedAt } },
      );
      return { opportunity };
    }),
  );
}
