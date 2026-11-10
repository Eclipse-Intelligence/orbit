import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { ensureMicrosoftFolder, GraphMailError, moveMicrosoftMessage, reconnectProblem, SNOOZE_FOLDER, updateMicrosoftMessage } from "@/lib/mail/microsoft";
import { sourceReconnect } from "@/lib/mail/accounts";
import { mailSourceToken } from "@/lib/mail/sync";
import { parseThreadKey } from "@/lib/mail/threads";
import type { MailView } from "@/lib/mail/view";
import type { MailRole } from "@/lib/mail/types";

export const MAIL_ACTIONS = ["read", "unread", "flag", "unflag", "archive", "trash", "inbox", "snooze"] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

const MOVES: Partial<Record<MailAction, { destination: string; role: MailRole; anywhere: MailRole[] }>> = {
  archive: { destination: "archive", role: "archive", anywhere: ["inbox", "other"] },
  trash: { destination: "deleteditems", role: "trash", anywhere: ["inbox", "other", "sent", "archive", "drafts", "junk"] },
  inbox: { destination: "inbox", role: "inbox", anywhere: ["archive", "trash", "snoozed", "junk"] },
  snooze: { destination: "snoozed", role: "snoozed", anywhere: ["inbox", "other"] },
};

const SNOOZE_MIN_MS = 60_000;
const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

const PARALLEL = 4;
const MESSAGE_LIMIT = 100;

type Row = {
  id: string;
  provider_message_id: string;
  folder_id: string;
  role: MailRole;
  is_read: boolean;
  is_flagged: boolean;
  subject: string | null;
  at: string;
};

function inView(row: Row, view: MailView | null, anywhere: MailRole[]) {
  if (!view) return anywhere.includes(row.role);
  if ("folderId" in view) return row.folder_id === view.folderId;
  return row.role === view.role;
}

function targets(rows: Row[], action: MailAction, view: MailView | null) {
  const latest = (list: Row[]) => (list.length ? [list[list.length - 1]] : []);
  const scoped = rows.filter((row) => inView(row, view, ["inbox", "other", "sent", "archive"]));
  switch (action) {
    case "read":
      return rows.filter((row) => !row.is_read);
    case "unread":
      return latest(scoped.length ? scoped : rows).filter((row) => row.is_read);
    case "flag":
      return latest(scoped.length ? scoped : rows).filter((row) => !row.is_flagged);
    case "unflag":
      return rows.filter((row) => row.is_flagged);
    default: {
      const move = MOVES[action]!;
      return rows.filter(
        (row) => row.role !== move.role && (row.role !== "drafts" || action === "trash") && inView(row, view, move.anywhere),
      );
    }
  }
}

async function eachLimited<T>(items: T[], run: (item: T) => Promise<void>) {
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        try {
          await run(item);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  return failures;
}

async function snoozeFolder(actor: UserActor, sourceId: string, token: string, fetchImpl: typeof fetch) {
  const stored = await withActor(actor, async (db) => {
    const result = await db.query<{ snooze_folder_id: string | null }>("select snooze_folder_id from crm.mail_sources where id = $1", [sourceId]);
    return result.rows[0]?.snooze_folder_id ?? null;
  });
  if (stored) return stored;
  const providerId = await ensureMicrosoftFolder(token, SNOOZE_FOLDER, fetchImpl);
  await withActor(actor, async (db) => {
    await db.query("update crm.mail_sources set snooze_folder_id = $2 where id = $1", [sourceId, providerId]);
    await db.query(
      `insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role, sync_state)
       values ($1, $2, $3, $4, $5, 'snoozed', 'pending')
       on conflict (source_id, provider_folder_id) do update set role = 'snoozed'`,
      [actor.workspaceId, actor.userId, sourceId, providerId, SNOOZE_FOLDER],
    );
  });
  return providerId;
}

async function settleReminders(db: Db, actor: UserActor, sourceId: string, key: string, action: MailAction, until: Date | null, subject: string | null) {
  if (action === "archive" || action === "trash") {
    await db.query(
      `update crm.mail_reminders set state = 'done'
       where user_id = $1 and source_id = $2 and thread_key = $3 and state <> 'done' and (kind = 'snooze' or state = 'due')`,
      [actor.userId, sourceId, key],
    );
  }
  if (action === "inbox" || action === "snooze") {
    await db.query(
      "update crm.mail_reminders set state = 'done' where user_id = $1 and source_id = $2 and thread_key = $3 and kind = 'snooze' and state <> 'done'",
      [actor.userId, sourceId, key],
    );
  }
  if (action === "snooze" && until) {
    await db.query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject)
       values ($1, $2, $3, $4, 'snooze', $5, $6)`,
      [actor.workspaceId, actor.userId, sourceId, key, until.toISOString(), subject],
    );
  }
}

async function recordMoves(db: Db, sourceId: string, moved: { id: string; folder: string | null }[], role: MailRole, providerFolder?: string) {
  const folders = await db.query<{ id: string; provider_folder_id: string; role: MailRole }>(
    "select id, provider_folder_id, role from crm.mail_folders where source_id = $1",
    [sourceId],
  );
  const fallback =
    (providerFolder ? folders.rows.find((folder) => folder.provider_folder_id === providerFolder)?.id : null) ??
    folders.rows.find((folder) => folder.role === role)?.id ??
    null;
  for (const item of moved) {
    const local = folders.rows.find((folder) => folder.provider_folder_id === item.folder)?.id ?? fallback;
    if (local) {
      await db.query("update crm.mail_messages set folder_id = $2 where id = $1", [item.id, local]);
    } else {
      await db.query("delete from crm.mail_messages where id = $1", [item.id]);
    }
  }
}

async function sourceEmail(actor: UserActor, sourceId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ email: string }>("select email from crm.mail_sources where id = $1 and user_id = $2", [sourceId, actor.userId]);
    return result.rows[0]?.email ?? null;
  }).catch(() => null);
}

async function failureMessage(actor: UserActor, sourceId: string, error: unknown) {
  const reconnect = reconnectProblem(error, await sourceEmail(actor, sourceId));
  if (reconnect) return reconnect;
  if (error instanceof GraphMailError) {
    if (error.status === 404) return "That email is no longer in Outlook.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Outlook didn't accept that change. Try again.";
}

export async function applyMailAction(
  actor: UserActor,
  input: { thread: string; action: MailAction; view?: MailView | null; until?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ changed: number }> {
  if (!MAIL_ACTIONS.includes(input.action)) throw new CrmError("validation_error", "Choose a mail action.", 400);
  const until = input.action === "snooze" ? new Date(input.until ?? "") : null;
  if (until && (Number.isNaN(until.getTime()) || until.getTime() < Date.now() + SNOOZE_MIN_MS || until.getTime() > Date.now() + SNOOZE_MAX_MS)) {
    throw new CrmError("invalid_input", "Choose a time at least a minute from now and within a year.", 400, { field: "until" });
  }
  const view = input.view && "folderId" in input.view && !isUuid(input.view.folderId) ? null : (input.view ?? null);
  const { sourceId, key } = parseThreadKey(input.thread);
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<Row>(
      `select m.id, m.provider_message_id, m.folder_id, f.role, m.is_read, m.is_flagged, m.subject,
         coalesce(m.received_at, m.sent_at, m.created_at) as at
       from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and m.source_id = $2 and m.thread_key = $3
         and f.role <> 'outbox'
         and (f.role <> 'junk' or not exists (
           select 1 from crm.mail_messages o join crm.mail_folders ofo on ofo.id = o.folder_id
           where o.user_id = m.user_id and o.source_id = m.source_id and o.thread_key = $3
             and ofo.role not in ('junk', 'outbox')
         ))
       order by at asc, m.id asc
       limit $4`,
      [actor.userId, sourceId, key, MESSAGE_LIMIT],
    );
    return result.rows;
  });
  if (rows.length === 0) throw new CrmError("not_found", "Conversation not found.", 404);
  const chosen = targets(rows, input.action, view);
  const subject = rows[rows.length - 1].subject?.slice(0, 2000) ?? null;
  if (chosen.length === 0) {
    if (input.action !== "snooze") await withActor(actor, (db) => settleReminders(db, actor, sourceId, key, input.action, null, subject));
    return { changed: 0 };
  }
  const token = await mailSourceToken(actor, sourceId, fetchImpl);
  const base = MOVES[input.action];
  const move = base && input.action === "snooze" ? { ...base, destination: await snoozeFolder(actor, sourceId, token, fetchImpl) } : base;
  const done: { row: Row; folder: string | null }[] = [];
  const failures = await eachLimited(chosen, async (row) => {
    if (move) {
      const moved = await moveMicrosoftMessage(token, row.provider_message_id, move.destination, fetchImpl);
      done.push({ row, folder: moved.folderId });
      return;
    }
    const isRead = input.action === "read" ? true : input.action === "unread" ? false : undefined;
    const flagged = input.action === "flag" ? true : input.action === "unflag" ? false : undefined;
    await updateMicrosoftMessage(token, row.provider_message_id, { isRead, flagged }, fetchImpl);
    done.push({ row, folder: null });
  });
  if (done.length > 0) {
    await withActor(actor, async (db) => {
      await settleReminders(db, actor, sourceId, key, input.action, until, subject);
      const ids = done.map((item) => item.row.id);
      if (input.action === "read" || input.action === "unread") {
        await db.query("update crm.mail_messages set is_read = $2 where id = any($1::uuid[])", [ids, input.action === "read"]);
      } else if (input.action === "flag" || input.action === "unflag") {
        await db.query("update crm.mail_messages set is_flagged = $2 where id = any($1::uuid[])", [ids, input.action === "flag"]);
      } else if (move) {
        await recordMoves(db, sourceId, done.map((item) => ({ id: item.row.id, folder: item.folder })), move.role);
      }
    });
  }
  if (failures.length > 0) {
    throw (await sourceReconnect(actor, sourceId, failures[0])) ?? new CrmError("mail_action_failed", await failureMessage(actor, sourceId, failures[0]), 502);
  }
  return { changed: done.length };
}

export async function threadForEmail(actor: UserActor, emailId: string) {
  if (!isUuid(emailId)) throw new CrmError("not_found", "That email isn't in Mail. Search for it again.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<{ source_id: string; tk: string; subject: string | null }>(
      "select source_id, thread_key as tk, subject from crm.mail_messages where id = $1 and user_id = $2",
      [emailId, actor.userId],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "That email isn't in Mail. Search for it again.", 404);
    return { thread: `${row.source_id}|${row.tk}`, subject: row.subject };
  });
}

export type MessageMove = "archive" | "trash" | { providerFolderId: string; role: MailRole };

export async function moveMessages(
  actor: UserActor,
  sourceId: string,
  messages: { id: string; providerMessageId: string; threadKey: string }[],
  target: MessageMove,
  fetchImpl: typeof fetch = fetch,
): Promise<{ moved: string[]; error: string | null }> {
  if (messages.length === 0) return { moved: [], error: null };
  const token = await mailSourceToken(actor, sourceId, fetchImpl);
  const destination = typeof target === "string" ? MOVES[target]!.destination : target.providerFolderId;
  const role = typeof target === "string" ? MOVES[target]!.role : target.role;
  const done: { id: string; folder: string | null; threadKey: string }[] = [];
  const failures = await eachLimited(messages, async (message) => {
    const moved = await moveMicrosoftMessage(token, message.providerMessageId, destination, fetchImpl);
    done.push({ id: message.id, folder: moved.folderId, threadKey: message.threadKey });
  });
  if (done.length > 0) {
    await withActor(actor, async (db) => {
      await recordMoves(db, sourceId, done, role, typeof target === "string" ? undefined : target.providerFolderId);
      if (typeof target === "string") {
        for (const key of new Set(done.map((item) => item.threadKey))) await settleReminders(db, actor, sourceId, key, target, null, null);
      }
    });
  }
  return { moved: done.map((item) => item.id), error: failures.length ? await failureMessage(actor, sourceId, failures[0]) : null };
}
