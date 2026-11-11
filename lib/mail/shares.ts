import { alertMembers } from "@/lib/alerts";
import { chatBackground, listChatPeople } from "@/lib/crm/chat";
import { listMembers } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, notFound, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import type { PushSender } from "@/lib/push";
import { shownAttachments } from "@/lib/mail/attachments";
import { graphReconnect } from "@/lib/mail/accounts";
import { cleanEmailHtml, richEmail } from "@/lib/mail/html";
import { fetchMicrosoftAttachment, GraphMailError, listMicrosoftAttachments } from "@/lib/mail/microsoft";
import { publishShareEvents, shareEvents } from "@/lib/mail/share-live";
import {
  SHARE_PEOPLE_MAX,
  sharedThreadHref,
  type MailShareControl,
  type MailSharePeople,
  type MailSharePerson,
  type SharedMessage,
  type SharedThread,
  type SharedThreadSummary,
} from "@/lib/mail/share-types";
import { mailSourceToken } from "@/lib/mail/sync";
import { parseThreadKey, threadKey } from "@/lib/mail/threads";
import type { MailAddress } from "@/lib/mail/types";

type Stamp = Date | string;

type PersonRow = { user_id: string; name: string; email: string | null; owner: boolean; added_at: Stamp };

export type LostShare = { shareId: string; userId: string; memberIds: string[] };

function iso(value: Stamp | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function firstWord(name: string | null | undefined, fallback: string) {
  return name?.trim().split(/\s+/)[0] || fallback;
}

function senderName(actor: UserActor) {
  return firstWord(actor.fullName, actor.email || "A teammate");
}

function shareFailure(error: unknown): never {
  throw pgFailure(error) ?? error;
}

function conversationNotFound() {
  return new CrmError("not_found", "Conversation not found.", 404);
}

function checkShareId(id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw conversationNotFound();
  return id.toLowerCase();
}

function cleanPeople(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new CrmError("invalid_input", "Pick people from the list.", 400, { field: "people" });
  const clean = ids.map((id) => (typeof id === "string" && isUuid(id) ? id.toLowerCase() : null));
  if (clean.some((id) => id === null)) throw new CrmError("invalid_input", "Pick people from the list.", 400, { field: "people" });
  const unique = [...new Set(clean as string[])];
  if (unique.length > SHARE_PEOPLE_MAX) throw new CrmError("invalid_input", `Add up to ${SHARE_PEOPLE_MAX} people at a time.`, 400, { field: "people" });
  return unique;
}

function toPerson(row: PersonRow): MailSharePerson {
  return { id: row.user_id, name: row.name, email: row.email, owner: row.owner, addedAt: iso(row.added_at)! };
}

function address(name: string | null, email: string | null): MailAddress | null {
  return email ? { name, address: email } : null;
}

async function readPeople(userId: string, shareId: string) {
  const result = await query<PersonRow>("select user_id, name, email, owner, added_at from private.mail_share_people($1, $2)", [userId, shareId]);
  const owner = result.rows.filter((row) => row.owner);
  const members = result.rows.filter((row) => !row.owner).sort((a, b) => new Date(a.added_at).getTime() - new Date(b.added_at).getTime() || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  return [...owner, ...members].map(toPerson);
}

async function ownThread(actor: UserActor, key: string) {
  const { sourceId, key: tk } = parseThreadKey(key);
  const found = await withActor(actor, (db) =>
    db.query(
      `select 1 from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and m.source_id = $2 and m.thread_key = $3 and not m.is_draft and f.role not in ('drafts', 'trash', 'junk', 'outbox')
       limit 1`,
      [actor.userId, sourceId, tk],
    ),
  );
  if ((found.rowCount ?? 0) === 0) throw conversationNotFound();
  return { sourceId, tk };
}

async function sharePeople(actor: UserActor, sourceId: string, tk: string): Promise<MailSharePeople> {
  const found = await query<{ id: string | null }>("select private.mail_share_for_thread($1, $2, $3) as id", [actor.userId, sourceId, tk]);
  const shareId = found.rows[0]?.id ?? null;
  return { shareId, people: shareId ? await readPeople(actor.userId, shareId) : [] };
}

export async function getThreadSharePeople(actor: UserActor, key: string): Promise<MailSharePeople> {
  const { sourceId, key: tk } = parseThreadKey(key);
  return sharePeople(actor, sourceId, tk);
}

export async function getThreadShare(actor: UserActor, key: string): Promise<MailShareControl> {
  const { sourceId, tk } = await ownThread(actor, key);
  const [{ shareId, people }, everyone, members] = await Promise.all([sharePeople(actor, sourceId, tk), listChatPeople(actor), listMembers(actor).catch(() => [])]);
  const inside = new Set([actor.userId, ...people.map((person) => person.id)]);
  const roles = new Map(members.map((member) => [member.id, member.role]));
  const candidates = everyone.filter((person) => !inside.has(person.id)).map((person) => ({ ...person, role: roles.get(person.id) ?? null }));
  return { shareId, people, candidates };
}

export async function ownSharedThreadKey(actor: UserActor, shareId: string): Promise<string | null> {
  if (!isUuid(shareId)) return null;
  const thread = await query<{ source_id: string; thread_key: string }>("select source_id, thread_key from private.mail_share_thread($1, $2)", [actor.userId, shareId.toLowerCase()]);
  return thread.rows[0] ? threadKey(thread.rows[0].source_id, thread.rows[0].thread_key) : null;
}

export async function shareThread(actor: UserActor, key: string, userIds: unknown, options: { send?: PushSender } = {}): Promise<{ share: MailShareControl; added: string[] }> {
  const people = cleanPeople(userIds);
  const { sourceId, key: tk } = parseThreadKey(key);
  let row: { share_id: string; added: string[]; added_at: Stamp; others: string[] };
  try {
    const result = await query<{ share_id: string; added: string[]; added_at: Stamp; others: string[] }>(
      "select share_id, added::text[] as added, added_at, others::text[] as others from private.mail_share_add($1, $2, $3, $4::uuid[])",
      [actor.userId, sourceId, tk, people],
    );
    row = result.rows[0];
  } catch (error) {
    shareFailure(error);
  }
  const shareId = row.share_id;
  const added = row.added ?? [];
  if (added.length > 0) {
    const stamp = new Date(row.added_at).getTime();
    chatBackground(async () => {
      await publishShareEvents([
        ...shareEvents(added, { type: "shared", shareId }),
        ...shareEvents([actor.userId, ...(row.others ?? [])], { type: "people", shareId }),
      ]);
      await alertMembers(actor, added, {
        source: "mail_share",
        key: `mail_share:${shareId}:added:${stamp}`,
        title: `${senderName(actor)} shared an email with you`,
        href: sharedThreadHref(shareId),
        tag: `mail_share:${shareId}`,
      }, { send: options.send });
    });
  }
  return { share: await getThreadShare(actor, threadKey(sourceId, tk)), added };
}

export async function removeFromShare(actor: UserActor, shareId: string, userId: string): Promise<{ removed: boolean }> {
  const id = checkShareId(shareId);
  if (typeof userId !== "string" || !isUuid(userId)) throw notFound("person");
  const member = userId.toLowerCase();
  let row: { removed: boolean; others: string[] };
  try {
    const result = await query<{ removed: boolean; others: string[] }>("select removed, others::text[] as others from private.mail_share_remove($1, $2, $3)", [actor.userId, id, member]);
    row = result.rows[0];
  } catch (error) {
    shareFailure(error);
  }
  if (row.removed) {
    chatBackground(() =>
      publishShareEvents([...shareEvents([member], { type: "removed", shareId: id }), ...shareEvents([actor.userId, ...(row.others ?? [])], { type: "people", shareId: id })]),
    );
  }
  return { removed: row.removed };
}

export async function listSharedThreads(actor: UserActor): Promise<SharedThreadSummary[]> {
  const result = await query<{
    share_id: string;
    owner_user_id: string;
    owner_name: string;
    shared_at: Stamp;
    subject: string | null;
    latest_at: Stamp | null;
    snippet: string | null;
    counterpart_name: string | null;
    counterpart_email: string | null;
    message_count: number;
    has_attachments: boolean;
  }>("select * from private.shared_threads($1)", [actor.userId]);
  return result.rows.map((row) => ({
    shareId: row.share_id,
    owner: { id: row.owner_user_id, name: row.owner_name },
    sharedAt: iso(row.shared_at)!,
    subject: row.subject,
    snippet: row.snippet,
    latestAt: iso(row.latest_at),
    counterpart: address(row.counterpart_name, row.counterpart_email),
    count: row.message_count,
    hasAttachments: row.has_attachments,
  }));
}

export async function getSharedThread(actor: UserActor, shareId: string): Promise<SharedThread> {
  const id = checkShareId(shareId);
  const people = await readPeople(actor.userId, id);
  const owner = people.find((person) => person.owner);
  if (!owner) throw conversationNotFound();
  const result = await query<{
    id: string;
    subject: string | null;
    from_email: string | null;
    from_name: string | null;
    to_recipients: MailAddress[] | null;
    cc_recipients: MailAddress[] | null;
    at: Stamp | null;
    has_attachments: boolean;
    snippet: string | null;
    body_html: string | null;
    body_text: string | null;
    body_truncated: boolean;
  }>("select * from private.shared_thread($1, $2)", [actor.userId, id]);
  const viewerIsOwner = owner.id === actor.userId;
  let ownKey: string | null = null;
  if (viewerIsOwner) {
    const thread = await query<{ source_id: string; thread_key: string }>("select source_id, thread_key from private.mail_share_thread($1, $2)", [actor.userId, id]);
    ownKey = thread.rows[0] ? threadKey(thread.rows[0].source_id, thread.rows[0].thread_key) : null;
  }
  const messages: SharedMessage[] = result.rows.map((row) => {
    const html = row.body_html ? cleanEmailHtml(row.body_html) : null;
    return {
      id: row.id,
      from: address(row.from_name, row.from_email),
      to: row.to_recipients ?? [],
      cc: row.cc_recipients ?? [],
      at: iso(row.at),
      hasAttachments: row.has_attachments,
      snippet: row.snippet,
      html,
      rich: html ? richEmail(html) : false,
      text: html ? null : row.body_text,
      truncated: row.body_truncated,
    };
  });
  return {
    shareId: id,
    owner: { id: owner.id, name: owner.name },
    viewerIsOwner,
    threadKey: ownKey,
    subject: result.rows.at(-1)?.subject ?? null,
    people,
    messages,
  };
}

async function ownerActor(ownerId: string) {
  const result = await query<{ workspace_id: string; workspace_name: string; role: WorkspaceRole; email: string | null; full_name: string | null }>(
    "select workspace_id, workspace_name, role, email, full_name from private.memberships_for($1)",
    [ownerId],
  );
  const home = result.rows[0];
  return home ? memberActor({ ...home, user_id: ownerId }) : null;
}

async function sharedMessage(actor: UserActor, shareId: string, messageId: string) {
  const id = checkShareId(shareId);
  if (typeof messageId !== "string" || !isUuid(messageId)) throw new CrmError("not_found", "Email not found.", 404);
  const result = await query<{ owner_user_id: string; source_id: string; provider_message_id: string }>(
    "select owner_user_id, source_id, provider_message_id from private.shared_message_owner($1, $2, $3)",
    [actor.userId, id, messageId.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Email not found.", 404);
  const owner = await ownerActor(row.owner_user_id);
  if (!owner) throw new CrmError("not_found", "Email not found.", 404);
  return { owner, sourceId: row.source_id, providerMessageId: row.provider_message_id };
}

function ownerProblem(owner: UserActor, error: unknown): CrmError {
  if (error instanceof GraphMailError && error.status === 404) return new CrmError("not_found", "That attachment is no longer in Outlook.", 404);
  const reconnect = graphReconnect(error, null);
  if (reconnect || (error instanceof CrmError && error.code === "not_found")) {
    return new CrmError("owner_reconnect", `Couldn't open the attachment. ${firstWord(owner.fullName, "The owner")} needs to reconnect their mailbox.`, 502);
  }
  if (error instanceof CrmError && error.status < 500) return error;
  console.error("Shared attachment failed", error instanceof GraphMailError ? `Graph ${error.status}` : error instanceof Error ? error.name : "unknown");
  return new CrmError("upstream_error", "Couldn't open the attachment. Try again.", 502);
}

async function asOwner<T>(owner: UserActor, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    throw ownerProblem(owner, error);
  }
}

export async function listSharedAttachments(actor: UserActor, shareId: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  const { owner, sourceId, providerMessageId } = await sharedMessage(actor, shareId, messageId);
  return asOwner(owner, async () => {
    const token = await mailSourceToken(owner, sourceId, fetchImpl);
    return shownAttachments(await listMicrosoftAttachments(token, providerMessageId, fetchImpl));
  });
}

export async function openSharedAttachment(actor: UserActor, shareId: string, messageId: string, attachmentId: string, fetchImpl: typeof fetch = fetch) {
  if (!attachmentId || attachmentId.length > 1000) throw new CrmError("not_found", "Attachment not found.", 404);
  const { owner, sourceId, providerMessageId } = await sharedMessage(actor, shareId, messageId);
  return asOwner(owner, async () => {
    const token = await mailSourceToken(owner, sourceId, fetchImpl);
    const items = await listMicrosoftAttachments(token, providerMessageId, fetchImpl);
    const item = items.find((entry) => entry.id === attachmentId);
    if (!item) throw new CrmError("attachment_missing", "Attachment not found.", 404);
    const response = await fetchMicrosoftAttachment(token, providerMessageId, attachmentId, fetchImpl);
    return { item, body: response.body! };
  });
}

export async function sharesLostOnLeaving(workspaceId: string, userId: string): Promise<LostShare[]> {
  const result = await query<{ share_id: string; user_id: string; member_ids: string[] }>(
    "select share_id, user_id, member_ids::text[] as member_ids from private.mail_shares_leaving($1, $2)",
    [workspaceId, userId],
  );
  return result.rows.map((row) => ({ shareId: row.share_id, userId: row.user_id, memberIds: row.member_ids ?? [] }));
}

export async function announceShareRemoval(lost: LostShare[]) {
  const removedFrom = new Map<string, Set<string>>();
  for (const item of lost) removedFrom.set(item.shareId, new Set([...(removedFrom.get(item.shareId) ?? []), item.userId]));
  const messages = lost.flatMap((item) => shareEvents([item.userId], { type: "removed", shareId: item.shareId }));
  for (const [shareId, gone] of removedFrom) {
    const stay = new Set(lost.filter((item) => item.shareId === shareId).flatMap((item) => item.memberIds).filter((id) => !gone.has(id)));
    messages.push(...shareEvents([...stay], { type: "people", shareId }));
  }
  await publishShareEvents(messages);
}
