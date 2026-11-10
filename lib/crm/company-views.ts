import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, tooLong } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor } from "@/lib/crm/types";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";
import { normaliseViewParams } from "@/lib/ai-fields/params";
import type { CompanyView } from "@/lib/ai-fields/types";

type ViewRow = { id: string; name: string; params: string; created_at: Date };

function toView(row: ViewRow): CompanyView {
  return { id: row.id, name: row.name, params: row.params, createdAt: new Date(row.created_at).toISOString() };
}

function assertViewAdmin(actor: Actor) {
  if (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new CrmError("forbidden", "Only owners and admins can change saved views.", 403);
  }
}

export function cleanViewParams(value: unknown) {
  const text = normaliseViewParams(typeof value === "string" ? value : "");
  if (text.length > 4000) throw new CrmError("invalid_input", "This view has too many filters to save.", 400);
  try {
    companyQueryFromSearchParams(new URLSearchParams(text));
  } catch (error) {
    const detail = error instanceof CrmError ? ` ${error.message}` : "";
    throw new CrmError("invalid_input", `This view has an invalid filter.${detail}`, 400, { field: "params" });
  }
  return text;
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 60) throw new CrmError("invalid_input", tooLong("the name", 60), 400, { field: "name" });
  if (name.toLowerCase() === "all companies") throw new CrmError("invalid_input", "Choose another name.", 400, { field: "name" });
  return name;
}

function conflict(error: unknown, name: string): never {
  if ((error as { code?: string }).code === "23505") throw new CrmError("conflict", `${name} already exists.`, 409, { field: "name" });
  throw error;
}

export async function listCompanyViews(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<ViewRow>("select id, name, params, created_at from crm.company_views where workspace_id = $1 order by lower(name)", [actor.workspaceId]);
    return result.rows.map(toView);
  });
}

export async function createCompanyView(actor: Actor, input: { name?: unknown; params?: unknown }) {
  assertViewAdmin(actor);
  const name = cleanName(input.name);
  const params = cleanViewParams(input.params);
  return withActor(actor, async (db) => {
    try {
      const result = await db.query<ViewRow>(
        "insert into crm.company_views (workspace_id, name, params, created_by_user_id) values ($1, $2, $3, $4) returning id, name, params, created_at",
        [actor.workspaceId, name, params, actor.type === "user" ? actor.userId : null],
      );
      return toView(result.rows[0]);
    } catch (error) {
      return conflict(error, name);
    }
  });
}

export async function updateCompanyView(actor: Actor, id: string, input: { name?: unknown; params?: unknown }) {
  assertViewAdmin(actor);
  if (!isUuid(id)) throw notFound("view");
  const name = input.name === undefined ? null : cleanName(input.name);
  const params = input.params === undefined ? null : cleanViewParams(input.params);
  return withActor(actor, async (db) => {
    try {
      const result = await db.query<ViewRow>(
        `update crm.company_views set name = coalesce($3, name), params = coalesce($4, params)
         where id = $1 and workspace_id = $2 returning id, name, params, created_at`,
        [id, actor.workspaceId, name, params],
      );
      if (!result.rows[0]) throw notFound("view");
      return toView(result.rows[0]);
    } catch (error) {
      return conflict(error, name ?? "that name");
    }
  });
}

export async function deleteCompanyView(actor: Actor, id: string) {
  assertViewAdmin(actor);
  if (!isUuid(id)) throw notFound("view");
  await withActor(actor, async (db) => {
    const used = await db.query<{ label: string }>("select label from crm.ai_fields where workspace_id = $1 and scope_view_id = $2 order by label limit 1", [actor.workspaceId, id]);
    if (used.rows[0]) throw new CrmError("conflict", `${used.rows[0].label} uses this view. Change that first.`, 409);
    await db.query("delete from crm.company_views where id = $1 and workspace_id = $2", [id, actor.workspaceId]);
  });
}
