import { z } from "zod";
import { membershipsFor } from "@/lib/auth/user";
import { createActivity, getActivity } from "@/lib/crm/activities";
import { getInsightTranscript, getInsightsForActivities } from "@/lib/crm/call-insights";
import { createTaskWithClickUp, getClickUpPicker } from "@/lib/crm/clickup";
import { getCompany, updateCompany } from "@/lib/crm/companies";
import { getContact, updateContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { sendContactEmail } from "@/lib/crm/inbox";
import { isUuid } from "@/lib/crm/mutate";
import { createOpportunity, getOpportunity, listOpportunities, updateOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { getTask } from "@/lib/crm/tasks";
import type { Company, CompanyWrite, Contact, ContactWrite, Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { createLinearIssue, LinearError } from "@/lib/linear";
import { completeJson, LlmError } from "@/lib/llm";
import { siteOrigin } from "@/lib/site-url";
import { appTimeZone } from "@/lib/time";
import {
  nextScheduleRun,
  safeDefinition,
  type Step,
  type Trigger,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import { conditionsPass, display, render, resolve, type Vars } from "@/lib/workflows/variables";

type Cursor = (number | string)[];

type LoopState = { items: unknown[]; index: number };

export type RunState = {
  started?: boolean;
  cursor?: Cursor;
  vars?: Vars;
  loops?: Record<string, LoopState>;
  waitingStep?: string | null;
  decisions?: Record<string, { approved: boolean; note: string | null; by: string | null }>;
  approval?: { stepId: string; title: string; details: string } | null;
};

type RunRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  owner_id: string;
  status: string;
  test: boolean;
  definition: unknown;
  event: RunEvent;
  state: RunState;
  depth: number;
};

export type RunEvent = {
  type: string;
  entityType?: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  actorUserId?: string | null;
  at?: string;
};

type StepResult =
  | { kind: "next"; output?: unknown }
  | { kind: "branch"; branch: "then" | "else"; output?: unknown }
  | { kind: "loop"; items: unknown[]; output?: unknown }
  | { kind: "wait"; until: Date; output?: unknown }
  | { kind: "approval"; title: string; details: string }
  | { kind: "stop"; output?: unknown };

type Ctx = {
  actor: UserActor;
  run: RunRow;
  vars: Vars;
  fetchImpl?: typeof fetch;
  deadline: number;
};

export type TickOptions = { budgetMs?: number; fetchImpl?: typeof fetch; limit?: number };

const DEFAULT_BUDGET_MS = 45_000;
const STEP_RESERVE_MS = 8_000;
const MAX_STEPS_PER_RUN = 200;
const TRANSCRIPT_LIMIT = 60_000;

export async function ownerActor(ownerId: string, workspaceId: string): Promise<UserActor | null> {
  const membership = (await membershipsFor(ownerId)).find((item) => item.workspace_id === workspaceId);
  if (!membership) return null;
  return {
    type: "user",
    userId: ownerId,
    email: membership.email ?? "",
    fullName: membership.full_name,
    workspaceId,
    workspaceName: membership.workspace_name,
    role: membership.role,
    scopes: scopesForRole(membership.role),
  };
}

function link(path: string) {
  const origin = siteOrigin();
  return origin ? `${origin}${path}` : path;
}

function companyVars(company: Company) {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    lifecycle: company.lifecycle,
    industry: company.industry,
    ownerId: company.ownerId,
    ownerName: company.ownerName,
    tags: company.tags,
    url: link(companyHref(company.id)),
  };
}

function contactVars(contact: Contact) {
  return {
    id: contact.id,
    name: contact.name,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    jobTitle: contact.jobTitle,
    ownerId: contact.ownerId,
    url: link(contactHref(contact.id)),
  };
}

async function maybe<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof CrmError && (error.code === "not_found" || error.code === "forbidden")) return null;
    throw error;
  }
}

function londonToday() {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: appTimeZone() }).format(new Date());
}

export async function buildContext(actor: UserActor, trigger: Trigger, event: RunEvent): Promise<{ vars: Vars; matches: boolean }> {
  const data = event.data ?? {};
  const vars: Vars = {
    trigger: { type: event.type, at: event.at ?? new Date().toISOString() },
    owner: { id: actor.userId, name: actor.fullName || actor.email, email: actor.email },
    today: londonToday(),
    steps: {},
  };
  let companyId: string | null = null;
  let contactId: string | null = null;
  let matches = true;
  if ("mine" in trigger && trigger.mine && event.actorUserId && event.actorUserId !== actor.userId) {
    return { vars, matches: false };
  }

  if (trigger.type === "call_summary_ready") {
    const activityId = typeof data.activityId === "string" ? data.activityId : null;
    const activity = activityId ? await maybe(() => getActivity(actor, activityId)) : null;
    if (!activity) return { vars, matches: false };
    const insight = (await getInsightsForActivities(actor, [activity.id]))[activity.id];
    const transcript = insight ? await maybe(() => getInsightTranscript(actor, insight.id)) : null;
    vars.activity = { id: activity.id, type: activity.type, title: activity.title, body: activity.body, occurredAt: activity.occurredAt };
    vars.call = {
      summary: insight?.summary ?? null,
      keyPoints: insight?.keyPoints ?? [],
      actionItems: (insight?.actionItems ?? []).map((item) => item.title),
      transcript: transcript ? transcript.slice(0, TRANSCRIPT_LIMIT) : null,
      source: insight?.source ?? null,
    };
    companyId = activity.companyId;
    contactId = activity.contactId;
  } else if (trigger.type === "record_created" || trigger.type === "manual") {
    if (event.entityType !== trigger.object) return { vars, matches: false };
    if (trigger.object === "company") companyId = event.entityId ?? null;
    else contactId = event.entityId ?? null;
  } else if (trigger.type === "field_changed") {
    if (event.entityType !== trigger.object) return { vars, matches: false };
    const fields = Array.isArray(data.fields) ? (data.fields as string[]) : [];
    if (!fields.includes(trigger.field)) return { vars, matches: false };
    const before = (data.before ?? {}) as Record<string, unknown>;
    const afterValues = (data.after ?? {}) as Record<string, unknown>;
    vars.change = { field: trigger.field, from: before[trigger.field] ?? null, to: afterValues[trigger.field] ?? null };
    if (trigger.to && display(afterValues[trigger.field]).toLowerCase() !== trigger.to.toLowerCase()) matches = false;
    if (trigger.object === "company") companyId = event.entityId ?? null;
    else contactId = event.entityId ?? null;
  } else if (trigger.type === "stage_changed" || trigger.type === "added_to_board") {
    const deal = event.entityId ? await maybe(() => getOpportunity(actor, event.entityId!)) : null;
    if (!deal) return { vars, matches: false };
    const before = ((data.before ?? {}) as { stageName?: string }).stageName ?? null;
    vars.deal = {
      id: deal.id,
      name: deal.name,
      stage: deal.stageName,
      previousStage: before,
      status: deal.status,
      board: deal.pipelineKind === "board" ? deal.pipelineName : "Opportunities",
      value: deal.value,
      currency: deal.currency,
    };
    if (trigger.type === "added_to_board") matches = deal.pipelineId === trigger.boardId;
    else {
      const pipelineMatches = trigger.pipelineId ? deal.pipelineId === trigger.pipelineId : deal.pipelineKind !== "board";
      matches = pipelineMatches && (!trigger.stageId || deal.stageId === trigger.stageId);
    }
    companyId = deal.companyId;
    contactId = deal.primaryContactId;
  } else if (trigger.type === "activity_logged") {
    const activity = event.entityId ? await maybe(() => getActivity(actor, event.entityId!)) : null;
    if (!activity) return { vars, matches: false };
    if (trigger.activityType && activity.type !== trigger.activityType) matches = false;
    vars.activity = { id: activity.id, type: activity.type, title: activity.title, body: activity.body, occurredAt: activity.occurredAt };
    companyId = activity.companyId;
    contactId = activity.contactId;
  } else if (trigger.type === "task_completed") {
    const task = event.entityId ? await maybe(() => getTask(actor, event.entityId!)) : null;
    if (!task) return { vars, matches: false };
    vars.task = { id: task.id, title: task.title, completedAt: task.completedAt, dueAt: task.dueAt };
    companyId = task.companyId;
    contactId = task.contactId;
  }

  const contact = contactId ? await maybe(() => getContact(actor, contactId!)) : null;
  if (contact) {
    vars.contact = contactVars(contact);
    companyId ??= contact.companyId;
  }
  const company = companyId ? await maybe(() => getCompany(actor, companyId!)) : null;
  if (company) vars.company = companyVars(company);
  if ((trigger.type === "record_created" || trigger.type === "manual" || trigger.type === "field_changed") && !company && !contact) {
    matches = false;
  }
  return { vars, matches };
}

function listAt(steps: Step[], cursor: Cursor): Step[] {
  let list = steps;
  for (let index = 0; index < cursor.length - 1; index += 2) {
    const step = list[cursor[index] as number];
    const key = cursor[index + 1] as "then" | "else" | "body";
    list = step?.[key] ?? [];
  }
  return list;
}

function stepAt(steps: Step[], cursor: Cursor) {
  return listAt(steps, cursor)[cursor[cursor.length - 1] as number];
}

function loopKey(cursor: Cursor) {
  return cursor.join(".");
}

function advance(steps: Step[], cursor: Cursor, state: RunState, vars: Vars): Cursor | null {
  let current: Cursor = [...cursor.slice(0, -1), (cursor[cursor.length - 1] as number) + 1];
  for (;;) {
    const list = listAt(steps, current);
    if ((current[current.length - 1] as number) < list.length) return current;
    if (current.length === 1) return null;
    const key = current[current.length - 2];
    const parent = current.slice(0, -2);
    if (key === "body") {
      const loop = state.loops?.[loopKey(parent)];
      if (loop && loop.index + 1 < loop.items.length) {
        loop.index += 1;
        vars.loop = { item: loop.items[loop.index], index: loop.index + 1, total: loop.items.length };
        return [...parent, "body", 0];
      }
      if (state.loops) delete state.loops[loopKey(parent)];
      delete vars.loop;
    }
    current = [...parent.slice(0, -1), (parent[parent.length - 1] as number) + 1];
  }
}

function provenance(ctx: Ctx, step: Step): Provenance {
  return {
    operation: `workflow_${step.type}`,
    source: "workflow",
    sourceUrl: `/workflows/${ctx.run.workflow_id}`,
    workflowId: ctx.run.workflow_id,
    depth: ctx.run.depth + 1,
  };
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requireRecord(ctx: Ctx, kind: "company" | "contact") {
  const record = ctx.vars[kind] as { id?: string } | undefined;
  if (!record?.id) throw new CrmError("invalid_input", `This run has no ${kind} to work on.`, 400);
  return record.id;
}

function aiSchema(outputs: { key: string; type: string; choices?: string[] }[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const output of outputs) {
    const choices = (output.choices ?? []).filter(Boolean);
    shape[output.key] =
      output.type === "number"
        ? z.coerce.number()
        : output.type === "boolean"
          ? z.boolean()
          : output.type === "list"
            ? z.array(z.string())
            : output.type === "choice" && choices.length > 0
              ? z.string()
              : z.string();
  }
  return z.object(shape);
}

async function aiStep(ctx: Ctx, step: Step): Promise<StepResult> {
  const raw = Array.isArray(step.config.outputs) ? (step.config.outputs as { key?: string; type?: string; description?: string; choices?: string[] }[]) : [];
  const outputs = raw
    .filter((output) => output.key && /^[a-z][a-zA-Z0-9_]{0,39}$/.test(output.key))
    .map((output) => ({ key: output.key!, type: output.type ?? "text", description: output.description ?? "", choices: output.choices ?? [] }));
  if (outputs.length === 0) outputs.push({ key: "text", type: "text", description: "Your answer.", choices: [] });
  const prompt = render(step.config.prompt, ctx.vars).trim();
  if (!prompt) throw new CrmError("invalid_input", "This AI step has no prompt.", 400);
  const shapeLines = outputs.map((output) => {
    const kind =
      output.type === "list"
        ? "array of strings"
        : output.type === "choice" && output.choices.length
          ? `one of ${output.choices.map((choice) => JSON.stringify(choice)).join(", ")}`
          : output.type;
    return `- "${output.key}" (${kind})${output.description ? `: ${output.description}` : ""}`;
  });
  const result = await completeJson({
    system: [
      `You are one step in an automated workflow inside Orbit, the CRM for ${ctx.actor.workspaceName}.`,
      "Work only from the information you are given. Never invent facts. UK English. No em dashes.",
      "Reply with a single JSON object with exactly these keys:",
      ...shapeLines,
    ].join("\n"),
    user: prompt,
    schema: aiSchema(outputs),
    model: str(step.config.model) || undefined,
    maxTokens: 4000,
    fetchImpl: ctx.fetchImpl,
    deadline: ctx.deadline,
  });
  const data = result.data as Record<string, unknown>;
  for (const output of outputs) {
    if (output.type === "choice" && output.choices.length) {
      const value = display(data[output.key]).trim();
      const match = output.choices.find((choice) => choice.toLowerCase() === value.toLowerCase());
      data[output.key] = match ?? value;
    }
  }
  return { kind: "next", output: { ...data, model: result.model } };
}

async function assigneeFor(ctx: Ctx, value: unknown) {
  const choice = str(value) || "owner";
  if (choice === "owner") return ctx.actor.userId;
  if (choice === "record_owner") {
    const company = ctx.vars.company as { ownerId?: string | null } | undefined;
    const contact = ctx.vars.contact as { ownerId?: string | null } | undefined;
    return company?.ownerId ?? contact?.ownerId ?? ctx.actor.userId;
  }
  return isUuid(choice) ? choice : ctx.actor.userId;
}

const SIDE_EFFECTS = new Set(["create_task", "add_note", "update_record", "board", "notify", "send_email", "linear_issue"]);

async function runStepAction(ctx: Ctx, step: Step): Promise<StepResult> {
  const config = step.config;
  if (ctx.run.test && (SIDE_EFFECTS.has(step.type) || step.type === "delay" || step.type === "approval")) {
    return { kind: "next", output: { testRun: true, wouldDo: renderedInput(step, ctx.vars) } };
  }
  switch (step.type) {
    case "ai":
      return aiStep(ctx, step);
    case "if":
      return { kind: "branch", branch: conditionsPass(config, ctx.vars) ? "then" : "else" };
    case "filter":
      return conditionsPass(config, ctx.vars) ? { kind: "next", output: { passed: true } } : { kind: "stop", output: { passed: false } };
    case "loop": {
      const value = resolve(str(config.items), ctx.vars);
      const items = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
      const limit = Math.min(Math.max(Number(config.limit) || 25, 1), 100);
      return { kind: "loop", items: items.slice(0, limit), output: { count: Math.min(items.length, limit) } };
    }
    case "delay": {
      const amount = Math.max(Number(config.amount) || 0, 0);
      const unit = str(config.unit) || "hours";
      const ms = unit === "minutes" ? 60_000 : unit === "days" ? 86_400_000 : 3_600_000;
      return { kind: "wait", until: new Date(Date.now() + Math.min(amount * ms, 90 * 86_400_000)) };
    }
    case "approval":
      return {
        kind: "approval",
        title: render(config.title, ctx.vars).trim() || "Approve this step",
        details: render(config.details, ctx.vars).trim(),
      };
    case "create_task": {
      const title = render(config.title, ctx.vars).replace(/\s+/g, " ").trim().slice(0, 200);
      if (!title) throw new CrmError("invalid_input", "The task has no title.", 400);
      const linkTo = str(config.link) || "company";
      const companyId = linkTo !== "none" ? ((ctx.vars.company as { id?: string } | undefined)?.id ?? null) : null;
      const contactId = linkTo === "contact" ? ((ctx.vars.contact as { id?: string } | undefined)?.id ?? null) : null;
      const days = config.dueInDays === "" || config.dueInDays === undefined || config.dueInDays === null ? null : Number(config.dueInDays);
      const dueAt = days !== null && Number.isFinite(days) ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      const picker = config.clickup ? await getClickUpPicker(ctx.actor).catch(() => null) : null;
      const created = await createTaskWithClickUp(
        ctx.actor,
        {
          title,
          description: render(config.notes, ctx.vars).trim() || null,
          dueAt,
          companyId: contactId ? undefined : companyId,
          contactId,
          ownerId: await assigneeFor(ctx, config.assignee),
          priority: "normal",
        },
        picker?.listId ?? null,
        { provenance: provenance(ctx, step), fetchImpl: ctx.fetchImpl },
      );
      return { kind: "next", output: { id: created.task.id, title: created.task.title, clickupError: created.clickupError } };
    }
    case "add_note": {
      const body = render(config.body, ctx.vars).trim();
      if (!body) throw new CrmError("invalid_input", "The note is empty.", 400);
      const companyId = (ctx.vars.company as { id?: string } | undefined)?.id ?? null;
      const contactId = (ctx.vars.contact as { id?: string } | undefined)?.id ?? null;
      if (!companyId && !contactId) throw new CrmError("invalid_input", "This run has no company or contact to add a note to.", 400);
      const created = await createActivity(
        ctx.actor,
        {
          type: "note",
          title: render(config.title, ctx.vars).trim().slice(0, 200) || null,
          body,
          companyId,
          contactId,
          metadata: { source: "workflow", workflowId: ctx.run.workflow_id, runId: ctx.run.id },
        },
        { provenance: provenance(ctx, step) },
      );
      return { kind: "next", output: { id: created.body.activity.id } };
    }
    case "update_record": {
      const object = str(config.object) === "contact" ? "contact" : "company";
      const field = str(config.field);
      const id = requireRecord(ctx, object);
      let value: unknown = render(config.value, ctx.vars).trim();
      if (field === "ownerId" && value === "owner") value = ctx.actor.userId;
      if (value === "") value = null;
      if (object === "company") {
        const updated = await updateCompany(ctx.actor, id, { [field]: value } as CompanyWrite, { provenance: provenance(ctx, step) });
        ctx.vars.company = companyVars(updated.body.company);
      } else {
        const updated = await updateContact(ctx.actor, id, { [field]: value } as ContactWrite, { provenance: provenance(ctx, step) });
        ctx.vars.contact = contactVars(updated.body.contact);
      }
      return { kind: "next", output: { field, value } };
    }
    case "board": {
      const companyId = requireRecord(ctx, "company");
      const boardId = str(config.boardId);
      const stageId = str(config.stageId) || null;
      if (!isUuid(boardId)) throw new CrmError("invalid_input", "Choose a board.", 400);
      const existing = (await listOpportunities(ctx.actor, { pipelineId: boardId, companyId, limit: 1 })).data[0];
      if (existing) {
        if (stageId && existing.stageId !== stageId) {
          const moved = await updateOpportunity(ctx.actor, existing.id, { stageId }, { provenance: provenance(ctx, step) });
          return { kind: "next", output: { cardId: existing.id, stage: moved.body.opportunity.stageName, moved: true } };
        }
        return { kind: "next", output: { cardId: existing.id, stage: existing.stageName, moved: false } };
      }
      const created = await createOpportunity(
        ctx.actor,
        {
          companyId,
          pipelineId: boardId,
          ...(stageId ? { stageId } : {}),
          primaryContactId: (ctx.vars.contact as { id?: string } | undefined)?.id ?? null,
        },
        { provenance: provenance(ctx, step) },
      );
      return { kind: "next", output: { cardId: created.body.opportunity.id, stage: created.body.opportunity.stageName, added: true } };
    }
    case "notify": {
      const to = await assigneeFor(ctx, config.to);
      const title = render(config.title, ctx.vars).replace(/\s+/g, " ").trim().slice(0, 200) || "Workflow update";
      const company = ctx.vars.company as { id?: string } | undefined;
      const contact = ctx.vars.contact as { id?: string } | undefined;
      const href = company?.id ? companyHref(company.id) : contact?.id ? contactHref(contact.id) : `/workflows/${ctx.run.workflow_id}`;
      await notify(ctx.actor, to, { title, body: render(config.body, ctx.vars).trim().slice(0, 4000) || null, href, source: "workflow" });
      return { kind: "next", output: { to, title } };
    }
    case "send_email": {
      const contactId = requireRecord(ctx, "contact");
      const subject = render(config.subject, ctx.vars).replace(/\s+/g, " ").trim();
      const body = render(config.body, ctx.vars).trim();
      if (!subject || !body) throw new CrmError("invalid_input", "The email needs a subject and a body.", 400);
      const sent = await sendContactEmail(ctx.actor, contactId, { subject, body }, ctx.fetchImpl);
      return { kind: "next", output: { subject, warning: sent.warning } };
    }
    case "linear_issue": {
      const issue = await createLinearIssue(
        {
          title: render(config.title, ctx.vars).trim(),
          description: render(config.description, ctx.vars).trim() || null,
          priority: str(config.priority) || null,
        },
        { fetchImpl: ctx.fetchImpl },
      );
      return { kind: "next", output: { identifier: issue.identifier, url: issue.url, title: issue.title } };
    }
    default:
      throw new CrmError("invalid_input", "This step type isn't supported.", 400);
  }
}

export async function notify(
  actor: UserActor,
  userId: string,
  input: { title: string; body?: string | null; href?: string | null; source?: string },
) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.notifications (workspace_id, user_id, title, body, href, source)
       values ($1, $2, $3, $4, $5, $6)`,
      [actor.workspaceId, userId, input.title.slice(0, 200), input.body ?? null, input.href ?? null, input.source ?? null],
    ),
  );
}

function errorText(error: unknown) {
  if (error instanceof CrmError || error instanceof LinearError || error instanceof LlmError) return error.message;
  if (error instanceof z.ZodError) return "The AI reply didn't have the fields this step expects.";
  console.error("Workflow step failed", error);
  return "Something went wrong in this step.";
}

async function logStep(
  ctx: Ctx,
  step: Step,
  status: "succeeded" | "failed" | "skipped" | "waiting",
  input: unknown,
  output: unknown,
  error: string | null,
  started: Date,
) {
  await withActor(ctx.actor, (db) =>
    db.query(
      `insert into crm.workflow_run_steps (workspace_id, run_id, owner_id, step_id, step_type, label, status, input, output, error, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, now())`,
      [
        ctx.actor.workspaceId,
        ctx.run.id,
        ctx.actor.userId,
        step.id,
        step.type,
        step.label ?? null,
        status,
        JSON.stringify(input ?? null),
        JSON.stringify(output ?? null),
        error ? error.slice(0, 2000) : null,
        started.toISOString(),
      ],
    ),
  );
}

function renderedInput(step: Step, vars: Vars) {
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.config)) {
    shown[key] = typeof value === "string" ? render(value, vars).slice(0, 4000) : value;
  }
  return shown;
}

async function saveRun(actor: UserActor, runId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((key, index) => `${key} = $${index + 2}${key === "state" ? "::jsonb" : ""}`);
  const values = keys.map((key) => (key === "state" ? JSON.stringify(fields[key]) : fields[key]));
  await withActor(actor, (db) => db.query(`update crm.workflow_runs set ${sets.join(", ")} where id = $1`, [runId, ...values]));
}

async function readRun(actor: UserActor, runId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<RunRow>(
      `select id, workspace_id, workflow_id, owner_id, status, test, definition, event, state, depth
       from crm.workflow_runs where id = $1`,
      [runId],
    );
    return result.rows[0] ?? null;
  });
}

async function workflowName(actor: UserActor, workflowId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ name: string }>("select name from crm.workflows where id = $1", [workflowId]);
    return result.rows[0]?.name ?? "A workflow";
  });
}

export async function executeRun(runId: string, ownerId: string, workspaceId: string, options: { deadline: number; fetchImpl?: typeof fetch }) {
  const actor = await ownerActor(ownerId, workspaceId);
  if (!actor) return "skipped" as const;
  const run = await readRun(actor, runId);
  if (!run || run.status !== "running") return "skipped" as const;
  const definition: WorkflowDefinition | null = safeDefinition(run.definition);
  if (!definition) {
    await saveRun(actor, run.id, { status: "failed", error: "This workflow's steps couldn't be read.", finished_at: new Date().toISOString() });
    return "failed" as const;
  }
  const state: RunState = run.state ?? {};
  if (!state.started) {
    const built = await buildContext(actor, definition.trigger, run.event);
    if (!built.matches && !run.test) {
      await withActor(actor, (db) => db.query("delete from crm.workflow_runs where id = $1", [run.id]));
      return "skipped" as const;
    }
    state.started = true;
    state.vars = built.vars;
    state.cursor = [0];
    state.loops = {};
    const company = built.vars.company as { id?: string } | undefined;
    const contact = built.vars.contact as { id?: string } | undefined;
    await saveRun(actor, run.id, { state, company_id: company?.id ?? null, contact_id: contact?.id ?? null });
    if (!run.test) {
      await withActor(actor, (db) => db.query("update crm.workflows set last_run_at = now() where id = $1", [run.workflow_id]));
    }
  }
  const vars = state.vars ?? {};
  const ctx: Ctx = { actor, run, vars, fetchImpl: options.fetchImpl, deadline: options.deadline };
  let cursor: Cursor | null = state.cursor ?? [0];
  if (definition.steps.length === 0) cursor = null;

  for (let count = 0; cursor && count < MAX_STEPS_PER_RUN; count += 1) {
    if (Date.now() > options.deadline - STEP_RESERVE_MS) {
      await saveRun(actor, run.id, { state: { ...state, cursor, vars }, status: "queued" });
      return "paused" as const;
    }
    const step = stepAt(definition.steps, cursor);
    if (!step) {
      cursor = advance(definition.steps, cursor, state, vars);
      continue;
    }
    const started = new Date();
    if (state.waitingStep === step.id) {
      state.waitingStep = null;
      if (step.type === "approval") {
        const decision = state.decisions?.[step.id];
        state.approval = null;
        if (!decision?.approved) {
          await logStep(ctx, step, "failed", null, decision ?? null, "Rejected.", started);
          await saveRun(actor, run.id, { state: { ...state, vars }, status: "cancelled", error: "Rejected at an approval step.", finished_at: new Date().toISOString() });
          return "cancelled" as const;
        }
        (vars.steps as Record<string, unknown>)[step.id] = { approved: true, note: decision.note };
        await logStep(ctx, step, "succeeded", null, { approved: true, note: decision.note }, null, started);
      } else {
        await logStep(ctx, step, "succeeded", null, { waited: true }, null, started);
      }
      cursor = advance(definition.steps, cursor, state, vars);
      continue;
    }
    const input = renderedInput(step, vars);
    let result: StepResult;
    try {
      result = await runStepAction(ctx, step);
    } catch (error) {
      const message = errorText(error);
      await logStep(ctx, step, "failed", input, null, message, started);
      await saveRun(actor, run.id, {
        state: { ...state, cursor, vars },
        status: "failed",
        error: `${step.label || step.id}: ${message}`.slice(0, 2000),
        finished_at: new Date().toISOString(),
      });
      if (!run.test) {
        await notify(actor, actor.userId, {
          title: `${await workflowName(actor, run.workflow_id)} failed`,
          body: `${step.label || step.id}: ${message}`,
          href: `/workflows/${run.workflow_id}?run=${run.id}`,
          source: "workflow",
        }).catch(() => undefined);
      }
      return "failed" as const;
    }
    if (result.kind === "wait") {
      state.waitingStep = step.id;
      await logStep(ctx, step, "waiting", input, { until: result.until.toISOString() }, null, started);
      await saveRun(actor, run.id, { state: { ...state, cursor, vars }, status: "waiting", waiting_for: "delay", resume_at: result.until.toISOString() });
      return "waiting" as const;
    }
    if (result.kind === "approval") {
      state.waitingStep = step.id;
      state.approval = { stepId: step.id, title: result.title, details: result.details };
      await logStep(ctx, step, "waiting", input, { title: result.title }, null, started);
      await saveRun(actor, run.id, { state: { ...state, cursor, vars }, status: "waiting", waiting_for: "approval" });
      await notify(actor, actor.userId, {
        title: `Approval needed: ${result.title}`.slice(0, 200),
        body: result.details.slice(0, 4000) || null,
        href: `/workflows?approve=${run.id}`,
        source: "workflow_approval",
      });
      return "waiting" as const;
    }
    (vars.steps as Record<string, unknown>)[step.id] = result.output ?? null;
    await logStep(ctx, step, "succeeded", input, result.output ?? null, null, started);
    if (result.kind === "stop") {
      cursor = null;
      break;
    }
    if (result.kind === "branch") {
      const branch = step[result.branch] ?? [];
      cursor = branch.length > 0 ? [...cursor, result.branch, 0] : advance(definition.steps, cursor, state, vars);
      continue;
    }
    if (result.kind === "loop") {
      const body = step.body ?? [];
      if (result.items.length === 0 || body.length === 0) {
        cursor = advance(definition.steps, cursor, state, vars);
        continue;
      }
      state.loops = { ...(state.loops ?? {}), [loopKey(cursor)]: { items: result.items, index: 0 } };
      vars.loop = { item: result.items[0], index: 1, total: result.items.length };
      cursor = [...cursor, "body", 0];
      continue;
    }
    cursor = advance(definition.steps, cursor, state, vars);
  }
  await saveRun(actor, run.id, { state: { ...state, cursor: null, vars }, status: "succeeded", error: null, finished_at: new Date().toISOString() });
  return "succeeded" as const;
}

async function startSchedules() {
  const claimed = await query<{ workflow_id: string; workspace_id: string; owner_id: string; definition: unknown; next_run_at: Date }>(
    "select * from private.claim_due_schedules($1)",
    [20],
  );
  for (const row of claimed.rows) {
    const actor = await ownerActor(row.owner_id, row.workspace_id);
    const definition = safeDefinition(row.definition);
    if (!actor || !definition || definition.trigger.type !== "schedule") continue;
    const next = nextScheduleRun(definition.trigger, new Date(), appTimeZone());
    await withActor(actor, async (db) => {
      await db.query(
        `insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, event)
         values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [actor.workspaceId, row.workflow_id, actor.userId, JSON.stringify(definition), JSON.stringify({ type: "schedule", at: new Date().toISOString() })],
      );
      await db.query("update crm.workflows set next_run_at = $2 where id = $1", [row.workflow_id, next.toISOString()]);
    });
  }
  return claimed.rows.length;
}

export async function runWorkflowTick(options: TickOptions = {}) {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const dispatched = (await query<{ count: number }>("select private.dispatch_workflow_events($1) as count", [200])).rows[0]?.count ?? 0;
  const scheduled = await startSchedules();
  let processed = 0;
  while (Date.now() < deadline - STEP_RESERVE_MS) {
    const claimed = await query<{ run_id: string; workspace_id: string; owner_id: string }>("select * from private.claim_workflow_runs($1)", [
      options.limit ?? 10,
    ]);
    if (claimed.rows.length === 0) break;
    for (const row of claimed.rows) {
      try {
        await executeRun(row.run_id, row.owner_id, row.workspace_id, { deadline, fetchImpl: options.fetchImpl });
      } catch (error) {
        console.error("Workflow run failed", error);
      }
      processed += 1;
    }
  }
  return { dispatched, scheduled, processed };
}
