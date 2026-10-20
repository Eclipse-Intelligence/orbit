import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { fetchMicrosoftAttachment, GraphMailError, listMicrosoftAttachments } from "@/lib/mail/microsoft";
import { mailSourceToken } from "@/lib/mail/sync";

async function messageSource(actor: UserActor, messageId: string) {
  if (!isUuid(messageId)) throw new CrmError("not_found", "Email not found.", 404);
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ source_id: string; provider_message_id: string }>(
      "select source_id, provider_message_id from crm.mail_messages where id = $1 and user_id = $2",
      [messageId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
  if (!row) throw new CrmError("not_found", "Email not found.", 404);
  return row;
}

function problem(error: unknown): never {
  if (error instanceof CrmError) throw error;
  if (error instanceof GraphMailError) throw new CrmError("upstream_error", error.status === 404 ? "That attachment is no longer in Outlook." : error.message, error.status === 404 ? 404 : 502);
  throw new CrmError("upstream_error", "Outlook didn't send the attachment. Try again.", 502);
}

export async function listMailAttachments(actor: UserActor, messageId: string, fetchImpl: typeof fetch = fetch) {
  const row = await messageSource(actor, messageId);
  const token = await mailSourceToken(actor, row.source_id, fetchImpl);
  const items = await listMicrosoftAttachments(token, row.provider_message_id, fetchImpl).catch(problem);
  return items.filter((item) => !item.inline || !/^image\//.test(item.contentType ?? ""));
}

export async function openMailAttachment(actor: UserActor, messageId: string, attachmentId: string, fetchImpl: typeof fetch = fetch) {
  if (!attachmentId || attachmentId.length > 1000) throw new CrmError("not_found", "Attachment not found.", 404);
  const row = await messageSource(actor, messageId);
  const token = await mailSourceToken(actor, row.source_id, fetchImpl);
  const items = await listMicrosoftAttachments(token, row.provider_message_id, fetchImpl).catch(problem);
  const item = items.find((entry) => entry.id === attachmentId);
  if (!item) throw new CrmError("not_found", "Attachment not found.", 404);
  const response = await fetchMicrosoftAttachment(token, row.provider_message_id, attachmentId, fetchImpl).catch(problem);
  return { item, body: response.body! };
}
