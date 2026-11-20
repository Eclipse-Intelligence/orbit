import { chatBackground } from "@/lib/crm/chat";
import { signalSynced } from "@/lib/sync-signals";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import {
  ensureMicrosoftFolder,
  GraphMailError,
  GraphOutOfTime,
  moveMicrosoftMessage,
  reconnectProblem,
  SNOOZE_FOLDER,
  updateMicrosoftMessage,
  type GraphLimit,
} from "@/lib/mail/microsoft";
import { sourceReconnect } from "@/lib/mail/accounts";
import { announceSharedThreads, shareVisibleRole } from "@/lib/mail/share-live";
import { mailSourceToken, recordMailEchoes, recountFolders } from "@/lib/mail/sync";
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
export const ACTION_BUDGET_MS = 40_000;

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

function graphFailure(error: unknown) {
  if (error instanceof GraphMailError) return { status: error.status, code: error.code.split(/\s/)[0] || null };
  if (error instanceof CrmError) return { status: error.status, code: error.code };
  return { status: null, code: error instanceof Error ? error.name : "unknown" };
}

function logFailures(action: string, sourceId: string, failures: unknown[]) {
  for (const failure of failures) console.error("Mail action failed in Microsoft", { action, mailbox: sourceId, ...graphFailure(failure) });
}

function landsIn(actor: UserActor, sourceId: string, role: MailRole) {
  let roles: Promise<Map<string, MailRole>> | null = null;
  return async (providerFolderId: string) => {
    roles ??= withActor(actor, async (db) => {
      const result = await db.query<{ provider_folder_id: string; role: MailRole }>("select provider_folder_id, role from crm.mail_folders where source_id = $1", [sourceId]);
      return new Map(result.rows.map((row) => [row.provider_folder_id, row.role]));
    });
    return (await roles).get(providerFolderId) === role;
  };
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

async function settleReminders(
  db: Db,
  actor: UserActor,
  sourceId: string,
  key: string,
  action: MailAction,
  until: Date | null,
  subject: string | null,
  complete = true,
) {
  if (action === "archive" || action === "trash") {
    await db.query(
      `update crm.mail_reminders set state = 'done'
       where user_id = $1 and source_id = $2 and thread_key = $3 and state <> 'done' and (kind = 'snooze' or state = 'due')`,
      [actor.userId, sourceId, key],
    );
  }
  if ((action === "inbox" && complete) || action === "snooze") {
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

async function recordMoves(db: Db, sourceId: string, moved: { id: string; folder: string | null }[], role: MailRole, providerFolder?: string): Promise<string[]> {
  const folders = await db.query<{ id: string; provider_folder_id: string; role: MailRole }>(
    "select id, provider_folder_id, role from crm.mail_folders where source_id = $1",
    [sourceId],
  );
  const fallback =
    (providerFolder ? folders.rows.find((folder) => folder.provider_folder_id === providerFolder)?.id : null) ??
    folders.rows.find((folder) => folder.role === role)?.id ??
    null;
  const before = await db.query<{ id: string; thread_key: string | null; is_draft: boolean; folder_id: string }>(
    "select id, thread_key, is_draft, folder_id from crm.mail_messages where id = any($1::uuid[])",
    [moved.map((item) => item.id)],
  );
  const current = new Map(before.rows.map((row) => [row.id, row]));
  const roleOf = (folderId: string | null) => folders.rows.find((folder) => folder.id === folderId)?.role ?? null;
  const shown = (folderId: string | null, draft: boolean) => {
    const folderRole = roleOf(folderId);
    return !draft && folderRole !== null && shareVisibleRole(folderRole);
  };
  const touched = new Set<string>();
  const recount = new Set<string>();
  for (const item of moved) {
    const local = folders.rows.find((folder) => folder.provider_folder_id === item.folder)?.id ?? fallback;
    if (local) {
      await db.query("update crm.mail_messages set folder_id = $2 where id = $1", [item.id, local]);
    } else {
      await db.query("delete from crm.mail_messages where id = $1", [item.id]);
    }
    const row = current.get(item.id);
    if (row?.folder_id) recount.add(row.folder_id);
    if (local) recount.add(local);
    if (row?.thread_key && shown(row.folder_id, row.is_draft) !== shown(local, row.is_draft)) touched.add(row.thread_key);
  }
  await recountFolders(db, [...recount]);
  return [...touched];
}

function announceMailChange(actor: UserActor, origin?: string | null) {
  chatBackground(() => signalSynced(actor.userId, "mail", origin));
}

function announceMoves(actor: UserActor, sourceId: string, threadKeys: string[]) {
  if (threadKeys.length === 0) return;
  chatBackground(() =>
    announceSharedThreads(actor.userId, sourceId, threadKeys).catch((error) => console.error("Couldn't announce shared thread changes", error instanceof Error ? error.name : "unknown")),
  );
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

export type MailActionResult = { changed: number; failed: number; problem: string | null; refused?: boolean; gone?: boolean };

function definiteRefusal(error: unknown) {
  return error instanceof GraphMailError && error.status >= 400 && error.status < 500 && ![401, 404, 408, 429].includes(error.status);
}

export function readMailActionInput(input: { thread: string; action: MailAction; view?: MailView | null; until?: string | null }) {
  if (!MAIL_ACTIONS.includes(input.action)) throw new CrmError("validation_error", "Choose a mail action.", 400);
  const until = input.action === "snooze" ? new Date(input.until ?? "") : null;
  if (until && (Number.isNaN(until.getTime()) || until.getTime() < Date.now() + SNOOZE_MIN_MS || until.getTime() > Date.now() + SNOOZE_MAX_MS)) {
    throw new CrmError("invalid_input", "Choose a time at least a minute from now and within a year.", 400, { field: "until" });
  }
  const view = input.view && "folderId" in input.view && !isUuid(input.view.folderId) ? null : (input.view ?? null);
  const { sourceId, key } = parseThreadKey(input.thread);
  return { until, view, sourceId, key };
}

export async function applyMailAction(
  actor: UserActor,
  input: { thread: string; action: MailAction; view?: MailView | null; until?: string | null },
  fetchImpl: typeof fetch = fetch,
  options: { deadline?: number; origin?: string | null } = {},
): Promise<MailActionResult> {
  const limit: GraphLimit = { deadline: options.deadline ?? Date.now() + ACTION_BUDGET_MS };
  const { until, view, sourceId, key } = readMailActionInput(input);
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
    return { changed: 0, failed: 0, problem: null };
  }
  const token = await mailSourceToken(actor, sourceId, fetchImpl);
  const base = MOVES[input.action];
  const move = base && input.action === "snooze" ? { ...base, destination: await snoozeFolder(actor, sourceId, token, fetchImpl) } : base;
  const done: { row: Row; folder: string | null; providerId: string }[] = [];
  const landed = move ? landsIn(actor, sourceId, move.role) : undefined;
  const failures = await eachLimited(chosen, async (row) => {
    if (move) {
      const moved = await moveMicrosoftMessage(token, row.provider_message_id, move.destination, fetchImpl, limit, landed);
      done.push({ row, folder: moved.folderId, providerId: moved.id });
      return;
    }
    const isRead = input.action === "read" ? true : input.action === "unread" ? false : undefined;
    const flagged = input.action === "flag" ? true : input.action === "unflag" ? false : undefined;
    await updateMicrosoftMessage(token, row.provider_message_id, { isRead, flagged }, fetchImpl, limit);
    done.push({ row, folder: null, providerId: row.provider_message_id });
  });
  if (done.length > 0) {
    const touched = await withActor(actor, async (db) => {
      await recordMailEchoes(db, actor, sourceId, done.flatMap((item) => [item.row.provider_message_id, item.providerId]));
      await settleReminders(db, actor, sourceId, key, input.action, until, subject, failures.length === 0);
      const ids = done.map((item) => item.row.id);
      if (input.action === "read" || input.action === "unread") {
        await db.query("update crm.mail_messages set is_read = $2 where id = any($1::uuid[])", [ids, input.action === "read"]);
      } else if (input.action === "flag" || input.action === "unflag") {
        await db.query("update crm.mail_messages set is_flagged = $2 where id = any($1::uuid[])", [ids, input.action === "flag"]);
      } else if (move) {
        return recordMoves(db, sourceId, done.map((item) => ({ id: item.row.id, folder: item.folder })), move.role);
      }
      return [];
    });
    announceMailChange(actor, options.origin);
    announceMoves(actor, sourceId, touched);
  }
  if (failures.length === 0) return { changed: done.length, failed: 0, problem: null };
  logFailures(input.action, sourceId, failures);
  if (done.length === 0) {
    throw (
      (await sourceReconnect(actor, sourceId, failures[0])) ??
      Object.assign(new CrmError("mail_action_failed", await failureMessage(actor, sourceId, failures[0]), 502), { cause: failures[0] })
    );
  }
  return { changed: done.length, failed: failures.length, problem: await failureMessage(actor, sourceId, failures[0]), refused: failures.every(definiteRefusal), gone: failures.every((failure) => failure instanceof GraphMailError && failure.status === 404) };
}

export function partialProblem(result: MailActionResult) {
  if (result.failed === 0) return null;
  return `Couldn't change ${result.failed} ${result.failed === 1 ? "email" : "emails"} in this conversation. ${result.problem ?? "Try again."}`;
}

export async function everyEmailChanged(pending: Promise<MailActionResult>) {
  const result = await pending;
  const problem = partialProblem(result);
  if (problem) throw new CrmError("mail_action_failed", problem, 502);
  return result;
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
  options: { deadline?: number } = {},
): Promise<{ moved: string[]; error: string | null; late: number }> {
  if (messages.length === 0) return { moved: [], error: null, late: 0 };
  const token = await mailSourceToken(actor, sourceId, fetchImpl);
  const destination = typeof target === "string" ? MOVES[target]!.destination : target.providerFolderId;
  const role = typeof target === "string" ? MOVES[target]!.role : target.role;
  const done: { id: string; folder: string | null; threadKey: string; providerIds: string[] }[] = [];
  const landed = typeof target === "string" ? landsIn(actor, sourceId, role) : undefined;
  const failures = await eachLimited(messages, async (message) => {
    const moved = await moveMicrosoftMessage(token, message.providerMessageId, destination, fetchImpl, { deadline: options.deadline }, landed);
    done.push({ id: message.id, folder: moved.folderId, threadKey: message.threadKey, providerIds: [message.providerMessageId, moved.id] });
  });
  if (done.length > 0) {
    const touched = await withActor(actor, async (db) => {
      await recordMailEchoes(db, actor, sourceId, done.flatMap((item) => item.providerIds));
      const keys = await recordMoves(db, sourceId, done, role, typeof target === "string" ? undefined : target.providerFolderId);
      if (typeof target === "string") {
        for (const key of new Set(done.map((item) => item.threadKey))) await settleReminders(db, actor, sourceId, key, target, null, null);
      }
      return keys;
    });
    announceMailChange(actor);
    announceMoves(actor, sourceId, touched);
  }
  const moved = done.map((item) => item.id);
  if (failures.length === 0) return { moved, error: null, late: 0 };
  logFailures(typeof target === "string" ? target : "move", sourceId, failures);
  const refused = failures.filter((failure) => !(failure instanceof GraphOutOfTime && !failure.sent));
  const late = failures.length - refused.length;
  return { moved, error: refused.length ? await failureMessage(actor, sourceId, refused[0]) : null, late };
}
