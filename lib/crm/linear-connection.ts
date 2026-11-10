import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export const LINEAR_ELSEWHERE = "Linear isn't connected in this workspace.";

export type LinearConnection = { here: boolean; claimable: boolean };

export async function linearHere(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query("select 1 from crm.integration_settings where integration = 'linear' and workspace_id = $1", [actor.workspaceId]);
    return (result.rowCount ?? 0) > 0;
  });
}

async function ownsEclipseBrand(actor: UserActor) {
  const result = await query<{ owns: boolean }>("select private.owns_eclipse_brand($1) as owns", [actor.userId]);
  return result.rows[0]?.owns === true;
}

function isAdmin(actor: UserActor) {
  return actor.role === "owner" || actor.role === "admin";
}

export async function linearConnection(actor: UserActor): Promise<LinearConnection> {
  const here = await linearHere(actor);
  if (here || !isAdmin(actor)) return { here, claimable: false };
  const claimed = await query<{ claimed: boolean }>("select private.integration_claimed('linear') as claimed");
  return { here: false, claimable: !claimed.rows[0]?.claimed && (await ownsEclipseBrand(actor)) };
}

export async function assertLinearHere(actor: UserActor) {
  if (!(await linearHere(actor))) throw new CrmError("forbidden", LINEAR_ELSEWHERE, 403);
}

function requireAdmin(actor: UserActor) {
  if (!isAdmin(actor)) throw new CrmError("forbidden", "Only owners and admins can change where Linear is connected.", 403);
}

export async function connectLinear(actor: UserActor, provenance?: Provenance) {
  requireAdmin(actor);
  if (!(await ownsEclipseBrand(actor))) throw new CrmError("forbidden", "Linear can't be connected here.", 403);
  const added = await withActor(actor, async (db) => {
    const inserted = await db.query(
      "insert into crm.integration_settings (integration, workspace_id, connected_by) values ('linear', $1, $2) on conflict (integration) do nothing",
      [actor.workspaceId, actor.userId],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      await recordAudit(db, actor, "integration.connected", "integration", actor.workspaceId, provenance ?? { operation: "connect_linear" }, { integration: "linear" });
    }
    return (inserted.rowCount ?? 0) > 0;
  });
  if (!added && !(await linearHere(actor))) throw new CrmError("conflict", "Linear can't be connected here.", 409);
}

export async function disconnectLinear(actor: UserActor, provenance?: Provenance) {
  requireAdmin(actor);
  await withActor(actor, async (db) => {
    const removed = await db.query("delete from crm.integration_settings where integration = 'linear' and workspace_id = $1", [actor.workspaceId]);
    if ((removed.rowCount ?? 0) > 0) {
      await recordAudit(db, actor, "integration.disconnected", "integration", actor.workspaceId, provenance ?? { operation: "disconnect_linear" }, { integration: "linear" });
    }
  });
}
