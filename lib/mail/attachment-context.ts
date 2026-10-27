import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { readAttachmentText, attachmentKind } from "@/lib/mail/attachment-text";
import { mailFullWhen, personName } from "@/lib/mail/format";
import { fetchMicrosoftAttachment, listMicrosoftAttachments } from "@/lib/mail/microsoft";
import { mailSourceToken } from "@/lib/mail/sync";

const SIZE_MAX = 25 * 1024 * 1024;
const PER_MESSAGE = 10;
const TEXT_MAX = 200_000;
const STEP_MS = 8_000;

type MessageRow = {
  id: string;
  source_id: string;
  provider_message_id: string;
  from_email: string | null;
  from_name: string | null;
  at: Date | string | null;
  read: number;
};

type TextRow = { message_id: string; name: string; text: string };

type AttachmentReport = { read: number; skipped: number };

async function bytesOf(response: Response, limit: number) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function store(
  actor: UserActor,
  messageId: string,
  item: { id: string; name: string; contentType: string | null; size: number },
  state: "read" | "unreadable" | "too_large" | "failed",
  text: string | null,
) {
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.mail_attachment_texts (workspace_id, user_id, message_id, attachment_id, name, content_type, size, state, text)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (message_id, attachment_id) do update set state = excluded.state, text = excluded.text, name = excluded.name`,
      [actor.workspaceId, actor.userId, messageId, item.id, item.name.slice(0, 300) || "Attachment", item.contentType, Math.min(item.size, 2_147_483_647), state, text],
    ),
  );
}

async function readMessage(actor: UserActor, message: MessageRow, deadline: number, fetchImpl: typeof fetch, report: AttachmentReport) {
  const token = await mailSourceToken(actor, message.source_id, fetchImpl);
  const items = (await listMicrosoftAttachments(token, message.provider_message_id, fetchImpl)).filter(
    (item) => !(item.inline && /^image\//.test(item.contentType ?? "")),
  );
  for (const item of items.slice(0, PER_MESSAGE)) {
    if (!attachmentKind(item.name, item.contentType)) {
      await store(actor, message.id, item, "unreadable", null);
      report.skipped += 1;
      continue;
    }
    if (item.size > SIZE_MAX) {
      await store(actor, message.id, item, "too_large", null);
      report.skipped += 1;
      continue;
    }
    if (deadline - Date.now() < STEP_MS) return false;
    try {
      const response = await fetchMicrosoftAttachment(token, message.provider_message_id, item.id, fetchImpl);
      const bytes = await bytesOf(response, SIZE_MAX);
      const text = bytes ? await readAttachmentText(bytes, item.name, item.contentType, TEXT_MAX) : null;
      await store(actor, message.id, item, bytes ? (text ? "read" : "unreadable") : "too_large", text);
      if (text) report.read += 1;
      else report.skipped += 1;
    } catch (error) {
      console.error("Reading an attachment failed", error instanceof Error ? error.message : error);
      await store(actor, message.id, item, "failed", null);
      report.skipped += 1;
    }
  }
  return true;
}

async function readAttachments(
  actor: UserActor,
  messageIds: string[],
  options: { deadline: number; fetchImpl?: typeof fetch },
): Promise<AttachmentReport> {
  const report: AttachmentReport = { read: 0, skipped: 0 };
  if (messageIds.length === 0) return report;
  const messages = await withActor(actor, async (db) => {
    const result = await db.query<MessageRow>(
      `select m.id, m.source_id, m.provider_message_id, m.from_email, m.from_name, coalesce(m.received_at, m.sent_at, m.created_at) as at,
         (select count(*)::int from crm.mail_attachment_texts t where t.message_id = m.id) as read
       from crm.mail_messages m
       where m.user_id = $1 and m.id = any($2::uuid[]) and m.has_attachments`,
      [actor.userId, messageIds],
    );
    return result.rows;
  });
  for (const message of messages.filter((item) => item.read === 0)) {
    if (options.deadline - Date.now() < STEP_MS) break;
    try {
      if (!(await readMessage(actor, message, options.deadline, options.fetchImpl ?? fetch, report))) break;
    } catch (error) {
      console.error("Listing attachments failed", error instanceof Error ? error.message : error);
    }
  }
  return report;
}

export async function attachmentNotes(
  actor: UserActor,
  messageIds: string[],
  options: { budget: number; deadline?: number; fetchImpl?: typeof fetch; read?: boolean },
) {
  if (messageIds.length === 0) return [];
  if (options.read !== false) {
    await readAttachments(actor, messageIds, { deadline: options.deadline ?? Date.now() + 20_000, fetchImpl: options.fetchImpl }).catch((error) =>
      console.error("Reading attachments failed", error instanceof Error ? error.message : error),
    );
  }
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<TextRow & { from_email: string | null; from_name: string | null; at: Date | string | null }>(
      `select t.message_id, t.name, t.text, m.from_email, m.from_name, coalesce(m.received_at, m.sent_at, m.created_at) as at
       from crm.mail_attachment_texts t join crm.mail_messages m on m.id = t.message_id
       where t.user_id = $1 and t.message_id = any($2::uuid[]) and t.state = 'read' and t.text is not null
       order by at desc, t.name`,
      [actor.userId, messageIds],
    );
    return result.rows;
  });
  if (rows.length === 0) return [];
  const share = Math.max(1_500, Math.floor(options.budget / rows.length));
  let left = options.budget;
  const notes: string[] = [];
  for (const row of rows) {
    if (left < 500) break;
    const take = Math.min(share, left, row.text.length);
    const sender = row.from_email ? personName({ name: row.from_name, address: row.from_email }) : "someone";
    const cut = take < row.text.length ? "\n[the rest of the attachment is cut]" : "";
    notes.push(`Attachment "${row.name}", sent by ${sender} on ${mailFullWhen(row.at ? new Date(row.at).toISOString() : null)}:\n${row.text.slice(0, take)}${cut}`);
    left -= take;
  }
  return notes;
}
