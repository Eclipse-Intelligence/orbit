import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { splitCase, splitJoin } from "@/lib/mail/split";
import type { MailSplit } from "@/lib/mail/view";
import { pushToUser, type PushSender } from "@/lib/push";

const FRESH_HOURS = 6;
const GROUP_AFTER = 3;

export type NotifyMail = "important" | "all" | "none";

type Arrival = {
  id: string;
  source_id: string;
  tk: string;
  subject: string | null;
  snippet: string | null;
  from_email: string | null;
  from_name: string | null;
  split: MailSplit;
};

export async function mailNotifyLevel(actor: UserActor): Promise<NotifyMail> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ notify_mail: NotifyMail }>(
      "select notify_mail from crm.mail_preferences where workspace_id = $1 and user_id = $2",
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0]?.notify_mail ?? "important";
  });
}

export async function notifyNewMail(actor: UserActor, messageIds: string[], options: { send?: PushSender } = {}) {
  if (messageIds.length === 0) return { sent: 0 };
  const level = await mailNotifyLevel(actor);
  if (level === "none") return { sent: 0 };
  const arrivals = await withActor(actor, async (db) => {
    const result = await db.query<Arrival>(
      `select n.id, n.source_id, n.tk, n.subject, n.snippet, n.from_email, n.from_name, ${splitCase("n", "$2")} as split
       from (
         select m.id, m.source_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk, m.subject, m.snippet, m.from_email, m.from_name,
           m.focused, coalesce(m.received_at, m.sent_at, m.created_at) as at
         from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
         where m.user_id = $1 and m.id = any($3::uuid[]) and f.role = 'inbox' and not m.is_read and not m.is_draft
           and coalesce(m.received_at, m.sent_at, m.created_at) > now() - make_interval(hours => $4)
           and lower(coalesce(m.from_email, '')) <> all (
             select lower(s.email) from crm.mail_sources s where s.user_id = $1
             union select lower($5::text)
           )
       ) n
       ${splitJoin("n", "$1")}
       order by n.at asc`,
      [actor.userId, actor.workspaceId, messageIds, FRESH_HOURS, actor.email],
    );
    return result.rows;
  });
  const wanted = arrivals.filter((item) => level === "all" || item.split === "important" || item.split === "calendar");
  if (wanted.length === 0) return { sent: 0 };
  const { mailUnreadCount } = await import("@/lib/mail/threads");
  const badge = await mailUnreadCount(actor).catch(() => null);
  if (wanted.length > GROUP_AFTER) {
    const senders = [...new Set(wanted.map((item) => item.from_name || item.from_email || "Someone"))];
    const result = await pushToUser(
      actor,
      {
        title: `${wanted.length} new emails`,
        body: `From ${senders.slice(0, 3).join(", ")}${senders.length > 3 ? ` and ${senders.length - 3} more` : ""}`,
        url: "/mail",
        tag: "mail-batch",
        badge,
      },
      options,
    );
    return { sent: result.sent };
  }
  let sent = 0;
  for (const item of wanted) {
    const key = `${item.source_id}|${item.tk}`;
    const result = await pushToUser(
      actor,
      {
        title: item.from_name || item.from_email || "New email",
        body: [item.subject?.trim() || "(no subject)", item.snippet?.trim()].filter(Boolean).join("\n").slice(0, 300),
        url: `/mail?view=inbox:${item.split === "calendar" ? "calendar" : "important"}&thread=${encodeURIComponent(key)}`,
        tag: key,
        badge,
      },
      options,
    );
    sent += result.sent;
  }
  return { sent };
}

export async function setMailNotifications(actor: UserActor, input: { mail?: NotifyMail; calendarMinutes?: number | null; reads?: boolean }) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.mail_preferences (workspace_id, user_id, notify_mail, notify_calendar_minutes, notify_reads)
       values ($1, $2, coalesce($3, 'important'), $4, coalesce($5, false))
       on conflict (workspace_id, user_id) do update set
         notify_mail = coalesce($3, crm.mail_preferences.notify_mail),
         notify_calendar_minutes = case when $6 then $4 else crm.mail_preferences.notify_calendar_minutes end,
         notify_reads = coalesce($5, crm.mail_preferences.notify_reads),
         updated_at = now()`,
      [
        actor.workspaceId,
        actor.userId,
        input.mail ?? null,
        input.calendarMinutes === undefined ? 10 : input.calendarMinutes,
        input.reads ?? null,
        input.calendarMinutes !== undefined,
      ],
    ),
  );
}

export async function notificationSettings(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ notify_mail: NotifyMail; notify_calendar_minutes: number | null; notify_reads: boolean }>(
      "select notify_mail, notify_calendar_minutes, notify_reads from crm.mail_preferences where workspace_id = $1 and user_id = $2",
      [actor.workspaceId, actor.userId],
    );
    const devices = await db.query<{ count: number }>("select count(*)::int as count from crm.push_subscriptions where user_id = $1", [actor.userId]);
    const row = result.rows[0];
    return {
      mail: row?.notify_mail ?? "important",
      calendarMinutes: row ? row.notify_calendar_minutes : 10,
      reads: row?.notify_reads ?? false,
      devices: devices.rows[0]?.count ?? 0,
    };
  });
}
