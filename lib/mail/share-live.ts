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
  await publishLiveBatch(messages).catch((error) => console.error("Shared mail broadcast failed", error));
}

export function syncTouchesShares(folderRole: string, inserted: string[]) {
  return inserted.length > 0 && !QUIET_ROLES.has(folderRole);
}

export async function announceSharedMessages(ownerId: string, messageIds: string[]) {
  if (messageIds.length === 0) return;
  const touched = await query<{ share_id: string; member_ids: string[] }>("select share_id, member_ids::text[] as member_ids from private.mail_shares_touched($1, $2::uuid[])", [
    ownerId,
    messageIds,
  ]);
  await publishShareEvents(touched.rows.flatMap((row) => shareEvents(row.member_ids ?? [], { type: "message", shareId: row.share_id })));
}
