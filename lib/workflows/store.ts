import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { cleanText } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { appTimeZone } from "@/lib/time";
import {
  graphProblem,
  nextNode,
  TRIGGER_NODE,
  definitionSchema,
  nextScheduleRun,
  safeDefinition,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import { executeRun, type RunEvent, type RunState } from "@/lib/workflows/engine";
import { starterTemplate } from "@/lib/workflows/templates";

export type WorkflowStatus = "draft" | "active" | "paused";

export type WorkflowSummary = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  triggerType: string;
  isTemplate: boolean;
  ownerId: string;
  ownerName: string | null;
  mine: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  updatedAt: string;
};

export type Workflow = WorkflowSummary & { definition: WorkflowDefinition };

export type RunSummary = {
  id: string;
  workflowId: string;
  status: string;
  test: boolean;
  waitingFor: string | null;
  error: string | null;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type RunStepLog = {
  id: string;
  stepId: string;
  stepType: string;
  label: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type Approval = {
  runId: string;
  workflowId: string;
  workflowName: string;
  title: string;
  details: string;
  companyId: string | null;
  companyName: string | null;
  email: { subject: string; href: string } | null;
  createdAt: string;
};

export type Notification = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  source: string | null;
  readAt: string | null;
  createdAt: string;
};

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  trigger_type: string;
  is_template: boolean;
  owner_id: string;
  owner_name: string | null;
  last_run_at: Date | null;
  last_run_status: string | null;
  run_count: number;
  updated_at: Date;
  definition: unknown;
};

const WORKFLOW_SQL = `
  select w.id, w.name, w.description, w.status, w.trigger_type, w.is_template, w.owner_id,
    coalesce(nullif(p.full_name, ''), p.email) as owner_name,
    w.last_run_at, w.updated_at, w.definition,
    (select r.status from crm.workflow_runs r where r.workflow_id = w.id and not r.test order by r.created_at desc limit 1) as last_run_status,
    (select count(*)::int from crm.workflow_runs r where r.workflow_id = w.id and not r.test and r.created_at > now() - interval '30 days') as run_count
  from crm.workflows w
  left join crm.profiles p on p.id = w.owner_id
`;

const EMPTY: WorkflowDefinition = { version: 2, trigger: { type: "manual", object: "company" }, triggerPosition: { x: 0, y: 0 }, nodes: [], edges: [] };

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function mapWorkflow(row: WorkflowRow, actor: UserActor): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    triggerType: row.trigger_type,
    isTemplate: row.is_template,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    mine: row.owner_id === actor.userId,
    lastRunAt: iso(row.last_run_at),
    lastRunStatus: row.last_run_status,
    runCount: row.run_count,
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    definition: safeDefinition(row.definition) ?? EMPTY,
  };
}

function cleanName(value: unknown) {
  const name = cleanText(typeof value === "string" ? value : "", 120, "name");
  if (!name) throw new CrmError("invalid_input", "Give the workflow a name.", 400, { field: "name" });
  return name;
}

function validate(definition: unknown) {
  const parsed = definitionSchema.safeParse(definition);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CrmError("invalid_input", `This workflow isn't valid yet${issue ? ` (${issue.path.join(".") || "steps"})` : ""}.`, 400);
  }
  const problem = graphProblem(parsed.data);
  if (problem) throw new CrmError("invalid_input", problem, 400);
  return parsed.data;
}

function nextRunFor(definition: WorkflowDefinition, status: WorkflowStatus) {
  if (status !== "active" || definition.trigger.type !== "schedule") return null;
  return nextScheduleRun(definition.trigger, new Date(), appTimeZone()).toISOString();
}

async function readWorkflow(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<WorkflowRow>(`${WORKFLOW_SQL} where w.id = $1 and w.workspace_id = $2 and w.archived_at is null`, [
      id,
      actor.workspaceId,
    ]);
    return result.rows[0] ? mapWorkflow(result.rows[0], actor) : null;
  });
}

export async function listWorkflows(actor: UserActor): Promise<{ mine: WorkflowSummary[]; templates: WorkflowSummary[] }> {
  return withActor(actor, async (db) => {
    const result = await db.query<WorkflowRow>(
      `${WORKFLOW_SQL}
       where w.workspace_id = $1 and w.archived_at is null and (w.owner_id = $2 or w.is_template)
       order by w.updated_at desc`,
      [actor.workspaceId, actor.userId],
    );
    const all = result.rows.map((row) => mapWorkflow(row, actor));
    return {
      mine: all.filter((item) => item.mine),
      templates: all.filter((item) => item.isTemplate),
    };
  });
}

export async function getWorkflow(actor: UserActor, id: string): Promise<Workflow> {
  const workflow = await readWorkflow(actor, id);
  if (!workflow) throw new CrmError("not_found", "Workflow not found.", 404);
  return workflow;
}

export async function createWorkflow(
  actor: UserActor,
  input: { name?: string; template?: string | null },
): Promise<Workflow> {
  let name = input.name?.trim() || "Untitled workflow";
  let description: string | null = null;
  let definition = EMPTY;
  let templateOf: string | null = null;
  if (input.template) {
    const starter = starterTemplate(input.template);
    if (starter) {
      name = starter.name;
      description = starter.description;
      definition = starter.definition;
    } else {
      const shared = await readWorkflow(actor, input.template);
      if (!shared || (!shared.isTemplate && !shared.mine)) throw new CrmError("not_found", "Template not found.", 404);
      name = shared.mine ? `${shared.name} (copy)` : shared.name;
      description = shared.description;
      definition = shared.definition;
      templateOf = shared.id;
    }
  }
  const created = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `insert into crm.workflows (workspace_id, owner_id, name, description, trigger_type, definition, template_of)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id`,
      [actor.workspaceId, actor.userId, cleanName(name), description, definition.trigger.type, JSON.stringify(definition), templateOf],
    );
    return result.rows[0].id;
  });
  return getWorkflow(actor, created);
}

async function requireOwn(actor: UserActor, id: string) {
  const workflow = await readWorkflow(actor, id);
  if (!workflow) throw new CrmError("not_found", "Workflow not found.", 404);
  if (!workflow.mine) throw new CrmError("forbidden", "Only the person who built this workflow can change it. Use it as a template to make your own copy.", 403);
  return workflow;
}

export async function saveWorkflow(
  actor: UserActor,
  id: string,
  input: { name?: string; description?: string | null; definition?: unknown },
): Promise<Workflow> {
  const current = await requireOwn(actor, id);
  const definition = input.definition === undefined ? current.definition : validate(input.definition);
  const name = input.name === undefined ? current.name : cleanName(input.name);
  const description = input.description === undefined ? current.description : cleanText(input.description ?? "", 2000, "description");
  await withActor(actor, (db) =>
    db.query(
      `update crm.workflows
       set name = $2, description = $3, definition = $4::jsonb, trigger_type = $5, next_run_at = $6
       where id = $1`,
      [id, name, description, JSON.stringify(definition), definition.trigger.type, nextRunFor(definition, current.status)],
    ),
  );
  return getWorkflow(actor, id);
}

export async function setWorkflowStatus(actor: UserActor, id: string, status: WorkflowStatus): Promise<Workflow> {
  const current = await requireOwn(actor, id);
  if (status === "active") {
    validate(current.definition);
    if (!nextNode(current.definition, TRIGGER_NODE, "out")) throw new CrmError("invalid_input", "Connect the trigger to a node before turning it on.", 400);
  }
  await withActor(actor, (db) =>
    db.query("update crm.workflows set status = $2, next_run_at = $3 where id = $1", [id, status, nextRunFor(current.definition, status)]),
  );
  return getWorkflow(actor, id);
}

export async function setWorkflowTemplate(actor: UserActor, id: string, isTemplate: boolean): Promise<Workflow> {
  await requireOwn(actor, id);
  await withActor(actor, (db) => db.query("update crm.workflows set is_template = $2 where id = $1", [id, isTemplate]));
  return getWorkflow(actor, id);
}

export async function discardUntouchedWorkflow(actor: UserActor, id: string) {
  if (!isUuid(id)) return false;
  const result = await withActor(actor, (db) =>
    db.query(
      `update crm.workflows w set archived_at = now(), status = 'paused', is_template = false
       where w.id = $1 and w.owner_id = $2 and w.archived_at is null and w.status <> 'active'
         and w.updated_at <= w.created_at + interval '2 seconds'
         and not exists (select 1 from crm.workflow_runs r where r.workflow_id = w.id)`,
      [id, actor.userId],
    ),
  );
  return (result.rowCount ?? 0) > 0;
}

export async function archiveWorkflow(actor: UserActor, id: string) {
  await requireOwn(actor, id);
  await withActor(actor, (db) =>
    db.query("update crm.workflows set archived_at = now(), status = 'paused', is_template = false where id = $1", [id]),
  );
}

async function testEvent(actor: UserActor, definition: WorkflowDefinition, record: { type: "company" | "contact"; id: string } | null): Promise<RunEvent> {
  const at = new Date().toISOString();
  const trigger = definition.trigger;
  if (trigger.type === "schedule" || !record) return { type: trigger.type === "schedule" ? "schedule" : "manual", at };
  const column = record.type === "company" ? "company_id" : "contact_id";
  return withActor(actor, async (db) => {
    if (trigger.type === "call_summary_ready") {
      const found = await db.query<{ activity_id: string }>(
        `select i.activity_id from crm.call_insights i
         join crm.activities a on a.id = i.activity_id and a.archived_at is null
         where i.workspace_id = $1 and i.${column} = $2 and i.status = 'ready'
         order by i.created_at desc limit 1`,
        [actor.workspaceId, record.id],
      );
      if (!found.rows[0]) throw new CrmError("invalid_input", `There's no summarised call for this ${record.type} to test with.`, 400);
      return { type: "call_summary.ready", entityType: "call_insight", data: { activityId: found.rows[0].activity_id }, at };
    }
    if (trigger.type === "activity_logged") {
      const found = await db.query<{ id: string }>(
        `select id from crm.activities where workspace_id = $1 and ${column} = $2 and archived_at is null order by occurred_at desc limit 1`,
        [actor.workspaceId, record.id],
      );
      if (!found.rows[0]) throw new CrmError("invalid_input", `There's no activity on this ${record.type} to test with.`, 400);
      return { type: "activity.created", entityType: "activity", entityId: found.rows[0].id, at };
    }
    if (trigger.type === "task_completed") {
      const found = await db.query<{ id: string }>(
        `select id from crm.tasks where workspace_id = $1 and ${column} = $2 order by coalesce(completed_at, created_at) desc limit 1`,
        [actor.workspaceId, record.id],
      );
      if (!found.rows[0]) throw new CrmError("invalid_input", `There's no task on this ${record.type} to test with.`, 400);
      return { type: "task.completed", entityType: "task", entityId: found.rows[0].id, at };
    }
    if (trigger.type === "stage_changed" || trigger.type === "added_to_board") {
      const pipeline = trigger.type === "added_to_board" ? trigger.boardId : (trigger.pipelineId ?? null);
      const found = await db.query<{ id: string }>(
        `select o.id from crm.opportunities o
         join crm.pipelines p on p.id = o.pipeline_id
         where o.workspace_id = $1 and o.company_id = $2 and o.archived_at is null
           and (case when $3::uuid is null then p.kind = 'sales' else o.pipeline_id = $3::uuid end)
         order by o.updated_at desc limit 1`,
        [actor.workspaceId, record.type === "company" ? record.id : null, pipeline],
      );
      if (!found.rows[0]) throw new CrmError("invalid_input", "There's no matching deal or card for this company to test with.", 400);
      return { type: "opportunity.stage_changed", entityType: "opportunity", entityId: found.rows[0].id, at };
    }
    if (trigger.type === "field_changed") {
      return {
        type: `${record.type}.updated`,
        entityType: record.type,
        entityId: record.id,
        data: { fields: [trigger.field], before: {}, after: { [trigger.field]: trigger.to ?? null } },
        at,
      };
    }
    return { type: "manual", entityType: record.type, entityId: record.id, at };
  });
}

export async function startRun(
  actor: UserActor,
  workflowId: string,
  options: { test: boolean; record?: { type: "company" | "contact"; id: string } | null; fetchImpl?: typeof fetch; deadline?: number },
): Promise<{ runId: string; status: string }> {
  const workflow = await readWorkflow(actor, workflowId);
  if (!workflow) throw new CrmError("not_found", "Workflow not found.", 404);
  if (!workflow.mine) throw new CrmError("forbidden", "Use this template to make your own copy first.", 403);
  if (!options.test && workflow.definition.trigger.type !== "manual") {
    throw new CrmError("invalid_input", "Only workflows that run from a record can be started by hand.", 400);
  }
  if (!options.test && workflow.status !== "active") throw new CrmError("invalid_input", "Turn the workflow on first.", 400);
  if (options.record && !isUuid(options.record.id)) throw new CrmError("not_found", "Record not found.", 404);
  const event = options.test
    ? await testEvent(actor, workflow.definition, options.record ?? null)
    : { type: "manual", entityType: options.record?.type, entityId: options.record?.id ?? null, at: new Date().toISOString(), actorUserId: actor.userId };
  const runId = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, status, test, definition, event, claimed_at, started_at)
       values ($1, $2, $3, 'running', $4, $5::jsonb, $6::jsonb, now(), now()) returning id`,
      [actor.workspaceId, workflow.id, actor.userId, options.test, JSON.stringify(workflow.definition), JSON.stringify(event)],
    );
    return result.rows[0].id;
  });
  const status = await executeRun(runId, actor.userId, actor.workspaceId, { deadline: Math.min(Date.now() + 50_000, options.deadline ?? Infinity), fetchImpl: options.fetchImpl });
  return { runId, status };
}

type RunRow = {
  id: string;
  workflow_id: string;
  status: string;
  test: boolean;
  waiting_for: string | null;
  error: string | null;
  company_id: string | null;
  company_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  created_at: Date;
  finished_at: Date | null;
};

const RUN_SQL = `
  select r.id, r.workflow_id, r.status, r.test, r.waiting_for, r.error, r.company_id, co.name as company_name,
    r.contact_id, nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), '') as contact_name, r.created_at, r.finished_at
  from crm.workflow_runs r
  left join crm.companies co on co.id = r.company_id
  left join crm.contacts ct on ct.id = r.contact_id
`;

function mapRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    test: row.test,
    waitingFor: row.waiting_for,
    error: row.error,
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    createdAt: iso(row.created_at) ?? "",
    finishedAt: iso(row.finished_at),
  };
}

export async function listRuns(actor: UserActor, workflowId: string, limit = 25): Promise<RunSummary[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<RunRow>(`${RUN_SQL} where r.workflow_id = $1 order by r.created_at desc limit $2`, [workflowId, limit]);
    return result.rows.map(mapRun);
  });
}

export async function getRunSteps(actor: UserActor, runId: string): Promise<{ run: RunSummary; steps: RunStepLog[] }> {
  if (!isUuid(runId)) throw new CrmError("not_found", "Run not found.", 404);
  return withActor(actor, async (db) => {
    const run = await db.query<RunRow>(`${RUN_SQL} where r.id = $1`, [runId]);
    if (!run.rows[0]) throw new CrmError("not_found", "Run not found.", 404);
    const steps = await db.query<{
      id: string;
      step_id: string;
      step_type: string;
      label: string | null;
      status: string;
      input: unknown;
      output: unknown;
      error: string | null;
      started_at: Date;
      finished_at: Date | null;
    }>("select * from crm.workflow_run_steps where run_id = $1 order by started_at, finished_at", [runId]);
    return {
      run: mapRun(run.rows[0]),
      steps: steps.rows.map((row) => ({
        id: row.id,
        stepId: row.step_id,
        stepType: row.step_type,
        label: row.label,
        status: row.status,
        input: row.input,
        output: row.output,
        error: row.error,
        startedAt: iso(row.started_at) ?? "",
        finishedAt: iso(row.finished_at),
      })),
    };
  });
}

export function approvalEmail(state: RunState | null | undefined) {
  const email = (state?.vars as { email?: { subject?: unknown; url?: unknown } } | undefined)?.email;
  if (!email || typeof email.url !== "string" || !email.url) return null;
  let href = email.url;
  try {
    const parsed = new URL(email.url, "http://orbit.local");
    href = `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
  if (!href.startsWith("/mail")) return null;
  return { subject: typeof email.subject === "string" && email.subject.trim() ? email.subject.trim() : "the email", href };
}

export async function listApprovals(actor: UserActor): Promise<Approval[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      workflow_id: string;
      workflow_name: string;
      state: RunState;
      company_id: string | null;
      company_name: string | null;
      updated_at: Date;
    }>(
      `select r.id, r.workflow_id, w.name as workflow_name, r.state, r.company_id, co.name as company_name, r.updated_at
       from crm.workflow_runs r
       join crm.workflows w on w.id = r.workflow_id
       left join crm.companies co on co.id = r.company_id
       where r.workspace_id = $1 and r.owner_id = $2 and r.status = 'waiting' and r.waiting_for = 'approval'
       order by r.updated_at`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows.map((row) => ({
      runId: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      title: row.state.approval?.title ?? "Approve this step",
      details: row.state.approval?.details ?? "",
      companyId: row.company_id,
      companyName: row.company_name,
      email: approvalEmail(row.state),
      createdAt: iso(row.updated_at) ?? "",
    }));
  });
}

export async function decideApproval(
  actor: UserActor,
  runId: string,
  input: { approved: boolean; note?: string | null },
  options: { fetchImpl?: typeof fetch } = {},
) {
  if (!isUuid(runId)) throw new CrmError("not_found", "Approval not found.", 404);
  const claimed = await withActor(actor, async (db) => {
    const result = await db.query<{ state: RunState }>(
      `select state from crm.workflow_runs
       where id = $1 and owner_id = $2 and status = 'waiting' and waiting_for = 'approval'
       for update`,
      [runId, actor.userId],
    );
    const row = result.rows[0];
    if (!row?.state.waitingStep) return false;
    const state: RunState = {
      ...row.state,
      decisions: {
        ...(row.state.decisions ?? {}),
        [row.state.waitingStep]: { approved: input.approved, note: input.note?.trim().slice(0, 1000) || null, by: actor.userId },
      },
    };
    await db.query(
      `update crm.workflow_runs set state = $2::jsonb, status = 'running', waiting_for = null, claimed_at = now() where id = $1`,
      [runId, JSON.stringify(state)],
    );
    await db.query(
      `update crm.notifications set read_at = now()
       where user_id = $1 and source = 'workflow_approval' and href = $2 and read_at is null`,
      [actor.userId, `/workflows?approve=${runId}`],
    );
    return true;
  });
  if (!claimed) throw new CrmError("conflict", "This approval has already been dealt with.", 409);
  return executeRun(runId, actor.userId, actor.workspaceId, { deadline: Date.now() + 50_000, fetchImpl: options.fetchImpl });
}

export async function listNotifications(actor: UserActor, limit = 20): Promise<Notification[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      title: string;
      body: string | null;
      href: string | null;
      source: string | null;
      read_at: Date | null;
      created_at: Date;
    }>(
      `select id, title, body, href, source, read_at, created_at from crm.notifications
       where workspace_id = $1 and user_id = $2 and created_at > now() - interval '30 days'
       order by created_at desc limit $3`,
      [actor.workspaceId, actor.userId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      href: row.href,
      source: row.source,
      readAt: iso(row.read_at),
      createdAt: iso(row.created_at) ?? "",
    }));
  });
}

export async function markNotificationsRead(actor: UserActor, ids?: string[]) {
  await withActor(actor, (db) =>
    db.query(
      `update crm.notifications set read_at = now()
       where workspace_id = $1 and user_id = $2 and read_at is null and ($3::uuid[] is null or id = any($3::uuid[]))`,
      [actor.workspaceId, actor.userId, ids && ids.length ? ids.filter((id) => isUuid(id)) : null],
    ),
  );
}

export async function manualWorkflows(actor: UserActor, object: "company" | "contact") {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string }>(
      `select id, name from crm.workflows
       where workspace_id = $1 and owner_id = $2 and status = 'active' and archived_at is null
         and trigger_type = 'manual' and definition->'trigger'->>'object' = $3
       order by name`,
      [actor.workspaceId, actor.userId, object],
    );
    return result.rows;
  });
}

export async function countApprovals(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.workflow_runs
       where workspace_id = $1 and owner_id = $2 and status = 'waiting' and waiting_for = 'approval'`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0]?.total ?? 0;
  });
}
