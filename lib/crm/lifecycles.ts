import { builtInLifecycle, cleanLifecycle, lifecycleLabel } from "@/lib/companies";
import { setCompanyLifecycleInDb } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { lockNamespace } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { LIFECYCLES, type Actor, type LifecycleCount } from "@/lib/crm/types";

export async function listLifecycles(actor: Actor): Promise<LifecycleCount[]> {
  assertScope(actor.scopes, "crm:read");
  const used = await withActor(actor, async (db) => {
    const result = await db.query<{ lifecycle: string; companies: number }>(
      `select lifecycle, count(*)::int as companies
       from crm.companies
       where workspace_id = $1 and archived_at is null
       group by lifecycle`,
      [actor.workspaceId],
    );
    return result.rows;
  });
  const counts = new Map(used.map((row) => [row.lifecycle, row.companies]));
  const builtIn = LIFECYCLES.map((value) => ({ value, label: lifecycleLabel(value), companies: counts.get(value) ?? 0, builtIn: true }));
  const custom = used
    .filter((row) => !(LIFECYCLES as readonly string[]).includes(row.lifecycle))
    .map((row) => ({ value: row.lifecycle, label: row.lifecycle, companies: row.companies, builtIn: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...builtIn, ...custom];
}

function customName(value: unknown, message: string) {
  const name = typeof value === "string" ? cleanLifecycle(value) : null;
  if (!name) throw new CrmError("invalid_input", message, 400, { field: "name" });
  return name;
}

async function moveCompanies(actor: Actor, from: string, to: string, operation: string) {
  return withActor(actor, async (db) => {
    await lockNamespace(db, actor.workspaceId, "companies");
    const companies = await db.query<{ id: string }>(
      "select id from crm.companies where workspace_id = $1 and lifecycle = $2 and archived_at is null order by id",
      [actor.workspaceId, from],
    );
    let moved = 0;
    for (const row of companies.rows) {
      const result = await setCompanyLifecycleInDb(db, actor, row.id, to, { operation, source: "web" }, from.toLowerCase() === to.toLowerCase());
      if (result.changed) moved += 1;
    }
    return { companies: moved };
  });
}

export async function renameLifecycle(actor: Actor, from: unknown, to: unknown) {
  assertScope(actor.scopes, "companies:write");
  const source = customName(from, "Choose a lifecycle to rename.");
  if (builtInLifecycle(source)) {
    throw new CrmError("invalid_input", "Lead, Prospect, Customer and Churned are built in and keep their names.", 400, { field: "name" });
  }
  const target = customName(to, "Enter a new name.");
  if (target === source) return { companies: 0 };
  return moveCompanies(actor, source, target, "rename_lifecycle");
}

export async function deleteLifecycle(actor: Actor, name: unknown) {
  assertScope(actor.scopes, "companies:write");
  const target = customName(name, "Choose a lifecycle to delete.");
  if (builtInLifecycle(target)) {
    throw new CrmError("invalid_input", "Lead, Prospect, Customer and Churned are built in and can't be deleted.", 400, { field: "name" });
  }
  return moveCompanies(actor, target, "lead", "delete_lifecycle");
}
