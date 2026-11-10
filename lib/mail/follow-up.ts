import { sendAlert } from "@/lib/alerts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { readDraftInput, sendMailDraft } from "@/lib/mail/compose";
import { firstName, firstNames } from "@/lib/mail/format";
import { ownMailAddresses, readFollowUpBody, replyAfterSql } from "@/lib/mail/follow-up-rules";
import { fetchConversationMessages } from "@/lib/mail/microsoft";
import { mailNotifyLevel } from "@/lib/mail/notify";
import { storeNudge, writeNudge } from "@/lib/mail/prepare";
import { mailSourceToken } from "@/lib/mail/sync";
import { threadKey } from "@/lib/mail/threads";
import type { MailAddress } from "@/lib/mail/types";
import type { PushSender } from "@/lib/push";

type Recipients = { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] };

export type SendFollowUpRow = {
  id: string;
  source_id: string;
  thread_key: string;
  subject: string | null;
  follow_up_body: string | null;
  recipients: Recipients | null;
  identity_id: string | null;
  used_identity: boolean;
  original_internet_id: string | null;
  created_at: Date | string;
};

type Latest = {
  id: string;
  own: boolean;
  at: Date | string;
  internet_message_id: string | null;
  to_recipients: MailAddress[];
  cc_recipients: MailAddress[];
};

type Outcome =
  | { kind: "sent"; to: MailAddress[] }
  | { kind: "replied"; name: string }
  | { kind: "gone" }
  | { kind: "failed"; reason: string; conflict: boolean; body: string | null; messageId: string | null };

export const FOLLOW_UP_ROW_COLUMNS = "id, source_id, thread_key, subject, follow_up_body, recipients, identity_id, used_identity, original_internet_id, created_at";

const ORIGINAL_SLACK_MS = 5 * 60_000;
const STUCK_MINUTES = 10;
const WRITE_MS = 20_000;

export async function firstReply(db: Db, actor: UserActor, reminderId: string) {
  const result = await db.query<{ id: string; from_name: string | null; from_email: string | null }>(
    `select x.id, x.from_name, x.from_email from crm.mail_reminders r
     cross join lateral (${replyAfterSql("r", "$2", "$3")} limit 1) x
     where r.id = $1`,
    [reminderId, actor.userId, actor.email],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: firstName(row.from_email ? { address: row.from_email, name: row.from_name } : null) } : null;
}

async function latestInThread(db: Db, actor: UserActor, sourceId: string, key: string) {
  const result = await db.query<Latest>(
    `select m.id, lower(coalesce(m.from_email, '')) = any (select * from ${ownMailAddresses("$1", "$4")} as own(email)) as own,
       coalesce(m.received_at, m.sent_at, m.created_at) as at, m.internet_message_id, m.to_recipients, m.cc_recipients
     from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and m.source_id = $2 and m.thread_key = $3
       and not m.is_draft and f.role not in ('drafts', 'outbox', 'junk')
     order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.id desc
     limit 1`,
    [actor.userId, sourceId, key, actor.email],
  );
  return result.rows[0] ?? null;
}

async function threadState(actor: UserActor, row: SendFollowUpRow) {
  return withActor(actor, async (db) => ({
    reply: await firstReply(db, actor, row.id),
    latest: await latestInThread(db, actor, row.source_id, row.thread_key),
  }));
}

function addressSet(list: (MailAddress[] | null | undefined)[]) {
  return new Set(list.flatMap((items) => items ?? []).map((item) => item.address.trim().toLowerCase()).filter(Boolean));
}

function sameAddresses(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((address) => right.has(address));
}

function isOriginal(row: SendFollowUpRow, latest: Latest) {
  if (row.original_internet_id && latest.internet_message_id) return row.original_internet_id === latest.internet_message_id;
  return new Date(latest.at).getTime() <= new Date(row.created_at).getTime() + ORIGINAL_SLACK_MS;
}

function blocker(row: SendFollowUpRow, latest: Latest | null) {
  if (!latest) return "Orbit can't find your email in this conversation yet, so it didn't send the follow-up.";
  if (!latest.own) return "The latest email in the conversation isn't yours, so Orbit didn't send the follow-up.";
  if (!isOriginal(row, latest)) return "You've sent another email in this conversation since, so Orbit didn't send the follow-up.";
  if (row.recipients?.to?.length && !sameAddresses(addressSet([row.recipients.to, row.recipients.cc]), addressSet([latest.to_recipients, latest.cc_recipients]))) {
    return "The people on your latest email in this conversation have changed, so Orbit didn't send the follow-up.";
  }
  if (row.used_identity && !row.identity_id) {
    return "The address you sent the email from isn't in Orbit any more, so Orbit didn't send the follow-up from a different one.";
  }
  return null;
}

async function ownAddresses(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ email: string }>(`select email from ${ownMailAddresses("$1", "$2")} as own(email) where email is not null`, [
      actor.userId,
      actor.email,
    ]);
    return new Set(result.rows.map((item) => item.email));
  });
}

export async function outlookReply(actor: UserActor, row: SendFollowUpRow, fetchImpl?: typeof fetch) {
  if (row.thread_key.startsWith("m:")) throw new Error("This conversation has no Outlook conversation to check.");
  const [token, own] = await Promise.all([mailSourceToken(actor, row.source_id, fetchImpl), ownAddresses(actor)]);
  const since = new Date(row.created_at).getTime();
  const messages = await fetchConversationMessages(token, row.thread_key, fetchImpl);
  const reply = messages
    .filter((message) => !message.isDraft && message.from && !own.has(message.from) && message.at && Date.parse(message.at) > since)
    .sort((left, right) => Date.parse(left.at!) - Date.parse(right.at!))[0];
  return reply ? { name: firstName({ address: reply.from!, name: reply.fromName }) } : null;
}

async function moveState(actor: UserActor, id: string, from: string, to: string) {
  return withActor(actor, async (db) => {
    const result = await db.query(
      `update crm.mail_reminders set state = $3, sending_at = case when $3 = 'sending' then now() else sending_at end
       where id = $1 and user_id = $2 and state = $4 returning id`,
      [id, actor.userId, to, from],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

async function keepBody(actor: UserActor, id: string, from: string, body: string) {
  return withActor(actor, async (db) => {
    const result = await db.query("update crm.mail_reminders set follow_up_body = $3 where id = $1 and user_id = $2 and state = $4 returning id", [
      id,
      actor.userId,
      body,
      from,
    ]);
    return (result.rowCount ?? 0) > 0;
  });
}

function failed(reason: string, conflict: boolean, body: string | null, messageId: string | null): Outcome {
  return { kind: "failed", reason, conflict, body, messageId };
}

async function deliverFollowUp(
  actor: UserActor,
  row: SendFollowUpRow,
  options: { from: "due" | "waiting"; origin: string | null; fetchImpl?: typeof fetch; deadline: number },
): Promise<Outcome> {
  let state = await threadState(actor, row);
  if (state.reply) {
    await moveState(actor, row.id, options.from, "replied");
    return { kind: "replied", name: state.reply.name };
  }
  const blocked = blocker(row, state.latest);
  if (blocked) return failed(blocked, true, null, state.latest?.own ? state.latest.id : null);
  let body = readFollowUpBody(row.follow_up_body);
  if (!body) {
    const written = await writeNudge(actor, row.source_id, row.thread_key, {
      deadline: Math.min(options.deadline, Date.now() + WRITE_MS),
      fetchImpl: options.fetchImpl,
      unreviewed: true,
    }).catch((error) => {
      console.error("Writing a follow-up failed", error instanceof Error ? error.message : error);
      return null;
    });
    body = readFollowUpBody(written?.body);
    if (!body) return failed("Orbit couldn't write the follow-up.", false, null, state.latest!.id);
    if (!(await keepBody(actor, row.id, options.from, body))) return { kind: "gone" };
  }
  state = await threadState(actor, row);
  if (state.reply) {
    await moveState(actor, row.id, options.from, "replied");
    return { kind: "replied", name: state.reply.name };
  }
  const blockedNow = blocker(row, state.latest);
  if (blockedNow) return failed(blockedNow, true, body, state.latest?.own ? state.latest.id : null);
  const latest = state.latest!;
  let remote;
  try {
    remote = await outlookReply(actor, row, options.fetchImpl);
  } catch (error) {
    console.error("Checking Outlook for a reply failed", error instanceof Error ? error.message : error);
    return failed("Orbit couldn't check Outlook for a reply, so it didn't send the follow-up.", false, body, latest.id);
  }
  if (remote) {
    await moveState(actor, row.id, options.from, "replied");
    return { kind: "replied", name: remote.name };
  }
  const recipients: Recipients = row.recipients?.to?.length
    ? { to: row.recipients.to, cc: row.recipients.cc ?? [], bcc: row.recipients.bcc ?? [] }
    : { to: latest.to_recipients ?? [], cc: latest.cc_recipients ?? [], bcc: [] };
  if (!(await moveState(actor, row.id, options.from, "sending"))) return { kind: "gone" };
  try {
    await sendMailDraft(
      actor,
      {
        ...readDraftInput({
          mode: "reply",
          messageId: latest.id,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: "",
          body,
          identityId: row.identity_id,
        }),
        attachments: [],
      },
      { origin: options.origin, fetchImpl: options.fetchImpl, storedFiles: "keep" },
    );
  } catch (error) {
    await moveState(actor, row.id, "sending", options.from);
    const reason = error instanceof Error ? error.message : "Outlook didn't send it.";
    return failed(`The follow-up didn't send. ${reason}`.slice(0, 400), false, body, latest.id);
  }
  await withActor(actor, (db) =>
    db.query("update crm.mail_reminders set state = 'sent', sent_at = now(), follow_up_body = $2 where id = $1", [row.id, body]),
  );
  return { kind: "sent", to: recipients.to.length ? recipients.to : recipients.cc };
}

function mailHref(sourceId: string, key: string) {
  return `/mail?thread=${encodeURIComponent(threadKey(sourceId, key))}`;
}

async function pushFor(actor: UserActor, send?: PushSender) {
  return (await mailNotifyLevel(actor)) === "none" ? async () => undefined : send;
}

export async function sendDueFollowUp(
  actor: UserActor,
  row: SendFollowUpRow,
  options: { origin: string | null; fetchImpl?: typeof fetch; send?: PushSender; deadline?: number },
): Promise<"sent" | "replied" | "reminded" | "gone"> {
  const outcome = await deliverFollowUp(actor, row, {
    from: "due",
    origin: options.origin,
    fetchImpl: options.fetchImpl,
    deadline: options.deadline ?? Date.now() + WRITE_MS,
  });
  if (outcome.kind === "replied" || outcome.kind === "gone") return outcome.kind;
  const href = mailHref(row.source_id, row.thread_key);
  const subject = row.subject?.trim() || "(no subject)";
  const push = await pushFor(actor, options.send);
  if (outcome.kind === "sent") {
    const title = `Follow-up sent to ${firstNames(outcome.to)}`;
    await sendAlert(
      actor,
      { key: `follow-up-sent:${row.id}`, title, body: subject, url: href, tag: `${row.source_id}|${row.thread_key}`, bell: { title, body: subject, href } },
      { send: push },
    ).catch(() => undefined);
    return "sent";
  }
  if (outcome.body && outcome.messageId) {
    await storeNudge(actor, { sourceId: row.source_id, key: row.thread_key, messageId: outcome.messageId, body: outcome.body }).catch(() => undefined);
  }
  const title = `Follow-up not sent: ${subject}`;
  const body = `${outcome.reason} Nobody has replied, so the conversation is back at the top of your inbox.`;
  await sendAlert(
    actor,
    { key: `follow-up:${row.id}`, title, body, url: href, tag: `${row.source_id}|${row.thread_key}`, bell: { title, body, href } },
    { send: push },
  ).catch(() => undefined);
  return "reminded";
}

export async function hasStuckFollowUps(db: Db, actor: UserActor) {
  const result = await db.query<{ stuck: boolean }>(
    `select exists (
       select 1 from crm.mail_reminders
       where user_id = $1 and state = 'sending' and coalesce(sending_at, created_at) < now() - make_interval(mins => ${STUCK_MINUTES})
     ) as stuck`,
    [actor.userId],
  );
  return Boolean(result.rows[0]?.stuck);
}

export async function recoverStuckFollowUps(actor: UserActor, options: { send?: PushSender } = {}) {
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; source_id: string; thread_key: string; subject: string | null }>(
      `update crm.mail_reminders set state = 'due', surfaced_at = now()
       where user_id = $1 and state = 'sending'
         and coalesce(sending_at, created_at) < now() - make_interval(mins => ${STUCK_MINUTES})
       returning id, source_id, thread_key, subject`,
      [actor.userId],
    );
    return result.rows;
  });
  if (rows.length === 0) return 0;
  const push = await pushFor(actor, options.send);
  for (const row of rows) {
    const href = mailHref(row.source_id, row.thread_key);
    const title = "Check Sent: Orbit may not have sent this follow-up";
    const body = `${row.subject?.trim() || "(no subject)"}. Orbit stopped partway through sending it and won't try again, so check Sent before you send it yourself.`;
    await sendAlert(
      actor,
      { key: `follow-up-stuck:${row.id}`, title, body, url: href, tag: `${row.source_id}|${row.thread_key}`, bell: { title, body, href } },
      { send: push },
    ).catch(() => undefined);
  }
  return rows.length;
}

async function waitingRow(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<SendFollowUpRow>(
      `select ${FOLLOW_UP_ROW_COLUMNS} from crm.mail_reminders
       where id = $1 and user_id = $2 and kind = 'follow_up' and action = 'send' and state = 'waiting'`,
      [id, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

const GONE = "That follow-up isn't waiting any more. It may have been sent or cancelled.";

export async function followUpUnwritten(actor: UserActor, id: string) {
  const row = await waitingRow(actor, id);
  return Boolean(row && !readFollowUpBody(row.follow_up_body));
}

export async function sendFollowUpNow(actor: UserActor, id: string, options: { origin: string | null; fetchImpl?: typeof fetch; deadline?: number }) {
  const row = await waitingRow(actor, id);
  if (!row) throw new CrmError("not_found", GONE, 404);
  const outcome = await deliverFollowUp(actor, row, {
    from: "waiting",
    origin: options.origin,
    fetchImpl: options.fetchImpl,
    deadline: options.deadline ?? Date.now() + 25_000,
  });
  if (outcome.kind === "sent") return { sent: true, to: firstNames(outcome.to) };
  if (outcome.kind === "replied") throw new CrmError("conflict", `${outcome.name} replied, so Orbit didn't send the follow-up.`, 409);
  if (outcome.kind === "gone") throw new CrmError("conflict", GONE, 409);
  if (outcome.conflict) throw new CrmError("conflict", outcome.reason, 409);
  throw new CrmError("upstream_error", outcome.reason, 502);
}

export async function writeFollowUpNow(actor: UserActor, id: string, options: { fetchImpl?: typeof fetch } = {}) {
  const row = await waitingRow(actor, id);
  if (!row) throw new CrmError("not_found", GONE, 404);
  const written = await writeNudge(actor, row.source_id, row.thread_key, { deadline: Date.now() + 25_000, fetchImpl: options.fetchImpl }).catch((error) => {
    console.error("Writing a follow-up failed", error instanceof Error ? error.message : error);
    return null;
  });
  const body = readFollowUpBody(written?.body);
  if (!body) throw new CrmError("upstream_error", "Orbit couldn't write the follow-up. Try again, or write it yourself.", 502);
  return saveFollowUpBody(actor, id, body);
}

export async function saveFollowUpBody(actor: UserActor, id: string, value: unknown) {
  if (!isUuid(id)) throw new CrmError("not_found", GONE, 404);
  if (typeof value === "string" && value.length > 20_000) throw new CrmError("invalid_input", "Keep the follow-up under 20,000 characters.", 400, { field: "body" });
  const body = readFollowUpBody(value);
  const saved = await withActor(actor, async (db) => {
    const result = await db.query<{ follow_up_body: string | null }>(
      `update crm.mail_reminders set follow_up_body = $3
       where id = $1 and user_id = $2 and kind = 'follow_up' and action = 'send' and state = 'waiting'
       returning follow_up_body`,
      [id, actor.userId, body],
    );
    return result.rows[0] ?? null;
  });
  if (!saved) throw new CrmError("not_found", GONE, 404);
  return { body: saved.follow_up_body };
}

export async function restoreFollowUp(actor: UserActor, id: string) {
  if (!isUuid(id)) throw new CrmError("not_found", GONE, 404);
  const restored = await withActor(actor, async (db) => {
    const result = await db.query(
      `update crm.mail_reminders r set state = 'waiting'
       where r.id = $1 and r.user_id = $2 and r.kind = 'follow_up' and r.action = 'send' and r.state = 'cancelled' and r.due_at > now()
         and not exists (
           select 1 from crm.mail_reminders o
           where o.user_id = r.user_id and o.source_id = r.source_id and o.thread_key = r.thread_key
             and o.kind = 'follow_up' and o.state = 'waiting' and o.id <> r.id
         )
       returning r.id`,
      [id, actor.userId],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!restored) throw new CrmError("conflict", "That follow-up can't be brought back now.", 409);
  return { restored: true };
}
