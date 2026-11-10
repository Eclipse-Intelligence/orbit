import { createHmac } from "node:crypto";
import { appSecret } from "@/lib/auth/config";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, EmailRead, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export function addressHash(address: string | null | undefined) {
  const value = address?.split(",")[0]?.trim();
  if (!value) return null;
  return createHmac("sha256", appSecret()).update(`viewer:${value}`).digest("hex").slice(0, 40);
}

export function opensSql(alias: string) {
  return `case when ${alias}.tracking_id is not null then (
    select coalesce(json_agg(json_build_object('at', o.opened_at, 'agent', o.agent) order by o.opened_at desc), '[]'::json)
    from crm.mail_opens o where o.tracking_id = ${alias}.tracking_id
  ) end`;
}

export function readsSql(alias: string) {
  return `case when ${alias}.tracking_id is not null then (
    select json_build_object('count', count(*)::int, 'last', max(o.opened_at)) from crm.mail_opens o where o.tracking_id = ${alias}.tracking_id
  ) end`;
}

export function readerAgent(userAgent: string | null | undefined) {
  const agent = userAgent ?? "";
  if (/GoogleImageProxy|ggpht/i.test(agent)) return "Gmail";
  if (/YahooMailProxy/i.test(agent)) return "Yahoo Mail";
  if (/Microsoft Outlook|ms-office|MSOffice|Outlook-iOS|Outlook-Android/i.test(agent)) return "Outlook";
  if (/iPhone/i.test(agent)) return "iPhone";
  if (/iPad/i.test(agent)) return "iPad";
  if (/Android/i.test(agent)) return "Android";
  if (/Macintosh|Mac OS X/i.test(agent)) return "Mac";
  if (/Windows/i.test(agent)) return "Windows";
  return null;
}

export async function recordOpen(trackingId: string, address: string | null, userAgent: string | null) {
  if (!isUuid(trackingId)) return false;
  const result = await query<{ recorded: boolean }>("select private.record_mail_open($1, $2, $3) as recorded", [
    trackingId,
    addressHash(address),
    readerAgent(userAgent),
  ]);
  return Boolean(result.rows[0]?.recorded);
}

export async function noteViewerAddress(actor: UserActor, address: string | null) {
  const hash = addressHash(address);
  if (!hash) return;
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.mail_viewer_addresses (workspace_id, user_id, address_hash)
       values ($1, $2, $3)
       on conflict (user_id, address_hash) do update set seen_at = now()
       where crm.mail_viewer_addresses.seen_at < now() - interval '1 hour'`,
      [actor.workspaceId, actor.userId, hash],
    ),
  );
}

export async function readStatusesOn(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ read_statuses: boolean }>(
      "select read_statuses from crm.mail_preferences where user_id = $1 order by updated_at desc limit 1",
      [actor.userId],
    );
    return result.rows[0]?.read_statuses ?? true;
  });
}

export async function setReadStatuses(actor: UserActor, on: boolean) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.mail_preferences (workspace_id, user_id, read_statuses) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set read_statuses = excluded.read_statuses, updated_at = now()`,
      [actor.workspaceId, actor.userId, on],
    ),
  );
  return on;
}

export async function activityReads(actor: Actor, activityIds: string[]): Promise<Record<string, EmailRead>> {
  const ids = [...new Set(activityIds.filter(isUuid))];
  if (actor.type !== "user" || ids.length === 0) return {};
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{
      activity_id: string;
      recipients: { name: string | null; address: string }[] | null;
      sent_at: Date | string | null;
      opens: { at: string; agent: string | null }[];
    }>(
      `select distinct on (t.activity_id) t.activity_id, t.recipients, t.sent_at,
         coalesce((
           select json_agg(json_build_object('at', o.opened_at, 'agent', o.agent) order by o.opened_at desc)
           from crm.mail_opens o where o.tracking_id = t.id and o.user_id = $2
         ), '[]'::json) as opens
       from crm.mail_tracking t
       where t.activity_id = any($1::uuid[]) and t.user_id = $2 and t.workspace_id = $3 and t.sent_at is not null
       order by t.activity_id, t.sent_at desc`,
      [ids, actor.userId, actor.workspaceId],
    );
    return result.rows;
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.activity_id,
      {
        opens: row.opens.map((open) => ({ at: new Date(open.at).toISOString(), agent: open.agent })),
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
      },
    ]),
  );
}

export async function timelineReads(actor: Actor, activities: { id: string; type: string }[]) {
  return activityReads(
    actor,
    activities.filter((activity) => activity.type === "email").map((activity) => activity.id),
  ).catch((error: unknown) => {
    console.error("Read statuses failed to load", error);
    return {} as Record<string, EmailRead>;
  });
}
