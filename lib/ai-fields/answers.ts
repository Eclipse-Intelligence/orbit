import { getCompany, updateCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooLong } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { ANSWER_SQL, answerFor, rowValue, storedNumber, type AnswerRow } from "@/lib/ai-fields/cells";
import { assertFieldAdmin, readField, readFields, scopeMembership, type StoredField } from "@/lib/ai-fields/fields";
import { displayAiValue, sizeForStaff, type AiAnswer, type AiValue } from "@/lib/ai-fields/types";

export const AI_FIELD_EVENT = "company.ai_field_changed";
export const BACKGROUND_PROVENANCE: Provenance = { operation: "ai_field", source: "parallel", automatic: true };
const MANUAL_PROVENANCE: Provenance = { operation: "ai_field_manual" };

export type StoredValue = { state: string; bool: boolean | null; number: number | string | null; text: string | null; options: string[] | null } | null;

export function aiFieldKey(fieldId: string) {
  return `ai:${fieldId}`;
}

export function shownValue(field: Pick<StoredField, "kind">, value: StoredValue) {
  if (!value || value.state !== "answered") return null;
  const shown = displayAiValue(
    field,
    rowValue(field, { state: "answered", value_bool: value.bool, value_number: value.number, value_text: value.text, value_options: value.options }),
  );
  return shown || null;
}

export async function recordAnswerChange(db: Db, actor: Actor, field: StoredField, companyId: string, before: StoredValue, after: StoredValue, provenance: Provenance) {
  const from = shownValue(field, before);
  const to = shownValue(field, after);
  if (from === to) return false;
  const key = aiFieldKey(field.id);
  await recordAudit(db, actor, AI_FIELD_EVENT, "company", companyId, provenance, {
    fields: [key],
    before: { [key]: from },
    after: { [key]: to },
    aiField: { id: field.id, label: field.label },
  });
  return true;
}

export async function fillSizeFromStaff(actor: Actor, field: StoredField, companyId: string, value: AiValue, provenance: Provenance) {
  if (!field.fillsSize || field.kind !== "number" || typeof value !== "number") return null;
  const size = sizeForStaff(value);
  if (!size) return null;
  try {
    const company = await getCompany(actor, companyId);
    if (company.sizeCategory) return null;
    await updateCompany(actor, companyId, { sizeCategory: size }, { provenance });
    return size;
  } catch (error) {
    if (!(error instanceof CrmError)) console.error("Filling size from an AI field failed", error);
    return null;
  }
}

export async function getCompanyAnswers(actor: Actor, companyId: string) {
  if (!isUuid(companyId)) return { fields: [], answers: [] as AiAnswer[] };
  return withActor(actor, async (db) => {
    const fields = await readFields(db, actor.workspaceId);
    if (fields.length === 0) return { fields, answers: [] as AiAnswer[] };
    const [scopes, rows] = await Promise.all([
      scopeMembership(db, actor.workspaceId, fields, [companyId]),
      db.query<AnswerRow>(`${ANSWER_SQL} where a.workspace_id = $1 and a.company_id = $2`, [actor.workspaceId, companyId]),
    ]);
    const byField = new Map(rows.rows.map((row) => [row.field_id, row]));
    return { fields, answers: fields.map((field) => answerFor(field, companyId, byField.get(field.id), scopes.get(field.id)?.has(companyId) ?? false)) };
  });
}

export async function getAnswer(actor: Actor, fieldId: string, companyId: string) {
  if (!isUuid(fieldId) || !isUuid(companyId)) throw notFound("answer");
  return withActor(actor, async (db) => {
    const field = await readField(db, actor.workspaceId, fieldId);
    if (!field) throw notFound("AI field");
    const [scopes, rows] = await Promise.all([
      scopeMembership(db, actor.workspaceId, [field], [companyId]),
      db.query<AnswerRow>(`${ANSWER_SQL} where a.workspace_id = $1 and a.company_id = $2 and a.field_id = $3`, [actor.workspaceId, companyId, fieldId]),
    ]);
    return { field, answer: answerFor(field, companyId, rows.rows[0], scopes.get(fieldId)?.has(companyId) ?? false) };
  });
}

type ManualValue = { state: "answered" | "unknown"; bool: boolean | null; number: number | null; text: string | null; options: string[] | null };

export function cleanManualValue(field: Pick<StoredField, "kind" | "options" | "multiple">, value: unknown): ManualValue {
  const unknown: ManualValue = { state: "unknown", bool: null, number: null, text: null, options: null };
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return unknown;
  if (field.kind === "yes_no") {
    if (value === true || value === "yes") return { ...unknown, state: "answered", bool: true };
    if (value === false || value === "no") return { ...unknown, state: "answered", bool: false };
    throw new CrmError("invalid_input", "Choose Yes, No or Unknown.", 400, { field: "value" });
  }
  if (field.kind === "number") {
    const digits = typeof value === "string" ? value.replace(/[,\s]/g, "") : "";
    const number = typeof value === "number" ? value : digits ? Number(digits) : Number.NaN;
    if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new CrmError("invalid_input", "Enter a number.", 400, { field: "value" });
    return { ...unknown, state: "answered", number };
  }
  if (field.kind === "text") {
    const text = String(value).replace(/\s+/g, " ").trim();
    if (!text) return unknown;
    if (text.length > 300) throw new CrmError("invalid_input", tooLong("the answer", 300), 400, { field: "value" });
    return { ...unknown, state: "answered", text };
  }
  const picked = (Array.isArray(value) ? value : [value]).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const options = field.options.filter((option) => picked.includes(option.toLowerCase()));
  if (picked.length > 0 && options.length !== new Set(picked).size) throw new CrmError("invalid_input", "Choose from the AI field's options.", 400, { field: "value" });
  if (options.length === 0) return unknown;
  if (!field.multiple && options.length > 1) throw new CrmError("invalid_input", "Choose one option.", 400, { field: "value" });
  return { ...unknown, state: "answered", options };
}

function storedFromRow(row: AnswerRow | undefined): StoredValue {
  if (!row) return null;
  return { state: row.state, bool: row.value_bool, number: row.value_number, text: row.value_text, options: row.value_options };
}

export async function setManualAnswer(actor: Actor, fieldId: string, companyId: string, value: unknown) {
  assertFieldAdmin(actor);
  if (!isUuid(fieldId) || !isUuid(companyId)) throw notFound("company or AI field");
  const { field, saved } = await withActor(actor, async (db) => {
    const field = await readField(db, actor.workspaceId, fieldId);
    if (!field) throw notFound("AI field");
    const company = await db.query("select 1 from crm.companies where id = $1 and workspace_id = $2 and archived_at is null", [companyId, actor.workspaceId]);
    if (!company.rows[0]) throw notFound("company");
    const next = cleanManualValue(field, value);
    const current = (await db.query<AnswerRow>(`${ANSWER_SQL} where a.field_id = $1 and a.company_id = $2 for update of a`, [fieldId, companyId])).rows[0];
    const web =
      current && current.manual
        ? current.web_answer
        : current && current.checked_at && current.state !== "pending"
          ? {
              state: current.state,
              bool: current.value_bool,
              number: storedNumber(current.value_number),
              text: current.value_text,
              options: current.value_options,
              likelihood: current.likelihood,
              confidence: current.confidence,
              reason: current.reason,
              sources: current.sources ?? [],
              checkedAt: new Date(current.checked_at).toISOString(),
            }
          : null;
    await db.query(
      `insert into crm.ai_field_answers (field_id, company_id, workspace_id, state, value_bool, value_number, value_text, value_options,
         likelihood, confidence, reason, sources, next_check_at, claimed_at, manual, manual_at, manual_by, web_answer)
       values ($1, $2, $3, $4, $5, $6, $7, $8, null, null, null, '[]'::jsonb, null, null, true, now(), $9, $10::jsonb)
       on conflict (field_id, company_id) do update set
         state = excluded.state, value_bool = excluded.value_bool, value_number = excluded.value_number, value_text = excluded.value_text,
         value_options = excluded.value_options, next_check_at = null, claimed_at = null, manual = true, manual_at = now(),
         manual_by = excluded.manual_by, web_answer = excluded.web_answer`,
      [fieldId, companyId, actor.workspaceId, next.state, next.bool, next.number, next.text, next.options, actor.userId, web ? JSON.stringify(web) : null],
    );
    await recordAnswerChange(db, actor, field, companyId, storedFromRow(current), next, MANUAL_PROVENANCE);
    return { field, saved: next };
  });
  if (saved.state === "answered" && saved.number !== null) await fillSizeFromStaff(actor, field, companyId, saved.number, MANUAL_PROVENANCE);
  return getAnswer(actor, fieldId, companyId);
}

export async function revertToWebAnswer(actor: Actor, fieldId: string, companyId: string) {
  assertFieldAdmin(actor);
  if (!isUuid(fieldId) || !isUuid(companyId)) throw notFound("company or AI field");
  await withActor(actor, async (db) => {
    const field = await readField(db, actor.workspaceId, fieldId);
    if (!field) throw notFound("AI field");
    const current = (await db.query<AnswerRow>(`${ANSWER_SQL} where a.field_id = $1 and a.company_id = $2 and a.workspace_id = $3 for update of a`, [fieldId, companyId, actor.workspaceId])).rows[0];
    if (!current?.manual) return;
    const web = current.web_answer as Record<string, unknown> | null;
    const interval = field.refresh === "weekly" ? 7 : field.refresh === "monthly" ? 30 : null;
    if (web) {
      await db.query(
        `update crm.ai_field_answers set state = $3, value_bool = $4, value_number = $5, value_text = $6, value_options = $7,
           likelihood = $8, confidence = $9, reason = $10, sources = $11::jsonb, checked_at = $12,
           next_check_at = case when $13::int is null then null else greatest(now(), $12::timestamptz + make_interval(days => $13::int)) end,
           manual = false, manual_at = null, manual_by = null, web_answer = null, claimed_at = null
         where field_id = $1 and company_id = $2`,
        [
          fieldId,
          companyId,
          web.state === "answered" ? "answered" : "unknown",
          typeof web.bool === "boolean" ? web.bool : null,
          typeof web.number === "number" ? web.number : null,
          typeof web.text === "string" ? web.text : null,
          Array.isArray(web.options) ? web.options : null,
          typeof web.likelihood === "number" ? web.likelihood : null,
          typeof web.confidence === "string" ? web.confidence : null,
          typeof web.reason === "string" ? web.reason : null,
          JSON.stringify(Array.isArray(web.sources) ? web.sources : []),
          typeof web.checkedAt === "string" ? web.checkedAt : null,
          interval,
        ],
      );
    } else {
      await db.query(
        `update crm.ai_field_answers set state = 'pending', value_bool = null, value_number = null, value_text = null, value_options = null,
           likelihood = null, confidence = null, reason = null, sources = '[]'::jsonb, checked_at = null, next_check_at = now(),
           manual = false, manual_at = null, manual_by = null, web_answer = null, claimed_at = null
         where field_id = $1 and company_id = $2`,
        [fieldId, companyId],
      );
    }
    const restored: StoredValue = web
      ? {
          state: web.state === "answered" ? "answered" : "unknown",
          bool: typeof web.bool === "boolean" ? web.bool : null,
          number: typeof web.number === "number" ? web.number : null,
          text: typeof web.text === "string" ? web.text : null,
          options: Array.isArray(web.options) ? (web.options as string[]) : null,
        }
      : null;
    await recordAnswerChange(db, actor, field, companyId, storedFromRow(current), restored, MANUAL_PROVENANCE);
  });
  return getAnswer(actor, fieldId, companyId);
}

export async function markCompanyDue(actor: Actor, companyId: string, fieldIds?: string[]) {
  assertFieldAdmin(actor);
  if (!isUuid(companyId)) throw notFound("company");
  const ids = (fieldIds ?? []).filter(isUuid);
  await withActor(actor, (db) =>
    db.query(
      `update crm.ai_field_answers set next_check_at = now()
       where workspace_id = $1 and company_id = $2 and not manual and run_id is null and ($3::uuid[] is null or field_id = any($3::uuid[]))`,
      [actor.workspaceId, companyId, fieldIds ? ids : null],
    ),
  );
}
