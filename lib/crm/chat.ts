import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { alertMembers, type TeamAlert } from "@/lib/alerts";
import {
  CHAT_BODY_MAX,
  CHAT_CLIENT_KEY_MAX,
  CHAT_COUNT_CAP,
  CHAT_PAGE_MAX,
  CHAT_PAGE_SIZE,
  CHAT_ROOM_NAME_MAX,
  EMPTY_HOOK_CARD,
  type ChatConversation,
  type ChatDiscussion,
  type ChatHookCard,
  type ChatKind,
  type ChatLiveEvent,
  type ChatMember,
  type ChatMessage,
  type ChatPage,
  type ChatPerson,
  type ChatPost,
  type ChatRoom,
  type ChatRoot,
  type ChatSearchResult,
  type ChatSidebar,
  type ChatSubject,
  type ChatSubjectKind,
  type ChatThread,
  type ChatThreadCard,
  type ChatThreads,
} from "@/lib/chat/types";
import { discussionHref, readSubject, taskPanelHref } from "@/lib/chat/discussions";
import { afterCommit } from "@/lib/crm/after-commit";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { addTaskParticipantsInDb } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { publishLiveBatch, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { sharedThreadHref } from "@/lib/mail/share-types";
import { mentionsIn } from "@/lib/mentions";

type Stamp = Date | string;

type MessageRow = {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  author_user_id: string | null;
  author_name: string;
  via_workflow_id: string | null;
  via_workflow_name: string | null;
  client_key: string | null;
  body: string;
  mentions: string[] | null;
  reply_count: number;
  last_reply_at: Stamp | null;
  edited_at: Stamp | null;
  deleted_at: Stamp | null;
  created_at: Stamp;
  reply_authors: ChatPerson[] | null;
  hook: { title?: unknown; url?: unknown; block?: unknown } | null;
};

type ConversationRow = {
  id: string;
  kind: ChatKind;
  name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  dm_user_id: string | null;
  dm_name: string | null;
  created_at: Stamp;
  created_by: string | null;
  last_message_at: Stamp | null;
  last_read_at: Stamp;
  unread: number;
  mentions: number;
  task_id?: string | null;
  page_id?: string | null;
  mail_share_id?: string | null;
  subject_workspace_id?: string | null;
};

type MemberRow = { user_id: string; last_read_at: Stamp };

export type LinkedRoom = { conversationId: string; memberIds: string[] };

const THREAD_CARD_REPLIES = 2;
const THREADS_PAGE_SIZE = 20;
const THREADS_PAGE_MAX = 50;
const SEARCH_LIMIT = 30;
const MENTION_MAX = 50;
const FORMER = "Former teammate";
const NUL = /\u0000/g;
const CONTROLS = /[\u0000\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const FILLERS = /[\u115F\u1160\u3164\uFFA0\u2800]/g;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function iso(value: Stamp): string;
function iso(value: Stamp | null): string | null;
function iso(value: Stamp | null) {
  return value === null ? null : new Date(value).toISOString();
}

function millis(value: Stamp) {
  return new Date(value).getTime();
}

function messageColumns(alias = "m") {
  return `${alias}.id, ${alias}.conversation_id, ${alias}.parent_id, ${alias}.author_user_id, ${alias}.author_name, ${alias}.via_workflow_id, ${alias}.via_workflow_name, ${alias}.client_key, ${alias}.body,
    ${alias}.mentions::text[] as mentions, ${alias}.reply_count, ${alias}.last_reply_at, ${alias}.edited_at, ${alias}.deleted_at, ${alias}.created_at, ${alias}.hook,
    case when ${alias}.reply_count > 0 then coalesce((
      select json_agg(json_build_object('id', a.author_user_id, 'name', a.author_name) order by a.latest desc)
      from (
        select r.author_user_id, (array_agg(r.author_name order by r.created_at desc))[1] as author_name, max(r.created_at) as latest
        from crm.chat_messages r
        where r.parent_id = ${alias}.id and r.deleted_at is null and r.author_user_id is not null
        group by r.author_user_id
        order by latest desc
        limit 3
      ) a
    ), '[]'::json) else '[]'::json end as reply_authors`;
}

function toMessage(row: MessageRow, viewerId: string): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    author: { id: row.author_user_id, name: row.author_name || FORMER },
    via: row.via_workflow_name ? { workflowId: row.via_workflow_id, name: row.via_workflow_name } : null,
    clientKey: row.author_user_id === viewerId ? row.client_key : null,
    body: row.body,
    mentions: row.mentions ?? [],
    replyCount: row.reply_count,
    lastReplyAt: iso(row.last_reply_at),
    replyAuthors: row.reply_authors ?? [],
    editedAt: iso(row.edited_at),
    deletedAt: iso(row.deleted_at),
    createdAt: iso(row.created_at),
    hook: row.deleted_at && row.hook ? { ...EMPTY_HOOK_CARD } : hookCard(row.hook),
  };
}

export function hookCard(value: { title?: unknown; url?: unknown; block?: unknown } | null): ChatHookCard | null {
  if (!value || typeof value !== "object") return null;
  return {
    title: typeof value.title === "string" && value.title ? value.title : null,
    url: typeof value.url === "string" && /^https?:\/\//i.test(value.url) ? value.url : null,
    block: value.block === true,
  };
}

function forViewer(message: ChatMessage, viewerId: string): ChatMessage {
  return message.author.id === viewerId ? message : { ...message, clientKey: null };
}

function toRoot(message: ChatMessage): ChatRoot {
  return { id: message.id, replyCount: message.replyCount, lastReplyAt: message.lastReplyAt, replyAuthors: message.replyAuthors };
}

function toConversation(row: ConversationRow): ChatConversation {
  const dm = row.kind === "dm";
  return {
    id: row.id,
    kind: row.kind,
    name: dm ? row.dm_name || FORMER : row.name ?? "",
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    dmUser: dm && row.dm_user_id ? { id: row.dm_user_id, name: row.dm_name || FORMER } : null,
    createdAt: iso(row.created_at),
    lastMessageAt: iso(row.last_message_at),
    lastReadAt: iso(row.last_read_at),
    unread: row.unread,
    mentions: row.mentions,
  };
}

const MEMBER_NAME = (member: string, profile: string) => `coalesce(nullif(btrim(${member}.name), ''), nullif(btrim(${profile}.full_name), ''), ${profile}.email)`;

const CONVERSATIONS_SQL = `
  select c.id, c.kind, c.name, c.workspace_id, w.name as workspace_name, c.created_at, c.created_by, me.last_read_at,
    last.created_at as last_message_at,
    other.user_id as dm_user_id,
    case when c.kind = 'dm' then coalesce(
      ${MEMBER_NAME("other", "p")},
      (select a.author_name from crm.chat_messages a
       where a.conversation_id = c.id and a.author_user_id = partner.id
       order by a.created_at desc limit 1)
    ) end as dm_name,
    counts.unread, mentioned.mentions
  from crm.chat_members me
  join crm.chat_conversations c on c.id = me.conversation_id and c.kind in ('room', 'dm') and c.archived_at is null
  left join crm.workspaces w on w.id = c.workspace_id
  left join lateral (
    select m.created_at from crm.chat_messages m
    where m.conversation_id = c.id and m.parent_id is null and m.deleted_at is null
    order by m.created_at desc, m.id desc limit 1
  ) last on true
  left join lateral (
    select o.user_id, o.name from crm.chat_members o where o.conversation_id = c.id and o.user_id <> me.user_id limit 1
  ) other on c.kind = 'dm'
  left join lateral (
    select coalesce(other.user_id, (case when split_part(c.dm_key, ':', 1) = me.user_id::text then split_part(c.dm_key, ':', 2) else split_part(c.dm_key, ':', 1) end)::uuid) as id
  ) partner on c.kind = 'dm'
  left join crm.profiles p on p.id = partner.id
  cross join lateral (
    select count(*)::integer as unread
    from (
      select 1 from crm.chat_messages m
      where m.conversation_id = c.id and m.parent_id is null and m.deleted_at is null
        and m.created_at > me.last_read_at and (m.author_user_id is distinct from me.user_id or m.via_workflow_name is not null)
      limit ${CHAT_COUNT_CAP}
    ) u
  ) counts
  cross join lateral (
    select count(*)::integer as mentions
    from (
      select 1 from crm.chat_messages m
      where m.conversation_id = c.id and m.parent_id is null and m.deleted_at is null
        and m.created_at > me.last_read_at and (m.author_user_id is distinct from me.user_id or m.via_workflow_name is not null) and me.user_id = any(m.mentions)
      limit ${CHAT_COUNT_CAP}
    ) u
  ) mentioned
  where me.user_id = $1`;

function chatFailure(error: unknown): never {
  throw pgFailure(error) ?? error;
}

function checkId(id: unknown, noun: string): string {
  if (typeof id !== "string" || !isUuid(id)) throw notFound(noun);
  return id.toLowerCase();
}

function pageSize(limit: unknown, fallback = CHAT_PAGE_SIZE) {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(CHAT_PAGE_MAX, Math.max(1, value));
}

function cleanBody(body: unknown) {
  const text = typeof body === "string" ? body.replace(NUL, "").replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new CrmError("invalid_input", "Write a message first.", 400, { field: "body" });
  if (text.length > CHAT_BODY_MAX) throw new CrmError("invalid_input", "Keep messages to 10,000 characters.", 400, { field: "body" });
  return text;
}

function memberMentions(body: string) {
  const ids = mentionsIn(body)
    .filter((mention) => mention.kind === "member" && isUuid(mention.id))
    .map((mention) => mention.id.toLowerCase());
  const unique = [...new Set(ids)];
  if (unique.length > MENTION_MAX) throw new CrmError("invalid_input", "Tag up to 50 people in one message.", 400, { field: "body" });
  return unique;
}

function cleanRoomName(name: unknown) {
  const text = typeof name === "string" ? name.replace(CONTROLS, "").trim().replace(/^#+/, "").replace(/\s+/g, " ").trim() : "";
  if (!LETTER_OR_DIGIT.test(text.replace(FILLERS, ""))) throw new CrmError("invalid_input", "Give the room a name.", 400, { field: "name" });
  if (text.length > CHAT_ROOM_NAME_MAX) throw new CrmError("invalid_input", "Keep the room name to 80 characters.", 400, { field: "name" });
  return text;
}

function cleanPeople(ids: unknown): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new CrmError("invalid_input", "Pick people from the list.", 400, { field: "members" });
  const clean = ids.map((id) => (typeof id === "string" && isUuid(id) ? id.toLowerCase() : null));
  if (clean.some((id) => id === null)) throw new CrmError("invalid_input", "Pick people from the list.", 400, { field: "members" });
  return [...new Set(clean as string[])];
}

function cleanClientKey(key: unknown) {
  if (typeof key !== "string") return randomUUID();
  const trimmed = key.replace(NUL, "").trim();
  if (!trimmed) return randomUUID();
  if (trimmed.length > CHAT_CLIENT_KEY_MAX) throw new CrmError("invalid_input", "That message key is too long.", 400, { field: "clientKey" });
  return trimmed;
}

function firstName(actor: UserActor) {
  return actor.fullName?.trim().split(/\s+/)[0] || actor.email || "A teammate";
}

const running = new Set<Promise<void>>();

function tracked(task: () => Promise<void>) {
  return () => {
    const work: Promise<void> = task()
      .catch((error) => console.error("Chat background work failed", error))
      .finally(() => running.delete(work));
    running.add(work);
    return work;
  };
}

export async function chatWorkSettled() {
  while (running.size > 0) await Promise.all([...running]);
}

function background(task: () => Promise<void>) {
  const run = tracked(task);
  try {
    after(run);
  } catch {
    void run();
  }
}

export function chatBackground(task: () => Promise<void>) {
  background(task);
}

function afterChatCommit(db: Db, task: () => Promise<void>) {
  afterCommit(db, tracked(task));
}

async function publish(messages: LiveMessage[]) {
  await publishLiveBatch(messages).catch((error) => console.error("Chat broadcast failed", error));
}

function eventFor(userId: string, event: ChatLiveEvent): LiveMessage {
  const payload = event.type === "message" || event.type === "edit" ? { ...event, message: forViewer(event.message, userId) } : event;
  return { topic: personTopic(userId), event: "chat", payload };
}

export async function broadcastChat(userIds: string[], event: ChatLiveEvent) {
  await broadcast(userIds, event);
}

async function broadcast(userIds: string[], event: ChatLiveEvent) {
  await publish([...new Set(userIds)].map((userId) => eventFor(userId, event)));
}

function broadcastAfterCommit(db: Db, userIds: string[], event: ChatLiveEvent) {
  afterChatCommit(db, () => broadcast(userIds, event));
}

const SUBJECT_SQL = `
  select c.id, c.kind, coalesce(t.title, p.title, '') as name, null::uuid as workspace_id, null::text as workspace_name, c.created_at, c.created_by,
    now() as last_read_at, null::timestamptz as last_message_at, null::uuid as dm_user_id, null::text as dm_name, 0 as unread, 0 as mentions,
    c.task_id, c.page_id, c.mail_share_id, coalesce(t.workspace_id, p.workspace_id) as subject_workspace_id
  from crm.chat_conversations c
  left join crm.tasks t on c.kind = 'task' and t.id = c.task_id
  left join crm.pages p on c.kind = 'doc' and p.id = c.page_id
  where c.kind in ('task', 'doc', 'mail_thread') and c.archived_at is null`;

const SUBJECT_AUDIENCE_SQL = `
  select wm.user_id, now() as last_read_at
  from crm.chat_conversations c
  join crm.tasks t on t.id = c.task_id
  join crm.workspace_members wm on wm.workspace_id = t.workspace_id
  where c.id = $1 and c.kind = 'task'
    and (
      wm.user_id = t.owner_id
      or wm.user_id = t.created_by_user_id
      or wm.role in ('owner', 'admin')
      or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = wm.user_id)
    )
  union
  select wm.user_id, now() as last_read_at
  from crm.chat_conversations c
  join crm.pages p on p.id = c.page_id
  join crm.workspace_members wm on wm.workspace_id = p.workspace_id
  where c.id = $1 and c.kind = 'doc' and p.effective_shared and p.kind = 'note'
  union
  select s.owner_user_id, now() as last_read_at
  from crm.chat_conversations c
  join crm.mail_shares s on s.id = c.mail_share_id
  where c.id = $1 and c.kind = 'mail_thread'
  union
  select sm.user_id, now() as last_read_at
  from crm.chat_conversations c
  join crm.mail_share_members sm on sm.share_id = c.mail_share_id
  where c.id = $1 and c.kind = 'mail_thread'`;

async function readConversation(db: Db, actor: UserActor, id: string) {
  const result = await db.query<ConversationRow>(`${CONVERSATIONS_SQL} and c.id = $2`, [actor.userId, id]);
  const row = result.rows[0] ?? (await db.query<ConversationRow>(`${SUBJECT_SQL} and c.id = $1`, [id])).rows[0];
  if (!row) throw notFound("conversation");
  return row;
}

async function memberIds(db: Db, conversationId: string) {
  const result = await db.query<MemberRow>(
    `select user_id, last_read_at from crm.chat_members where conversation_id = $1
     union all
     select a.user_id, a.last_read_at from (${SUBJECT_AUDIENCE_SQL}) a`,
    [conversationId],
  );
  return result.rows;
}

async function readMessage(db: Db, id: string, viewerId: string) {
  const result = await db.query<MessageRow>(`select ${messageColumns()} from crm.chat_messages m where m.id = $1`, [id]);
  return result.rows[0] ? toMessage(result.rows[0], viewerId) : null;
}

export async function listConversations(actor: UserActor): Promise<ChatSidebar> {
  return withActor(actor, async (db) => {
    const rows = await db.query<ConversationRow>(
      `${CONVERSATIONS_SQL}
         and not (
           c.kind = 'dm' and not me.opened
           and not exists (select 1 from crm.chat_messages v where v.conversation_id = c.id and v.parent_id is null and (v.deleted_at is null or v.reply_count > 0))
         )
       order by c.kind, coalesce(last.created_at, c.created_at) desc`,
      [actor.userId],
    );
    const threads = await db.query<{ unread: number; mentions: number }>(
      `select count(*) filter (where u.unread > 0)::integer as unread, coalesce(sum(u.mentions), 0)::integer as mentions
       from crm.chat_thread_reads t
       join crm.chat_messages r on r.id = t.message_id
       join crm.chat_conversations c on c.id = r.conversation_id and c.kind in ('room', 'dm') and c.archived_at is null
       cross join lateral (
         select
           (select count(*)::integer from (
             select 1 from crm.chat_messages x
             where x.parent_id = r.id and x.deleted_at is null and x.created_at > t.last_read_at and x.author_user_id is distinct from t.user_id
             limit ${CHAT_COUNT_CAP}
           ) a) as unread,
           (select count(*)::integer from (
             select 1 from crm.chat_messages x
             where x.parent_id = r.id and x.deleted_at is null and x.created_at > t.last_read_at and x.author_user_id is distinct from t.user_id and t.user_id = any(x.mentions)
             limit ${CHAT_COUNT_CAP}
           ) b) as mentions
       ) u
       where t.user_id = $1 and r.last_reply_at > t.last_read_at`,
      [actor.userId],
    );
    const conversations = rows.rows.map(toConversation);
    const threadCounts = threads.rows[0] ?? { unread: 0, mentions: 0 };
    return {
      conversations,
      threads: threadCounts,
      unreadConversations: conversations.filter((conversation) => conversation.unread > 0).length,
      mentioned: threadCounts.mentions > 0 || conversations.some((conversation) => conversation.mentions > 0 || (conversation.kind === "dm" && conversation.unread > 0)),
    };
  });
}

export async function getConversation(actor: UserActor, id: string): Promise<ChatConversation> {
  const conversationId = checkId(id, "conversation");
  return withActor(actor, async (db) => toConversation(await readConversation(db, actor, conversationId)));
}

export async function getRoom(actor: UserActor, id: string): Promise<ChatRoom> {
  const conversationId = checkId(id, "conversation");
  return withActor(actor, async (db) => {
    const row = await readConversation(db, actor, conversationId);
    const members = await db.query<{ user_id: string; name: string | null; email: string | null; created_at: Stamp; added_by: string | null }>(
      `select m.user_id, ${MEMBER_NAME("m", "p")} as name, p.email, m.created_at, m.added_by
       from crm.chat_members m
       left join crm.profiles p on p.id = m.user_id
       where m.conversation_id = $1
       order by m.created_at, ${MEMBER_NAME("m", "p")}`,
      [conversationId],
    );
    const list: ChatMember[] = members.rows.map((member) => ({
      id: member.user_id,
      name: member.name || FORMER,
      email: member.email,
      addedAt: iso(member.created_at),
      addedBy: member.added_by,
    }));
    return { conversation: toConversation(row), members: list, createdBy: row.created_by };
  });
}

export async function listChatPeople(actor: UserActor, options: { workspaceId?: string | null } = {}): Promise<(ChatPerson & { email: string | null })[]> {
  const workspaceId = options.workspaceId ? checkId(options.workspaceId, "workspace") : null;
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string | null; email: string | null }>(
      `select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name, p.email
       from crm.profiles p
       where p.id <> $1
         and ($2::uuid is null or exists (select 1 from crm.workspace_members m where m.workspace_id = $2 and m.user_id = p.id))
       order by lower(coalesce(nullif(btrim(p.full_name), ''), p.email, ''))`,
      [actor.userId, workspaceId],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name || FORMER, email: row.email }));
  });
}

export async function createRoom(actor: UserActor, input: { name: unknown; workspaceId?: unknown; memberIds?: unknown }): Promise<ChatConversation> {
  const name = cleanRoomName(input.name);
  const workspaceId = input.workspaceId ? checkId(input.workspaceId, "workspace") : null;
  const members = cleanPeople(input.memberIds).filter((id) => id !== actor.userId);
  let id: string;
  try {
    const result = await query<{ id: string }>("select private.chat_create_room($1, $2, $3, $4) as id", [actor.userId, name, workspaceId, members]);
    id = result.rows[0].id;
  } catch (error) {
    chatFailure(error);
  }
  const conversation = await getConversation(actor, id);
  background(() => broadcast([actor.userId, ...members], { type: "conversation", conversationId: id }));
  return conversation;
}

export async function updateRoom(actor: UserActor, id: string, input: { name?: unknown; workspaceId?: unknown }): Promise<ChatConversation> {
  const conversationId = checkId(id, "room");
  const name = input.name === undefined ? null : cleanRoomName(input.name);
  const setWorkspace = input.workspaceId !== undefined;
  const workspaceId = setWorkspace && input.workspaceId ? checkId(input.workspaceId, "workspace") : null;
  try {
    await query("select private.chat_update_room($1, $2, $3, $4, $5)", [actor.userId, conversationId, name, setWorkspace, workspaceId]);
  } catch (error) {
    chatFailure(error);
  }
  return withActor(actor, async (db) => {
    const row = await readConversation(db, actor, conversationId);
    const members = await memberIds(db, conversationId);
    broadcastAfterCommit(
      db,
      members.map((member) => member.user_id),
      { type: "conversation", conversationId },
    );
    return toConversation(row);
  });
}

export async function addRoomMembers(actor: UserActor, id: string, userIds: unknown): Promise<{ added: string[] }> {
  const conversationId = checkId(id, "room");
  const people = cleanPeople(userIds);
  if (people.length === 0) throw new CrmError("invalid_input", "Pick someone to add.", 400, { field: "members" });
  let added: string[];
  try {
    const result = await query<{ added: string[] }>("select private.chat_add_members($1, $2, $3)::text[] as added", [actor.userId, conversationId, people]);
    added = result.rows[0]?.added ?? [];
  } catch (error) {
    chatFailure(error);
  }
  await withActor(actor, async (db) => {
    const members = await memberIds(db, conversationId);
    broadcastAfterCommit(
      db,
      members.map((member) => member.user_id),
      { type: "conversation", conversationId },
    );
  });
  return { added };
}

export async function removeRoomMember(actor: UserActor, id: string, userId: string): Promise<{ deleted: boolean }> {
  const conversationId = checkId(id, "room");
  const member = checkId(userId, "member");
  const before = await withActor(actor, async (db) => (await memberIds(db, conversationId)).map((row) => row.user_id));
  let deleted: boolean;
  try {
    const result = await query<{ deleted: boolean }>("select private.chat_remove_member($1, $2, $3) as deleted", [actor.userId, conversationId, member]);
    deleted = result.rows[0]?.deleted === true;
  } catch (error) {
    chatFailure(error);
  }
  background(() => announceRemoval(member, [{ conversationId, memberIds: before.filter((other) => other !== member) }]));
  return { deleted };
}

export async function leaveRoom(actor: UserActor, id: string) {
  return removeRoomMember(actor, id, actor.userId);
}

export async function roomsLostOnLeaving(workspaceId: string, userId: string): Promise<LinkedRoom[]> {
  const result = await query<{ conversation_id: string; member_ids: string[] }>("select conversation_id, member_ids::text[] as member_ids from private.chat_rooms_leaving($1, $2)", [
    workspaceId,
    userId,
  ]);
  return result.rows.map((row) => ({ conversationId: row.conversation_id, memberIds: row.member_ids ?? [] }));
}

export async function announceRemoval(userId: string, rooms: LinkedRoom[]) {
  if (rooms.length === 0) return;
  const messages: LiveMessage[] = [];
  for (const room of rooms) {
    messages.push(eventFor(userId, { type: "removed", conversationId: room.conversationId }));
    for (const other of new Set(room.memberIds)) {
      if (other !== userId) messages.push(eventFor(other, { type: "conversation", conversationId: room.conversationId }));
    }
  }
  await publish(messages);
}

export async function openDm(actor: UserActor, userId: string): Promise<ChatConversation> {
  const other = checkId(userId, "teammate");
  let id: string;
  try {
    const result = await query<{ id: string }>("select private.chat_open_dm($1, $2) as id", [actor.userId, other]);
    id = result.rows[0].id;
  } catch (error) {
    chatFailure(error);
  }
  return getConversation(actor, id);
}

type PageOptions = { before?: string | null; after?: string | null; around?: string | null; limit?: number };

const VISIBLE_ROOT = `m.conversation_id = $1 and m.parent_id is null and (m.deleted_at is null or m.reply_count > 0)`;
const ROOT_CURSOR = `(select k.created_at from crm.chat_messages k where k.id = $2 and k.conversation_id = $1)`;

async function rootCursor(db: Db, conversationId: string, value: string | null | undefined) {
  if (!value) return null;
  const id = checkId(value, "message");
  const result = await db.query<{ id: string; parent_id: string | null }>("select id, parent_id from crm.chat_messages where id = $1 and conversation_id = $2", [id, conversationId]);
  const row = result.rows[0];
  if (!row) throw notFound("message");
  return row.parent_id ?? row.id;
}

export async function listMessages(actor: UserActor, id: string, options: PageOptions = {}): Promise<ChatPage> {
  const conversationId = checkId(id, "conversation");
  const limit = pageSize(options.limit);
  return withActor(actor, async (db) => {
    const conversation = await readConversation(db, actor, conversationId);
    const older = async (pivot: string | null, count: number) => {
      const compare = pivot ? `and (m.created_at, m.id) < (${ROOT_CURSOR}, $2::uuid)` : "";
      const result = await db.query<MessageRow>(
        `select ${messageColumns()} from crm.chat_messages m where ${VISIBLE_ROOT} ${compare} order by m.created_at desc, m.id desc limit ${count + 1}`,
        pivot ? [conversationId, pivot] : [conversationId],
      );
      return { rows: result.rows.slice(0, count).reverse(), more: result.rows.length > count };
    };
    const newer = async (pivot: string, inclusive: boolean, count: number) => {
      const result = await db.query<MessageRow>(
        `select ${messageColumns()} from crm.chat_messages m where ${VISIBLE_ROOT} and (m.created_at, m.id) ${inclusive ? ">=" : ">"} (${ROOT_CURSOR}, $2::uuid)
         order by m.created_at, m.id limit ${count + 1}`,
        [conversationId, pivot],
      );
      return { rows: result.rows.slice(0, count), more: result.rows.length > count };
    };
    const beyond = async (pivot: string, side: ">=" | "<=") => {
      const result = await db.query(`select 1 from crm.chat_messages m where ${VISIBLE_ROOT} and (m.created_at, m.id) ${side} (${ROOT_CURSOR}, $2::uuid) limit 1`, [
        conversationId,
        pivot,
      ]);
      return (result.rowCount ?? 0) > 0;
    };
    const unread = await db.query<{ id: string }>(
      `select m.id from crm.chat_messages m
       where m.conversation_id = $1 and m.parent_id is null and m.deleted_at is null and (m.author_user_id is distinct from $2 or m.via_workflow_name is not null)
         and m.created_at > (select r.last_read_at from crm.chat_members r where r.conversation_id = $1 and r.user_id = $2)
       order by m.created_at, m.id limit 1`,
      [conversationId, actor.userId],
    );
    const firstUnreadId = unread.rows[0]?.id ?? null;
    const before = await rootCursor(db, conversationId, options.before);
    const afterId = before ? null : await rootCursor(db, conversationId, options.after);
    const around = before || afterId ? null : options.around === "unread" ? firstUnreadId : await rootCursor(db, conversationId, options.around);
    let rows: MessageRow[];
    let hasOlder = false;
    let hasNewer = false;
    if (before) {
      const page = await older(before, limit);
      rows = page.rows;
      hasOlder = page.more;
      hasNewer = await beyond(before, ">=");
    } else if (afterId) {
      const page = await newer(afterId, false, limit);
      rows = page.rows;
      hasNewer = page.more;
      hasOlder = await beyond(afterId, "<=");
    } else if (around) {
      const above = await older(around, Math.floor(limit / 2));
      const below = await newer(around, true, limit);
      rows = [...above.rows, ...below.rows];
      hasOlder = above.more;
      hasNewer = below.more;
    } else {
      const page = await older(null, limit);
      rows = page.rows;
      hasOlder = page.more;
    }
    return { messages: rows.map((row) => toMessage(row, actor.userId)), hasOlder, hasNewer, firstUnreadId, lastReadAt: iso(conversation.last_read_at) };
  });
}

async function readRoot(db: Db, rootId: string, viewerId: string) {
  const root = await readMessage(db, rootId, viewerId);
  if (!root || root.parentId) throw notFound("thread");
  return root;
}

async function replyCursor(db: Db, rootId: string, value: string | null | undefined) {
  if (!value) return null;
  const id = checkId(value, "message");
  const result = await db.query("select 1 from crm.chat_messages where id = $1 and parent_id = $2", [id, rootId]);
  if ((result.rowCount ?? 0) === 0) throw notFound("message");
  return id;
}

export async function listThread(actor: UserActor, rootId: string, options: { before?: string | null; after?: string | null; limit?: number } = {}): Promise<ChatThread> {
  const id = checkId(rootId, "thread");
  const limit = pageSize(options.limit, CHAT_PAGE_MAX);
  return withActor(actor, async (db) => {
    const root = await readRoot(db, id, actor.userId);
    const conversation = await readConversation(db, actor, root.conversationId);
    const cursor = `(select k.created_at from crm.chat_messages k where k.id = $2 and k.parent_id = $1)`;
    const before = await replyCursor(db, id, options.before);
    const afterId = before ? null : await replyCursor(db, id, options.after);
    const beyond = async (pivot: string, side: ">=" | "<=") => {
      const result = await db.query(`select 1 from crm.chat_messages m where m.parent_id = $1 and m.deleted_at is null and (m.created_at, m.id) ${side} (${cursor}, $2::uuid) limit 1`, [
        id,
        pivot,
      ]);
      return (result.rowCount ?? 0) > 0;
    };
    let rows: MessageRow[];
    let hasOlder = false;
    let hasNewer = false;
    if (afterId) {
      const result = await db.query<MessageRow>(
        `select ${messageColumns()} from crm.chat_messages m where m.parent_id = $1 and m.deleted_at is null and (m.created_at, m.id) > (${cursor}, $2::uuid)
         order by m.created_at, m.id limit ${limit + 1}`,
        [id, afterId],
      );
      rows = result.rows.slice(0, limit);
      hasNewer = result.rows.length > limit;
      hasOlder = await beyond(afterId, "<=");
    } else {
      const compare = before ? `and (m.created_at, m.id) < (${cursor}, $2::uuid)` : "";
      const result = await db.query<MessageRow>(
        `select ${messageColumns()} from crm.chat_messages m where m.parent_id = $1 and m.deleted_at is null ${compare}
         order by m.created_at desc, m.id desc limit ${limit + 1}`,
        before ? [id, before] : [id],
      );
      rows = result.rows.slice(0, limit).reverse();
      hasOlder = result.rows.length > limit;
      hasNewer = before ? await beyond(before, ">=") : false;
    }
    const follow = await db.query<{ last_read_at: Stamp }>("select last_read_at from crm.chat_thread_reads where message_id = $1 and user_id = $2", [id, actor.userId]);
    const lastReadAt = follow.rows[0]?.last_read_at ?? null;
    return {
      conversation: toConversation(conversation),
      root,
      replies: rows.map((row) => toMessage(row, actor.userId)),
      hasOlder,
      hasNewer,
      following: Boolean(lastReadAt),
      lastReadAt: iso(lastReadAt),
    };
  });
}

type ThreadsCursor = { u: 0 | 1; t: string; id: string };

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

function readThreadsCursor(value: string | null | undefined): ThreadsCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ThreadsCursor>;
    if ((parsed.u === 0 || parsed.u === 1) && typeof parsed.t === "string" && CURSOR_TIME.test(parsed.t) && typeof parsed.id === "string" && isUuid(parsed.id)) {
      return { u: parsed.u, t: parsed.t, id: parsed.id.toLowerCase() };
    }
  } catch {}
  throw new CrmError("invalid_input", "That page of threads isn't valid. Reload Threads.", 400);
}

function threadsCursor(cursor: ThreadsCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export async function listThreads(actor: UserActor, options: { cursor?: string | null; limit?: number } = {}): Promise<ChatThreads> {
  const limit = Math.min(THREADS_PAGE_MAX, pageSize(options.limit, THREADS_PAGE_SIZE));
  const cursor = readThreadsCursor(options.cursor);
  return withActor(actor, async (db) => {
    const result = await db.query<
      MessageRow & { last_read: Stamp; unread: number; unread_mentions: number; c_kind: ChatKind; c_name: string | null; dm_name: string | null; reply_at: string }
    >(
      `select ${messageColumns("r")}, r.last_reply_at::text as reply_at, t.last_read_at as last_read, u.unread, u.mentions as unread_mentions, c.kind as c_kind, c.name as c_name,
         case when c.kind = 'dm' then (
           select ${MEMBER_NAME("o", "p")} from crm.chat_members o left join crm.profiles p on p.id = o.user_id
           where o.conversation_id = c.id and o.user_id <> t.user_id limit 1
         ) end as dm_name
       from crm.chat_thread_reads t
       join crm.chat_messages r on r.id = t.message_id
       join crm.chat_conversations c on c.id = r.conversation_id and c.kind in ('room', 'dm') and c.archived_at is null
       cross join lateral (
         select
           (select count(*)::integer from (
             select 1 from crm.chat_messages x
             where x.parent_id = r.id and x.deleted_at is null and x.created_at > t.last_read_at and x.author_user_id is distinct from t.user_id
             limit ${CHAT_COUNT_CAP}
           ) a) as unread,
           (select count(*)::integer from (
             select 1 from crm.chat_messages x
             where x.parent_id = r.id and x.deleted_at is null and x.created_at > t.last_read_at and x.author_user_id is distinct from t.user_id and t.user_id = any(x.mentions)
             limit ${CHAT_COUNT_CAP}
           ) b) as mentions
       ) u
       where t.user_id = $1 and r.reply_count > 0
         and ($2::integer is null or ((case when u.unread > 0 then 1 else 0 end), r.last_reply_at, r.id) < ($2::integer, $3::timestamptz, $4::uuid))
       order by (case when u.unread > 0 then 1 else 0 end) desc, r.last_reply_at desc, r.id desc
       limit ${limit + 1}`,
      [actor.userId, cursor?.u ?? null, cursor?.t ?? null, cursor?.id ?? null],
    );
    const rows = result.rows.slice(0, limit);
    const latest = await db.query<MessageRow & { root_id: string }>(
      `select x.root_id, ${messageColumns("m")}
       from unnest($1::uuid[]) as x(root_id)
       cross join lateral (
         select * from crm.chat_messages y where y.parent_id = x.root_id and y.deleted_at is null order by y.created_at desc, y.id desc limit ${THREAD_CARD_REPLIES}
       ) m`,
      [rows.map((row) => row.id)],
    );
    const byRoot = new Map<string, ChatMessage[]>();
    for (const row of latest.rows) byRoot.set(row.root_id, [toMessage(row, actor.userId), ...(byRoot.get(row.root_id) ?? [])]);
    const threads: ChatThreadCard[] = rows.map((row) => {
      const replies = (byRoot.get(row.id) ?? []).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        conversation: { id: row.conversation_id, kind: row.c_kind, name: row.c_kind === "dm" ? row.dm_name || FORMER : row.c_name ?? "" },
        root: toMessage(row, actor.userId),
        latest: replies,
        earlier: Math.max(0, row.reply_count - replies.length),
        unread: row.unread,
        mentions: row.unread_mentions,
        lastReadAt: iso(row.last_read),
      };
    });
    const last = rows[rows.length - 1];
    const next = result.rows.length > limit && last ? threadsCursor({ u: last.unread > 0 ? 1 : 0, t: last.reply_at, id: last.id }) : null;
    return { threads, next };
  });
}

function likePattern(text: string) {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export async function searchMessages(actor: UserActor, id: string, text: unknown, options: { limit?: number } = {}): Promise<ChatSearchResult> {
  const conversationId = checkId(id, "conversation");
  const search = typeof text === "string" ? text.replace(NUL, "").trim().slice(0, 200) : "";
  if (!search) return { messages: [] };
  const limit = Math.min(SEARCH_LIMIT, pageSize(options.limit, SEARCH_LIMIT));
  let ids: string[];
  try {
    const found = await query<{ id: string }>("select id from private.chat_search($1, $2, $3, $4)", [actor.userId, conversationId, likePattern(search), limit]);
    ids = found.rows.map((row) => row.id);
  } catch (error) {
    chatFailure(error);
  }
  if (ids.length === 0) return { messages: [] };
  return withActor(actor, async (db) => {
    const result = await db.query<MessageRow>(`select ${messageColumns()} from crm.chat_messages m where m.id = any($1::uuid[]) and m.conversation_id = $2`, [ids, conversationId]);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    return { messages: ids.flatMap((messageId) => (byId.has(messageId) ? [toMessage(byId.get(messageId)!, actor.userId)] : [])) };
  });
}

type PostInput = { conversationId: unknown; parentId?: unknown; body: unknown; clientKey?: unknown };

function chatHref(conversationId: string, message: ChatMessage) {
  return message.parentId ? `/chat/${conversationId}?thread=${message.parentId}` : `/chat/${conversationId}?message=${message.id}`;
}

const VERIFIED = { recipientsVerified: true };

type AlertJob = () => Promise<void>;

function alertJob(actor: UserActor, recipients: string[], alert: TeamAlert, options: { includeSelf?: boolean } = {}): AlertJob[] {
  if (recipients.length === 0) return [];
  return [
    async () => {
      await alertMembers(actor, recipients, alert, { ...VERIFIED, ...options });
    },
  ];
}

function mentionAlert(actor: UserActor, conversation: ConversationRow, message: ChatMessage, recipients: string[]) {
  const sender = message.via ? `${firstName(actor)} via ${message.via.name}` : firstName(actor);
  return alertJob(
    actor,
    recipients,
    {
      source: "chat",
      href: chatHref(conversation.id, message),
      tag: `chat:${conversation.id}`,
      body: null,
      key: `chat:mention:${message.id}`,
      title: `${sender} mentioned you in #${conversation.name ?? ""}`.slice(0, 200),
    },
    { includeSelf: Boolean(message.via) },
  );
}

function postAlerts(actor: UserActor, conversation: ConversationRow, members: MemberRow[], message: ChatMessage): AlertJob[] {
  const name = firstName(actor);
  const tag = `chat:${conversation.id}`;
  const dm = conversation.kind === "dm";
  const others = members.filter((member) => member.user_id !== actor.userId);
  const memberSet = new Set((message.via ? members : others).map((member) => member.user_id));
  const mentioned = dm ? [] : message.mentions.filter((id) => memberSet.has(id));
  const jobs = mentionAlert(actor, conversation, message, mentioned);
  if (!message.parentId) {
    if (dm) {
      for (const other of others) {
        jobs.push(
          ...alertJob(actor, [other.user_id], {
            source: "chat",
            href: `/chat/${conversation.id}`,
            tag,
            body: null,
            key: `chat:dm:${conversation.id}:${millis(other.last_read_at)}`,
            title: `${name} sent you a message`,
          }),
        );
      }
    }
    return jobs;
  }
  const rootId = message.parentId;
  const skip = new Set([actor.userId, ...mentioned]);
  const title = dm ? `${name} replied in a thread` : `${name} replied in a thread in #${conversation.name ?? ""}`;
  jobs.push(async () => {
    const followers = await query<{ user_id: string; last_read_at: Stamp }>("select user_id, last_read_at from private.chat_thread_followers($1, $2)", [actor.userId, rootId]);
    const byKey = new Map<string, string[]>();
    for (const follower of followers.rows) {
      if (skip.has(follower.user_id)) continue;
      const key = `chat:thread:${rootId}:${millis(follower.last_read_at)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), follower.user_id]);
    }
    for (const [key, recipients] of byKey) {
      await alertMembers(actor, recipients, { source: "chat", href: chatHref(conversation.id, message), tag, body: null, key, title }, VERIFIED);
    }
  });
  return jobs;
}

function afterPost(db: Db, userIds: string[], event: ChatLiveEvent, jobs: AlertJob[]) {
  afterChatCommit(db, async () => {
    await broadcast(userIds, event);
    for (const job of jobs) {
      try {
        await job();
      } catch (error) {
        console.error("Chat alert failed", error);
      }
    }
  });
}

export async function ownPostWithKey(actor: UserActor, clientKey: string): Promise<{ conversationId: string; parentId: string | null } | null> {
  const key = cleanClientKey(clientKey);
  return withActor(actor, async (db) => {
    const result = await db.query<{ conversation_id: string; parent_id: string | null }>(
      "select conversation_id, parent_id from crm.chat_messages where author_user_id = $1 and client_key = $2",
      [actor.userId, key],
    );
    const row = result.rows[0];
    return row ? { conversationId: row.conversation_id, parentId: row.parent_id } : null;
  });
}

export function checkChatPost(body: unknown) {
  const text = cleanBody(body);
  memberMentions(text);
  return text;
}

async function existingPost(db: Db, actor: UserActor, clientKey: string, conversationId: string, parentId: string | null, body?: string): Promise<ChatPost | null> {
  const existing = await db.query<{ id: string; body: string }>("select id, body from crm.chat_messages where author_user_id = $1 and client_key = $2", [actor.userId, clientKey]);
  if (!existing.rows[0]) return null;
  const message = await readMessage(db, existing.rows[0].id, actor.userId);
  if (!message || message.conversationId !== conversationId || message.parentId !== parentId || (body !== undefined && existing.rows[0].body !== body)) {
    throw new CrmError("conflict", "That message key was already used for another message.", 409, { field: "clientKey" });
  }
  const root = message.parentId ? await readMessage(db, message.parentId, actor.userId) : null;
  return { message, root: root ? toRoot(root) : null, duplicate: true };
}

export async function postMessage(actor: UserActor, input: PostInput, options: { viaWorkflowId?: string; charge?: () => Promise<void> } = {}): Promise<ChatPost> {
  const conversationId = checkId(input.conversationId, "conversation");
  const parentId = input.parentId ? checkId(input.parentId, "thread") : null;
  const body = cleanBody(input.body);
  const clientKey = cleanClientKey(input.clientKey);
  const mentions = memberMentions(body);
  const repeatCheck = options.charge ? body : undefined;
  try {
    if (options.charge) {
      const before = await withActor(actor, async (db) => {
        await readConversation(db, actor, conversationId);
        return existingPost(db, actor, clientKey, conversationId, parentId, repeatCheck);
      });
      if (before) return before;
      await options.charge();
    }
    return await withActor(actor, async (db) => {
      const conversation = await readConversation(db, actor, conversationId);
      const earlier = await existingPost(db, actor, clientKey, conversationId, parentId, repeatCheck);
      if (earlier) return earlier;
      const tagged = await tagFromDiscussion(db, actor, conversation, mentions);
      if (conversation.kind === "dm") {
        const reachable = conversation.dm_user_id ? await db.query("select 1 from crm.profiles where id = $1", [conversation.dm_user_id]) : null;
        if ((reachable?.rowCount ?? 0) === 0) throw new CrmError("forbidden", "You no longer share a workspace with this person, so they can't get new messages.", 403);
      }
      const via = options.viaWorkflowId ?? null;
      const inserted = await db.query<{ id: string }>(
        `insert into crm.chat_messages (conversation_id, parent_id, author_user_id, client_key, body, mentions${via ? ", via_workflow_id" : ""})
         values ($1, $2, $3, $4, $5, $6::uuid[]${via ? ", $7" : ""})
         on conflict on constraint chat_messages_author_client_key do nothing
         returning id`,
        [conversationId, parentId, actor.userId, clientKey, body, mentions, ...(via ? [via] : [])],
      );
      if (!inserted.rows[0]) {
        const raced = await existingPost(db, actor, clientKey, conversationId, parentId, repeatCheck);
        if (raced) return raced;
        throw new CrmError("conflict", "That message key was already used for another message. Send this one with a new key.", 409, { field: "clientKey" });
      }
      const message = (await readMessage(db, inserted.rows[0].id, actor.userId))!;
      const rootMessage = parentId ? await readMessage(db, parentId, actor.userId) : null;
      const root = rootMessage ? toRoot(rootMessage) : null;
      if (!parentId && !via) {
        await db.query(
          `update crm.chat_members set last_read_at = greatest(last_read_at, (select created_at from crm.chat_messages where id = $3))
           where conversation_id = $1 and user_id = $2`,
          [conversationId, actor.userId, message.id],
        );
      }
      const members = await memberIds(db, conversationId);
      const jobs = conversation.kind === "room" || conversation.kind === "dm" ? postAlerts(actor, conversation, members, message) : subjectAlerts(actor, conversation, message, tagged);
      afterPost(
        db,
        members.map((member) => member.user_id),
        { type: "message", conversationId, message, root, ...(subjectOf(conversation) ? { subject: subjectOf(conversation)! } : {}) },
        jobs,
      );
      return { message, root, duplicate: false };
    });
  } catch (error) {
    chatFailure(error);
  }
}

export type MyRoom = { id: string; name: string; workspaceId: string | null };

export async function findMyRooms(actor: UserActor, ref: { id?: string | null; name?: string | null }): Promise<MyRoom[]> {
  const id = ref.id && isUuid(ref.id) ? ref.id.toLowerCase() : null;
  const name = ref.name?.trim().replace(/^#+/, "").trim().toLowerCase() || null;
  if (!id && !name) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string; workspace_id: string | null }>(
      `select c.id, c.name, c.workspace_id from crm.chat_conversations c
       join crm.chat_members me on me.conversation_id = c.id and me.user_id = $1
       where c.kind = 'room' and c.archived_at is null
         and (case when $2::uuid is not null then c.id = $2::uuid else lower(c.name) = $3 end)
       order by c.created_at
       limit 20`,
      [actor.userId, id, name],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, workspaceId: row.workspace_id }));
  });
}

async function ownMessage(db: Db, actor: UserActor, id: string) {
  const message = await readMessage(db, id, actor.userId);
  if (!message) throw notFound("message");
  if (message.author.id !== actor.userId) throw new CrmError("forbidden", "You can only change your own messages.", 403);
  if (message.deletedAt) throw new CrmError("invalid_input", "That message was deleted.", 400);
  return message;
}

export async function editMessage(actor: UserActor, id: string, body: unknown): Promise<ChatMessage> {
  const messageId = checkId(id, "message");
  const text = cleanBody(body);
  const mentions = memberMentions(text);
  try {
    const followed = await query<{ user_id: string }>("select user_id from private.chat_message_followers($1, $2)", [actor.userId, messageId]);
    const followersBefore = new Set(followed.rows.map((row) => row.user_id));
    return await withActor(actor, async (db) => {
      const current = await ownMessage(db, actor, messageId);
      if (current.via) throw new CrmError("invalid_input", "Messages sent by a workflow can't be edited. Delete it instead.", 400);
      const conversation = await readConversation(db, actor, current.conversationId);
      const before = new Set(current.mentions);
      const tagged = await tagFromDiscussion(
        db,
        actor,
        conversation,
        mentions.filter((person) => !before.has(person)),
      );
      const updated = await db.query("update crm.chat_messages set body = $2, mentions = $3::uuid[] where id = $1 and author_user_id = $4", [messageId, text, mentions, actor.userId]);
      if ((updated.rowCount ?? 0) === 0) throw notFound("message");
      const message = (await readMessage(db, messageId, actor.userId))!;
      const members = await memberIds(db, current.conversationId);
      const memberSet = new Set(members.map((member) => member.user_id));
      const added =
        conversation.kind === "room"
          ? message.mentions.filter((person) => !before.has(person) && person !== actor.userId && memberSet.has(person) && !followersBefore.has(person))
          : [];
      afterPost(
        db,
        members.map((member) => member.user_id),
        { type: "edit", conversationId: current.conversationId, message },
        conversation.kind === "room" || conversation.kind === "dm"
          ? mentionAlert(actor, conversation, message, added)
          : subjectAlerts(actor, conversation, { ...message, parentId: null, mentions: message.mentions.filter((person) => !before.has(person)) }, tagged),
      );
      return message;
    });
  } catch (error) {
    chatFailure(error);
  }
}

async function deleteHookMessage(actor: UserActor, messageId: string): Promise<{ deleted: true }> {
  try {
    const result = await query<{ conversation_id: string }>("select private.chat_delete_hook_message($1, $2) as conversation_id", [actor.userId, messageId]);
    const conversationId = result.rows[0].conversation_id;
    await withActor(actor, async (db) => {
      const members = await memberIds(db, conversationId);
      broadcastAfterCommit(
        db,
        members.map((member) => member.user_id),
        { type: "delete", conversationId, messageId, parentId: null, root: null },
      );
    });
    return { deleted: true as const };
  } catch (error) {
    chatFailure(error);
  }
}

export async function deleteMessage(actor: UserActor, id: string): Promise<{ deleted: true }> {
  const messageId = checkId(id, "message");
  const target = await withActor(actor, (db) => db.query<{ from_hook: boolean }>("select hook is not null as from_hook from crm.chat_messages where id = $1", [messageId]));
  if (target.rows[0]?.from_hook) return deleteHookMessage(actor, messageId);
  try {
    return await withActor(actor, async (db) => {
      const current = await ownMessage(db, actor, messageId);
      const updated = await db.query("update crm.chat_messages set deleted_at = now() where id = $1 and author_user_id = $2 and deleted_at is null", [messageId, actor.userId]);
      if ((updated.rowCount ?? 0) === 0) throw notFound("message");
      const rootMessage = current.parentId ? await readMessage(db, current.parentId, actor.userId) : null;
      const members = await memberIds(db, current.conversationId);
      broadcastAfterCommit(
        db,
        members.map((member) => member.user_id),
        { type: "delete", conversationId: current.conversationId, messageId, parentId: current.parentId, root: rootMessage ? toRoot(rootMessage) : null },
      );
      return { deleted: true as const };
    });
  } catch (error) {
    chatFailure(error);
  }
}

export async function markConversationRead(actor: UserActor, id: string, upTo?: string | null): Promise<{ lastReadAt: string }> {
  const conversationId = checkId(id, "conversation");
  const messageId = upTo ? checkId(upTo, "message") : null;
  return withActor(actor, async (db) => {
    if (messageId) {
      const known = await db.query("select 1 from crm.chat_messages where id = $1 and conversation_id = $2", [messageId, conversationId]);
      if ((known.rowCount ?? 0) === 0) throw notFound("message");
    }
    const result = await db.query<{ last_read_at: Stamp }>(
      `update crm.chat_members set last_read_at = greatest(last_read_at, coalesce(
         (select m.created_at from crm.chat_messages m where m.id = $3 and m.conversation_id = $1),
         case when $3::uuid is null then clock_timestamp() end,
         last_read_at
       ))
       where conversation_id = $1 and user_id = $2
       returning last_read_at`,
      [conversationId, actor.userId, messageId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("conversation");
    const lastReadAt = iso(row.last_read_at);
    broadcastAfterCommit(db, [actor.userId], { type: "read", conversationId, lastReadAt });
    return { lastReadAt };
  });
}

export async function markThreadRead(actor: UserActor, rootId: string, upTo?: string | null): Promise<{ lastReadAt: string | null }> {
  const id = checkId(rootId, "thread");
  const messageId = upTo ? checkId(upTo, "message") : null;
  return withActor(actor, async (db) => {
    const root = await readRoot(db, id, actor.userId);
    if (messageId) {
      const known = await db.query("select 1 from crm.chat_messages where id = $1 and parent_id = $2", [messageId, id]);
      if ((known.rowCount ?? 0) === 0) throw notFound("message");
    }
    const result = await db.query<{ last_read_at: Stamp }>(
      `update crm.chat_thread_reads set last_read_at = greatest(last_read_at, coalesce(
         (select m.created_at from crm.chat_messages m where m.id = $3 and m.parent_id = $1),
         case when $3::uuid is null then clock_timestamp() end,
         last_read_at
       ))
       where message_id = $1 and user_id = $2
       returning last_read_at`,
      [id, actor.userId, messageId],
    );
    const row = result.rows[0];
    if (!row) return { lastReadAt: null };
    const lastReadAt = iso(row.last_read_at);
    broadcastAfterCommit(db, [actor.userId], { type: "thread-read", conversationId: root.conversationId, messageId: id, lastReadAt });
    return { lastReadAt };
  });
}

function subjectOf(conversation: ConversationRow): ChatSubject | null {
  if (conversation.kind === "task" && conversation.task_id) return { kind: "task", id: conversation.task_id };
  if (conversation.kind === "doc" && conversation.page_id) return { kind: "doc", id: conversation.page_id };
  if (conversation.kind === "mail_thread" && conversation.mail_share_id) return { kind: "mail_thread", id: conversation.mail_share_id };
  return null;
}

async function refuseOutsiders(db: Db, actor: UserActor, shareId: string, people: string[]) {
  const wanted = [...new Set(people.filter((person) => person !== actor.userId))];
  if (wanted.length === 0) return;
  const audience = await db.query<{ user_id: string; owner: boolean }>(
    `select s.owner_user_id as user_id, true as owner from crm.mail_shares s where s.id = $1
     union all
     select sm.user_id, false from crm.mail_share_members sm where sm.share_id = $1`,
    [shareId],
  );
  const inside = new Set(audience.rows.map((row) => row.user_id));
  const outside = wanted.filter((person) => !inside.has(person));
  if (outside.length === 0) return;
  const ownerId = audience.rows.find((row) => row.owner)?.user_id ?? null;
  const named = await db.query<{ id: string; name: string }>(
    "select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email, 'Someone') as name from crm.profiles p where p.id = any($1::uuid[])",
    [ownerId ? [...outside, ownerId] : outside],
  );
  const names = new Map(named.rows.map((row) => [row.id, row.name]));
  const outsiders = outside.map((id) => ({ id, name: names.get(id) ?? "Someone" }));
  const canAdd = ownerId === actor.userId;
  const who = outsiders.length === 1 ? outsiders[0].name : `${outsiders.length} people you tagged`;
  const verb = outsiders.length === 1 ? "isn't" : "aren't";
  const ownerName = ownerId ? (names.get(ownerId) ?? "The owner").split(/\s+/)[0] : "The owner";
  const message = canAdd ? `${who} ${verb} in this thread. Add them first.` : `${who} ${verb} in this thread. Only ${ownerName} can add people.`;
  throw new CrmError("conflict", message, 409, { field: "body", needsShare: { people: outsiders, canAdd } });
}

async function tagFromDiscussion(db: Db, actor: UserActor, conversation: ConversationRow, people: string[]) {
  if (conversation.kind === "mail_thread" && conversation.mail_share_id) {
    await refuseOutsiders(db, actor, conversation.mail_share_id, people);
    return [];
  }
  if (conversation.kind !== "task" || !conversation.task_id) return [];
  const wanted = [...new Set(people.filter((person) => person !== actor.userId))];
  if (wanted.length === 0) return [];
  const seeing = await db.query<{ user_id: string }>(
    `select wm.user_id from crm.tasks t
     join crm.workspace_members wm on wm.workspace_id = t.workspace_id
     where t.id = $1 and wm.user_id = any($2::uuid[])
       and (
         wm.user_id = t.owner_id
         or wm.user_id = t.created_by_user_id
         or wm.role in ('owner', 'admin')
         or exists (select 1 from crm.task_participants tp where tp.task_id = t.id and tp.user_id = wm.user_id)
       )`,
    [conversation.task_id, wanted],
  );
  const already = new Set(seeing.rows.map((row) => row.user_id));
  const fresh = wanted.filter((person) => !already.has(person));
  if (fresh.length === 0) return [];
  assertScope(actor.scopes, "tasks:write");
  try {
    return await addTaskParticipantsInDb(db, actor, conversation.task_id, fresh, { operation: "tag_task", source: "chat" }, { alert: false });
  } catch (error) {
    if (error instanceof CrmError && error.code === "invalid_input") {
      throw new CrmError("invalid_input", "Tag people in this task's workspace.", 400, { field: "body" });
    }
    throw error;
  }
}

function mailThreadAlerts(actor: UserActor, shareId: string, message: ChatMessage): AlertJob[] {
  const name = firstName(actor);
  const base = { source: "mail_share" as const, href: sharedThreadHref(shareId, { notes: true }), tag: `mail_share:${shareId}`, body: null };
  const mentioned = message.mentions.filter((person) => person !== actor.userId);
  const jobs: AlertJob[] = [];
  if (mentioned.length > 0) {
    jobs.push(async () => {
      const audience = await query<{ user_id: string }>("select user_id from private.mail_share_people($1, $2)", [actor.userId, shareId]);
      const inside = new Set(audience.rows.map((row) => row.user_id));
      const recipients = mentioned.filter((person) => inside.has(person));
      if (recipients.length === 0) return;
      await alertMembers(actor, recipients, { ...base, key: `mail_share:discussion:${message.id}`, title: `${name} mentioned you in a shared email` }, VERIFIED);
    });
  }
  const rootId = message.parentId;
  if (!rootId) return jobs;
  const skip = new Set([actor.userId, ...message.mentions]);
  jobs.push(async () => {
    const followers = await query<{ user_id: string; last_read_at: Stamp }>("select user_id, last_read_at from private.chat_subject_followers($1, $2)", [actor.userId, rootId]);
    const byKey = new Map<string, string[]>();
    for (const follower of followers.rows) {
      if (skip.has(follower.user_id)) continue;
      const key = `chat:thread:${rootId}:${millis(follower.last_read_at)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), follower.user_id]);
    }
    for (const [key, recipients] of byKey) {
      await alertMembers(actor, recipients, { ...base, key, title: `${name} replied in a thread on a shared email` }, VERIFIED);
    }
  });
  return jobs;
}

function subjectAlerts(actor: UserActor, conversation: ConversationRow, message: ChatMessage, tagged: string[]): AlertJob[] {
  if (conversation.kind === "mail_thread") return conversation.mail_share_id ? mailThreadAlerts(actor, conversation.mail_share_id, message) : [];
  const subject = subjectOf(conversation);
  const workspaceId = conversation.subject_workspace_id ?? null;
  if (!subject || subject.kind === "mail_thread" || !workspaceId) return [];
  const task = subject.kind === "task";
  const name = task ? actor.fullName?.trim() || actor.email || "A teammate" : firstName(actor);
  const base = { source: subject.kind, href: discussionHref(subject), tag: `${subject.kind}:${subject.id}`, body: task ? conversation.name : null, workspaceId };
  const fresh = new Set(tagged);
  const mentioned = message.mentions.filter((person) => person !== actor.userId && !fresh.has(person));
  const jobs: AlertJob[] = [];
  if (tagged.length > 0) {
    jobs.push(async () => {
      await alertMembers(actor, tagged, {
        ...base,
        href: taskPanelHref(subject.id, { tagged: true }),
        key: `task:discussion:${message.id}:tagged`,
        title: `${name} tagged you in a task`,
      });
    });
  }
  if (mentioned.length > 0) {
    jobs.push(async () => {
      await alertMembers(actor, mentioned, {
        ...base,
        key: `${subject.kind}:discussion:${message.id}`,
        title: task ? `${name} mentioned you in a task` : `${name} mentioned you in a doc`,
      });
    });
  }
  const rootId = message.parentId;
  if (!rootId) return jobs;
  const skip = new Set([actor.userId, ...message.mentions, ...tagged]);
  jobs.push(async () => {
    const followers = await query<{ user_id: string; last_read_at: Stamp }>("select user_id, last_read_at from private.chat_subject_followers($1, $2)", [actor.userId, rootId]);
    const byKey = new Map<string, string[]>();
    for (const follower of followers.rows) {
      if (skip.has(follower.user_id)) continue;
      const key = `chat:thread:${rootId}:${millis(follower.last_read_at)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), follower.user_id]);
    }
    for (const [key, recipients] of byKey) {
      await alertMembers(actor, recipients, { ...base, key, title: task ? `${name} replied in a thread on a task` : `${name} replied in a thread on a doc` }, VERIFIED);
    }
  });
  return jobs;
}

function checkSubject(input: unknown): ChatSubject {
  const subject = readSubject(input);
  if (!subject) throw notFound("discussion");
  return subject;
}

async function assertDiscussable(db: Db, subject: ChatSubject) {
  if (subject.kind === "mail_thread") {
    const share = await db.query("select 1 from crm.mail_shares where id = $1", [subject.id]);
    if ((share.rowCount ?? 0) === 0) throw notFound("conversation");
    return;
  }
  if (subject.kind === "task") {
    const task = await db.query("select 1 from crm.tasks where id = $1", [subject.id]);
    if ((task.rowCount ?? 0) === 0) throw notFound("task");
    return;
  }
  const page = await db.query<{ kind: string; effective_shared: boolean }>("select kind, effective_shared from crm.pages where id = $1", [subject.id]);
  const row = page.rows[0];
  if (!row) throw notFound("doc");
  if (row.kind !== "note") throw new CrmError("invalid_input", "Daily notes don't have a discussion.", 400);
  if (!row.effective_shared) throw new CrmError("forbidden", "Share this doc with the workspace to discuss it.", 403);
}

const SUBJECT_COLUMN: Record<ChatSubjectKind, "task_id" | "page_id" | "mail_share_id"> = { task: "task_id", doc: "page_id", mail_thread: "mail_share_id" };

async function findDiscussion(db: Db, subject: ChatSubject) {
  const column = SUBJECT_COLUMN[subject.kind];
  const found = await db.query<{ id: string }>(`select id from crm.chat_conversations where kind = $1 and ${column} = $2`, [subject.kind, subject.id]);
  return found.rows[0]?.id ?? null;
}

export async function openDiscussion(actor: UserActor, input: unknown): Promise<{ conversationId: string }> {
  const subject = checkSubject(input);
  const column = SUBJECT_COLUMN[subject.kind];
  try {
    return await withActor(actor, async (db) => {
      await assertDiscussable(db, subject);
      await db.query(
        `insert into crm.chat_conversations (kind, ${column}, created_by) values ($1, $2, $3)
         on conflict (${column}) where ${column} is not null do nothing`,
        [subject.kind, subject.id, actor.userId],
      );
      const conversationId = await findDiscussion(db, subject);
      if (!conversationId) throw notFound("discussion");
      return { conversationId };
    });
  } catch (error) {
    chatFailure(error);
  }
}

export async function getDiscussion(actor: UserActor, input: unknown, options: PageOptions = {}): Promise<ChatDiscussion> {
  const subject = checkSubject(input);
  const found = await withActor(actor, async (db) => {
    await assertDiscussable(db, subject);
    const conversationId = await findDiscussion(db, subject);
    if (!conversationId) return { conversationId: null, count: 0 };
    const counted = await db.query<{ count: number }>("select count(*)::integer as count from crm.chat_messages where conversation_id = $1 and deleted_at is null", [conversationId]);
    return { conversationId, count: counted.rows[0]?.count ?? 0 };
  });
  const page = found.conversationId ? await listMessages(actor, found.conversationId, options) : null;
  return { subject, conversationId: found.conversationId, count: found.count, page };
}

export async function discussionCounts(actor: UserActor, kind: ChatSubjectKind, ids: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(ids.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return {};
  const column = SUBJECT_COLUMN[kind];
  return withActor(actor, async (db) => {
    const result = await db.query<{ subject_id: string; count: number }>(
      `select c.${column} as subject_id, count(m.id)::integer as count
       from crm.chat_conversations c
       join crm.chat_messages m on m.conversation_id = c.id and m.deleted_at is null
       where c.kind = $1 and c.${column} = any($2::uuid[])
       group by c.${column}`,
      [kind, wanted],
    );
    return Object.fromEntries(result.rows.map((row) => [row.subject_id, row.count]));
  });
}
