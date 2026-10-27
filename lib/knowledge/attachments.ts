import { createHash } from "node:crypto";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { CONTENT_MAX } from "@/lib/knowledge/indexing";
import { transcriptText } from "@/lib/knowledge/media";
import { addKnowledgeText, type KnowledgeTarget } from "@/lib/knowledge/store";
import { openMailAttachment } from "@/lib/mail/attachments";
import { readAttachmentText } from "@/lib/mail/attachment-text";
import { KNOWLEDGE_MAX_BYTES } from "@/lib/storage";

async function readAll(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function addMailAttachmentToKnowledge(actor: UserActor, messageId: string, attachmentId: string, target: KnowledgeTarget, fetchImpl: typeof fetch = fetch) {
  const { item, body } = await openMailAttachment(actor, messageId, attachmentId, fetchImpl);
  const bytes = await readAll(body, KNOWLEDGE_MAX_BYTES);
  if (!bytes) throw new CrmError("invalid_input", `${item.name} is over 50 MB.`, 400);
  const text = /\.(vtt|srt)$/i.test(item.name)
    ? transcriptText(new TextDecoder("utf-8", { fatal: false }).decode(bytes), item.name.toLowerCase().endsWith(".vtt") ? "text/vtt" : "application/srt")
    : await readAttachmentText(bytes, item.name, item.contentType, CONTENT_MAX).catch(() => null);
  if (!text?.trim()) throw new CrmError("invalid_input", `Orbit can't read text from ${item.name}.`, 400);
  const place = "companyId" in target ? target.companyId : "eclipse";
  const sourceRef = `attachment:${createHash("sha256").update(`${messageId}\n${attachmentId}`).digest("hex").slice(0, 40)}:${place}`;
  return addKnowledgeText(
    actor,
    target,
    {
      kind: "attachment",
      title: item.name.replace(/\.[a-z0-9]{1,5}$/i, "") || item.name,
      content: text,
      sourceRef,
      mimeType: item.contentType,
      sizeBytes: bytes.byteLength,
    },
    { operation: "add_knowledge_attachment" },
  );
}
