import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { sendContactEmail } from "@/lib/crm/inbox";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { logEvent, readRow } from "@/lib/proposals/documents";
import { readBlocks } from "@/lib/proposals/catalogue";
import { longDate, tabsOf, type Block, type Step, type StepSide } from "@/lib/proposals/model";
import { appTimeZone, zonedParts } from "@/lib/time";

export const STEPS_MAX = 60;

type StepRow = { id: string; title: string; side: StepSide; due_date: string | null; done_at: Date | null; done_by: "client" | "user" | null; done_name: string | null };

const COLUMNS = "id, title, side, to_char(due_date, 'YYYY-MM-DD') as due_date, done_at, done_by, done_name";

function toStep(row: StepRow): Step {
  return { id: row.id, title: row.title, side: row.side, dueDate: row.due_date, doneAt: row.done_at ? new Date(row.done_at).toISOString() : null, doneBy: row.done_by, doneName: row.done_name };
}

function invalid(message: string, field?: string) {
  return new CrmError("invalid_input", message, 400, field ? { field } : undefined);
}

function cleanTitle(value: unknown) {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!title || title.length > 300) throw invalid("Give the step a name of up to 300 characters.", "title");
  return title;
}

function cleanDate(value: unknown) {
  if (value === null || value === "" || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("Choose a valid date.", "dueDate");
  return value;
}

function today() {
  const parts = zonedParts(new Date(), appTimeZone());
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function inDays(days: number) {
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function readSteps(db: Db, documentId: string) {
  const result = await db.query<StepRow>(`select ${COLUMNS} from crm.document_steps where document_id = $1 order by position, created_at`, [documentId]);
  return result.rows.map(toStep);
}

export async function seedSteps(db: Db, actor: Actor, documentId: string, blocks: Block[]) {
  const items = blocks.flatMap((block) => (block.type === "steps" ? block.items : [])).filter((item) => item.title.trim());
  let position = 0;
  for (const item of items.slice(0, STEPS_MAX)) {
    await db.query(
      "insert into crm.document_steps (workspace_id, document_id, position, title, side, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7)",
      [actor.workspaceId, documentId, position, item.title.trim().slice(0, 300), item.side, item.dueInDays === null ? null : inDays(item.dueInDays), actor.type === "user" ? actor.userId : null],
    );
    position += 1;
  }
}

async function documentFor(db: Db, actor: Actor, documentId: string) {
  if (!isUuid(documentId)) throw new CrmError("not_found", "Proposal not found.", 404);
  return readRow(db, actor, documentId);
}

export async function listSteps(actor: Actor, documentId: string) {
  return withActor(actor, async (db) => {
    await documentFor(db, actor, documentId);
    return readSteps(db, documentId);
  });
}

export async function addStep(actor: Actor, documentId: string, input: { title?: unknown; side?: unknown; dueDate?: unknown }) {
  assertScope(actor.scopes, "opportunities:write");
  return withActor(actor, async (db) => {
    const row = await documentFor(db, actor, documentId);
    const count = await db.query<{ count: number; next: number }>("select count(*)::int as count, coalesce(max(position), -1) + 1 as next from crm.document_steps where document_id = $1", [row.id]);
    if ((count.rows[0]?.count ?? 0) >= STEPS_MAX) throw invalid(`A plan can have up to ${STEPS_MAX} steps.`);
    const side: StepSide = input.side === "us" ? "us" : "client";
    await db.query(
      "insert into crm.document_steps (workspace_id, document_id, position, title, side, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7)",
      [actor.workspaceId, row.id, count.rows[0]?.next ?? 0, cleanTitle(input.title), side, cleanDate(input.dueDate), actor.type === "user" ? actor.userId : null],
    );
    await recordAudit(db, actor, "document.steps_changed", "document", row.id, { operation: "add_step" }, { added: cleanTitle(input.title) });
    return readSteps(db, row.id);
  });
}

export async function updateStep(actor: Actor, stepId: string, input: { title?: unknown; side?: unknown; dueDate?: unknown; done?: unknown }) {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(stepId)) throw new CrmError("not_found", "Step not found.", 404);
  return withActor(actor, async (db) => {
    const found = await db.query<{ document_id: string }>("select document_id from crm.document_steps where id = $1 and workspace_id = $2", [stepId, actor.workspaceId]);
    const documentId = found.rows[0]?.document_id;
    if (!documentId) throw new CrmError("not_found", "Step not found.", 404);
    const sets: string[] = [];
    const values: unknown[] = [stepId];
    const set = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(sql.replace("?", `$${values.length}`));
    };
    if (input.title !== undefined) set("title = ?", cleanTitle(input.title));
    if (input.side !== undefined) set("side = ?", input.side === "us" ? "us" : "client");
    if (input.dueDate !== undefined) set("due_date = ?", cleanDate(input.dueDate));
    if (input.done !== undefined) {
      if (input.done === true) {
        sets.push("done_at = now()", "done_by = 'user'");
        set("done_name = ?", actor.type === "user" ? (actor.fullName || actor.email) : "Agent");
      } else sets.push("done_at = null", "done_by = null", "done_name = null");
    }
    if (sets.length) await db.query(`update crm.document_steps set ${sets.join(", ")} where id = $1`, values);
    return readSteps(db, documentId);
  });
}

export async function removeStep(actor: Actor, stepId: string) {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(stepId)) throw new CrmError("not_found", "Step not found.", 404);
  return withActor(actor, async (db) => {
    const removed = await db.query<{ document_id: string; title: string }>("delete from crm.document_steps where id = $1 and workspace_id = $2 returning document_id, title", [stepId, actor.workspaceId]);
    const row = removed.rows[0];
    if (!row) throw new CrmError("not_found", "Step not found.", 404);
    await recordAudit(db, actor, "document.steps_changed", "document", row.document_id, { operation: "remove_step" }, { removed: row.title });
    return readSteps(db, row.document_id);
  });
}

export async function moveStep(actor: Actor, stepId: string, by: -1 | 1) {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(stepId)) throw new CrmError("not_found", "Step not found.", 404);
  return withActor(actor, async (db) => {
    const found = await db.query<{ document_id: string }>("select document_id from crm.document_steps where id = $1 and workspace_id = $2", [stepId, actor.workspaceId]);
    const documentId = found.rows[0]?.document_id;
    if (!documentId) throw new CrmError("not_found", "Step not found.", 404);
    const ids = (await readSteps(db, documentId)).map((step) => step.id);
    const index = ids.indexOf(stepId);
    const target = index + by;
    if (target < 0 || target >= ids.length) return readSteps(db, documentId);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    for (const [position, id] of ids.entries()) await db.query("update crm.document_steps set position = $2 where id = $1", [id, position]);
    return readSteps(db, documentId);
  });
}

export async function emailOpenSteps(actor: UserActor, documentId: string, url: string, fetchImpl?: typeof fetch) {
  const { row, steps } = await withActor(actor, async (db) => {
    const current = await documentFor(db, actor, documentId);
    return { row: current, steps: await readSteps(db, current.id) };
  });
  const open = steps.filter((step) => step.side === "client" && !step.doneAt);
  if (open.length === 0) throw invalid("There are no open steps for the client.");
  const first = (row.contact_name ?? "").split(/\s+/)[0] || "there";
  const lines = open.map((step) => `- ${step.title}${step.dueDate ? `, by ${longDate(step.dueDate)}` : ""}`).join("\n");
  const tab = tabsOf(readBlocks(row.blocks))?.find((entry) => entry.blocks.some((block) => block.type === "steps"));
  const body = `Hi ${first},\n\nHere are the next steps on your side:\n\n${lines}\n\nYou can tick them off as you go here:\n${url}${tab ? `#${tab.slug}` : ""}`;
  const sent = await sendContactEmail(actor, row.contact_id, { subject: `Next steps: ${row.title}`, body }, fetchImpl);
  await withActor(actor, (db) => logEvent(db, { workspaceId: actor.workspaceId, documentId: row.id, type: "steps_emailed", actor: "user", userId: actor.userId, data: { count: open.length } }));
  return { warning: sent.warning ?? null };
}
