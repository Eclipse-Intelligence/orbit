import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { publishLiveBatch, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import type { MailShareLiveEvent } from "@/lib/mail/share-types";

const QUIET_ROLES = new Set(["drafts", "trash", "junk", "outbox"]);

export function shareEvents(userIds: string[], event: MailShareLiveEvent): LiveMessage[] {
  return [...new Set(userIds)].map((userId) => ({ topic: personTopic(userId), event: "mail_share", payload: event }));
}

export async function publishShareEvents(messages: LiveMessage[]) {
  if (messages.length === 0) return;
  await publishLiveBatch(messages).catch((error) => console.error("Shared mail broadcast failed", error instanceof Error ? error.name : "unknown"));
}

export function shareVisibleRole(folderRole: string) {
  return !QUIET_ROLES.has(folderRole);
}

export async function ownsShares(actor: UserActor) {
  const result = await withActor(actor, (db) => db.query("select 1 from crm.mail_shares where owner_user_id = $1 limit 1", [actor.userId])).catch(() => null);
  return (result?.rowCount ?? 0) > 0;
}

export async function announceSharedThreads(ownerId: string, sourceId: string, threadKeys: string[]) {
  if (threadKeys.length === 0) return;
  const followed = await query<{ share_id: string; members: string[] }>("select share_id, members::text[] as members from private.mail_shares_follow_sent($1, $2, $3::text[])", [
    ownerId,
    sourceId,
    [...new Set(threadKeys)],
  ]);
  if (followed.rows.length > 0) {
    await publishShareEvents(followed.rows.flatMap((row) => shareEvents([ownerId, ...(row.members ?? [])], { type: "draft", shareId: row.share_id })));
  }
  const touched = await query<{ share_id: string; member_ids: string[] }>(
    "select share_id, member_ids::text[] as member_ids from private.mail_shares_touched($1, $2, $3::text[])",
    [ownerId, sourceId, [...new Set(threadKeys)]],
  );
  await publishShareEvents(touched.rows.flatMap((row) => shareEvents(row.member_ids ?? [], { type: "message", shareId: row.share_id })));
}
