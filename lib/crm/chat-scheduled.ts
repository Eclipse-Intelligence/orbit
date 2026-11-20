import { randomUUID } from "node:crypto";
import { alertMembers } from "@/lib/alerts";
import { CHAT_ARCHIVED, type ChatKind, type ChatPost, type ChatScheduled, type ChatScheduledChange, type ChatScheduledInput, type ChatScheduledItem, type ChatScheduledStatus } from "@/lib/chat/types";
import { CHAT_SCHEDULED_PATH } from "@/lib/chat/routes";
import { cleanFormat, type ChatFormat } from "@/lib/chat/markdown";
import { broadcastChat, checkId, checkScheduledPost, FORMER, iso, MEMBER_NAME, postMessage } from "@/lib/crm/chat";
import { checkUploads, cleanAttachmentIds } from "@/lib/crm/chat-attachments";
import { withActor } from "@/lib/crm/context";
import { CrmError, pgFailure } from "@/lib/crm/errors";
import { actingActor } from "@/lib/crm/task-outlook";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import type { PushSender } from "@/lib/push";

const SEND_BUDGET_MS = 40_000;
const TOO_LATE = "Pick a time in the future.";
const SEND_FAILED = "Couldn't send. Try again.";
const LEFT = "You're no longer in that conversation.";
const FILE_MISSING = "A file is missing. Remove it and try again.";
const NO_ACCOUNT = "You no longer have access to Orbit.";
const NOTICE_TITLE = "A scheduled message wasn't sent";

type Claimed = {
  id: string;
  user_id: string;
  conversation_id: string;
  parent_id: string | null;
  body: string;
  format: string;
  attachment_ids: string[];
  attempts: number;
  claim_token: string;
};

type ScheduledRow = {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  body: string;
  format: string;
  send_at: Date | string;
  status: ChatScheduledStatus;
  failure: string | null;
  created_at: Date | string;
  conversation_kind: ChatKind | null;
  c_name: string | null;
  dm_name: string | null;
  attachments: ChatScheduledItem["attachments"] | null;
};

export type DeliverOptions = { fetchImpl?: typeof fetch; send?: PushSender };

export type DeliverOutcome = { outcome: "sent"; post: ChatPost | null } | { outcome: "failed"; reason: string } | { outcome: "retry" };

export type DueResult = { sent: number; failed: number; retried: number };

function failure(error: unknown): never {
  const known = pgFailure(error);
  throw known?.message === CHAT_ARCHIVED ? new CrmError("conflict", CHAT_ARCHIVED, 409) : (known ?? error);
}

function readSendAt(value: unknown) {
  const date = typeof value === "string" && value.trim() ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new CrmError("invalid_input", TOO_LATE, 400, { field: "sendAt" });
  return date;
}

function readKey(value: unknown) {
  if (value === undefined || value === null || value === "") return randomUUID();
  return checkId(value, "scheduled message");
}

function toItem(row: ScheduledRow): ChatScheduledItem {
  return {
    id: row.id,
    conversation: {
      id: row.conversation_id,
      kind: row.conversation_kind ?? "room",
      name: row.conversation_kind === "dm" ? (row.dm_name ?? FORMER) : row.conversation_kind ? row.c_name : null,
    },
    parentId: row.parent_id,
    body: row.body,
    format: cleanFormat(row.format, "markdown"),
    attachments: row.attachments ?? [],
    sendAt: iso(row.send_at),
    status: row.status,
    failure: row.failure,
    createdAt: iso(row.created_at),
  };
}

async function readScheduled(actor: UserActor, id: string | null): Promise<ChatScheduledItem[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<ScheduledRow>(
      `select s.id, s.conversation_id, s.parent_id, s.body, s.format, s.send_at, s.status, s.failure, s.created_at,
         c.kind as conversation_kind, c.name as c_name,
         case when c.kind = 'dm' then (
           select ${MEMBER_NAME("o", "op")} from crm.chat_members o left join crm.profiles op on op.id = o.user_id
           where o.conversation_id = c.id and o.user_id <> s.user_id limit 1
         ) end as dm_name,
         coalesce((
           select json_agg(json_build_object('id', f.id, 'name', f.name, 'contentType', f.content_type, 'size', f.size, 'width', f.width, 'height', f.height)
             order by array_position(s.attachment_ids, f.id))
           from crm.chat_attachments f
           where f.scheduled_id = s.id and f.message_id is null
         ), '[]'::json) as attachments
       from crm.chat_scheduled s
       left join crm.chat_conversations c on c.id = s.conversation_id
       where s.user_id = $1 and ($2::uuid is null or s.id = $2)
       order by s.send_at, s.id`,
      [actor.userId, id],
    );
    return result.rows.map(toItem);
  });
}

export async function listScheduled(actor: UserActor): Promise<ChatScheduled> {
  return { items: await readScheduled(actor, null) };
}

export async function scheduleMessage(actor: UserActor, input: Partial<ChatScheduledInput> | null | undefined, options: { fetchImpl?: typeof fetch } = {}): Promise<{ item: ChatScheduledItem; duplicate: boolean }> {
  const source = input ?? {};
  const id = readKey(source.id);
  const earlier = (await readScheduled(actor, id))[0];
  if (earlier) return { item: earlier, duplicate: true };
  const sendAt = readSendAt(source.sendAt);
  const attachmentIds = cleanAttachmentIds(source.attachmentIds);
  const checked = await checkScheduledPost(actor, { conversationId: source.conversationId, parentId: source.parentId, body: source.body, format: source.format, files: attachmentIds.length });
  await checkUploads(actor, checked.conversationId, attachmentIds, options.fetchImpl);
  let created = false;
  try {
    const result = await query<{ created: boolean }>("select private.chat_schedule_create($1, $2, $3, $4, $5, $6, $7::uuid[], $8) as created", [
      actor.userId,
      id,
      checked.conversationId,
      checked.parentId,
      checked.body,
      checked.format,
      attachmentIds,
      sendAt.toISOString(),
    ]);
    created = result.rows[0]?.created === true;
  } catch (error) {
    failure(error);
  }
  const item = (await readScheduled(actor, id))[0];
  if (!item) throw new CrmError("conflict", "That schedule key was already used for another message.", 409, { field: "id" });
  return { item, duplicate: !created };
}

export async function updateScheduled(actor: UserActor, id: unknown, change: ChatScheduledChange | null | undefined): Promise<{ item: ChatScheduledItem }> {
  const scheduledId = checkId(id, "scheduled message");
  const wanted = change ?? {};
  const current = (await readScheduled(actor, scheduledId))[0];
  if (!current) throw new CrmError("not_found", "That message is no longer scheduled.", 404);
  const removing = cleanAttachmentIds(wanted.removeAttachmentIds);
  const remaining = current.attachments.filter((file) => !removing.includes(file.id)).length;
  const sendAt = wanted.sendAt === undefined ? null : readSendAt(wanted.sendAt);
  let body: string | null = null;
  let format: ChatFormat | null = null;
  if (wanted.body !== undefined) {
    const checked = await checkScheduledPost(actor, {
      conversationId: current.conversation.id,
      parentId: current.parentId,
      body: wanted.body,
      format: wanted.format ?? current.format,
      files: remaining,
    });
    body = checked.body;
    format = checked.format;
  }
  try {
    await query("select private.chat_schedule_update($1, $2, $3, $4, $5, $6::uuid[])", [actor.userId, scheduledId, body, format, sendAt?.toISOString() ?? null, removing]);
  } catch (error) {
    failure(error);
  }
  const item = (await readScheduled(actor, scheduledId))[0];
  if (!item) throw new CrmError("not_found", "That message is no longer scheduled.", 404);
  return { item };
}

export async function cancelScheduled(actor: UserActor, id: unknown): Promise<{ cancelled: boolean }> {
  const scheduledId = checkId(id, "scheduled message");
  try {
    const result = await query<{ cancelled: boolean }>("select private.chat_schedule_cancel($1, $2) as cancelled", [actor.userId, scheduledId]);
    return { cancelled: result.rows[0]?.cancelled === true };
  } catch (error) {
    failure(error);
  }
}

function permanentReason(error: unknown): string | null {
  if (!(error instanceof CrmError) || error.status >= 500) return null;
  if (error.details?.field === "files") return FILE_MISSING;
  if (error.code === "not_found") return LEFT;
  return error.message;
}

async function notifyFailed(userId: string, row: { id: string; claim_token: string }, reason: string, options: DeliverOptions) {
  try {
    const actor = await actingActor(userId, "", true);
    if (!actor) return;
    await alertMembers(
      actor,
      [userId],
      { source: "chat", key: `chat-scheduled:${row.id}:${row.claim_token}`, title: NOTICE_TITLE, body: reason, href: CHAT_SCHEDULED_PATH, tag: `chat-scheduled:${row.id}` },
      { includeSelf: true, recipientsVerified: true, send: options.send },
    );
  } catch (error) {
    console.error("Scheduled message notice failed", error instanceof Error ? error.name : "unknown");
  }
}

async function release(row: Claimed, reason: string | null, options: DeliverOptions & { notify: boolean }): Promise<DeliverOutcome> {
  const released = await query<{ user_id: string; failed: boolean; failure: string | null }>("select * from private.chat_schedule_release($1, $2, $3)", [row.id, row.claim_token, reason]);
  const result = released.rows[0];
  if (!result?.failed) return { outcome: "retry" };
  const text = result.failure ?? SEND_FAILED;
  if (options.notify) {
    await broadcastChat([row.user_id], { type: "scheduled", conversationId: row.conversation_id });
    await notifyFailed(row.user_id, row, text, options);
  }
  return { outcome: "failed", reason: text };
}

export async function deliverScheduled(row: Claimed, options: DeliverOptions & { actor?: UserActor | null; notify?: boolean } = {}): Promise<DeliverOutcome> {
  const notify = options.notify !== false;
  try {
    const actor = options.actor ?? (await actingActor(row.user_id, "", true));
    if (!actor) return await release(row, NO_ACCOUNT, { ...options, notify });
    const posted = await query<{ posted: boolean }>("select private.chat_schedule_posted($1, $2) as posted", [row.id, row.claim_token]);
    if (posted.rows[0]?.posted) return { outcome: "sent", post: null };
    const checked = await checkScheduledPost(actor, { conversationId: row.conversation_id, parentId: row.parent_id, body: row.body, format: row.format, files: row.attachment_ids.length });
    const post = await postMessage(
      actor,
      { conversationId: checked.conversationId, parentId: checked.parentId, body: checked.body, format: checked.format, clientKey: row.id, attachmentIds: row.attachment_ids },
      { roomMention: true, fetchImpl: options.fetchImpl, markRead: false },
    );
    await query("select private.chat_schedule_done($1, $2)", [row.id, row.claim_token]);
    return { outcome: "sent", post };
  } catch (error) {
    const reason = permanentReason(error);
    if (!reason) console.error("Scheduled message attempt failed", error instanceof Error ? error.name : "unknown");
    try {
      return await release(row, reason, { ...options, notify });
    } catch (releasing) {
      console.error("Scheduled message release failed", releasing instanceof Error ? releasing.name : "unknown");
      return { outcome: "retry" };
    }
  }
}

export async function sendScheduledNow(actor: UserActor, id: unknown, options: DeliverOptions = {}): Promise<{ post: ChatPost | null }> {
  const scheduledId = checkId(id, "scheduled message");
  let claimed: Claimed | undefined;
  try {
    claimed = (await query<Claimed>("select * from private.chat_schedule_claim_now($1, $2)", [actor.userId, scheduledId])).rows[0];
  } catch (error) {
    failure(error);
  }
  if (!claimed) throw new CrmError("not_found", "That message is no longer scheduled.", 404);
  const result = await deliverScheduled(claimed, { ...options, actor, notify: false });
  if (result.outcome === "sent") return { post: result.post };
  if (result.outcome === "failed") throw new CrmError("conflict", result.reason, 409);
  throw new CrmError("upstream_error", SEND_FAILED, 502);
}

export async function processDueScheduled(options: DeliverOptions & { deadline?: number } = {}): Promise<DueResult> {
  const deadline = options.deadline ?? Date.now() + SEND_BUDGET_MS;
  const totals: DueResult = { sent: 0, failed: 0, retried: 0 };
  const tried: string[] = [];
  while (Date.now() < deadline) {
    const claimed = (await query<Claimed>("select * from private.chat_schedule_claim_due($1::uuid[])", [tried])).rows[0];
    if (!claimed) break;
    tried.push(claimed.id);
    const result = await deliverScheduled(claimed, options);
    if (result.outcome === "sent") totals.sent += 1;
    else if (result.outcome === "failed") totals.failed += 1;
    else totals.retried += 1;
  }
  return totals;
}

export async function sweepScheduled(limit = 200) {
  const result = await query<{ count: number }>("select private.chat_sweep_scheduled($1) as count", [limit]);
  return result.rows[0]?.count ?? 0;
}
