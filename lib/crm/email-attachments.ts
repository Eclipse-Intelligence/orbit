import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import type { MailAttachment } from "@/lib/microsoft/oauth";
import { ATTACHMENT_MAX_BYTES, putObject, readObject, removeObjects, signedUploadUrl, storageConfigured, StorageError } from "@/lib/storage";

const ATTACHMENT_MAX_COUNT = 10;

export type PreparedAttachment = { id: string; name: string; size: number; uploadUrl: string };
type AttachmentSummary = { name: string; size: number };

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/[\\/\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!name) throw new CrmError("invalid_input", "The file needs a name.", 400, { field: "attachments" });
  return name;
}

function cleanType(value: unknown) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 200 ? type : "application/octet-stream";
}

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function storageFailure(error: unknown) {
  if (error instanceof CrmError) return error;
  return new CrmError("upstream_error", error instanceof StorageError ? error.message : "Couldn't store the attachment.", 502);
}

export async function prepareAttachment(
  actor: UserActor,
  input: { name: unknown; size: unknown; contentType?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedAttachment> {
  if (!storageConfigured()) throw new CrmError("invalid_input", "Attachments need SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
  const name = cleanName(input.name);
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : 0;
  if (size < 1) throw new CrmError("invalid_input", `${name} is empty.`, 400, { field: "attachments" });
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new CrmError("invalid_input", `${name} is ${megabytes(size)}. Attachments can be up to ${megabytes(ATTACHMENT_MAX_BYTES)} in total.`, 400, { field: "attachments" });
  }
  const row = await withActor(actor, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into crm.email_attachments (workspace_id, user_id, name, content_type, size)
       values ($1, $2, $3, $4, $5) returning id`,
      [actor.workspaceId, actor.userId, name, cleanType(input.contentType), size],
    );
    return inserted.rows[0];
  });
  try {
    return { id: row.id, name, size, uploadUrl: await signedUploadUrl(row.id, fetchImpl) };
  } catch (error) {
    await withActor(actor, (db) => db.query("delete from crm.email_attachments where id = $1", [row.id])).catch(() => undefined);
    throw storageFailure(error);
  }
}

function attachmentIds(ids: unknown) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length > ATTACHMENT_MAX_COUNT) {
    throw new CrmError("invalid_input", `Attach up to ${ATTACHMENT_MAX_COUNT} files.`, 400, { field: "attachments" });
  }
  if (!list.every((id) => typeof id === "string" && isUuid(id))) throw new CrmError("not_found", "Attachment not found.", 404);
  return [...new Set(list as string[])];
}

export async function loadAttachments(
  actor: UserActor,
  ids: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ files: MailAttachment[]; summary: AttachmentSummary[] }> {
  const wanted = attachmentIds(ids);
  if (wanted.length === 0) return { files: [], summary: [] };
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string; content_type: string; size: number }>(
      "select id, name, content_type, size from crm.email_attachments where id = any($1::uuid[])",
      [wanted],
    );
    return result.rows;
  });
  if (rows.length !== wanted.length) throw new CrmError("not_found", "An attachment has expired. Attach it again.", 404, { field: "attachments" });
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  if (total > ATTACHMENT_MAX_BYTES) {
    throw new CrmError("invalid_input", `Attachments add up to ${megabytes(total)}. The limit is ${megabytes(ATTACHMENT_MAX_BYTES)}.`, 400, { field: "attachments" });
  }
  const ordered = wanted.map((id) => rows.find((row) => row.id === id)!);
  const files: MailAttachment[] = [];
  for (const row of ordered) {
    let bytes: Uint8Array;
    try {
      bytes = await readObject(row.id, fetchImpl);
    } catch (error) {
      throw new CrmError("invalid_input", `${row.name} didn't finish uploading. Attach it again.`, 400, { field: "attachments", cause: storageFailure(error).message });
    }
    if (bytes.byteLength !== row.size) throw new CrmError("invalid_input", `${row.name} didn't finish uploading. Attach it again.`, 400, { field: "attachments" });
    files.push({ name: row.name, contentType: row.content_type, bytes });
  }
  return { files, summary: ordered.map((row) => ({ name: row.name, size: row.size })) };
}

function knowledgeFileName(title: string, path: string) {
  const extension = path.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? "";
  const name = title.toLowerCase().endsWith(extension.toLowerCase()) ? title : `${title}${extension}`;
  return cleanName(name);
}

export async function attachableFiles(actor: UserActor, ids: unknown, fetchImpl: typeof fetch = fetch) {
  const wanted = attachmentIds(ids);
  if (wanted.length === 0) return { ids: [], copied: [] };
  const found = await withActor(actor, async (db) => {
    const own = await db.query<{ id: string }>("select id from crm.email_attachments where id = any($1::uuid[])", [wanted]);
    const knowledge = await db.query<{ id: string; title: string; file_path: string | null; mime_type: string | null; size_bytes: number | null }>(
      `select id, title, file_path, mime_type, size_bytes from crm.knowledge_items
       where workspace_id = $1 and id = any($2::uuid[]) and archived_at is null`,
      [actor.workspaceId, wanted],
    );
    return { own: new Set(own.rows.map((row) => row.id)), knowledge: knowledge.rows };
  });
  const copied: string[] = [];
  const out: string[] = [];
  try {
    for (const id of wanted) {
      if (found.own.has(id)) {
        out.push(id);
        continue;
      }
      const item = found.knowledge.find((row) => row.id === id);
      if (!item) throw new CrmError("not_found", "One of the files isn't in Knowledge or on the draft.", 404, { field: "attachments" });
      if (!item.file_path) throw new CrmError("invalid_input", `${item.title} is a link or text in Knowledge, not a file, so it can't be attached.`, 400, { field: "attachments" });
      if ((item.size_bytes ?? 0) > ATTACHMENT_MAX_BYTES) {
        throw new CrmError("invalid_input", `${item.title} is ${megabytes(item.size_bytes ?? 0)}. Attachments can be up to ${megabytes(ATTACHMENT_MAX_BYTES)} in total.`, 400, { field: "attachments" });
      }
      if (!storageConfigured()) throw new CrmError("invalid_input", "Attachments need SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
      let bytes: Uint8Array;
      try {
        bytes = await readObject(item.file_path, fetchImpl, "knowledge");
      } catch (error) {
        throw new CrmError("upstream_error", `Couldn't read ${item.title} from Knowledge.`, 502, { cause: storageFailure(error).message });
      }
      const name = knowledgeFileName(item.title, item.file_path);
      const contentType = cleanType(item.mime_type);
      const row = await withActor(actor, async (db) => {
        const inserted = await db.query<{ id: string }>(
          `insert into crm.email_attachments (workspace_id, user_id, name, content_type, size)
           values ($1, $2, $3, $4, $5) returning id`,
          [actor.workspaceId, actor.userId, name, contentType, bytes.byteLength],
        );
        return inserted.rows[0];
      });
      copied.push(row.id);
      try {
        await putObject(row.id, bytes, contentType, fetchImpl);
      } catch (error) {
        throw storageFailure(error);
      }
      out.push(row.id);
    }
  } catch (error) {
    await discardAttachments(actor, copied, fetchImpl).catch(() => undefined);
    throw error;
  }
  return { ids: out, copied };
}

export async function discardAttachments(actor: UserActor, ids: unknown, fetchImpl: typeof fetch = fetch) {
  const wanted = attachmentIds(ids);
  if (wanted.length === 0) return;
  const removed = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>("delete from crm.email_attachments where id = any($1::uuid[]) returning id", [wanted]);
    return result.rows.map((row) => row.id);
  });
  await removeObjects(removed, fetchImpl).catch((error) => console.error("Attachment cleanup failed", error));
}

export async function sweepEmailAttachments(fetchImpl: typeof fetch = fetch) {
  if (!storageConfigured()) return 0;
  const stale = await query<{ id: string }>("select * from private.claim_stale_email_attachments($1)", [200]);
  const ids = stale.rows.map((row) => row.id);
  await removeObjects(ids, fetchImpl);
  return ids.length;
}
