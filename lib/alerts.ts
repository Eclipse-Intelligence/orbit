import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { pushToUser, type PushSender } from "@/lib/push";
import { notify } from "@/lib/workflows/engine";

type Alert = {
  key?: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
  bell?: { title: string; body?: string | null; href?: string | null };
};

export async function sendAlert(actor: UserActor, alert: Alert, options: { send?: PushSender } = {}) {
  if (alert.key) {
    const fresh = await withActor(actor, async (db) => {
      const result = await db.query(
        `insert into crm.push_log (workspace_id, user_id, key) values ($1, $2, $3)
         on conflict (user_id, key) do nothing returning id`,
        [actor.workspaceId, actor.userId, alert.key!.slice(0, 500)],
      );
      return (result.rowCount ?? 0) > 0;
    });
    if (!fresh) return { sent: 0, skipped: true };
  }
  if (alert.bell) {
    await notify(actor, actor.userId, { title: alert.bell.title, body: alert.bell.body ?? null, href: alert.bell.href ?? null, source: "mail" }).catch(() => undefined);
  }
  const result = await pushToUser(actor, { title: alert.title, body: alert.body, url: alert.url, tag: alert.tag }, options);
  return { sent: result.sent, skipped: false };
}
