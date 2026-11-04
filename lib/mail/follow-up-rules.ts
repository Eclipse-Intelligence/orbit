import { dayKey, nonWorkingReason, shiftDay } from "@/lib/crm/task-due";
import { zonedParts, zonedTimeToDate } from "@/lib/time";

export const FOLLOW_UP_ZONE = "Europe/London";
export const FOLLOW_UP_MAX_DAYS = 10;
export const FOLLOW_UP_BODY_MAX = 20_000;

export function followUpDueAt(fromMs: number, workingDays: number, timeZone = FOLLOW_UP_ZONE) {
  const start = zonedParts(new Date(fromMs), timeZone);
  let key = dayKey(start.year, start.month, start.day);
  let left = Math.max(1, Math.round(workingDays));
  while (left > 0) {
    key = shiftDay(key, 1);
    if (!nonWorkingReason(key)) left -= 1;
  }
  const [year, month, day] = key.split("-").map(Number);
  return zonedTimeToDate({ year, month, day, hour: 9, minute: 0, second: 0 }, timeZone);
}

export function readFollowUpDays(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= FOLLOW_UP_MAX_DAYS ? value : null;
}

export function readFollowUpBody(value: unknown) {
  if (typeof value !== "string") return null;
  const body = value.replace(/\r\n/g, "\n").trim();
  return body ? body.slice(0, FOLLOW_UP_BODY_MAX) : null;
}

export function ownMailAddresses(userParam: string, emailParam: string) {
  return `(
    select lower(s.email) from crm.mail_sources s where s.user_id = ${userParam}
    union select lower(i.email) from crm.send_identities i where i.user_id = ${userParam}
    union select lower(${emailParam}::text)
  )`;
}

export function replyAfterSql(reminder: string, userParam: string, emailParam: string) {
  return `select rp.id, rp.from_name, rp.from_email from crm.mail_messages rp
    join crm.mail_folders rpf on rpf.id = rp.folder_id
    where rp.user_id = ${userParam} and rp.source_id = ${reminder}.source_id
      and coalesce(rp.thread_key, 'm:' || rp.id::text) = ${reminder}.thread_key
      and not rp.is_draft and rpf.role not in ('drafts', 'outbox')
      and coalesce(rp.received_at, rp.sent_at, rp.created_at) > ${reminder}.created_at
      and lower(coalesce(rp.from_email, '')) <> all ${ownMailAddresses(userParam, emailParam)}
    order by coalesce(rp.received_at, rp.sent_at, rp.created_at), rp.id`;
}
