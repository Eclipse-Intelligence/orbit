import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { linkKind } from "@/lib/knowledge/media";
import { KNOWLEDGE_MAX_BYTES, removeObjects, signedUploadUrl, storageConfigured, StorageError } from "@/lib/storage";

export const KNOWLEDGE_KINDS = ["file", "link", "youtube", "podcast", "transcript", "attachment"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeStatus = "pending" | "indexing" | "ready" | "failed";
export type KnowledgeTarget = { companyId: string } | { eclipse: true };

export const READ_WINDOW = 20_000;
export const STALE_MS = 5 * 60_000;
export const UPLOAD_STALE_MS = 30 * 60_000;

export type KnowledgeItem = {
  id: string;
  scope: "company" | "eclipse";
  companyId: string | null;
  companyName: string | null;
  kind: KnowledgeKind;
  title: string;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: KnowledgeStatus;
  error: string | null;
  summary: string | null;
  charCount: number;
  chunkCount: number;
  createdBy: string | null;
  createdAt: string;
  indexedAt: string | null;
  updatedAt: string;
};

export type ItemRow = {
  id: string;
  workspace_id: string;
  scope: "company" | "eclipse";
  company_id: string | null;
  company_name: string | null;
  kind: KnowledgeKind;
  title: string;
  source_url: string | null;
  source_ref: string | null;
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: KnowledgeStatus;
  error: string | null;
  summary: string | null;
  char_count: number;
  chunk_count: number;
  created_by: string | null;
  created_at: Date;
  indexed_at: Date | null;
  updated_at: Date;
};

export const ITEM_COLUMNS = `i.id, i.workspace_id, i.scope, i.company_id, co.name as company_name, i.kind, i.title, i.source_url, i.source_ref,
  i.file_path, i.mime_type, i.size_bytes, i.status, i.error, i.summary, i.char_count, i.chunk_count,
  coalesce(nullif(p.full_name, ''), p.email) as created_by, i.created_at, i.indexed_at, i.updated_at`;

export const ITEM_FROM = `crm.knowledge_items i
  left join crm.companies co on co.id = i.company_id
  left join crm.profiles p on p.id = i.created_by_user_id`;

export function mapItem(row: ItemRow): KnowledgeItem {
  return {
    id: row.id,
    scope: row.scope,
    companyId: row.company_id,
    companyName: row.company_name,
    kind: row.kind,
    title: row.title,
    sourceUrl: row.source_url,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    error: row.error,
    summary: row.summary,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    indexedAt: row.indexed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function isStale(item: Pick<KnowledgeItem, "status" | "updatedAt" | "kind">, now = Date.now()) {
  if (item.status !== "indexing" && item.status !== "pending") return false;
  return now - new Date(item.updatedAt).getTime() > (item.status === "pending" && item.kind === "file" ? UPLOAD_STALE_MS : STALE_MS);
}

function cleanTitle(value: unknown, fallback = "") {
  const title = (typeof value === "string" ? value : fallback).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) throw new CrmError("invalid_input", "Give it a name.", 400, { field: "title" });
  return title;
}

function cleanFileName(value: unknown) {
  const name = typeof value === "string" ? value.replace(/[\\/\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!name) throw new CrmError("invalid_input", "The file needs a name.", 400, { field: "file" });
  return name;
}

function cleanType(value: unknown) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 200 ? type : null;
}

export function cleanUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new CrmError("invalid_input", "Paste a link.", 400, { field: "url" });
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CrmError("invalid_input", "That isn't a link Orbit can open.", 400, { field: "url" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CrmError("invalid_input", "Links need to start with https.", 400, { field: "url" });
  url.hash = "";
  return url.href.slice(0, 2000);
}

function storageKey(name: string) {
  if (/^[.\s]*$/.test(name)) return "file";
  return name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-120) || "file";
}

function megabytes(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function assertCompany(db: Db, workspaceId: string, companyId: string) {
  if (!isUuid(companyId)) throw new CrmError("not_found", "Company not found.", 404);
  const found = await db.query("select 1 from crm.companies where id = $1 and workspace_id = $2 and archived_at is null", [companyId, workspaceId]);
  if (found.rowCount === 0) throw new CrmError("not_found", "Company not found.", 404);
}

function targetColumns(target: KnowledgeTarget) {
  return "companyId" in target ? { scope: "company" as const, companyId: target.companyId } : { scope: "eclipse" as const, companyId: null };
}

export function targetFrom(input: { companyId?: unknown; eclipse?: unknown }): KnowledgeTarget {
  if (input.eclipse === true) return { eclipse: true };
  if (typeof input.companyId === "string" && input.companyId) return { companyId: input.companyId };
  throw new CrmError("invalid_input", "Choose a company or Eclipse.", 400, { field: "companyId" });
}

export async function readItem(db: Db, workspaceId: string, id: string) {
  if (!isUuid(id)) return null;
  const result = await db.query<ItemRow>(`select ${ITEM_COLUMNS} from ${ITEM_FROM} where i.id = $1 and i.workspace_id = $2 and i.archived_at is null`, [id, workspaceId]);
  return result.rows[0] ?? null;
}

type NewItem = {
  target: KnowledgeTarget;
  kind: KnowledgeKind;
  title: string;
  status: KnowledgeStatus;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  content?: string | null;
};

export async function insertItem(db: Db, actor: UserActor, input: NewItem, provenance: Provenance) {
  const { scope, companyId } = targetColumns(input.target);
  if (companyId) await assertCompany(db, actor.workspaceId, companyId);
  const inserted = await db.query<{ id: string }>(
    `insert into crm.knowledge_items (workspace_id, scope, company_id, kind, title, source_url, source_ref, mime_type, size_bytes, status, content, char_count, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce(char_length($11), 0), $12)
     on conflict (workspace_id, source_ref) where source_ref is not null and archived_at is null do nothing
     returning id`,
    [
      actor.workspaceId,
      scope,
      companyId,
      input.kind,
      input.title,
      input.sourceUrl ?? null,
      input.sourceRef ?? null,
      input.mimeType ?? null,
      input.sizeBytes ?? null,
      input.status,
      input.content ?? null,
      actor.userId,
    ],
  );
  if (!inserted.rows[0]) {
    const existing = await db.query<{ id: string }>(
      "select id from crm.knowledge_items where workspace_id = $1 and source_ref = $2 and archived_at is null",
      [actor.workspaceId, input.sourceRef],
    );
    return { id: existing.rows[0].id, created: false };
  }
  const id = inserted.rows[0].id;
  await recordAudit(db, actor, "knowledge.added", "knowledge", id, provenance, {
    after: { title: input.title, kind: input.kind, scope, companyId, sourceUrl: input.sourceUrl ?? null },
  });
  return { id, created: true };
}

export type PreparedKnowledgeUpload = { item: KnowledgeItem; uploadUrl: string };

export async function prepareKnowledgeUpload(
  actor: UserActor,
  target: KnowledgeTarget,
  input: { name: unknown; size: unknown; contentType?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<PreparedKnowledgeUpload> {
  if (!storageConfigured()) throw new CrmError("invalid_input", "Uploads need SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
  const name = cleanFileName(input.name);
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : 0;
  if (size < 1) throw new CrmError("invalid_input", `${name} is empty.`, 400, { field: "file" });
  if (size > KNOWLEDGE_MAX_BYTES) throw new CrmError("invalid_input", `${name} is over ${megabytes(KNOWLEDGE_MAX_BYTES)}.`, 400, { field: "file" });
  const row = await withActor(actor, async (db) => {
    const { id } = await insertItem(
      db,
      actor,
      { target, kind: "file", title: cleanTitle(name.replace(/\.[a-z0-9]{1,5}$/i, ""), name), status: "pending", mimeType: cleanType(input.contentType), sizeBytes: size },
      { operation: "add_knowledge_file" },
    );
    const path = `${actor.workspaceId}/${id}/${storageKey(name)}`;
    await db.query("update crm.knowledge_items set file_path = $2 where id = $1", [id, path]);
    return readItem(db, actor.workspaceId, id);
  });
  if (!row) throw new CrmError("not_found", "That upload couldn't start.", 404);
  try {
    return { item: mapItem(row), uploadUrl: await signedUploadUrl(row.file_path!, fetchImpl, "knowledge") };
  } catch (error) {
    await withActor(actor, (db) => db.query("update crm.knowledge_items set archived_at = now() where id = $1", [row.id])).catch(() => undefined);
    throw new CrmError("upstream_error", error instanceof StorageError ? error.message : "Couldn't store the file.", 502);
  }
}

export async function addKnowledgeLink(actor: UserActor, target: KnowledgeTarget, input: { url: unknown; title?: unknown }) {
  const url = cleanUrl(input.url);
  const kind = linkKind(url);
  const host = new URL(url).hostname.replace(/^www\./, "");
  const title = cleanTitle(typeof input.title === "string" && input.title.trim() ? input.title : host);
  return withActor(actor, async (db) => {
    const { scope, companyId } = targetColumns(target);
    const duplicate = await db.query<{ id: string }>(
      `select id from crm.knowledge_items
       where workspace_id = $1 and archived_at is null and source_url = $2 and scope = $3 and company_id is not distinct from $4
       limit 1`,
      [actor.workspaceId, url, scope, companyId],
    );
    if (duplicate.rows[0]) throw new CrmError("conflict", "That link is already here.", 409, { field: "url" });
    const { id } = await insertItem(db, actor, { target, kind, title, status: "pending", sourceUrl: url }, { operation: "add_knowledge_link", sourceUrl: url });
    return mapItem((await readItem(db, actor.workspaceId, id))!);
  });
}

export async function addKnowledgeText(
  actor: UserActor,
  target: KnowledgeTarget,
  input: { kind: KnowledgeKind; title: string; content: string; sourceRef?: string | null; sourceUrl?: string | null; mimeType?: string | null; sizeBytes?: number | null },
  provenance: Provenance,
) {
  const content = input.content.trim().slice(0, 600_000);
  if (!content) throw new CrmError("invalid_input", "There's no text to add.", 400);
  return withActor(actor, async (db) => {
    const outcome = await insertItem(
      db,
      actor,
      {
        target,
        kind: input.kind,
        title: cleanTitle(input.title),
        status: "pending",
        content,
        sourceRef: input.sourceRef,
        sourceUrl: input.sourceUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      provenance,
    );
    return { item: mapItem((await readItem(db, actor.workspaceId, outcome.id))!), created: outcome.created };
  });
}

export async function getKnowledgeItem(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const row = await readItem(db, actor.workspaceId, id);
    if (!row) throw new CrmError("not_found", "That item isn't in Knowledge.", 404);
    return row;
  });
}

export async function listKnowledge(actor: UserActor, target: KnowledgeTarget | "all", limit = 200): Promise<KnowledgeItem[]> {
  return withActor(actor, async (db) => {
    const filter =
      target === "all" ? "" : "companyId" in target ? "and i.scope = 'company' and i.company_id = $2" : "and i.scope = 'eclipse'";
    const params: unknown[] = [actor.workspaceId];
    if (target !== "all" && "companyId" in target) {
      if (!isUuid(target.companyId)) return [];
      params.push(target.companyId);
    }
    params.push(Math.min(500, Math.max(1, limit)));
    const result = await db.query<ItemRow>(
      `select ${ITEM_COLUMNS} from ${ITEM_FROM}
       where i.workspace_id = $1 and i.archived_at is null ${filter}
       order by i.created_at desc
       limit $${params.length}`,
      params,
    );
    return result.rows.map(mapItem);
  });
}

export async function renameKnowledge(actor: UserActor, id: string, title: unknown) {
  const next = cleanTitle(title);
  return withActor(actor, async (db) => {
    const row = await readItem(db, actor.workspaceId, id);
    if (!row) throw new CrmError("not_found", "That item isn't in Knowledge.", 404);
    if (row.title === next) return mapItem(row);
    await db.query("update crm.knowledge_items set title = $2 where id = $1", [id, next]);
    await recordAudit(db, actor, "knowledge.updated", "knowledge", id, { operation: "rename_knowledge" }, { before: { title: row.title }, after: { title: next } });
    return mapItem((await readItem(db, actor.workspaceId, id))!);
  });
}

export async function archiveKnowledge(actor: UserActor, id: string, fetchImpl: typeof fetch = fetch) {
  const row = await withActor(actor, async (db) => {
    const current = await readItem(db, actor.workspaceId, id);
    if (!current) throw new CrmError("not_found", "That item isn't in Knowledge.", 404);
    await db.query("update crm.knowledge_items set archived_at = now(), content = null, chunk_count = 0 where id = $1", [id]);
    await db.query("delete from crm.knowledge_chunks where item_id = $1", [id]);
    await recordAudit(db, actor, "knowledge.removed", "knowledge", id, { operation: "remove_knowledge" }, {
      before: { title: current.title, kind: current.kind, scope: current.scope, companyId: current.company_id },
    });
    return current;
  });
  if (row.file_path && storageConfigured()) {
    await removeObjects([row.file_path], fetchImpl, "knowledge").catch((error) => console.error("Knowledge file cleanup failed", error));
  }
}

export async function readKnowledge(actor: UserActor, id: string, offset = 0) {
  return withActor(actor, async (db) => {
    if (!isUuid(id)) throw new CrmError("not_found", "That item isn't in Knowledge.", 404);
    const result = await db.query<ItemRow & { window: string | null; window_length: number | null }>(
      `select ${ITEM_COLUMNS}, substr(i.content, $3 + 1, $4) as window, char_length(substr(i.content, $3 + 1, $4)) as window_length
       from ${ITEM_FROM}
       where i.id = $1 and i.workspace_id = $2 and i.archived_at is null`,
      [id, actor.workspaceId, Math.max(0, Math.floor(offset)), READ_WINDOW],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "That item isn't in Knowledge.", 404);
    const start = Math.max(0, Math.floor(offset));
    const text = row.window ?? "";
    const end = start + (row.window_length ?? 0);
    return {
      item: mapItem(row),
      offset: start,
      text,
      nextOffset: end < row.char_count ? end : null,
    };
  });
}
