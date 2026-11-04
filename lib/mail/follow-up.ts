import { sendAlert } from "@/lib/alerts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { readDraftInput, sendMailDraft } from "@/lib/mail/compose";
import { firstName, firstNames } from "@/lib/mail/format";
import { ownMailAddresses, readFollowUpBody, replyAfterSql } from "@/lib/mail/follow-up-rules";
import { mailNotifyLevel } from "@/lib/mail/notify";
import { storeNudge, writeNudge } from "@/lib/mail/prepare";
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
};

type Latest = { id: string; own: boolean; at: Date | string; to_recipients: MailAddress[]; cc_recipients: MailAddress[] };

type Outcome =
  | { kind: "sent"; to: MailAddress[] }
  | { kind: "replied"; name: string }
  | { kind: "gone" }
  | { kind: "failed"; reason: string; body: string | null; messageId: string | null };

const ROW_COLUMNS = "id, source_id, thread_key, subject, follow_up_body, recipients, identity_id";

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
       coalesce(m.received_at, m.sent_at, m.created_at) as at, m.to_recipients, m.cc_recipients
     from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3
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

function notOurs(latest: Latest | null) {
  return latest
    ? "The latest email in the conversation isn't yours, so Orbit didn't send the follow-up."
    : "Orbit can't find your email in this conversation yet.";
}

async function moveState(actor: UserActor, id: string, from: string, to: string) {
  return withActor(actor, async (db) => {
    const result = await db.query("update crm.mail_reminders set state = $3 where id = $1 and user_id = $2 and state = $4 returning id", [
      id,
      actor.userId,
      to,
      from,
    ]);
    return (result.rowCount ?? 0) > 0;
  });
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
  if (!state.latest?.own) return { kind: "failed", reason: notOurs(state.latest), body: null, messageId: null };
  let body = readFollowUpBody(row.follow_up_body);
  if (!body) {
    const written = await writeNudge(actor, row.source_id, row.thread_key, { deadline: options.deadline, fetchImpl: options.fetchImpl }).catch((error) => {
      console.error("Writing a follow-up failed", error instanceof Error ? error.message : error);
      return null;
    });
    body = readFollowUpBody(written?.body);
  }
  if (!body) return { kind: "failed", reason: "Orbit couldn't write the follow-up.", body: null, messageId: state.latest.id };
  state = await threadState(actor, row);
  if (state.reply) {
    await moveState(actor, row.id, options.from, "replied");
    return { kind: "replied", name: state.reply.name };
  }
  if (!state.latest?.own) return { kind: "failed", reason: notOurs(state.latest), body, messageId: null };
  const latest = state.latest;
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
    return { kind: "failed", reason: `The follow-up didn't send. ${reason}`.slice(0, 400), body, messageId: latest.id };
  }
  await withActor(actor, (db) =>
    db.query("update crm.mail_reminders set state = 'sent', sent_at = now(), follow_up_body = $2 where id = $1", [row.id, body]),
  );
  return { kind: "sent", to: recipients.to.length ? recipients.to : recipients.cc };
}

function mailHref(sourceId: string, key: string) {
  return `/mail?thread=${encodeURIComponent(threadKey(sourceId, key))}`;
}

export async function sendDueFollowUp(
  actor: UserActor,
  row: SendFollowUpRow,
  options: { origin: string | null; fetchImpl?: typeof fetch; send?: PushSender },
): Promise<"sent" | "replied" | "reminded" | "gone"> {
  const outcome = await deliverFollowUp(actor, row, { from: "due", origin: options.origin, fetchImpl: options.fetchImpl, deadline: Date.now() + 20_000 });
  if (outcome.kind === "replied" || outcome.kind === "gone") return outcome.kind;
  const href = mailHref(row.source_id, row.thread_key);
  const subject = row.subject?.trim() || "(no subject)";
  const quiet = (await mailNotifyLevel(actor)) === "none";
  const push = quiet ? async () => undefined : options.send;
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

async function waitingRow(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<SendFollowUpRow>(
      `select ${ROW_COLUMNS} from crm.mail_reminders
       where id = $1 and user_id = $2 and kind = 'follow_up' and action = 'send' and state = 'waiting'`,
      [id, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

const GONE = "That follow-up isn't waiting any more. It may have been sent or cancelled.";

export async function sendFollowUpNow(actor: UserActor, id: string, options: { origin: string | null; fetchImpl?: typeof fetch }) {
  const row = await waitingRow(actor, id);
  if (!row) throw new CrmError("not_found", GONE, 404);
  const outcome = await deliverFollowUp(actor, row, { from: "waiting", origin: options.origin, fetchImpl: options.fetchImpl, deadline: Date.now() + 25_000 });
  if (outcome.kind === "sent") return { sent: true, to: firstNames(outcome.to) };
  if (outcome.kind === "replied") throw new CrmError("conflict", `${outcome.name} replied, so Orbit didn't send the follow-up.`, 409);
  if (outcome.kind === "gone") throw new CrmError("conflict", GONE, 409);
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
  const restored = await moveState(actor, id, "cancelled", "waiting");
  if (!restored) throw new CrmError("not_found", "That follow-up can't be brought back now.", 404);
  return { restored: true };
}
