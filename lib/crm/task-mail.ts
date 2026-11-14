import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, Task, UserActor } from "@/lib/crm/types";

const NOT_A_THREAD = "Choose an email thread from Mail.";
const NOT_YOURS = "That email thread isn't in your Mail.";
const NOT_IN_MAIL = "That email isn't in your own Mail. Only emails in your mailbox can be pinned to a task, not ones in a thread shared with you.";

export function readMailThreadKey(given: unknown): string | null {
  if (given === null || given === undefined || (typeof given === "string" && given.trim() === "")) return null;
  if (typeof given !== "string" || /[\u0000-\u001f\u007f]/.test(given.trim())) throw new CrmError("invalid_input", NOT_A_THREAD, 400, { field: "mailThreadKey" });
  const value = given.trim();
  const split = value.indexOf("|");
  const sourceId = value.slice(0, split);
  const key = value.slice(split + 1);
  if (split <= 0 || !isUuid(sourceId) || !key || key.length > 450) {
    throw new CrmError("invalid_input", NOT_A_THREAD, 400, { field: "mailThreadKey" });
  }
  return `${sourceId.toLowerCase()}|${key}`;
}

export async function threadSubjectsInDb(db: Db, userId: string, keys: string[]) {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return new Map<string, string | null>();
  const result = await db.query<{ key: string; subject: string | null }>(
    `select k.key, s.subject
     from unnest($2::text[]) as k(key)
     cross join lateral (
       select m.subject from crm.mail_messages m
       where m.user_id = $1 and m.source_id = split_part(k.key, '|', 1)::uuid
         and m.thread_key = substr(k.key, 38)
       order by m.is_draft, coalesce(m.received_at, m.sent_at, m.created_at) desc
       limit 1
     ) s`,
    [userId, wanted],
  );
  return new Map(result.rows.map((row) => [row.key, row.subject]));
}

export async function assertOwnThreadInDb(db: Db, actor: Actor, key: string | null | undefined) {
  if (!key || actor.type !== "user") return;
  const found = await threadSubjectsInDb(db, actor.userId, [key]);
  if (!found.has(key)) throw new CrmError("invalid_input", NOT_YOURS, 400, { field: "mailThreadKey" });
}

export async function withMailThreadsInDb<T extends Task>(db: Db, viewer: Actor, tasks: T[]): Promise<T[]> {
  const keys = tasks.flatMap((task) => (task.mailThreadKey ? [task.mailThreadKey] : []));
  const subjects = viewer.type === "user" && keys.length > 0 ? await threadSubjectsInDb(db, viewer.userId, keys) : new Map<string, string | null>();
  return tasks.map((task) => {
    if (!task.mailThreadKey) return task.mailThread === null ? task : { ...task, mailThread: null };
    const readable = subjects.has(task.mailThreadKey);
    return { ...task, mailThread: { subject: readable ? (subjects.get(task.mailThreadKey)?.trim() || null) : null, readable } };
  });
}

export function withoutViewerMail<T extends Task>(task: T): Omit<T, "mailThread"> {
  const rest: Partial<T> = { ...task };
  delete rest.mailThread;
  return rest as Omit<T, "mailThread">;
}

export async function mailThreadSubject(actor: UserActor, value: string) {
  const key = readMailThreadKey(value);
  if (!key) return null;
  const found = await withActor(actor, (db) => threadSubjectsInDb(db, actor.userId, [key]));
  return found.has(key) ? { key, subject: found.get(key)?.trim() || null } : null;
}

export async function emailThreadKey(actor: UserActor, emailId: string) {
  if (!isUuid(emailId)) throw new CrmError("not_found", NOT_IN_MAIL, 404, { field: "emailId" });
  return withActor(actor, async (db) => {
    const result = await db.query<{ key: string }>(
      "select source_id::text || '|' || thread_key as key from crm.mail_messages where id = $1 and user_id = $2 and thread_key is not null",
      [emailId, actor.userId],
    );
    const key = result.rows[0]?.key;
    if (!key) throw new CrmError("not_found", NOT_IN_MAIL, 404, { field: "emailId" });
    return key;
  });
}
