import { alertMembers } from "@/lib/alerts";
import { chatBackground, listChatPeople } from "@/lib/crm/chat";
import { listMembers } from "@/lib/crm/companies";
import { CrmError, isPgError, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import type { PushSender } from "@/lib/push";
import { publishShareEvents, shareEvents } from "@/lib/mail/share-live";
import { SHARE_PEOPLE_MAX, sharedThreadHref, type MailShareCandidate, type MailSharePerson, type SharedDraft, type SharedDraftFile, type SharedDraftState } from "@/lib/mail/share-types";
import { readPeople } from "@/lib/mail/shares";
import type { MailAddress } from "@/lib/mail/types";

export const SHARED_TEXT_LOCKED = "This draft is shared, so its subject and message can't be changed here. Send it as it is, or edit it in Mail.";
export const DRAFT_NO_ACCESS = "You no longer have access to this draft.";

const BODY_MAX = 20_000;
const SUBJECT_MAX = 300;
const THREAD_TRIES = 3;

type Stamp = Date | string;

export type ClosedShare = { id: string; members: string[] };

function firstName(name: string | null | undefined, fallback: string) {
  return name?.trim().split(/\s+/)[0] || fallback;
}

export function draftFailure(error: unknown): never {
  if (isPgError(error) && error.code === "55006") throw new CrmError("conflict", error.message.trim(), 409, { locked: true });
  if (isPgError(error) && error.code === "P0004") throw new CrmError("conflict", error.message.trim(), 409);
  if (isPgError(error) && error.code === "40001") throw new CrmError("conflict", error.message.trim(), 409, { changed: true });
  throw pgFailure(error) ?? error;
}

function notFound() {
  return new CrmError("not_found", DRAFT_NO_ACCESS, 404);
}

function checkId(id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw notFound();
  return id.toLowerCase();
}

function cleanPeople(ids: unknown): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !isUuid(id))) {
    throw new CrmError("invalid_input", "Choose people from the list.", 400, { field: "people" });
  }
  const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  if (unique.length > SHARE_PEOPLE_MAX) throw new CrmError("invalid_input", `Add up to ${SHARE_PEOPLE_MAX} people at a time.`, 400, { field: "people" });
  return unique;
}

export async function draftShareCandidates(actor: UserActor): Promise<MailShareCandidate[]> {
  const [everyone, members] = await Promise.all([listChatPeople(actor), listMembers(actor).catch(() => [])]);
  const roles = new Map(members.map((member) => [member.id, member.role]));
  return everyone.filter((person) => person.id !== actor.userId).map((person) => ({ ...person, role: roles.get(person.id) ?? null }));
}

export async function draftSharePeople(actor: UserActor, shareId: unknown) {
  return readPeople(actor.userId, checkId(shareId));
}

export function announceShare(shareId: string, userIds: string[]) {
  return publishShareEvents(shareEvents(userIds, { type: "draft", shareId }));
}

export async function draftShareMembers(ownerId: string, draftId: string) {
  if (!isUuid(draftId)) return null;
  const result = await query<{ share_id: string; members: string[] }>("select share_id, members::text[] as members from private.mail_share_draft_members($1, $2)", [ownerId, draftId]);
  const row = result.rows[0];
  return row ? { shareId: row.share_id, members: row.members ?? [] } : null;
}

export function announceDraftChange(ownerId: string, draftId: string) {
  chatBackground(async () => {
    const share = await draftShareMembers(ownerId, draftId).catch(() => null);
    if (share) await announceShare(share.shareId, [ownerId, ...share.members]);
  });
}

export async function sharedDraftClosed(actor: UserActor, closed: ClosedShare, threadKey: string | null, internetId: string | null) {
  if (!threadKey && internetId) {
    await query("select private.mail_share_follow_sent_now($1, $2)", [actor.userId, closed.id]).catch((error) =>
      console.error("Couldn't find the shared draft's sent copy", error instanceof Error ? error.name : "unknown"),
    );
  }
  if (threadKey) {
    for (let attempt = 1; attempt <= THREAD_TRIES; attempt += 1) {
      try {
        await query("select private.mail_share_draft_thread($1, $2, $3)", [actor.userId, closed.id, threadKey]);
        break;
      } catch (error) {
        if (attempt === THREAD_TRIES) console.error("Couldn't move the shared draft to its thread", error instanceof Error ? error.name : "unknown");
      }
    }
  }
  chatBackground(() => announceShare(closed.id, [actor.userId, ...closed.members]));
}

export async function shareDraft(actor: UserActor, draftId: unknown, userIds: unknown, options: { send?: PushSender } = {}): Promise<{ shareId: string; people: MailSharePerson[]; added: string[] }> {
  if (typeof draftId !== "string" || !isUuid(draftId)) throw new CrmError("not_found", "That draft has gone. Save it again.", 404);
  const people = cleanPeople(userIds);
  const add = () =>
    query<{ share_id: string; added: string[]; members: string[]; added_at: Stamp }>(
      "select share_id, added::text[] as added, members::text[] as members, added_at from private.mail_share_draft_add($1, $2, $3::uuid[])",
      [actor.userId, draftId.toLowerCase(), people],
    );
  let row: { share_id: string; added: string[]; members: string[]; added_at: Stamp };
  try {
    row = (await add().catch((error: unknown) => (isPgError(error) && error.code === "P0004" ? add() : Promise.reject(error)))).rows[0];
  } catch (error) {
    draftFailure(error);
  }
  const shareId = row.share_id;
  const added = [...new Set(row.added ?? [])];
  const stamp = new Date(row.added_at).getTime();
  chatBackground(async () => {
    await publishShareEvents([
      ...shareEvents(added, { type: "shared", shareId }),
      ...shareEvents([actor.userId, ...(row.members ?? [])], { type: "people", shareId }),
      ...shareEvents([actor.userId, ...(row.members ?? [])], { type: "draft", shareId }),
    ]);
    if (added.length === 0) return;
    await alertMembers(
      actor,
      added,
      {
        source: "mail_share",
        key: `mail_share:${shareId}:draft:${stamp}`,
        title: `${firstName(actor.fullName, actor.email || "A teammate")} added you to a draft`,
        href: sharedThreadHref(shareId),
        tag: `mail_share:${shareId}`,
      },
      { send: options.send },
    );
  });
  return { shareId, people: await readPeople(actor.userId, shareId), added };
}

type DraftRow = {
  owner_user_id: string;
  state: SharedDraftState;
  mode: SharedDraft["mode"];
  from_email: string | null;
  to_recipients: MailAddress[];
  cc_recipients: MailAddress[];
  subject: string | null;
  body: string | null;
  signature: string | null;
  attachments: SharedDraftFile[];
  send_at: Stamp | null;
  version: number;
  updated_at: Stamp | null;
};

export async function readSharedDraft(userId: string, shareId: string) {
  const result = await query<DraftRow>("select * from private.shared_draft($1, $2)", [userId, shareId]);
  return result.rows[0] ?? null;
}

export async function getSharedDraft(actor: UserActor, shareId: unknown): Promise<SharedDraft> {
  const id = checkId(shareId);
  const [row, people] = await Promise.all([readSharedDraft(actor.userId, id), readPeople(actor.userId, id)]);
  const owner = people.find((person) => person.owner);
  if (!row || !owner) throw notFound();
  return {
    shareId: id,
    owner: { id: owner.id, name: owner.name },
    viewerIsOwner: owner.id === actor.userId,
    state: row.state,
    mode: row.mode,
    from: row.from_email,
    to: row.to_recipients ?? [],
    cc: row.cc_recipients ?? [],
    subject: row.subject ?? "",
    body: row.body ?? "",
    signature: row.signature,
    attachments: row.attachments ?? [],
    sendAt: row.send_at ? new Date(row.send_at).toISOString() : null,
    version: row.version,
    savedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function readSharedText(value: unknown) {
  const input = (value ?? {}) as Record<string, unknown>;
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n") : null;
  if (body !== null && body.length > BODY_MAX) throw new CrmError("invalid_input", "Keep the message under 20,000 characters.", 400, { field: "body" });
  const subject = typeof input.subject === "string" ? input.subject.replace(/[\r\n\t]+/g, " ") : null;
  if (subject !== null && subject.length > SUBJECT_MAX) throw new CrmError("invalid_input", "Keep the subject under 300 characters.", 400, { field: "subject" });
  const base = typeof input.base === "number" && Number.isInteger(input.base) && input.base >= 0 ? input.base : null;
  return { subject, body, base };
}

export async function saveSharedDraft(
  actor: UserActor,
  shareId: unknown,
  text: { subject: string | null; body: string | null; base?: number | null },
): Promise<{ version: number; savedAt: string }> {
  const id = checkId(shareId);
  let row: { version: number; owner_user_id: string; members: string[] };
  try {
    const result = await query<{ version: number; owner_user_id: string; members: string[] }>(
      "select version, owner_user_id, members::text[] as members from private.merge_shared_draft($1, $2, $3, $4, $5)",
      [actor.userId, id, text.subject, text.body, text.base ?? null],
    );
    row = result.rows[0];
  } catch (error) {
    draftFailure(error);
  }
  chatBackground(() => announceShare(id, [row.owner_user_id, ...(row.members ?? [])]));
  return { version: row.version, savedAt: new Date().toISOString() };
}

export async function holdSharedDraft(actor: UserActor, draftId: unknown, hold: boolean, version: number | null = null): Promise<{ shared: boolean }> {
  if (typeof draftId !== "string" || !isUuid(draftId)) return { shared: false };
  let row: { share_id: string; members: string[] } | undefined;
  try {
    const result = await query<{ share_id: string; members: string[] }>(
      "select share_id, members::text[] as members from private.mail_share_draft_hold($1, $2, $3, $4)",
      [actor.userId, draftId.toLowerCase(), hold, version],
    );
    row = result.rows[0];
  } catch (error) {
    draftFailure(error);
  }
  if (!row) return { shared: false };
  const share = row;
  chatBackground(() => announceShare(share.share_id, [actor.userId, ...(share.members ?? [])]));
  return { shared: true };
}
