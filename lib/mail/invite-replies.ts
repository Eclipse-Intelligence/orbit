import { ImapFlow } from "imapflow";
import { withActor } from "@/lib/crm/context";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import { readItipReply, type ItipReply } from "@/lib/ical/itip";
import { identityForSend, imapTimeouts, type SendIdentity } from "@/lib/mail/identities";

const LOOKBACK_MS = 14 * 86_400_000;
const MESSAGES_READ = 300;
const PART_MAX_BYTES = 256_000;

export type ReplyMessage = { text: string; senders: string[] };

export type ReplyCursor = { uidValidity: string; lastUid: number };

export type ReplyRead = { messages: ReplyMessage[]; cursor: ReplyCursor | null };

export type ReplyReader = (
  identity: SendIdentity & { password: string },
  options: { since: Date; cursor: ReplyCursor | null; deadline: number },
) => Promise<ReplyRead>;

type StructureNode = { part?: string; type: string; parameters?: Record<string, string>; childNodes?: StructureNode[] };

type Address = { address?: string };

function calendarParts(node: StructureNode | undefined, found: string[] = []) {
  if (!node) return found;
  if (node.type?.toLowerCase() === "text/calendar" || node.type?.toLowerCase() === "application/ics") found.push(node.part ?? "1");
  for (const child of node.childNodes ?? []) calendarParts(child, found);
  return found;
}

function addresses(...lists: (Address[] | undefined)[]) {
  const found = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const email = item.address ? canonicalEmail(item.address) : null;
      if (email) found.add(email);
    }
  }
  return [...found];
}

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString("utf8");
}

export const defaultReplyReader: ReplyReader = async (identity, { since, cursor, deadline }) => {
  if (!identity.imapHost) return { messages: [], cursor };
  const client = new ImapFlow({
    host: identity.imapHost,
    port: identity.imapPort ?? 993,
    secure: (identity.imapPort ?? 993) === 993,
    auth: { user: identity.username, pass: identity.password },
    logger: false,
    ...imapTimeouts(deadline),
  });
  await client.connect();
  const messages: ReplyMessage[] = [];
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox || null;
      const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
      const resume = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : null;
      const found = resume === null ? await client.search({ since }, { uid: true }) : await client.search({ uid: `${resume + 1}:*` }, { uid: true });
      const uids = (found || []).filter((uid) => resume === null || uid > resume).sort((left, right) => left - right);
      const batch = resume === null ? uids.slice(-MESSAGES_READ) : uids.slice(0, MESSAGES_READ);
      let lastUid = resume ?? (batch.length > 0 ? batch[0] - 1 : Math.max(0, (mailbox?.uidNext ?? 1) - 1));
      if (batch.length > 0) {
        const fetched = await client.fetchAll(batch.join(","), { uid: true, bodyStructure: true, envelope: true }, { uid: true });
        fetched.sort((left, right) => left.uid - right.uid);
        for (const message of fetched) {
          if (Date.now() > deadline) break;
          const senders = addresses(message.envelope?.from, message.envelope?.sender);
          for (const part of calendarParts(message.bodyStructure as StructureNode | undefined)) {
            const download = await client.download(String(message.uid), part, { uid: true, maxBytes: PART_MAX_BYTES });
            if (!("content" in download) || !download.content) continue;
            const text = await readStream(download.content);
            if (/METHOD:REPLY/i.test(text)) messages.push({ text, senders });
          }
          lastUid = Math.max(lastUid, message.uid);
        }
      }
      return { messages, cursor: uidValidity ? { uidValidity, lastUid } : null };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
};

function withResponses(attendees: unknown, responses: ItipReply["responses"]) {
  if (!Array.isArray(attendees)) return null;
  const answers = new Map(responses.map((item) => [item.email, item.response]));
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

function trustedReply(message: ReplyMessage, organiser: string) {
  const reply = readItipReply(message.text);
  if (!reply || reply.organizer !== organiser) return null;
  const senders = new Set(message.senders.map((email) => email.toLowerCase()));
  const responses = reply.responses.filter((item) => senders.has(item.email));
  return responses.length > 0 ? { ...reply, responses } : null;
}

export async function applyInviteReplies(actor: UserActor, identity: Pick<SendIdentity, "id" | "email">, messages: ReplyMessage[]) {
  const organiser = canonicalEmail(identity.email) ?? identity.email.toLowerCase();
  const replies = messages.map((message) => trustedReply(message, organiser)).filter((reply): reply is ItipReply => reply !== null);
  if (replies.length === 0) return 0;
  return withActor(actor, async (db) => {
    let updated = 0;
    for (const reply of replies) {
      const found = await db.query<{ id: string; attendees: unknown; invite_sequence: number }>(
        `select id, attendees, invite_sequence from crm.calendar_events
         where user_id = $1 and invite_identity_id = $2 and invite_uid = $3`,
        [actor.userId, identity.id, reply.uid],
      );
      for (const row of found.rows) {
        if (reply.sequence !== null && reply.sequence < row.invite_sequence) continue;
        const attendees = withResponses(row.attendees, reply.responses);
        if (!attendees) continue;
        await db.query("update crm.calendar_events set attendees = $2::jsonb where id = $1", [row.id, JSON.stringify(attendees)]);
        updated += 1;
      }
    }
    return updated;
  });
}

async function saveCursor(actor: UserActor, identityId: string, cursor: ReplyCursor | null) {
  await withActor(actor, (db) =>
    db.query("update crm.send_identities set reply_uid_validity = $3, reply_last_uid = $4 where id = $1 and user_id = $2", [
      identityId,
      actor.userId,
      cursor?.uidValidity ?? null,
      cursor?.lastUid ?? null,
    ]),
  );
}

async function readCursor(actor: UserActor, identityId: string): Promise<ReplyCursor | null> {
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ reply_uid_validity: string | null; reply_last_uid: string | null }>(
      "select reply_uid_validity, reply_last_uid from crm.send_identities where id = $1 and user_id = $2",
      [identityId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
  if (!row || row.reply_uid_validity === null || row.reply_last_uid === null) return null;
  return { uidValidity: String(row.reply_uid_validity), lastUid: Number(row.reply_last_uid) };
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
      const cursor = await readCursor(actor, identity.id);
      const read = await (options.reader ?? defaultReplyReader)(identity, { since, cursor, deadline });
      updated += await applyInviteReplies(actor, identity, read.messages);
      await saveCursor(actor, identity.id, read.cursor);
    } catch (error) {
      console.error("Reading invite replies failed", error instanceof Error ? error.message : error);
    }
  }
  return updated;
}
