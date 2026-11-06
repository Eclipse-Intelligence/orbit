import type { AiFilter } from "@/lib/ai-fields/params";
import { likePattern, normalizeTag } from "@/lib/crm/normalize";
import { QUIET_DAYS, type CompanyListQuery, type CompanyPresence } from "@/lib/crm/types";

export const CURRENT_FIT = "(case when es.web_icp and ws.icp_hash = es.icp_hash then ws.icp_score end)";

export const FIT_JOINS = `
  left join crm.company_web_state ws on ws.company_id = c.id
  left join crm.enrichment_settings es on es.workspace_id = c.workspace_id`;

export const GOOD_FIT_MIN = 2.5;

const PRESENCE_SQL: Record<CompanyPresence, string> = {
  domain: "c.domain is not null",
  contacts: "exists (select 1 from crm.contacts ct where ct.company_id = c.id and ct.archived_at is null)",
  interactions: "exists (select 1 from crm.activities a where a.company_id = c.id and a.archived_at is null)",
};

function answered(field: string, condition: string) {
  return `exists (select 1 from crm.ai_field_answers aa where aa.company_id = c.id and aa.field_id = ${field} and aa.state = 'answered' and ${condition})`;
}

function unanswered(field: string) {
  return `not exists (select 1 from crm.ai_field_answers aa where aa.company_id = c.id and aa.field_id = ${field} and aa.state = 'answered')`;
}

function aiFilterSql(filter: AiFilter, values: unknown[]) {
  values.push(filter.fieldId);
  const field = `$${values.length}::uuid`;
  return `(not exists (select 1 from crm.ai_fields af where af.id = ${field} and af.workspace_id = c.workspace_id) or ${aiConditionSql(filter, field, values)})`;
}

function aiConditionSql(filter: AiFilter, field: string, values: unknown[]) {
  if (filter.op === "is") {
    if (filter.value === "unknown") return unanswered(field);
    return answered(field, `aa.value_bool = ${filter.value === "yes" ? "true" : "false"}`);
  }
  if (filter.op === "has") {
    values.push(likePattern(filter.text));
    const pattern = `$${values.length}`;
    return answered(field, `(coalesce(aa.value_text, '') ilike ${pattern} escape '\\' or array_to_string(coalesce(aa.value_options, '{}'), ' ') ilike ${pattern} escape '\\')`);
  }
  if (filter.op === "range") {
    const parts = ["aa.value_number is not null"];
    if (filter.min !== null) {
      values.push(filter.min);
      parts.push(`aa.value_number >= $${values.length}::numeric`);
    }
    if (filter.max !== null) {
      values.push(filter.max);
      parts.push(`aa.value_number <= $${values.length}::numeric`);
    }
    const matched = filter.min === null && filter.max === null ? "false" : answered(field, parts.join(" and "));
    return filter.unknown ? `(${matched} or ${unanswered(field)})` : matched;
  }
  const lowered = filter.options.map((option) => option.toLowerCase());
  let matched = "false";
  if (lowered.length > 0) {
    values.push(lowered);
    matched = answered(field, `exists (select 1 from unnest(aa.value_options) o where lower(o) = any($${values.length}::text[]))`);
  }
  return filter.unknown ? `(${matched} or ${unanswered(field)})` : matched;
}

export function companyWhere(query: CompanyListQuery, values: unknown[], workspaceParam = "$1") {
  const where = [`c.workspace_id = ${workspaceParam}`];
  if (!query.includeArchived) where.push("c.archived_at is null");
  if (query.health === "none") where.push("c.health is null");
  else if (query.health) {
    values.push(query.health);
    where.push(`c.health = $${values.length}`);
  }
  if (query.lifecycle) {
    values.push(query.lifecycle);
    where.push(`lower(c.lifecycle) = lower($${values.length})`);
  }
  if (query.ownerId === "unassigned") where.push("c.owner_id is null");
  else if (query.ownerId) {
    values.push(query.ownerId);
    where.push(`c.owner_id = $${values.length}`);
  }
  const tag = query.tag ? normalizeTag(query.tag) : "";
  if (tag) {
    values.push([tag]);
    where.push(`c.tags @> $${values.length}::text[]`);
  }
  const text = query.query?.trim();
  if (text) {
    values.push(likePattern(text.slice(0, 200)));
    const ref = `$${values.length}`;
    where.push(`(
      c.name ilike ${ref} escape '\\'
      or coalesce(c.domain, '') ilike ${ref} escape '\\'
      or coalesce(c.industry, '') ilike ${ref} escape '\\'
      or c.normalized_name ilike ${ref} escape '\\'
    )`);
  }
  for (const field of query.has ?? []) where.push(PRESENCE_SQL[field]);
  for (const field of query.missing ?? []) where.push(`not (${PRESENCE_SQL[field]})`);
  if (query.quiet) {
    values.push(QUIET_DAYS);
    where.push(`not exists (
      select 1 from crm.activities qa
      where qa.workspace_id = c.workspace_id
        and qa.archived_at is null
        and qa.occurred_at >= now() - make_interval(days => $${values.length}::int)
        and (
          qa.company_id = c.id
          or qa.contact_id in (
            select qc.id from crm.contacts qc
            where qc.company_id = c.id and qc.workspace_id = c.workspace_id and qc.archived_at is null
          )
        )
    )`);
  }
  for (const filter of query.ai ?? []) where.push(aiFilterSql(filter, values));
  return where.join(" and ");
}

export function aiSortSql(fieldId: string, direction: "asc" | "desc", values: unknown[]) {
  values.push(fieldId);
  const field = `$${values.length}::uuid`;
  const pick = (column: string) =>
    `(select ${column} from crm.ai_field_answers sa where sa.company_id = c.id and sa.field_id = ${field} and sa.state = 'answered') ${direction} nulls last`;
  return [pick("sa.value_number"), pick("sa.value_bool"), pick("lower(sa.value_text)"), pick("lower(array_to_string(sa.value_options, ', '))")].join(", ");
}
