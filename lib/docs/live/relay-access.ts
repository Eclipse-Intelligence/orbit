import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { parseTopic } from "@/lib/docs/live/protocol";
import { pageInScope } from "@/lib/docs/store";

export async function relayAllows(actor: UserActor, topic: string, send: boolean) {
  const target = parseTopic(topic);
  if (!target) return false;
  if (target.kind === "person") return !send && target.id === actor.userId;
  if (target.kind === "workspace") return !send && target.id === actor.workspaceId;
  if (!isUuid(target.id)) return false;
  return withActor(actor, async (db) => {
    const result = await db.query<{ archived: boolean }>(
      `select archived_at is not null as archived from crm.pages p where id = $1 and ${pageInScope("p", 2, 3)}`,
      [target.id, actor.workspaceId, actor.userId],
    );
    const row = result.rows[0];
    return Boolean(row) && !(send && row.archived);
  });
}
