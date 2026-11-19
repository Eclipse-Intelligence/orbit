import { baseType, opensInline } from "@/lib/chat/files";
import { CHAT_FILE_MAX_BYTES, CHAT_FILES_MAX, type ChatUpload } from "@/lib/chat/types";
import { withActor } from "@/lib/crm/context";
import { cleanName, cleanType, megabytes } from "@/lib/crm/email-attachments";
import { CrmError, notFound, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { bucketForId, objectExists, removeObjects, signedDownloadUrl, signedUploadUrl, storageConfigured } from "@/lib/storage";

const TOMBSTONE_BATCH = 500;
const REMOVE_CHUNK = 100;
const STALE_BATCH = 200;
const DIMENSION_MAX = 100_000;

export const UPLOAD_UNFINISHED = "A file didn't finish uploading. Try again.";
const UPLOAD_FAILED = "Couldn't upload. Try again.";
const OPEN_FAILED = "Couldn't open the file. Try again.";
const SWEEP_BUDGET_MS = 20_000;

function storageError(error: unknown, copy: string) {
  if (error instanceof CrmError) return error;
  console.error("Chat file storage failed", error);
  return new CrmError("upstream_error", copy, 502, { field: "files" });
}

type AttachmentRow = { id: string; conversation_id: string; message_id: string | null; name: string; content_type: string; size: number };

export function chatAttachmentKey(conversationId: string, id: string) {
  return `team-chat/${conversationId}/${id}`;
}

function noStorage() {
  return new CrmError("invalid_input", "Attaching files needs SUPABASE_SERVICE_ROLE_KEY set on the server.", 400, { field: "files" });
}

function dimension(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= DIMENSION_MAX ? value : null;
}

function cleanFile(input: unknown) {
  const file = (input && typeof input === "object" ? input : {}) as { name?: unknown; size?: unknown; contentType?: unknown; width?: unknown; height?: unknown };
  const name = cleanName(file.name);
  const size = typeof file.size === "number" && Number.isInteger(file.size) ? file.size : 0;
  if (size < 1) throw new CrmError("invalid_input", `${name} is empty.`, 400, { field: "files" });
  if (size > CHAT_FILE_MAX_BYTES) throw new CrmError("invalid_input", `${name} is ${megabytes(size)}. Files can be up to ${megabytes(CHAT_FILE_MAX_BYTES)} each.`, 400, { field: "files" });
  return { name, size, content_type: cleanType(file.contentType), width: dimension(file.width), height: dimension(file.height) };
}

export function cleanAttachmentIds(ids: unknown): string[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && isUuid(id))) throw new CrmError("not_found", "A file has expired. Attach it again.", 404, { field: "files" });
  const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  if (unique.length > CHAT_FILES_MAX) throw new CrmError("invalid_input", `Attach up to ${CHAT_FILES_MAX} files to a message.`, 400, { field: "files" });
  return unique;
}

function failure(error: unknown): never {
  throw pgFailure(error) ?? error;
}

export async function prepareChatUpload(actor: UserActor, conversationId: unknown, files: unknown, fetchImpl: typeof fetch = fetch): Promise<ChatUpload[]> {
  if (typeof conversationId !== "string" || !isUuid(conversationId)) throw notFound("conversation");
  if (!storageConfigured()) throw noStorage();
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) throw new CrmError("invalid_input", "Choose a file to attach.", 400, { field: "files" });
  if (list.length > CHAT_FILES_MAX) throw new CrmError("invalid_input", `Attach up to ${CHAT_FILES_MAX} files to a message.`, 400, { field: "files" });
  const cleaned = list.map(cleanFile);
  let rows: { id: string; name: string; content_type: string; size: number }[];
  try {
    const result = await query<{ id: string; name: string; content_type: string; size: number }>("select * from private.chat_prepare_attachments($1, $2, $3::jsonb)", [
      actor.userId,
      conversationId.toLowerCase(),
      JSON.stringify(cleaned),
    ]);
    rows = result.rows;
  } catch (error) {
    failure(error);
  }
  try {
    return await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        contentType: row.content_type,
        size: row.size,
        uploadUrl: await signedUploadUrl(chatAttachmentKey(conversationId.toLowerCase(), row.id), fetchImpl),
      })),
    );
  } catch (error) {
    await query("select private.chat_discard_attachments($1, $2::uuid[])", [actor.userId, rows.map((row) => row.id)]).catch(() => undefined);
    throw storageError(error, UPLOAD_FAILED);
  }
}

export async function discardChatUploads(actor: UserActor, ids: unknown) {
  const wanted = cleanAttachmentIds(ids);
  if (wanted.length === 0) return { discarded: 0 };
  const result = await query<{ discarded: number }>("select private.chat_discard_attachments($1, $2::uuid[]) as discarded", [actor.userId, wanted]);
  return { discarded: result.rows[0]?.discarded ?? 0 };
}

function storedMatches(object: { contentType: string | null; size: number | null }, row: AttachmentRow) {
  if (object.size !== null && object.size !== row.size) return false;
  if (!opensInline(row.content_type)) return true;
  return object.contentType !== null && baseType(object.contentType) === baseType(row.content_type);
}

export async function checkUploads(actor: UserActor, conversationId: string, ids: string[], fetchImpl: typeof fetch = fetch) {
  if (ids.length === 0) return;
  if (!storageConfigured()) throw noStorage();
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<AttachmentRow>("select id, conversation_id, message_id, name, content_type, size from crm.chat_attachments where id = any($1::uuid[])", [ids]);
    return result.rows;
  });
  if (rows.length !== ids.length || rows.some((row) => row.message_id || row.conversation_id !== conversationId)) {
    throw new CrmError("not_found", "A file has expired. Attach it again.", 404, { field: "files" });
  }
  const stored = await Promise.all(
    rows.map((row) =>
      objectExists(chatAttachmentKey(row.conversation_id, row.id), fetchImpl).catch((error) => {
        throw storageError(error, UPLOAD_FAILED);
      }),
    ),
  );
  rows.forEach((row, index) => {
    const object = stored[index];
    if (!object || !storedMatches(object, row)) {
      throw new CrmError("invalid_input", UPLOAD_UNFINISHED, 400, { field: "files", file: row.name });
    }
  });
}

export async function removeChatAttachments(actor: UserActor, messageId: string, ids: string[]) {
  if (ids.length === 0) return;
  try {
    await query("select private.chat_remove_attachments($1, $2, $3::uuid[])", [actor.userId, messageId, ids]);
  } catch (error) {
    failure(error);
  }
}

export async function chatFileLink(actor: UserActor, id: string, options: { download?: boolean } = {}, fetchImpl: typeof fetch = fetch) {
  if (!isUuid(id)) throw notFound("file");
  if (!storageConfigured()) throw noStorage();
  const row = await withActor(actor, async (db) => {
    const result = await db.query<AttachmentRow>("select id, conversation_id, message_id, name, content_type, size from crm.chat_attachments where id = $1", [id.toLowerCase()]);
    return result.rows[0];
  });
  if (!row) throw notFound("file");
  const inline = !options.download && row.message_id !== null && opensInline(row.content_type);
  try {
    return await signedDownloadUrl(chatAttachmentKey(row.conversation_id, row.id), inline ? {} : { download: row.name }, fetchImpl);
  } catch (error) {
    throw storageError(error, OPEN_FAILED);
  }
}

export async function drainStorageTombstones(fetchImpl: typeof fetch = fetch, deadline = Date.now() + SWEEP_BUDGET_MS) {
  if (!storageConfigured()) return 0;
  const due = await query<{ bucket: string; path: string }>("select bucket, path from private.storage_tombstones_due($1)", [TOMBSTONE_BATCH]);
  const byBucket = new Map<string, string[]>();
  for (const row of due.rows) byBucket.set(row.bucket, [...(byBucket.get(row.bucket) ?? []), row.path]);
  let removed = 0;
  for (const [bucketId, paths] of byBucket) {
    const bucket = bucketForId(bucketId);
    if (!bucket) continue;
    for (let start = 0; start < paths.length && Date.now() < deadline; start += REMOVE_CHUNK) {
      const chunk = paths.slice(start, start + REMOVE_CHUNK);
      try {
        await removeObjects(chunk, fetchImpl, bucket);
      } catch (error) {
        console.error("Storage cleanup failed", error);
        continue;
      }
      await query("select private.storage_tombstones_done($1, $2::text[])", [bucketId, chunk]);
      removed += chunk.length;
    }
  }
  return removed;
}

export async function sweepChatAttachments(fetchImpl: typeof fetch = fetch, options: { deadline?: number } = {}) {
  if (!storageConfigured()) return { stale: 0, removed: 0 };
  const deadline = options.deadline ?? Date.now() + SWEEP_BUDGET_MS;
  const stale = await query<{ count: number }>("select private.chat_sweep_attachments($1) as count", [STALE_BATCH]);
  const removed = Date.now() < deadline ? await drainStorageTombstones(fetchImpl, deadline) : 0;
  return { stale: stale.rows[0]?.count ?? 0, removed };
}
