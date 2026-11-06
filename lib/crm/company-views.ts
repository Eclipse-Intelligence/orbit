import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor } from "@/lib/crm/types";
import type { CompanyView } from "@/lib/ai-fields/types";

const VIEW_PARAMS_SKIPPED = new Set(["page", "view", "record", "limit", "offset"]);

type ViewRow = { id: string; name: string; params: string; created_at: Date };

function toView(row: ViewRow): CompanyView {
  return { id: row.id, name: row.name, params: row.params, createdAt: new Date(row.created_at).toISOString() };
}

function assertViewAdmin(actor: Actor) {
  if (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "admin")) {
    throw new CrmError("forbidden", "Only workspace owners and admins can change saved views.", 403);
  }
}

export function cleanViewParams(value: unknown) {
  const raw = typeof value === "string" ? value.replace(/^\?/, "") : "";
  const params = new URLSearchParams(raw);
  const kept = new URLSearchParams();
  for (const [key, entry] of params.entries()) {
    if (VIEW_PARAMS_SKIPPED.has(key) || !entry) continue;
    if (key.length > 60 || entry.length > 500) continue;
    kept.set(key, entry);
  }
  kept.sort();
  const text = kept.toString();
  if (text.length > 4000) throw new CrmError("invalid_input", "This view has too many filters to save.", 400);
  return text;
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 60) throw new CrmError("invalid_input", "Give the view a name of up to 60 characters.", 400, { field: "name" });
  if (name.toLowerCase() === "all companies") throw new CrmError("invalid_input", "All companies is already a view. Choose another name.", 400, { field: "name" });
  return name;
}

function conflict(error: unknown, name: string): never {
  if ((error as { code?: string }).code === "23505") throw new CrmError("conflict", `There's already a view called ${name}.`, 409, { field: "name" });
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
  if (!isUuid(id)) throw new CrmError("not_found", "That view no longer exists.", 404);
  const name = input.name === undefined ? null : cleanName(input.name);
  const params = input.params === undefined ? null : cleanViewParams(input.params);
  return withActor(actor, async (db) => {
    try {
      const result = await db.query<ViewRow>(
        `update crm.company_views set name = coalesce($3, name), params = coalesce($4, params)
         where id = $1 and workspace_id = $2 returning id, name, params, created_at`,
        [id, actor.workspaceId, name, params],
      );
      if (!result.rows[0]) throw new CrmError("not_found", "That view no longer exists.", 404);
      return toView(result.rows[0]);
    } catch (error) {
      return conflict(error, name ?? "that name");
    }
  });
}

export async function deleteCompanyView(actor: Actor, id: string) {
  assertViewAdmin(actor);
  if (!isUuid(id)) throw new CrmError("not_found", "That view no longer exists.", 404);
  await withActor(actor, async (db) => {
    const used = await db.query<{ label: string }>("select label from crm.ai_fields where workspace_id = $1 and scope_view_id = $2 order by label limit 1", [actor.workspaceId, id]);
    if (used.rows[0]) throw new CrmError("conflict", `${used.rows[0].label} checks the companies in this view. Change its companies first.`, 409);
    await db.query("delete from crm.company_views where id = $1 and workspace_id = $2", [id, actor.workspaceId]);
  });
}
