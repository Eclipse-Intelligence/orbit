import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { randomUUID } from "node:crypto";
import { hiddenSubscriptionSql } from "@/lib/mail/subscriptions";
import { decideRelevance, decisionState, emailBodyText, historyInDb, judgeInDb, workspaceContext, type Candidate, type Judged } from "@/lib/mail/relevance";

const CLASSIFY_MS = 10_000;

type MessageRow = {
  id: string;
  source_id: string;
  thread_key: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  at: Date;
  account: string;
  unsubscribed: boolean;
};

export type TaskGateOptions = { fetchImpl?: typeof fetch; deadline?: number; timeoutMs?: number; colleague?: boolean };

export async function mirroredMessageId(actor: UserActor, connectionId: string, providerMessageId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `select m.id from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id
       where m.user_id = $1 and s.connection_id = $2 and m.provider_message_id = $3
       limit 1`,
      [actor.userId, connectionId, providerMessageId],
    );
    return result.rows[0]?.id ?? null;
  });
}

function worthIt(judged: Judged<Candidate>) {
  const { verdict } = judged;
  if (verdict.state === "skipped") return false;
  if (verdict.state === "pending") return null;
  return !verdict.category || verdict.category === "business";
}

export async function mailWorthATask(actor: UserActor, messageId: string, options: TaskGateOptions = {}) {
  try {
    const row = await withActor(actor, async (db) => {
      const result = await db.query<MessageRow>(
        `select m.id, m.source_id, m.thread_key, lower(m.from_email) as from_email, m.from_name, m.subject, m.snippet,
           coalesce(m.received_at, m.created_at) as at, s.email as account,
           ${hiddenSubscriptionSql("$2", "lower(m.from_email)")} as unsubscribed
         from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id
         where m.id = $1 and m.user_id = $2`,
        [messageId, actor.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return true;
    if (row.unsubscribed) return false;
    if (!row.thread_key || !row.from_email) return true;
    const item: Candidate = {
      key: `${row.source_id}|${row.thread_key}`,
      messageId: row.id,
      email: row.from_email,
      name: row.from_name,
      subject: row.subject,
      snippet: row.snippet,
      address: row.account,
      workspaceId: actor.workspaceId,
      at: new Date(row.at).toISOString(),
    };
    const judge = async () => (await withActor(actor, (db) => judgeInDb(db, actor, [item], Date.now(), { ignoreHistory: options.colleague })))[0];
    const first = await judge();
    const decided = worthIt(first);
    if (decided !== null) return decided;
    const { classifyItems, sortingNow } = await import("@/lib/mail/capture-filter");
    const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + Math.min(options.timeoutMs ?? CLASSIFY_MS, CLASSIFY_MS));
    const running = sortingNow(item.key);
    if (running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))));
      await Promise.race([running, expired]);
      clearTimeout(timer);
      return worthIt(await judge()) ?? true;
    }
    await classifyItems(actor, [actor], [{ item: { ...item, neverAsk: "" }, hint: first.hint }], { deadline, fetchImpl: options.fetchImpl, headers: true, ignoreHistory: options.colleague });
    return worthIt(await judge()) ?? true;
  } catch (error) {
    console.error("Couldn't judge an email before suggesting a task", error instanceof Error ? error.message : error);
    return true;
  }
}

export type InboxEmail = { connectionId: string; threadKey: string | null; fromEmail: string | null; fromName: string | null; subject: string | null; text: string | null };

export async function inboxMailWorthATask(actor: UserActor, email: InboxEmail, options: TaskGateOptions = {}) {
  try {
    const sender = email.fromEmail?.toLowerCase();
    if (!sender || !email.threadKey) return true;
    const found = await withActor(actor, async (db) => {
      const source = await db.query<{ id: string; email: string }>("select id, email from crm.mail_sources where connection_id = $1 and user_id = $2 limit 1", [email.connectionId, actor.userId]);
      const hidden = await db.query<{ hidden: boolean }>(`select ${hiddenSubscriptionSql("$1", "$2")} as hidden`, [actor.userId, sender]);
      return { source: source.rows[0] ?? null, hidden: Boolean(hidden.rows[0]?.hidden) };
    });
    if (found.hidden) return false;
    if (!found.source) return true;
    const item: Candidate = {
      key: `${found.source.id}|${email.threadKey.slice(0, 400)}`,
      messageId: randomUUID(),
      email: sender,
      name: email.fromName,
      subject: email.subject,
      snippet: email.text,
      address: found.source.email,
      workspaceId: actor.workspaceId,
      at: new Date().toISOString(),
    };
    const first = (await withActor(actor, (db) => judgeInDb(db, actor, [item])))[0];
    const decided = worthIt(first);
    if (decided !== null) return decided;
    const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + Math.min(options.timeoutMs ?? CLASSIFY_MS, CLASSIFY_MS));
    const [context, history] = await Promise.all([workspaceContext(actor), withActor(actor, (db) => historyInDb(db, actor, actor.workspaceId, [sender]))]);
    const state = decisionState(
      context,
      { fromName: email.fromName, fromAddress: sender, receivedBy: found.source.email, subject: email.subject, snippet: email.text, body: emailBodyText(email.text), listedAs: first.hint },
      history.get(sender),
    );
    const decision = await decideRelevance(state, { deadline, fetchImpl: options.fetchImpl });
    return !decision.category || decision.category === "business";
  } catch (error) {
    console.error("Couldn't judge an email before suggesting a task", error instanceof Error ? error.message : error);
    return true;
  }
}
