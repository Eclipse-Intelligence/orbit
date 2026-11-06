import { ImapFlow } from "imapflow";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { readItipReply, type ItipReply } from "@/lib/ical/itip";
import { identityForSend, type SendIdentity } from "@/lib/mail/identities";

const LOOKBACK_MS = 14 * 86_400_000;
const MESSAGES_READ = 300;
const PART_MAX_BYTES = 256_000;

export type ReplyReader = (identity: SendIdentity & { password: string }, since: Date, deadline: number) => Promise<string[]>;

type StructureNode = { part?: string; type: string; parameters?: Record<string, string>; childNodes?: StructureNode[] };

function calendarParts(node: StructureNode | undefined, found: string[] = []) {
  if (!node) return found;
  if (node.type?.toLowerCase() === "text/calendar" || node.type?.toLowerCase() === "application/ics") found.push(node.part ?? "1");
  for (const child of node.childNodes ?? []) calendarParts(child, found);
  return found;
}

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > PART_MAX_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const defaultReplyReader: ReplyReader = async (identity, since, deadline) => {
  if (!identity.imapHost) return [];
  const client = new ImapFlow({
    host: identity.imapHost,
    port: identity.imapPort ?? 993,
    secure: (identity.imapPort ?? 993) === 993,
    auth: { user: identity.username, pass: identity.password },
    logger: false,
  });
  await client.connect();
  const texts: string[] = [];
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const recent = uids.slice(-MESSAGES_READ);
      const messages = await client.fetchAll(recent.join(","), { uid: true, bodyStructure: true }, { uid: true });
      const wanted = messages.flatMap((message) =>
        calendarParts(message.bodyStructure as StructureNode | undefined).map((part) => ({ uid: message.uid, part })),
      );
      for (const item of wanted) {
        if (Date.now() > deadline) break;
        const download = await client.download(String(item.uid), item.part, { uid: true });
        if (!("content" in download) || !download.content) continue;
        const text = await readStream(download.content);
        if (/METHOD:REPLY/i.test(text)) texts.push(text);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return texts;
};

function withResponses(attendees: unknown, reply: ItipReply) {
  if (!Array.isArray(attendees)) return null;
  const answers = new Map(reply.responses.map((item) => [item.email, item.response]));
  let changed = false;
  const next = attendees.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const person = entry as Record<string, unknown>;
    const email = typeof person.email === "string" ? person.email.toLowerCase() : "";
    const response = answers.get(email);
    if (!response || person.response === response) return entry;
    changed = true;
    return { ...person, response };
  });
  return changed ? next : null;
}

export async function applyInviteReplies(actor: UserActor, identityId: string, texts: string[]) {
  const replies = texts.map(readItipReply).filter((reply): reply is ItipReply => reply !== null);
  if (replies.length === 0) return 0;
  return withActor(actor, async (db) => {
    let updated = 0;
    for (const reply of replies) {
      const found = await db.query<{ id: string; attendees: unknown; invite_sequence: number }>(
        `select id, attendees, invite_sequence from crm.calendar_events
         where user_id = $1 and invite_identity_id = $2 and invite_uid = $3`,
        [actor.userId, identityId, reply.uid],
      );
      for (const row of found.rows) {
        if (reply.sequence < row.invite_sequence) continue;
        const attendees = withResponses(row.attendees, reply);
        if (!attendees) continue;
        await db.query("update crm.calendar_events set attendees = $2::jsonb where id = $1", [row.id, JSON.stringify(attendees)]);
        updated += 1;
      }
    }
    return updated;
  });
}

export async function readInviteReplies(
  actor: UserActor,
  options: { reader?: ReplyReader; deadline?: number; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const deadline = options.deadline ?? Date.now() + 30_000;
  const open = await withActor(actor, async (db) => {
    const result = await db.query<{ identity_id: string; first_sent: Date }>(
      `select invite_identity_id as identity_id, min(created_at) as first_sent
       from crm.calendar_events
       where user_id = $1 and invite_identity_id is not null and invite_uid is not null
         and not is_cancelled and ends_at > $2
       group by invite_identity_id`,
      [actor.userId, new Date(now - 86_400_000).toISOString()],
    );
    return result.rows;
  });
  let updated = 0;
  for (const row of open) {
    if (Date.now() > deadline - 5_000) break;
    try {
      const identity = await identityForSend(actor, row.identity_id);
      const since = new Date(Math.max(new Date(row.first_sent).getTime() - 86_400_000, now - LOOKBACK_MS));
      const texts = await (options.reader ?? defaultReplyReader)(identity, since, deadline);
      updated += await applyInviteReplies(actor, identity.id, texts);
    } catch (error) {
      console.error("Reading invite replies failed", error instanceof Error ? error.message : error);
    }
  }
  return updated;
}
