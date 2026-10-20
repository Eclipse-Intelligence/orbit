import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { MAIL_SPLITS, type MailSplit } from "@/lib/mail/view";

const CALENDAR_SUBJECT =
  "^(accepted|declined|tentative|tentatively accepted|invitation|updated invitation|canceled|cancelled|new time proposed|meeting forward notification|invitation updated)\\M";
const CALENDAR_SENDER = "^(calendar-notification|calendar|noreply-calendar|invites?)@";
const AUTOMATED_SENDER =
  "^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|newsletters?|news|updates?|marketing|mailer|mailer-daemon|digest|alerts?|bounces?|automated|robot|billing|receipts?|invoices?|info|hello|team)([._+-][^@]*)?@";
const AUTOMATED_DOMAIN = "@(e|em|email|mail|mailer|mg|news|newsletter|marketing|notifications?|alerts?|updates?|bounce|post)\\.";

export function splitJoin(alias: string, userParam: string) {
  return `left join lateral (
    select sr.split from crm.mail_sender_rules sr
    where sr.user_id = ${userParam}
      and (sr.sender = lower(${alias}.from_email) or sr.sender = '@' || split_part(lower(${alias}.from_email), '@', 2))
    order by sr.sender like '@%'
    limit 1
  ) rule on true`;
}

export function splitCase(alias: string, workspaceParam: string) {
  return `case
    when rule.split is not null then rule.split
    when coalesce(${alias}.subject, '') ~* '${CALENDAR_SUBJECT}' or coalesce(${alias}.from_email, '') ~* '${CALENDAR_SENDER}' then 'calendar'
    when exists (
      select 1 from crm.contacts c
      where c.workspace_id = ${workspaceParam} and c.archived_at is null and c.normalized_email = lower(${alias}.from_email)
    ) then 'important'
    when exists (
      select 1 from crm.mail_messages own
      join crm.mail_folders own_folder on own_folder.id = own.folder_id
      where own.source_id = ${alias}.source_id and coalesce(own.thread_key, 'm:' || own.id::text) = ${alias}.tk and own_folder.role = 'sent'
    ) then 'important'
    when coalesce(${alias}.from_email, '') ~* '${AUTOMATED_SENDER}' or coalesce(${alias}.from_email, '') ~* '${AUTOMATED_DOMAIN}' then 'news'
    when ${alias}.focused is false then 'other'
    else 'important'
  end`;
}

function senderKey(value: string) {
  const text = value.trim().toLowerCase();
  if (text.startsWith("@")) {
    const domain = text.slice(1);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? `@${domain}` : null;
  }
  return canonicalEmail(text);
}

export async function setSenderSplit(actor: UserActor, sender: string, split: MailSplit | null) {
  const key = senderKey(sender);
  if (!key) throw new CrmError("invalid_input", "Choose an email address or @domain.", 400, { field: "sender" });
  if (split && !MAIL_SPLITS.includes(split)) throw new CrmError("invalid_input", "Choose Important, Other, News or Calendar.", 400, { field: "split" });
  await withActor(actor, async (db) => {
    if (!split) {
      await db.query("delete from crm.mail_sender_rules where user_id = $1 and sender = $2", [actor.userId, key]);
      return;
    }
    await db.query(
      `insert into crm.mail_sender_rules (workspace_id, user_id, sender, split) values ($1, $2, $3, $4)
       on conflict (user_id, sender) do update set split = excluded.split, created_at = now()`,
      [actor.workspaceId, actor.userId, key, split],
    );
  });
  return { sender: key, split };
}
