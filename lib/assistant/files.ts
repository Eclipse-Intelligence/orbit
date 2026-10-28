import { withActor } from "@/lib/crm/context";
import { cleanName, cleanType, megabytes, storageFailure } from "@/lib/crm/email-attachments";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { fileText, hasReadableText, isAudio } from "@/lib/knowledge/indexing";
import { addKnowledgeFile, CONTENT_LIMIT, READ_WINDOW, type KnowledgeTarget } from "@/lib/knowledge/store";
import { ATTACHMENT_MAX_BYTES, chatFileKey, readObject, removeObjects, signedUploadUrl, storageConfigured } from "@/lib/storage";

const CHAT_FILES_MAX = 10;

export type ChatFile = { id: string; name: string; contentType: string; size: number };
export type PreparedChatFile = { id: string; name: string; size: number; uploadUrl: string };

type FileRow = { id: string; name: string; content_type: string; size: number; message_id: string | null; content: string | null };

const READABLE = "PDF, Word, PowerPoint, Excel, text, CSV and HTML files";

const IMAGE_NOTE =
  "This is an image. Orbit can't pass images to the model yet, so you can't see what it shows. Tell the user that, and ask them to describe it or paste any text in it. It can still be attached to an email.";

function summary(row: Pick<FileRow, "id" | "name" | "content_type" | "size">): ChatFile {
  return { id: row.id, name: row.name, contentType: row.content_type, size: row.size };
}

function isImage(name: string, type: string | null) {
  return (type ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg|avif)$/i.test(name);
}

function noStorage() {
  return new CrmError("invalid_input", "Attaching files needs SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
}

export async function prepareChatFile(
  actor: UserActor,
  input: { name: unknown; size: unknown; contentType?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedChatFile> {
  if (!storageConfigured()) throw noStorage();
  const name = cleanName(input.name);
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : 0;
  if (size < 1) throw new CrmError("invalid_input", `${name} is empty.`, 400, { field: "files" });
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new CrmError("invalid_input", `${name} is ${megabytes(size)}. Files can be up to ${megabytes(ATTACHMENT_MAX_BYTES)} in total.`, 400, { field: "files" });
  }
  const row = await withActor(actor, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.chat_files (workspace_id, user_id, name, content_type, size)
       values ($1, $2, $3, $4, $5) returning id`,
      [actor.workspaceId, actor.userId, name, cleanType(input.contentType), size],
    );
    return inserted.rows[0];
  });
  try {
    return { id: row.id, name, size, uploadUrl: await signedUploadUrl(chatFileKey(row.id), fetchImpl) };
  } catch (error) {
    await withActor(actor, (db) => db.query("delete from crm.chat_files where id = $1", [row.id])).catch(() => undefined);
    throw storageFailure(error);
  }
}

function fileIds(ids: unknown) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length > CHAT_FILES_MAX) throw new CrmError("invalid_input", `Attach up to ${CHAT_FILES_MAX} files to a message.`, 400, { field: "files" });
  if (!list.every((id) => typeof id === "string" && isUuid(id))) throw new CrmError("not_found", "A file has expired. Attach it again.", 404, { field: "files" });
  return [...new Set(list as string[])];
}

export async function discardChatFiles(actor: UserActor, ids: unknown, fetchImpl: typeof fetch = fetch) {
  const wanted = fileIds(ids);
  if (wanted.length === 0) return;
  const removed = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>("delete from crm.chat_files where id = any($1::uuid[]) and message_id is null returning id", [wanted]);
    return result.rows.map((row) => row.id);
  });
  await removeChatObjects(removed, fetchImpl);
}

export async function removeChatObjects(ids: string[], fetchImpl: typeof fetch = fetch) {
  if (ids.length === 0 || !storageConfigured()) return;
  await removeObjects(ids.map(chatFileKey), fetchImpl).catch((error) => console.error("Chat file cleanup failed", error));
}

export async function chatFilesFor(actor: UserActor, ids: unknown): Promise<ChatFile[]> {
  const wanted = fileIds(ids);
  if (wanted.length === 0) return [];
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<FileRow>("select id, name, content_type, size, message_id, null as content from crm.chat_files where id = any($1::uuid[])", [wanted]);
    return result.rows;
  });
  if (rows.length !== wanted.length || rows.some((row) => row.message_id)) throw new CrmError("not_found", "A file has expired. Attach it again.", 404, { field: "files" });
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  if (total > ATTACHMENT_MAX_BYTES) {
    throw new CrmError("invalid_input", `The files add up to ${megabytes(total)}. The limit is ${megabytes(ATTACHMENT_MAX_BYTES)} a message.`, 400, { field: "files" });
  }
  return wanted.map((id) => summary(rows.find((row) => row.id === id)!));
}

function shownSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function chatFileNote(files: ChatFile[]) {
  if (files.length === 0) return "";
  const lines = files.map(
    (file) => `- ${file.name} (${file.contentType}, ${shownSize(file.size)}, chat file id ${file.id}${isImage(file.name, file.contentType) ? ", an image you can't see" : ""})`,
  );
  return `[Orbit note: the user attached ${files.length === 1 ? "this file" : "these files"} to the message. Read text with read_chat_file, add one to Knowledge with add_chat_file_to_knowledge, or attach one to an email by putting its id in attachmentIds.]\n${lines.join("\n")}`;
}

async function ownFile(actor: UserActor, id: string) {
  if (!isUuid(id)) throw new CrmError("not_found", "That file isn't in your chats. Ask the user to attach it again.", 404);
  const row = await withActor(actor, async (db) => {
    const result = await db.query<FileRow>("select id, name, content_type, size, message_id, content from crm.chat_files where id = $1", [id]);
    return result.rows[0];
  });
  if (!row) throw new CrmError("not_found", "That file isn't in your chats. Ask the user to attach it again.", 404);
  return row;
}

async function fileBytes(row: FileRow, fetchImpl: typeof fetch) {
  if (!storageConfigured()) throw noStorage();
  let bytes: Uint8Array;
  try {
    bytes = await readObject(chatFileKey(row.id), fetchImpl);
  } catch (error) {
    throw new CrmError("invalid_input", `${row.name} didn't finish uploading. Ask the user to attach it again.`, 400, { cause: storageFailure(error).message });
  }
  if (bytes.byteLength !== row.size) throw new CrmError("invalid_input", `${row.name} didn't finish uploading. Ask the user to attach it again.`, 400);
  return bytes;
}

export async function readChatFile(actor: UserActor, id: string, offset = 0, fetchImpl: typeof fetch = fetch) {
  const row = await ownFile(actor, id);
  const file = summary(row);
  if (isImage(row.name, row.content_type)) return { file, image: true, text: null, nextOffset: null, note: IMAGE_NOTE };
  let content = row.content;
  if (content === null) {
    if (isAudio(row.name, row.content_type)) {
      throw new CrmError("invalid_input", `${row.name} is a recording. Orbit can't transcribe it in the chat, but adding it to Knowledge does.`, 400);
    }
    if (!hasReadableText(row.name, row.content_type)) throw new CrmError("invalid_input", `Orbit can't read text from ${row.name}. ${READABLE} work.`, 400);
    const text = (await fileText(await fileBytes(row, fetchImpl), row.name, row.content_type))?.trim();
    if (!text) throw new CrmError("invalid_input", `Orbit found no text in ${row.name}. It may be a scan or a picture of text.`, 400);
    content = text.slice(0, CONTENT_LIMIT);
    await withActor(actor, (db) => db.query("update crm.chat_files set content = $2 where id = $1", [row.id, content]));
  }
  const start = Math.min(Math.max(0, Math.floor(offset)), content.length);
  const text = content.slice(start, start + READ_WINDOW);
  const end = start + text.length;
  return { file, offset: start, characters: content.length, text, nextOffset: end < content.length ? end : null };
}

export async function addChatFileToKnowledge(
  actor: UserActor,
  id: string,
  target: KnowledgeTarget,
  provenance: Provenance,
  fetchImpl: typeof fetch = fetch,
) {
  const row = await ownFile(actor, id);
  if (!isAudio(row.name, row.content_type) && !hasReadableText(row.name, row.content_type)) {
    throw new CrmError("invalid_input", `Knowledge can't read ${row.name}. ${READABLE}, and recordings, work.`, 400);
  }
  const place = "companyId" in target ? target.companyId : "eclipse";
  return addKnowledgeFile(
    actor,
    target,
    { name: row.name, contentType: row.content_type, bytes: await fileBytes(row, fetchImpl), sourceRef: `chat:${row.id}:${place}` },
    provenance,
    fetchImpl,
  );
}

export async function sweepChatFiles(fetchImpl: typeof fetch = fetch) {
  if (!storageConfigured()) return 0;
  const stale = await query<{ id: string }>("select * from private.claim_stale_chat_files($1)", [200]);
  const ids = stale.rows.map((row) => row.id);
  await removeObjects(ids.map(chatFileKey), fetchImpl);
  return ids.length;
}
