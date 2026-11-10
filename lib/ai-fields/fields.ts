import { withActor } from "@/lib/crm/context";
import { companyWhere, CURRENT_FIT, FIT_JOINS, GOOD_FIT_MIN } from "@/lib/crm/company-query";
import { CrmError, notFound, tooLong, tooMany } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, UserActor } from "@/lib/crm/types";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";
import type { Db } from "@/lib/db/pool";
import { validOptionName } from "@/lib/ai-fields/params";
import {
  AI_FIELD_DECISION_QUESTIONS_MAX,
  AI_FIELD_KINDS,
  AI_FIELD_LABEL_MAX,
  AI_FIELD_OPTION_MAX,
  AI_FIELD_OPTIONS_MAX,
  AI_FIELD_REFRESH,
  AI_FIELD_SCOPES,
  AI_FIELDS_MAX,
  DECISION_COST,
  looksLikeStaff,
  TASK_COST,
  type AiField,
  type AiFieldKind,
  type AiFieldRefresh,
  type AiFieldScope,
  type AiFieldStats,
} from "@/lib/ai-fields/types";

type FieldRow = {
  id: string;
  label: string;
  question: string;
  kind: AiFieldKind;
  options: string[];
  multiple: boolean;
  scope: AiFieldScope;
  scope_view_id: string | null;
  scope_view_name: string | null;
  scope_view_params: string | null;
  refresh: AiFieldRefresh;
  paused: boolean;
  fills_size: boolean;
  web_check_id: string | null;
  position: number;
  last_run_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  created_at: Date;
};

export type StoredField = AiField & { scopeViewParams: string | null };

const FIELD_SQL = `
  select f.id, f.label, f.question, f.kind, f.options, f.multiple, f.scope, f.scope_view_id, v.name as scope_view_name, v.params as scope_view_params,
    f.refresh, f.paused, f.fills_size, f.web_check_id, f.position, f.last_run_at, f.last_error, f.last_error_at, f.created_at
  from crm.ai_fields f
  left join crm.company_views v on v.id = f.scope_view_id`;

function iso(value: Date | null) {
  return value ? new Date(value).toISOString() : null;
}

function toField(row: FieldRow): StoredField {
  return {
    id: row.id,
    label: row.label,
    question: row.question,
    kind: row.kind,
    options: row.options ?? [],
    multiple: row.multiple,
    scope: row.scope,
    scopeViewId: row.scope_view_id,
    scopeViewName: row.scope_view_name,
    scopeViewParams: row.scope_view_params,
    refresh: row.refresh,
    paused: row.paused,
    fillsSize: row.fills_size,
    webCheckId: row.web_check_id,
    position: row.position,
    lastRunAt: iso(row.last_run_at),
    lastError: row.last_error,
    lastErrorAt: iso(row.last_error_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function publicField(field: StoredField): AiField {
  const { scopeViewParams: _params, ...rest } = field;
  void _params;
  return rest;
}

export function invalid(message: string, field?: string) {
  return new CrmError("invalid_input", message, 400, field ? { field } : undefined);
}

export function assertFieldAdmin(actor: Actor): asserts actor is UserActor {
  if (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new CrmError("forbidden", "Only owners and admins can change AI fields.", 403);
  }
}

export async function readFields(db: Db, workspaceId: string) {
  const result = await db.query<FieldRow>(`${FIELD_SQL} where f.workspace_id = $1 order by f.position, f.created_at, f.label`, [workspaceId]);
  return result.rows.map(toField);
}

export async function listAiFields(actor: Actor) {
  return withActor(actor, (db) => readFields(db, actor.workspaceId));
}

export async function readField(db: Db, workspaceId: string, id: string) {
  if (!isUuid(id)) return null;
  const result = await db.query<FieldRow>(`${FIELD_SQL} where f.workspace_id = $1 and f.id = $2`, [workspaceId, id]);
  return result.rows[0] ? toField(result.rows[0]) : null;
}

const BASE_SCOPE = "c.archived_at is null and (c.domain is not null or c.website is not null)";

type ScopeInput = Pick<StoredField, "scope" | "scopeViewId" | "scopeViewParams">;

function viewQuery(field: ScopeInput) {
  if (!field.scopeViewId || field.scopeViewParams === null) return null;
  try {
    return companyQueryFromSearchParams(new URLSearchParams(field.scopeViewParams));
  } catch {
    return null;
  }
}

export function scopeProblem(field: ScopeInput) {
  if (field.scope !== "view") return null;
  if (!field.scopeViewId || field.scopeViewParams === null) return "Its saved view was deleted. Choose other companies.";
  if (!viewQuery(field)) return "Its saved view has an invalid filter. Save the view again.";
  return null;
}

export function scopeSql(field: ScopeInput, values: unknown[]) {
  if (field.scope === "fit") {
    values.push(GOOD_FIT_MIN);
    return `(${BASE_SCOPE} and ${CURRENT_FIT} >= $${values.length})`;
  }
  if (field.scope === "view") {
    const query = viewQuery(field);
    if (!query) return "false";
    return `(${BASE_SCOPE} and ${companyWhere({ ...query, includeArchived: false }, values, "c.workspace_id")})`;
  }
  return `(${BASE_SCOPE})`;
}

export async function scopeMembership(db: Db, workspaceId: string, fields: StoredField[], companyIds: string[]) {
  const inScope = new Map<string, Set<string>>();
  if (fields.length === 0 || companyIds.length === 0) return inScope;
  const values: unknown[] = [workspaceId, companyIds];
  const columns = fields.map((field, index) => `${scopeSql(field, values)} as s${index}`);
  const result = await db.query<Record<string, unknown>>(
    `select c.id, ${columns.join(", ")} from crm.companies c ${FIT_JOINS} where c.workspace_id = $1 and c.id = any($2::uuid[])`,
    values,
  );
  fields.forEach((field, index) => {
    inScope.set(field.id, new Set(result.rows.filter((row) => row[`s${index}`] === true).map((row) => String(row.id))));
  });
  return inScope;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function cleanOptions(value: unknown) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const item of raw) {
    const option = cleanText(item);
    if (!option) continue;
    if (option.length > AI_FIELD_OPTION_MAX) throw invalid(`Keep each option to ${AI_FIELD_OPTION_MAX} characters.`, "options");
    if (!validOptionName(option)) throw invalid("Options can't contain | or be just a question mark.", "options");
    if (option.toLowerCase() === "unknown") throw invalid("Remove Unknown. It's added automatically.", "options");
    if (seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    options.push(option);
  }
  if (options.length < 2) throw invalid("Enter at least two options.", "options");
  if (options.length > AI_FIELD_OPTIONS_MAX) throw invalid(tooMany(AI_FIELD_OPTIONS_MAX, "options"), "options");
  return options;
}

export type AiFieldInput = {
  id?: unknown;
  label?: unknown;
  question?: unknown;
  kind?: unknown;
  options?: unknown;
  multiple?: unknown;
  scope?: unknown;
  scopeViewId?: unknown;
  refresh?: unknown;
  fillsSize?: unknown;
};

export async function saveAiField(actor: Actor, input: AiFieldInput, link: { webCheckId?: string } = {}) {
  assertFieldAdmin(actor);
  const label = cleanText(input.label);
  if (!label || label.length > AI_FIELD_LABEL_MAX) throw invalid(tooLong("the name", AI_FIELD_LABEL_MAX), "label");
  const question = cleanText(input.question);
  if (question.length < 10 || question.length > 1000) throw invalid("Enter a question of 10 to 1,000 characters.", "question");
  const kind = AI_FIELD_KINDS.find((item) => item === input.kind);
  if (!kind) throw invalid("Choose an answer type.", "kind");
  const options = kind === "pick" ? cleanOptions(input.options) : [];
  const multiple = kind === "pick" && input.multiple === true;
  const scope = AI_FIELD_SCOPES.find((item) => item === input.scope) ?? "all";
  const viewId = scope === "view" && typeof input.scopeViewId === "string" && isUuid(input.scopeViewId) ? input.scopeViewId : null;
  if (scope === "view" && !viewId) throw invalid("Choose a saved view.", "scopeViewId");
  const refresh = AI_FIELD_REFRESH.find((item) => item === input.refresh) ?? "monthly";
  const fillsSize = kind === "number" && (typeof input.fillsSize === "boolean" ? input.fillsSize : looksLikeStaff(label, question));
  const editing = typeof input.id === "string" && isUuid(input.id) ? input.id : null;
  return withActor(actor, async (db) => {
    if (kind === "yes_no" || kind === "pick") {
      const others = await db.query<{ kind: AiFieldKind; multiple: boolean; options: string[] }>(
        "select kind, multiple, options from crm.ai_fields where workspace_id = $1 and kind in ('yes_no', 'pick') and ($2::uuid is null or id <> $2)",
        [actor.workspaceId, editing],
      );
      const total = [...others.rows, { kind, multiple, options }].reduce((sum, item) => sum + (item.kind === "pick" && item.multiple ? item.options.length : 1), 0);
      if (total > AI_FIELD_DECISION_QUESTIONS_MAX) {
        throw invalid(
          `Too many yes or no and list questions (${total} of ${AI_FIELD_DECISION_QUESTIONS_MAX}). Remove some options or fields.`,
          "options",
        );
      }
    }
    if (viewId) {
      const view = await db.query("select 1 from crm.company_views where id = $1 and workspace_id = $2", [viewId, actor.workspaceId]);
      if (!view.rows[0]) throw invalid("View not found.", "scopeViewId");
    }
    try {
      if (editing) {
        const before = await readField(db, actor.workspaceId, editing);
        if (!before) throw notFound("AI field");
        await db.query(
          `update crm.ai_fields set label = $3, question = $4, kind = $5, options = $6, multiple = $7, scope = $8, scope_view_id = $9, refresh = $10, fills_size = $11
           where id = $1 and workspace_id = $2`,
          [editing, actor.workspaceId, label, question, kind, options, multiple, scope, viewId, refresh, fillsSize],
        );
        const reshaped = before.kind !== kind || (kind === "pick" && (before.multiple !== multiple || before.options.join("\n") !== options.join("\n")));
        if (reshaped) await reshapeAnswers(db, actor.workspaceId, editing, { kind, options, multiple }, before);
        else if (before.question !== question) {
          await db.query(
            "update crm.ai_field_answers set next_check_at = now(), run_id = null, run_started_at = null, collect_claimed_at = null where field_id = $1 and workspace_id = $2 and not manual",
            [editing, actor.workspaceId],
          );
        } else if (before.refresh !== refresh) {
          await db.query(
            `update crm.ai_field_answers set next_check_at = case $3::text when 'manual' then null when 'weekly' then checked_at + interval '7 days' else checked_at + interval '30 days' end
             where field_id = $1 and workspace_id = $2 and not manual and checked_at is not null and run_id is null`,
            [editing, actor.workspaceId, refresh],
          );
        }
        return (await readField(db, actor.workspaceId, editing))!;
      }
      const count = await db.query<{ total: number; next: number }>(
        "select count(*)::int as total, coalesce(max(position) + 1, 0)::int as next from crm.ai_fields where workspace_id = $1",
        [actor.workspaceId],
      );
      if ((count.rows[0]?.total ?? 0) >= AI_FIELDS_MAX) throw invalid(tooMany(AI_FIELDS_MAX, "AI fields"));
      const created = await db.query<{ id: string }>(
        `insert into crm.ai_fields (workspace_id, label, question, kind, options, multiple, scope, scope_view_id, refresh, fills_size, position, web_check_id, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [
          actor.workspaceId,
          label,
          question,
          kind,
          options,
          multiple,
          scope,
          viewId,
          refresh,
          fillsSize,
          count.rows[0]?.next ?? 0,
          link.webCheckId ?? null,
          actor.userId,
        ],
      );
      return (await readField(db, actor.workspaceId, created.rows[0].id))!;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new CrmError("conflict", `${label} already exists.`, 409, { field: "label" });
      throw error;
    }
  });
}

type Shape = Pick<StoredField, "kind" | "options" | "multiple">;

type ManualRow = { company_id: string; state: string; value_options: string[] | null };

export function fitsShape(shape: Shape, before: Pick<StoredField, "kind">, row: Pick<ManualRow, "state" | "value_options">): string[] | null | false {
  if (row.state !== "answered") return null;
  if (shape.kind !== before.kind) return false;
  if (shape.kind !== "pick") return null;
  const picked = row.value_options ?? [];
  const matched = picked.map((option) => shape.options.find((item) => item.toLowerCase() === option.toLowerCase()));
  if (matched.some((option) => option === undefined) || matched.length === 0) return false;
  if (!shape.multiple && matched.length > 1) return false;
  return matched as string[];
}

async function reshapeAnswers(db: Db, workspaceId: string, fieldId: string, shape: Shape, previous: Pick<StoredField, "kind">) {
  const manual = await db.query<ManualRow>(
    "select company_id, state, value_options from crm.ai_field_answers where field_id = $1 and workspace_id = $2 and manual for update",
    [fieldId, workspaceId],
  );
  const dropped: string[] = [];
  for (const row of manual.rows) {
    const fit = fitsShape(shape, previous, row);
    if (fit === false) dropped.push(row.company_id);
    else {
      await db.query("update crm.ai_field_answers set web_answer = null, value_options = coalesce($3::text[], value_options) where field_id = $1 and company_id = $2", [
        fieldId,
        row.company_id,
        fit,
      ]);
    }
  }
  await db.query("delete from crm.ai_field_answers where field_id = $1 and workspace_id = $2 and (not manual or company_id = any($3::uuid[]))", [fieldId, workspaceId, dropped]);
}

export async function aiFieldEditImpact(actor: Actor, id: string) {
  if (!isUuid(id)) return { web: 0, manual: 0 };
  return withActor(actor, async (db) => {
    const result = await db.query<{ web: number; manual: number }>(
      `select count(*) filter (where not manual and checked_at is not null)::int as web, count(*) filter (where manual)::int as manual
       from crm.ai_field_answers where field_id = $1 and workspace_id = $2`,
      [id, actor.workspaceId],
    );
    return { web: result.rows[0]?.web ?? 0, manual: result.rows[0]?.manual ?? 0 };
  });
}

export async function removeAiField(actor: Actor, id: string) {
  assertFieldAdmin(actor);
  if (!isUuid(id)) throw notFound("AI field");
  await withActor(actor, (db) => db.query("delete from crm.ai_fields where id = $1 and workspace_id = $2", [id, actor.workspaceId]));
}

export async function setAiFieldPaused(actor: Actor, id: string, paused: boolean) {
  assertFieldAdmin(actor);
  if (!isUuid(id)) throw notFound("AI field");
  return withActor(actor, async (db) => {
    const result = await db.query("update crm.ai_fields set paused = $3 where id = $1 and workspace_id = $2 returning id", [id, actor.workspaceId, paused]);
    if (!result.rows[0]) throw notFound("AI field");
    if (!paused) {
      await db.query(
        `update crm.ai_field_answers a set next_check_at = now()
         from crm.ai_fields f where f.id = a.field_id and a.field_id = $1 and a.workspace_id = $2 and not a.manual
           and f.refresh <> 'manual' and a.next_check_at is not null and a.next_check_at < now()`,
        [id, actor.workspaceId],
      );
    }
  });
}

export async function checkFieldAgain(actor: Actor, id: string) {
  assertFieldAdmin(actor);
  if (!isUuid(id)) throw notFound("AI field");
  return withActor(actor, async (db) => {
    const field = await readField(db, actor.workspaceId, id);
    if (!field) throw notFound("AI field");
    await db.query("update crm.ai_field_answers set next_check_at = now() where field_id = $1 and workspace_id = $2 and not manual and run_id is null", [id, actor.workspaceId]);
    return field;
  });
}

export async function moveAiField(actor: Actor, id: string, position: number) {
  assertFieldAdmin(actor);
  if (!isUuid(id)) throw notFound("AI field");
  await withActor(actor, (db) => db.query("update crm.ai_fields set position = $3 where id = $1 and workspace_id = $2", [id, actor.workspaceId, Math.max(0, Math.round(position))]));
}

export async function showRuleAsColumn(actor: Actor, webCheckId: string) {
  assertFieldAdmin(actor);
  if (!isUuid(webCheckId)) throw notFound("tag rule");
  const found = await withActor(actor, async (db) => {
    const existing = await db.query<{ id: string }>("select id from crm.ai_fields where workspace_id = $1 and web_check_id = $2", [actor.workspaceId, webCheckId]);
    if (existing.rows[0]) return { existing: existing.rows[0].id, rule: null };
    const rule = await db.query<{ label: string; question: string }>(
      "select label, question from crm.web_checks where id = $1 and workspace_id = $2 and kind = 'tag'",
      [webCheckId, actor.workspaceId],
    );
    return { existing: null, rule: rule.rows[0] ?? null };
  });
  if (found.existing) return (await withActor(actor, (db) => readField(db, actor.workspaceId, found.existing!)))!;
  if (!found.rule) throw notFound("tag rule");
  const label = found.rule.label.slice(0, AI_FIELD_LABEL_MAX);
  return saveAiField(actor, { label: `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`, question: found.rule.question, kind: "yes_no", scope: "all", refresh: "monthly" }, { webCheckId });
}

export async function aiFieldStats(actor: Actor, fields?: StoredField[]): Promise<AiFieldStats[]> {
  return withActor(actor, async (db) => {
    const list = fields ?? (await readFields(db, actor.workspaceId));
    const stats: AiFieldStats[] = [];
    for (const field of list) {
      const values: unknown[] = [actor.workspaceId, field.id];
      const scope = scopeSql(field, values);
      const result = await db.query<{ total: number; answered: number; checked: number; running: number; next_check_at: Date | null }>(
        `select count(*)::int as total,
           count(*) filter (where a.state = 'answered')::int as answered,
           count(*) filter (where a.checked_at is not null or a.manual)::int as checked,
           count(*) filter (where a.run_id is not null or (a.claimed_at is not null and a.claimed_at > now() - interval '5 minutes'))::int as running,
           min(a.next_check_at) filter (where not a.manual and a.next_check_at > now()) as next_check_at
         from crm.companies c ${FIT_JOINS}
         left join crm.ai_field_answers a on a.company_id = c.id and a.field_id = $2
         where c.workspace_id = $1 and ${scope}`,
        values,
      );
      const row = result.rows[0];
      stats.push({
        fieldId: field.id,
        total: row?.total ?? 0,
        answered: row?.answered ?? 0,
        checked: row?.checked ?? 0,
        running: row?.running ?? 0,
        nextCheckAt: field.paused || !row?.next_check_at ? null : new Date(row.next_check_at).toISOString(),
      });
    }
    return stats;
  });
}

export async function scopeCounts(actor: Actor) {
  return withActor(actor, async (db) => {
    const base = await db.query<{ all: number; fit: number }>(
      `select count(*)::int as all, count(*) filter (where ${CURRENT_FIT} >= $2)::int as fit
       from crm.companies c ${FIT_JOINS}
       where c.workspace_id = $1 and ${BASE_SCOPE}`,
      [actor.workspaceId, GOOD_FIT_MIN],
    );
    const views = await db.query<{ id: string; params: string }>("select id, params from crm.company_views where workspace_id = $1 order by lower(name)", [actor.workspaceId]);
    const counts: Record<string, number> = {};
    for (const view of views.rows) {
      const values: unknown[] = [actor.workspaceId];
      const scope = scopeSql({ scope: "view", scopeViewId: view.id, scopeViewParams: view.params }, values);
      const result = await db.query<{ total: number }>(`select count(*)::int as total from crm.companies c ${FIT_JOINS} where c.workspace_id = $1 and ${scope}`, values);
      counts[view.id] = result.rows[0]?.total ?? 0;
    }
    return { all: base.rows[0]?.all ?? 0, fit: base.rows[0]?.fit ?? 0, views: counts };
  });
}

export async function spendThisMonth(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ decisions: number; tasks: number }>(
      "select decisions, tasks from crm.ai_field_spend where workspace_id = $1 and month = date_trunc('month', now())::date",
      [actor.workspaceId],
    );
    const row = result.rows[0];
    return { decisions: row?.decisions ?? 0, tasks: row?.tasks ?? 0, amount: (row?.decisions ?? 0) * DECISION_COST + (row?.tasks ?? 0) * TASK_COST };
  });
}

export async function hiddenAiFields(actor: Actor) {
  if (actor.type !== "user") return [];
  return withActor(actor, async (db) => {
    const result = await db.query<{ field_id: string }>("select field_id from crm.ai_field_hidden where user_id = $1 and workspace_id = $2", [actor.userId, actor.workspaceId]);
    return result.rows.map((row) => row.field_id);
  });
}

export async function setAiFieldHidden(actor: Actor, fieldId: string, hidden: boolean) {
  if (actor.type !== "user") throw new CrmError("forbidden", "Only people can hide AI fields.", 403);
  if (!isUuid(fieldId)) throw notFound("AI field");
  await withActor(actor, async (db) => {
    if (hidden) {
      await db.query(
        `insert into crm.ai_field_hidden (user_id, field_id, workspace_id)
         select $1, f.id, f.workspace_id from crm.ai_fields f where f.id = $2 and f.workspace_id = $3
         on conflict do nothing`,
        [actor.userId, fieldId, actor.workspaceId],
      );
    } else {
      await db.query("delete from crm.ai_field_hidden where user_id = $1 and field_id = $2", [actor.userId, fieldId]);
    }
  });
}
