import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export const LINEAR_ELSEWHERE = "Linear isn't connected in this workspace.";

export type LinearConnection = { here: boolean; claimable: boolean };

export async function linearHere(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query("select 1 from crm.integration_settings where integration = 'linear' and workspace_id = $1", [actor.workspaceId]);
    return (result.rowCount ?? 0) > 0;
  });
}

export async function linearConnection(actor: UserActor): Promise<LinearConnection> {
  const here = await linearHere(actor);
  if (here) return { here, claimable: false };
  const claimed = await query<{ claimed: boolean }>("select private.integration_claimed('linear') as claimed");
  return { here: false, claimable: !claimed.rows[0]?.claimed && (actor.role === "owner" || actor.role === "admin") };
}

export async function assertLinearHere(actor: UserActor) {
  if (!(await linearHere(actor))) throw new CrmError("forbidden", LINEAR_ELSEWHERE, 403);
}

function requireAdmin(actor: UserActor) {
  if (actor.role !== "owner" && actor.role !== "admin") throw new CrmError("forbidden", "Only workspace owners and admins can change where Linear is connected.", 403);
}

export async function connectLinear(actor: UserActor) {
  requireAdmin(actor);
  const added = await withActor(actor, (db) =>
    db.query(
      "insert into crm.integration_settings (integration, workspace_id, connected_by) values ('linear', $1, $2) on conflict (integration) do nothing",
      [actor.workspaceId, actor.userId],
    ),
  );
  if ((added.rowCount ?? 0) === 0 && !(await linearHere(actor))) throw new CrmError("conflict", "Linear can't be connected here.", 409);
}

export async function disconnectLinear(actor: UserActor) {
  requireAdmin(actor);
  await withActor(actor, (db) => db.query("delete from crm.integration_settings where integration = 'linear' and workspace_id = $1", [actor.workspaceId]));
}
