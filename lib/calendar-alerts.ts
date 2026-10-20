import { sendAlert } from "@/lib/alerts";
import { memberActor } from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import type { PushSender } from "@/lib/push";
import { appTimeZone } from "@/lib/time";

type EventRow = {
  subject: string | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  location: string | null;
  online_meeting_url: string | null;
  ical_uid: string | null;
  provider_event_id: string | null;
};

function time(value: Date | string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: appTimeZone() }).format(new Date(value));
}

export function eventAlertKey(event: { ical_uid: string | null; provider_event_id: string | null; starts_at: Date | string }) {
  return `cal:${event.ical_uid ?? event.provider_event_id ?? "event"}:${new Date(event.starts_at).toISOString().slice(0, 16)}`;
}

export function startsIn(start: Date | string, now: number) {
  const minutes = Math.round((new Date(start).getTime() - now) / 60_000);
  if (minutes <= 0) return "is starting now";
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export async function calendarAlerts(actor: UserActor, options: { now?: number; send?: PushSender } = {}) {
  const now = options.now ?? Date.now();
  const { minutes, events } = await withActor(actor, async (db) => {
    const pref = await db.query<{ notify_calendar_minutes: number | null }>(
      "select notify_calendar_minutes from crm.mail_preferences where workspace_id = $1 and user_id = $2",
      [actor.workspaceId, actor.userId],
    );
    const minutes = pref.rows.length ? pref.rows[0].notify_calendar_minutes : 10;
    if (minutes === null) return { minutes, events: [] as EventRow[] };
    const result = await db.query<EventRow>(
      `select subject, starts_at, ends_at, location, online_meeting_url, ical_uid, provider_event_id
       from crm.calendar_events
       where user_id = $1 and workspace_id = $2 and not is_cancelled and not is_all_day
         and starts_at > $3::timestamptz - interval '2 minutes'
         and starts_at <= $3::timestamptz + make_interval(mins => $4)
       order by starts_at
       limit 20`,
      [actor.userId, actor.workspaceId, new Date(now).toISOString(), minutes],
    );
    return { minutes, events: result.rows };
  });
  if (minutes === null) return { sent: 0 };
  const seen = new Set<string>();
  let sent = 0;
  for (const event of events) {
    const key = eventAlertKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const place = event.online_meeting_url ? "Tap to join" : event.location?.trim() || null;
    const result = await sendAlert(
      actor,
      {
        key,
        title: `${event.subject?.trim() || "Meeting"} ${startsIn(event.starts_at, now)}`,
        body: [`${time(event.starts_at)}${event.ends_at ? ` to ${time(event.ends_at)}` : ""}`, place].filter(Boolean).join(" · "),
        url: event.online_meeting_url ?? "/calendar",
        tag: key,
      },
      { send: options.send },
    );
    sent += result.sent;
  }
  return { sent };
}

export async function processAllCalendarAlerts(deadline: number) {
  const members = await query<Parameters<typeof memberActor>[0]>("select * from private.calendar_alert_members()");
  let sent = 0;
  for (const row of members.rows) {
    if (Date.now() > deadline) break;
    sent += (await calendarAlerts(memberActor(row)).catch((error) => {
      console.error("Calendar alert failed", error);
      return { sent: 0 };
    })).sent;
  }
  return { users: members.rows.length, sent };
}
