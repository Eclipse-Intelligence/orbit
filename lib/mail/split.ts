import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { MAIL_SPLITS, type MailSplit } from "@/lib/mail/view";

export const CALENDAR_SUBJECT =
  "^(accepted|declined|tentative|tentatively accepted|invitation|updated invitation|canceled|cancelled|new time proposed|meeting forward notification|invitation updated)\\M";
export const CALENDAR_SENDER = "^(calendar-notification|calendar|noreply-calendar|invites?)@";
export const AUTOMATED_SENDER =
  "^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|newsletters?|news|updates?|marketing|mailer|mailer-daemon|digest|alerts?|bounces?|automated|robot|billing|receipts?|invoices?|info|hello|team)([._+-][^@]*)?@";
export const UNSUBSCRIBE_TEXT = "(unsubscribe|opt[ -]?out|manage (your )?(email |subscription )?preferences|email preferences)";
export const AUTOMATED_DOMAIN = "@(e|em|email|mail|mailer|mg|news|newsletter|marketing|notifications?|alerts?|updates?|bounce|post)\\.";

export function sameThread(alias: string, key: string) {
  return `${alias}.thread_key = ${key}`;
}

export function splitJoin(alias: string, userParam: string) {
  return `left join lateral (
    select coalesce(
      (select sr.split from crm.mail_sender_rules sr where sr.user_id = ${userParam} and sr.sender = lower(${alias}.from_email)),
      (select sr.split from crm.mail_sender_rules sr where sr.user_id = ${userParam} and sr.sender = '@' || split_part(lower(${alias}.from_email), '@', 2))
    ) as split
  ) rule on true`;
}

export function splitCase(alias: string) {
  return `case
    when rule.split is not null then rule.split
    when coalesce(${alias}.subject, '') ~* '${CALENDAR_SUBJECT}' or coalesce(${alias}.from_email, '') ~* '${CALENDAR_SENDER}' then 'calendar'
    when exists (
      select 1 from crm.contacts c
      where c.archived_at is null and c.normalized_email = lower(${alias}.from_email)
    ) then 'important'
    when exists (
      select 1 from crm.mail_sent_threads sent where sent.source_id = ${alias}.source_id and sent.thread_key = ${alias}.tk
    ) then 'important'
    when coalesce(${alias}.from_email, '') ~* '${AUTOMATED_SENDER}' or coalesce(${alias}.from_email, '') ~* '${AUTOMATED_DOMAIN}' then 'news'
    when ${alias}.focused is false then 'other'
    else 'important'
  end`;
}

export type CrmParams = { workspaces: string; free: string; own: string };

export type CrmValues = { workspaceIds: string[]; free: string[]; own: string[] };

export async function crmValues(db: Db, actor: UserActor, workspaceIds: string[]): Promise<CrmValues> {
  const ids = workspaceIds.length ? workspaceIds : [actor.workspaceId];
  const result = await db.query<{ email: string }>(
    `select own.email from (${ownAddressesSql("$1", "$2")}) as own(email) where own.email is not null
     union select lower(p.email) from crm.workspace_members wm join crm.profiles p on p.id = wm.user_id where wm.workspace_id = any($3::uuid[]) and p.email is not null`,
    [actor.userId, actor.email, ids],
  );
  const own = new Set<string>();
  for (const row of result.rows) {
    const email = row.email.trim().toLowerCase();
    if (!email.includes("@")) continue;
    own.add(email);
    const domain = email.split("@")[1];
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) own.add(`@${domain}`);
  }
  return { workspaceIds: ids, free: [...FREE_MAIL_DOMAINS], own: [...own] };
}

export function crmSender(alias: string, params: CrmParams) {
  return `(
    lower(${alias}.from_email) <> all(${params.own}::text[])
    and '@' || split_part(lower(${alias}.from_email), '@', 2) <> all(${params.own}::text[])
    and (
      exists (
        select 1 from crm.contacts c
        where c.workspace_id = any(${params.workspaces}::uuid[]) and c.archived_at is null and c.normalized_email = lower(${alias}.from_email)
      )
      or (
        split_part(lower(${alias}.from_email), '@', 2) <> all(${params.free}::text[])
        and exists (
          select 1 from crm.companies co
          where co.workspace_id = any(${params.workspaces}::uuid[]) and co.archived_at is null and co.domain = split_part(lower(${alias}.from_email), '@', 2)
        )
      )
    )
  )`;
}

export function automatedLooking(alias: string) {
  return `(
    coalesce(${alias}.from_email, '') ~* '${AUTOMATED_SENDER}' or coalesce(${alias}.from_email, '') ~* '${AUTOMATED_DOMAIN}'
    or coalesce(${alias}.subject, '') ~* '${CALENDAR_SUBJECT}' or coalesce(${alias}.from_email, '') ~* '${CALENDAR_SENDER}'
  )`;
}

export function needsReplyCheck(alias: string) {
  return `(
    ${automatedLooking(alias)}
    or exists (select 1 from crm.mail_messages b where b.id = ${alias}.id and right(coalesce(b.body_text, ''), 4000) ~* '${UNSUBSCRIBE_TEXT}')
  )`;
}

export function replyCheckSaysReply(alias: string) {
  return `exists (select 1 from crm.mail_prepared v where v.message_id = ${alias}.id and v.kind = 'reply_check' and v.state = 'ready')`;
}

export function replyableSplit(alias: string, params: CrmParams) {
  return `case
    when rule.split is not null then rule.split = 'important'
    when ${crmSender(alias, params)} then (not ${needsReplyCheck(alias)} or ${replyCheckSaysReply(alias)})
    else ${splitCase(alias)} = 'important'
  end`;
}

export async function isCrmSender(db: Db, values: CrmValues, email: string | null | undefined) {
  if (!email) return false;
  const result = await db.query<{ known: boolean }>(
    `select ${crmSender("m", { workspaces: "$1", free: "$2", own: "$3" })} as known from (select $4::text as from_email) m`,
    [values.workspaceIds, values.free, values.own, email],
  );
  return Boolean(result.rows[0]?.known);
}

export function senderKey(value: string) {
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

export function ownAddressesSql(userParam: string, emailParam: string) {
  return `select lower(email) as email from crm.mail_sources where user_id = ${userParam}
    union select lower(email) from crm.send_identities where user_id = ${userParam}
    union select lower(btrim(other)) from crm.profiles p cross join lateral unnest(coalesce(p.other_emails, '{}'::text[])) as other where p.id = ${userParam}
    union select lower(${emailParam}::text)`;
}
