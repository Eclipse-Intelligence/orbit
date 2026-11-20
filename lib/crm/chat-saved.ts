import {
  CHAT_PAGE_MAX,
  CHAT_REMIND_WHEN,
  type ChatKind,
  type ChatRemindWhen,
  type ChatSaved,
  type ChatSavedIds,
  type ChatSavedItem,
  type ChatSavedState,
  type ChatSubject,
} from "@/lib/chat/types";
import { discussionHref } from "@/lib/chat/discussions";
import { messageHref } from "@/lib/chat/routes";
import { checkId, CURSOR_TIME, FORMER, iso, MEMBER_NAME, messageColumns, toMessage, type MessageRow } from "@/lib/crm/chat";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { createReminder, type Reminder } from "@/lib/crm/reminders";
import type { UserActor } from "@/lib/crm/types";
import { dayKeyAt, shiftDay } from "@/lib/crm/working-days";
import type { Db } from "@/lib/db/pool";

export const SAVED_PAGE_SIZE = 30;
export const REMINDER_NAME_MAX = 80;
const HOUR_MS = 60 * 60 * 1000;
const GONE = "That message was deleted.";
const NOT_SAVABLE = "That can't be saved.";

type SavedCursor = { t: string; id: string };

type SubjectColumns = { conversation_kind: ChatKind; task_id: string | null; page_id: string | null; mail_share_id: string | null };

function subjectOf(row: SubjectColumns): ChatSubject | null {
  if (row.conversation_kind === "task" && row.task_id) return { kind: "task", id: row.task_id };
  if (row.conversation_kind === "doc" && row.page_id) return { kind: "doc", id: row.page_id };
  if (row.conversation_kind === "mail_thread" && row.mail_share_id) return { kind: "mail_thread", id: row.mail_share_id };
  return null;
}

function readCursor(value: string | null | undefined): SavedCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SavedCursor>;
    if (typeof parsed.t === "string" && CURSOR_TIME.test(parsed.t) && typeof parsed.id === "string" && isUuid(parsed.id)) {
      return { t: parsed.t, id: parsed.id.toLowerCase() };
    }
  } catch {}
  throw new CrmError("invalid_input", "That page of saved messages isn't valid. Reload Saved.", 400);
}

function writeCursor(cursor: SavedCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function pageSize(limit: unknown) {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : SAVED_PAGE_SIZE;
  return Math.min(CHAT_PAGE_MAX, Math.max(1, value));
}

function savedMessageHref(conversationId: string, message: { id: string; parentId: string | null }, subject: ChatSubject | null) {
  return subject ? discussionHref(subject) : messageHref(conversationId, message);
}

type Readable = SubjectColumns & { id: string; conversation_id: string; parent_id: string | null; author_name: string; msg_kind: string; deleted_at: Date | string | null };

async function readableMessage(db: Db, messageId: string) {
  const result = await db.query<Readable>(
    `select m.id, m.conversation_id, m.parent_id, m.author_name, m.kind as msg_kind, m.deleted_at, c.kind as conversation_kind, c.task_id, c.page_id, c.mail_share_id
     from crm.chat_messages m
     join crm.chat_conversations c on c.id = m.conversation_id
     where m.id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("message");
  if (row.deleted_at) throw new CrmError("invalid_input", GONE, 400);
  if (row.msg_kind !== "message") throw new CrmError("invalid_input", NOT_SAVABLE, 400);
  return row;
}

export async function setMessageSaved(actor: UserActor, id: string, saved: boolean): Promise<ChatSavedState> {
  const messageId = checkId(id, "message");
  return withActor(actor, async (db) => {
    if (!saved) {
      await db.query("delete from crm.chat_saved where user_id = $1 and message_id = $2", [actor.userId, messageId]);
      return { messageId, saved: false };
    }
    await readableMessage(db, messageId);
    try {
      await db.query("insert into crm.chat_saved (user_id, message_id) values ($1, $2) on conflict do nothing", [actor.userId, messageId]);
    } catch (error) {
      if (isPgError(error) && error.code === "42501") throw notFound("message");
      throw error;
    }
    return { messageId, saved: true };
  });
}

export async function listSavedIds(actor: UserActor): Promise<ChatSavedIds> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ message_id: string }>(
      `select s.message_id from crm.chat_saved s
       join crm.chat_messages m on m.id = s.message_id and m.deleted_at is null
       where s.user_id = $1
       order by s.created_at desc, s.message_id desc`,
      [actor.userId],
    );
    return { ids: result.rows.map((row) => row.message_id) };
  });
}

type SavedRow = MessageRow &
  SubjectColumns & { saved_at: string; saved_ts: Date; c_name: string | null; dm_name: string | null; task_title: string | null; page_title: string | null };

export async function listSaved(actor: UserActor, options: { cursor?: string | null; limit?: number } = {}): Promise<ChatSaved> {
  const limit = pageSize(options.limit);
  const cursor = readCursor(options.cursor);
  return withActor(actor, async (db) => {
    const result = await db.query<SavedRow>(
      `select s.created_at::text as saved_at, s.created_at as saved_ts, ${messageColumns("m")},
         c.kind as conversation_kind, c.name as c_name, c.task_id, c.page_id, c.mail_share_id, t.title as task_title, d.title as page_title,
         case when c.kind = 'dm' then (
           select ${MEMBER_NAME("o", "op")} from crm.chat_members o left join crm.profiles op on op.id = o.user_id
           where o.conversation_id = c.id and o.user_id <> s.user_id limit 1
         ) end as dm_name
       from crm.chat_saved s
       join crm.chat_messages m on m.id = s.message_id and m.deleted_at is null
       join crm.chat_conversations c on c.id = m.conversation_id
       left join crm.tasks t on c.kind = 'task' and t.id = c.task_id
       left join crm.pages d on c.kind = 'doc' and d.id = c.page_id
       where s.user_id = $1
         and ($2::timestamptz is null or (s.created_at, s.message_id) < ($2::timestamptz, $3::uuid))
       order by s.created_at desc, s.message_id desc
       limit ${limit + 1}`,
      [actor.userId, cursor?.t ?? null, cursor?.id ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const items: ChatSavedItem[] = rows.map((row) => ({
      message: toMessage(row, actor.userId),
      conversation: {
        id: row.conversation_id,
        kind: row.conversation_kind,
        name:
          row.conversation_kind === "dm"
            ? row.dm_name || FORMER
            : row.conversation_kind === "task"
              ? (row.task_title ?? "")
              : row.conversation_kind === "doc"
                ? (row.page_title ?? "")
                : (row.c_name ?? ""),
      },
      subject: subjectOf(row),
      savedAt: iso(row.saved_ts),
    }));
    const last = rows[rows.length - 1];
    return { items, next: result.rows.length > limit && last ? writeCursor({ t: last.saved_at, id: last.id }) : null };
  });
}

function reminderTitle(authorName: string) {
  const first = authorName.replace(/\s+/g, " ").trim().split(" ")[0]?.slice(0, REMINDER_NAME_MAX) ?? "";
  return first ? `Chat message from ${first}` : "Chat message";
}

export function remindWhen(value: unknown): ChatRemindWhen {
  if (!(CHAT_REMIND_WHEN as readonly unknown[]).includes(value)) throw new CrmError("invalid_input", "Pick when to be reminded.", 400, { field: "when" });
  return value as ChatRemindWhen;
}

export async function remindAboutMessage(
  actor: UserActor,
  id: string,
  when: unknown,
  options: { now?: number; idempotencyKey?: string | null } = {},
): Promise<{ reminder: Reminder }> {
  const messageId = checkId(id, "message");
  const wanted = remindWhen(when);
  const now = options.now ?? Date.now();
  const row = await withActor(actor, (db) => readableMessage(db, messageId));
  const link = savedMessageHref(row.conversation_id, { id: row.id, parentId: row.parent_id }, subjectOf(row));
  const timing = wanted === "hour" ? { dueAt: new Date(now + HOUR_MS).toISOString() } : wanted === "tomorrow" ? { dueOn: shiftDay(dayKeyAt(new Date(now)), 1) } : {};
  return createReminder(actor, { title: reminderTitle(row.author_name), ...timing }, { now, idempotencyKey: options.idempotencyKey ?? null, link, fingerprint: { messageId, when: wanted } });
}
