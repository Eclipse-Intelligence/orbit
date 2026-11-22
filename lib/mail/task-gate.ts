import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { judgeInDb, type Candidate, type Judged } from "@/lib/mail/relevance";

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
  internal: boolean;
};

export type TaskGateOptions = { fetchImpl?: typeof fetch; deadline?: number; timeoutMs?: number };

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
           exists (
             select 1 from crm.workspace_brands b
             cross join lateral unnest(b.own_domains) as d(domain)
             where d.domain = split_part(lower(m.from_email), '@', 2)
               and b.workspace_id in (select w.workspace_id from crm.workspace_members w where w.user_id = $2)
           ) as internal
         from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id
         where m.id = $1 and m.user_id = $2`,
        [messageId, actor.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!row) return true;
    if (row.internal) return false;
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
    const judge = async () => (await withActor(actor, (db) => judgeInDb(db, actor, [item])))[0];
    const first = await judge();
    const decided = worthIt(first);
    if (decided !== null) return decided;
    const { classifyItems } = await import("@/lib/mail/capture-filter");
    const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + Math.min(options.timeoutMs ?? CLASSIFY_MS, CLASSIFY_MS));
    await classifyItems(actor, [actor], [{ item: { ...item, neverAsk: "" }, hint: first.hint }], { deadline, fetchImpl: options.fetchImpl });
    return worthIt(await judge()) ?? true;
  } catch (error) {
    console.error("Couldn't judge an email before suggesting a task", error instanceof Error ? error.message : error);
    return true;
  }
}
