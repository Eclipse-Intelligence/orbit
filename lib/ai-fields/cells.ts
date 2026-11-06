import type { Db } from "@/lib/db/pool";
import { readFields, scopeMembership, type StoredField } from "@/lib/ai-fields/fields";
import type { AiAnswer, AiCell, AiSource, AiValue, AiWebAnswer } from "@/lib/ai-fields/types";

export type AnswerRow = {
  field_id: string;
  company_id: string;
  state: "pending" | "answered" | "unknown";
  value_bool: boolean | null;
  value_number: string | number | null;
  value_text: string | null;
  value_options: string[] | null;
  likelihood: number | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
  sources: AiSource[] | null;
  checked_at: Date | null;
  next_check_at: Date | null;
  claimed_at: Date | null;
  run_id: string | null;
  error: string | null;
  manual: boolean;
  manual_at: Date | null;
  manual_by_name: string | null;
  web_answer: Record<string, unknown> | null;
};

export const ANSWER_SQL = `
  select a.field_id, a.company_id, a.state, a.value_bool, a.value_number, a.value_text, a.value_options, a.likelihood, a.confidence, a.reason,
    a.sources, a.checked_at, a.next_check_at, a.claimed_at, a.run_id, a.error, a.manual, a.manual_at,
    coalesce(nullif(p.full_name, ''), p.email) as manual_by_name, a.web_answer
  from crm.ai_field_answers a
  left join crm.profiles p on p.id = a.manual_by`;

export function rowValue(field: Pick<StoredField, "kind">, row: Pick<AnswerRow, "state" | "value_bool" | "value_number" | "value_text" | "value_options">): AiValue {
  if (row.state !== "answered") return null;
  if (field.kind === "yes_no") return row.value_bool;
  if (field.kind === "number") return row.value_number === null ? null : Number(row.value_number);
  if (field.kind === "text") return row.value_text;
  return row.value_options ?? [];
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function cellFor(field: StoredField, row: AnswerRow | undefined, inScope: boolean): AiCell {
  if (row && (row.state === "answered" || (row.state === "unknown" && (row.manual || inScope)))) {
    return row.manual ? { state: row.state, value: rowValue(field, row), manual: true, manualByName: row.manual_by_name } : { state: row.state, value: rowValue(field, row), manual: false };
  }
  if (!inScope) return { state: "outside", value: null, manual: false };
  if (field.paused && !row?.run_id) return { state: "unknown", value: null, manual: false };
  return { state: "checking", value: null, manual: false };
}

function webAnswer(field: StoredField, value: Record<string, unknown> | null): AiWebAnswer | null {
  if (!value) return null;
  const state = value.state === "answered" ? "answered" : "unknown";
  const row = {
    state,
    value_bool: typeof value.bool === "boolean" ? value.bool : null,
    value_number: typeof value.number === "number" || typeof value.number === "string" ? (value.number as number | string) : null,
    value_text: typeof value.text === "string" ? value.text : null,
    value_options: Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === "string") : null,
  } as const;
  return {
    state,
    value: rowValue(field, row),
    likelihood: typeof value.likelihood === "number" ? value.likelihood : null,
    confidence: value.confidence === "high" || value.confidence === "medium" || value.confidence === "low" ? value.confidence : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    sources: Array.isArray(value.sources) ? (value.sources as AiSource[]) : [],
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
  };
}

export function answerFor(field: StoredField, companyId: string, row: AnswerRow | undefined, inScope: boolean): AiAnswer {
  const cell = cellFor(field, row, inScope);
  return {
    ...cell,
    fieldId: field.id,
    companyId,
    likelihood: row?.manual ? null : (row?.likelihood ?? null),
    confidence: row?.manual ? null : (row?.confidence ?? null),
    reason: row?.manual ? null : (row?.reason ?? null),
    sources: row?.manual ? [] : (row?.sources ?? []),
    checkedAt: iso(row?.checked_at),
    nextCheckAt: row?.manual || field.paused ? null : iso(row?.next_check_at),
    manualAt: iso(row?.manual_at),
    manualByName: row?.manual_by_name ?? null,
    web: row?.manual ? webAnswer(field, row.web_answer) : null,
    error: row?.error ?? null,
  };
}

export async function readAiCells(db: Db, workspaceId: string, companyIds: string[]) {
  const cells: Record<string, Record<string, AiCell>> = {};
  if (companyIds.length === 0) return cells;
  const fields = await readFields(db, workspaceId);
  if (fields.length === 0) return cells;
  const [scopes, answers] = await Promise.all([
    scopeMembership(db, workspaceId, fields, companyIds),
    db.query<AnswerRow>(`${ANSWER_SQL} where a.workspace_id = $1 and a.company_id = any($2::uuid[])`, [workspaceId, companyIds]),
  ]);
  const byKey = new Map(answers.rows.map((row) => [`${row.field_id}:${row.company_id}`, row]));
  for (const companyId of companyIds) {
    cells[companyId] = {};
    for (const field of fields) {
      cells[companyId][field.id] = cellFor(field, byKey.get(`${field.id}:${companyId}`), scopes.get(field.id)?.has(companyId) ?? false);
    }
  }
  return cells;
}
