import { createHash } from "node:crypto";
import { withActor } from "@/lib/crm/context";
import { errorText, timeLeft } from "@/lib/crm/conversations";
import { recordAudit } from "@/lib/crm/mutate";
import type { Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { scheduleIndexing } from "@/lib/knowledge/background";
import { CONTENT_LIMIT, insertItem, type KnowledgeTarget } from "@/lib/knowledge/store";
import {
  hasReaderTag,
  highlightText,
  readerClient,
  readerTags,
  readerText,
  readerUrl,
  ReadwiseError,
  type ReaderClient,
  type ReaderDocument,
} from "@/lib/readwise";
import { decryptToken, READWISE_NOT_CONNECTED, readReadwiseKey, type ReadwiseKeyRow } from "@/lib/readwise/keys";

const ORBIT_TAG = "orbit";
const FULL_EVERY_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 15;
const STEP_RESERVE_MS = 3_000;
const MAX_DOCUMENT_PAGES = 20;

export type ReaderSyncOptions = {
  deadline?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  full?: boolean;
  maxRequests?: number;
  index?: (actor: UserActor, ids: string[]) => void;
};

export type ReaderSyncResult = {
  ran: boolean;
  documents: number;
  added: number;
  updated: number;
  archived: number;
  highlights: number;
  complete: boolean;
  error?: string;
};

type StoredHighlight = { text: string; note: string | null; offset: number | null; updatedAt: string | null; seen: string };

type DocumentRow = {
  id: string;
  document_id: string;
  knowledge_item_id: string | null;
  highlights: Record<string, StoredHighlight>;
  content_hash: string | null;
  dirty: boolean;
};

type Company = { id: string; name: string; domain: string | null };

const PROVENANCE = (sourceUrl: string | null): Provenance => ({ operation: "sync_readwise", source: "readwise", sourceUrl });

function readerSourceRef(documentId: string) {
  return `reader:${documentId}`;
}

function normalise(value: string) {
  return value.toLowerCase().replace(/^www\./, "").replace(/[\s_-]+/g, " ").trim();
}

export function matchCompany(tags: { key: string; name: string }[], companies: Company[]): string | null {
  const names = new Map<string, string>();
  for (const company of companies) {
    const keys = [company.name, company.domain ?? ""].map(normalise).filter(Boolean);
    for (const key of keys) if (!names.has(key)) names.set(key, company.id);
  }
  for (const tag of tags) {
    if (normalise(tag.key) === ORBIT_TAG || normalise(tag.name) === ORBIT_TAG) continue;
    const found = names.get(normalise(tag.name)) ?? names.get(normalise(tag.key));
    if (found) return found;
  }
  return null;
}

function cleanTitle(document: ReaderDocument) {
  const raw = document.title?.trim() || readerUrl(document)?.replace(/^https?:\/\/(www\.)?/i, "") || "Reader document";
  return raw.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || "Reader document";
}

function highlightOrder(a: StoredHighlight, b: StoredHighlight) {
  if (a.offset !== null && b.offset !== null && a.offset !== b.offset) return a.offset - b.offset;
  return (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
}

function readerContent(document: ReaderDocument, highlights: StoredHighlight[]) {
  const url = readerUrl(document);
  const tags = readerTags(document)
    .map((tag) => tag.name)
    .filter((name) => normalise(name) !== ORBIT_TAG);
  const header = [
    cleanTitle(document),
    document.author?.trim() ? `By ${document.author.trim()}` : null,
    url ? `Source: ${url}` : null,
    document.site_name?.trim() ? `Site: ${document.site_name.trim()}` : null,
    tags.length ? `Tags: ${tags.join(", ")}` : null,
  ].filter(Boolean);
  const parts = [header.join("\n")];
  if (document.summary?.trim()) parts.push(`Summary:\n${document.summary.trim()}`);
  if (document.notes?.trim()) parts.push(`Note:\n${document.notes.trim()}`);
  const text = readerText(document);
  if (text) parts.push(text);
  const sorted = [...highlights].sort(highlightOrder);
  if (sorted.length) {
    parts.push(
      `Highlights:\n${sorted.map((item) => `- ${item.text.replace(/\s+/g, " ").trim()}${item.note?.trim() ? `\n  Note: ${item.note.trim()}` : ""}`).join("\n")}`,
    );
  }
  return parts.join("\n\n").slice(0, CONTENT_LIMIT);
}

function stored(highlight: ReaderDocument, seen: string): StoredHighlight {
  return {
    text: highlightText(highlight),
    note: highlight.notes?.trim() || null,
    offset: typeof highlight.highlight_offset === "number" ? highlight.highlight_offset : null,
    updatedAt: highlight.updated_at ?? null,
    seen,
  };
}

function sameHighlight(a: StoredHighlight | undefined, b: StoredHighlight) {
  return Boolean(a) && a!.text === b.text && a!.note === b.note && a!.offset === b.offset;
}

function orbitTagStamp(document: ReaderDocument) {
  const value = document.tags;
  if (!value || typeof value !== "object") return null;
  const entries: [string | null, unknown][] = Array.isArray(value) ? value.map((item) => [null, item]) : Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    const details = item && typeof item === "object" ? (item as { key?: unknown; name?: unknown; created?: unknown }) : {};
    const names = [key, details.key, details.name, typeof item === "string" ? item : null];
    if (!names.some((name) => typeof name === "string" && normalise(name) === ORBIT_TAG)) continue;
    return typeof details.created === "number" || typeof details.created === "string" ? String(details.created) : null;
  }
  return null;
}

function hashOf(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function documentRows(db: Db, keyId: string) {
  const result = await db.query<DocumentRow>(
    "select id, document_id, knowledge_item_id, highlights, content_hash, dirty from crm.readwise_documents where key_id = $1",
    [keyId],
  );
  return new Map(result.rows.map((row) => [row.document_id, row]));
}

async function archiveItem(db: Db, actor: UserActor, itemId: string, sourceUrl: string | null) {
  const archived = await db.query<{ title: string; scope: string; company_id: string | null }>(
    `update crm.knowledge_items set archived_at = now(), content = null, chunk_count = 0
     where id = $1 and workspace_id = $2 and archived_at is null
     returning title, scope, company_id`,
    [itemId, actor.workspaceId],
  );
  const row = archived.rows[0];
  if (!row) return false;
  await db.query("delete from crm.knowledge_chunks where item_id = $1", [itemId]);
  await recordAudit(db, actor, "knowledge.removed", "knowledge", itemId, PROVENANCE(sourceUrl), {
    before: { title: row.title, kind: "reader", scope: row.scope, companyId: row.company_id },
  });
  return true;
}

async function dropDocument(actor: UserActor, row: DocumentRow) {
  return withActor(actor, async (db) => {
    const archived = row.knowledge_item_id ? await archiveItem(db, actor, row.knowledge_item_id, null) : false;
    await db.query("delete from crm.readwise_documents where id = $1", [row.id]);
    return archived;
  });
}

async function companies(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<Company>(
      "select id, name, domain from crm.companies where workspace_id = $1 and archived_at is null order by created_at",
      [actor.workspaceId],
    );
    return result.rows;
  });
}

async function fileDocument(
  actor: UserActor,
  keyId: string,
  row: DocumentRow,
  document: ReaderDocument,
  list: Company[],
): Promise<{ outcome: "added" | "updated" | "unchanged" | "removed"; itemId: string | null }> {
  const companyId = matchCompany(readerTags(document), list);
  const target: KnowledgeTarget = companyId ? { companyId } : { eclipse: true };
  const title = cleanTitle(document);
  const url = readerUrl(document);
  const content = readerContent(document, Object.values(row.highlights));
  const hash = hashOf([title, url, companyId, content, orbitTagStamp(document)]);
  return withActor(actor, async (db) => {
    let itemId = row.knowledge_item_id;
    if (!itemId && row.content_hash === hash) {
      await db.query("update crm.readwise_documents set dirty = false where id = $1", [row.id]);
      return { outcome: "unchanged" as const, itemId: null };
    }
    if (itemId) {
      const current = await db.query<{ archived: boolean }>(
        "select archived_at is not null as archived from crm.knowledge_items where id = $1 and workspace_id = $2",
        [itemId, actor.workspaceId],
      );
      if (!current.rows[0] || current.rows[0].archived) {
        await db.query("update crm.readwise_documents set knowledge_item_id = null, dirty = false, content_hash = $2 where id = $1", [row.id, hash]);
        return { outcome: "removed" as const, itemId: null };
      }
      if (row.content_hash === hash) {
        await db.query("update crm.readwise_documents set dirty = false where id = $1", [row.id]);
        return { outcome: "unchanged" as const, itemId };
      }
    }
    let outcome: "added" | "updated" = "updated";
    if (!itemId) {
      const inserted = await insertItem(
        db,
        actor,
        { target, kind: "reader", title, status: "pending", content, sourceRef: readerSourceRef(document.id), sourceUrl: url },
        PROVENANCE(url),
      );
      itemId = inserted.id;
      outcome = inserted.created ? "added" : "updated";
    }
    if (outcome === "updated") {
      const before = await db.query<{ title: string; scope: string; company_id: string | null }>(
        "select title, scope, company_id from crm.knowledge_items where id = $1",
        [itemId],
      );
      await db.query(
        `update crm.knowledge_items
         set title = $2, source_url = $3, scope = $4, company_id = $5, kind = 'reader', content = $6,
           char_count = char_length($6), status = 'pending', error = null
         where id = $1`,
        [itemId, title, url, companyId ? "company" : "eclipse", companyId, content],
      );
      await recordAudit(db, actor, "knowledge.updated", "knowledge", itemId, PROVENANCE(url), {
        before: { title: before.rows[0]?.title, scope: before.rows[0]?.scope, companyId: before.rows[0]?.company_id ?? null },
        after: { title, scope: companyId ? "company" : "eclipse", companyId },
      });
    }
    await db.query(
      "update crm.readwise_documents set knowledge_item_id = $2, content_hash = $3, dirty = false where id = $1 and key_id = $4",
      [row.id, itemId, hash, keyId],
    );
    return { outcome, itemId };
  });
}

async function claim(actor: UserActor, keyId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query(
      `update crm.readwise_keys set sync_started_at = now()
       where id = $1 and (sync_started_at is null or sync_started_at < now() - interval '5 minutes')
       returning id`,
      [keyId],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

type PassState = Partial<Record<"updated_after" | "full_sync_at" | "scan_cursor" | "scan_since" | "scan_started_at" | "list_cursor", string | null>> &
  Partial<Record<"scan_full" | "list_full" | "list_done", boolean>>;

const PASS_RESET: PassState = {
  scan_cursor: null,
  scan_since: null,
  scan_started_at: null,
  scan_full: false,
  list_cursor: null,
  list_full: false,
  list_done: false,
};

async function saveState(actor: UserActor, keyId: string, state: PassState) {
  const entries = Object.entries(state);
  if (entries.length === 0) return;
  const sets = entries.map(([column], index) => `${column} = $${index + 2}`);
  await withActor(actor, (db) =>
    db.query(`update crm.readwise_keys set ${sets.join(", ")} where id = $1`, [keyId, ...entries.map(([, value]) => value)]),
  );
}

async function finish(actor: UserActor, keyId: string, error: string | null) {
  await withActor(actor, (db) =>
    db.query(
      error
        ? "update crm.readwise_keys set sync_started_at = null, last_error = $2, last_error_at = now() where id = $1"
        : "update crm.readwise_keys set sync_started_at = null, last_sync_at = now(), last_error = null, last_error_at = null where id = $1",
      error ? [keyId, error.slice(0, 500)] : [keyId],
    ),
  );
}

function iso(value: Date | null, minus = 0) {
  return value ? new Date(value.getTime() - minus).toISOString() : null;
}

async function upsertDocuments(actor: UserActor, keyId: string, documents: ReaderDocument[], listedAt: string) {
  if (documents.length === 0) return;
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.readwise_documents (key_id, workspace_id, user_id, document_id, dirty, backfill_from, listed_at)
       select $1, $2, $3, source.id, true, source.since, $6
       from unnest($4::text[], $5::timestamptz[]) as source (id, since)
       on conflict (workspace_id, user_id, document_id) do update set dirty = true, key_id = excluded.key_id, listed_at = excluded.listed_at`,
      [keyId, actor.workspaceId, actor.userId, documents.map((item) => item.id), documents.map(savedFrom), listedAt],
    ),
  );
}

async function unlistedRows(actor: UserActor, keyId: string, listedAt: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<DocumentRow>(
      `select id, document_id, knowledge_item_id, highlights, content_hash, dirty from crm.readwise_documents
       where key_id = $1 and (listed_at is null or listed_at < $2::timestamptz)`,
      [keyId, listedAt],
    );
    return result.rows;
  });
}

function taggedDocuments(results: ReaderDocument[]) {
  return results.filter((document) => !document.parent_id && hasReaderTag(document, ORBIT_TAG));
}

type ListOutcome = { done: boolean; cursor: string | null; documents: Map<string, ReaderDocument>; error?: unknown };

async function listTagged(
  actor: UserActor,
  keyId: string,
  api: ReaderClient,
  pass: { since: string | null; cursor: string | null; listedAt: string },
  deadline: number | undefined,
): Promise<ListOutcome> {
  const documents = new Map<string, ReaderDocument>();
  let cursor = pass.cursor;
  for (let page = 0; page < MAX_DOCUMENT_PAGES; page += 1) {
    if (!api.canRequest() || !timeLeft(deadline, STEP_RESERVE_MS)) return { done: false, cursor, documents };
    let body;
    try {
      body = await api.listPage({ tags: [ORBIT_TAG], withHtmlContent: true, updatedAfter: pass.since ?? undefined, pageCursor: cursor, limit: 100 });
    } catch (error) {
      return { done: false, cursor, documents, error };
    }
    const found = taggedDocuments(body.results);
    for (const document of found) documents.set(document.id, document);
    await upsertDocuments(actor, keyId, found, pass.listedAt);
    cursor = body.nextPageCursor;
    if (!cursor) return { done: true, cursor: null, documents };
  }
  return { done: false, cursor, documents };
}

function expiredCursor(error: unknown, cursor: string | null, resumed: string | null) {
  return error instanceof ReadwiseError && error.status === 400 && cursor !== null && cursor === resumed;
}

function savedFrom(document: ReaderDocument) {
  for (const value of [document.saved_at, document.created_at]) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time)) return new Date(time - OVERLAP_MS).toISOString();
  }
  return new Date(0).toISOString();
}

async function claimBackfill(actor: UserActor, keyId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ since: Date | null }>(
      `with pending as (
         select id, backfill_from from crm.readwise_documents where key_id = $1 and backfill_from is not null for update
       ), cleared as (
         update crm.readwise_documents d set backfill_from = null from pending p where d.id = p.id returning p.backfill_from
       )
       select min(backfill_from) as since from cleared`,
      [keyId],
    );
    return result.rows[0]?.since ?? null;
  });
}

function earliest(a: string | null, b: Date | null) {
  if (!b) return a;
  if (!a) return null;
  return b.getTime() < Date.parse(a) ? b.toISOString() : a;
}

type ScanOutcome = { done: boolean; cursor: string | null; seen: number; error?: unknown };

async function scanHighlights(
  actor: UserActor,
  key: ReadwiseKeyRow,
  api: ReaderClient,
  pass: { since: string | null; startedAt: string; full: boolean; cursor: string | null },
  deadline: number | undefined,
): Promise<ScanOutcome> {
  let cursor = pass.cursor;
  let seenCount = 0;
  const known = await withActor(actor, (db) => documentRows(db, key.id));
  for (;;) {
    if (!api.canRequest() || !timeLeft(deadline, STEP_RESERVE_MS)) return { done: false, cursor, seen: seenCount };
    let page;
    try {
      page = await api.listPage({ category: "highlight", updatedAfter: pass.since ?? undefined, pageCursor: cursor, limit: 100 });
    } catch (error) {
      return { done: false, cursor, seen: seenCount, error };
    }
    const touched = new Map<string, DocumentRow>();
    for (const highlight of page.results) {
      const parent = highlight.parent_id ? known.get(highlight.parent_id) : undefined;
      if (!parent) continue;
      seenCount += 1;
      const next = stored(highlight, pass.startedAt);
      if (!sameHighlight(parent.highlights[highlight.id], next)) parent.dirty = true;
      parent.highlights = { ...parent.highlights, [highlight.id]: next };
      touched.set(parent.id, parent);
    }
    if (touched.size > 0) {
      await withActor(actor, async (db) => {
        for (const row of touched.values()) {
          await db.query("update crm.readwise_documents set highlights = $2::jsonb, dirty = dirty or $3 where id = $1", [
            row.id,
            JSON.stringify(row.highlights),
            row.dirty,
          ]);
        }
      });
    }
    cursor = page.nextPageCursor;
    if (!cursor) break;
  }
  if (pass.full) {
    await withActor(actor, async (db) => {
      const rows = await documentRows(db, key.id);
      for (const row of rows.values()) {
        const kept = Object.fromEntries(Object.entries(row.highlights).filter(([, item]) => item.seen >= pass.startedAt));
        if (Object.keys(kept).length === Object.keys(row.highlights).length) continue;
        await db.query("update crm.readwise_documents set highlights = $2::jsonb, dirty = true where id = $1", [row.id, JSON.stringify(kept)]);
      }
    });
  }
  return { done: true, cursor: null, seen: seenCount };
}

export async function syncReaderToKnowledge(actor: UserActor, options: ReaderSyncOptions = {}): Promise<ReaderSyncResult> {
  const result: ReaderSyncResult = { ran: false, documents: 0, added: 0, updated: 0, archived: 0, highlights: 0, complete: false };
  const key = await readReadwiseKey(actor);
  if (!key) return { ...result, error: READWISE_NOT_CONNECTED };
  const token = decryptToken(key);
  if (!token) {
    const message = "Orbit couldn't read the saved Readwise token. Connect Readwise Reader again.";
    await finish(actor, key.id, message);
    return { ...result, error: message };
  }
  if (!(await claim(actor, key.id))) return result;
  result.ran = true;
  const api = readerClient({ token, fetchImpl: options.fetchImpl, sleep: options.sleep, deadline: options.deadline, maxRequests: options.maxRequests ?? MAX_REQUESTS });
  const toIndex: string[] = [];
  try {
    const now = new Date();
    const inPass = Boolean(key.scan_started_at);
    const restart = inPass && Boolean(options.full) && !key.list_full;
    const resuming = inPass && !restart;
    const full = resuming ? key.scan_full : !key.updated_after || !key.full_sync_at || now.getTime() - key.full_sync_at.getTime() > FULL_EVERY_MS;
    const listFull = resuming ? key.list_full : Boolean(options.full) || full;
    const startedAt = resuming ? key.scan_started_at! : now;
    const listedAt = startedAt.toISOString();
    let highlightSince = resuming ? iso(key.scan_since) : full ? null : earliest(iso(key.updated_after, OVERLAP_MS), restart ? key.scan_since : null);
    if (!resuming) {
      await saveState(actor, key.id, { ...PASS_RESET, scan_started_at: listedAt, scan_full: full, scan_since: highlightSince, list_full: listFull });
    }

    let listDone = resuming && key.list_done;
    let documents = new Map<string, ReaderDocument>();
    if (!listDone) {
      const resumedList = resuming ? key.list_cursor : null;
      const listed = await listTagged(
        actor,
        key.id,
        api,
        { since: listFull ? null : iso(key.updated_after, OVERLAP_MS), cursor: resumedList, listedAt },
        options.deadline,
      );
      documents = listed.documents;
      if (listed.error) {
        await saveState(actor, key.id, expiredCursor(listed.error, listed.cursor, resumedList) ? { ...PASS_RESET, full_sync_at: null } : { list_cursor: listed.cursor });
        throw listed.error;
      }
      if (listed.done) {
        if (listFull) {
          for (const row of await unlistedRows(actor, key.id, listedAt)) {
            if (await dropDocument(actor, row)) result.archived += 1;
          }
        }
        const backfill = await claimBackfill(actor, key.id);
        if (!full) highlightSince = earliest(highlightSince, backfill);
        await saveState(actor, key.id, { list_cursor: null, list_done: true, scan_since: highlightSince });
        listDone = true;
      } else {
        await saveState(actor, key.id, { list_cursor: listed.cursor });
      }
    } else if (api.canRequest() && timeLeft(options.deadline, STEP_RESERVE_MS)) {
      const recent = await api.listPage({ tags: [ORBIT_TAG], withHtmlContent: true, updatedAfter: iso(startedAt, OVERLAP_MS)!, limit: 100 });
      const found = taggedDocuments(recent.results);
      for (const document of found) documents.set(document.id, document);
      await upsertDocuments(actor, key.id, found, listedAt);
    }
    result.documents = documents.size;

    let scanDone = false;
    if (listDone) {
      const resumedCursor = resuming ? key.scan_cursor : null;
      const scan = await scanHighlights(actor, key, api, { since: highlightSince, startedAt: listedAt, full, cursor: resumedCursor }, options.deadline);
      result.highlights = scan.seen;
      if (scan.error) {
        await saveState(actor, key.id, expiredCursor(scan.error, scan.cursor, resumedCursor) ? { ...PASS_RESET, full_sync_at: null } : { scan_cursor: scan.cursor });
        throw scan.error;
      }
      if (scan.done) {
        await saveState(actor, key.id, { ...PASS_RESET, updated_after: listedAt, ...(full ? { full_sync_at: listedAt } : {}) });
      } else {
        await saveState(actor, key.id, { scan_cursor: scan.cursor });
      }
      scanDone = scan.done;
    }

    const list = await companies(actor);
    const rows = await withActor(actor, (db) => documentRows(db, key.id));
    let pending = false;
    for (const row of rows.values()) {
      if (!row.dirty && !documents.has(row.document_id)) continue;
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
        pending = true;
        break;
      }
      let document = documents.get(row.document_id) ?? null;
      if (!document) {
        if (!api.canRequest()) {
          pending = true;
          continue;
        }
        const fetched = await api.listPage({ id: row.document_id, withHtmlContent: true });
        document = fetched.results.find((item) => item.id === row.document_id) ?? null;
        if (!document || !hasReaderTag(document, ORBIT_TAG)) {
          if (await dropDocument(actor, row)) result.archived += 1;
          continue;
        }
      }
      const filed = await fileDocument(actor, key.id, row, document, list);
      if (filed.outcome === "added") result.added += 1;
      if (filed.outcome === "updated") result.updated += 1;
      if ((filed.outcome === "added" || filed.outcome === "updated") && filed.itemId) toIndex.push(filed.itemId);
    }
    result.complete = listDone && scanDone && !pending;
    await finish(actor, key.id, null);
  } catch (error) {
    const message = errorText(error, "Couldn't sync Readwise Reader.");
    await finish(actor, key.id, message).catch(() => undefined);
    result.error = message;
  }
  (options.index ?? scheduleIndexing)(actor, toIndex);
  return result;
}
