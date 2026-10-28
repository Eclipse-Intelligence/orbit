import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import {
  highlightText,
  READER_CATEGORIES,
  READER_LOCATIONS,
  readerClient,
  readerTags,
  readerText,
  readerUrl,
  ReadwiseError,
  type ReaderCategory,
  type ReaderClient,
  type ReaderDocument,
  type ReaderLocation,
} from "@/lib/readwise";
import { requireReadwiseToken } from "@/lib/readwise/keys";

const LIVE_REQUESTS = 15;
const HIGHLIGHT_PAGES = 14;
const OVERLAP_MS = 5 * 60 * 1000;
export const READER_PART_CHARS = 60_000;
const BREAK_WINDOW = 0.2;

export type ReaderLiveOptions = { fetchImpl?: typeof fetch; deadline?: number; sleep?: (ms: number) => Promise<void> };

export type ReaderListInput = {
  location?: string;
  category?: string;
  tag?: string | string[];
  updatedAfter?: string;
  limit?: number;
  pageCursor?: string;
};

export type ReaderHighlightsInput = { tag?: string; documentId?: string; updatedAfter?: string; limit?: number };

type Highlight = { id: string; documentId: string | null; text: string; note: string | null; tags: string[]; updatedAt: string | null; createdAt: string | null };

function summaryOf(document: ReaderDocument) {
  return {
    id: document.id,
    title: document.title,
    author: document.author,
    url: readerUrl(document),
    readerUrl: document.url,
    siteName: document.site_name,
    category: document.category,
    location: document.location,
    tags: readerTags(document).map((tag) => tag.name),
    summary: document.summary,
    wordCount: document.word_count,
    publishedDate: document.published_date,
    savedAt: document.saved_at,
    updatedAt: document.updated_at,
    parentId: document.parent_id,
  };
}

function highlightOf(item: ReaderDocument): Highlight {
  return {
    id: item.id,
    documentId: item.parent_id,
    text: highlightText(item),
    note: item.notes?.trim() || null,
    tags: readerTags(item).map((tag) => tag.name),
    updatedAt: item.updated_at,
    createdAt: item.created_at,
  };
}

function isoDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) throw new CrmError("invalid_input", "Give the date as YYYY-MM-DD or an ISO date and time.", 400, { field });
  return new Date(time).toISOString();
}

function choice<T extends string>(value: unknown, options: readonly T[], field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
  throw new CrmError("invalid_input", `${field} must be one of ${options.join(", ")}.`, 400, { field });
}

async function client(actor: UserActor, options: ReaderLiveOptions) {
  const token = await requireReadwiseToken(actor);
  return readerClient({ token, fetchImpl: options.fetchImpl, sleep: options.sleep, deadline: options.deadline, maxRequests: LIVE_REQUESTS });
}

async function live<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReadwiseError) throw new CrmError("upstream_error", error.message, 502);
    throw error;
  }
}

function since(document: ReaderDocument) {
  for (const value of [document.saved_at, document.created_at]) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time)) return new Date(time - OVERLAP_MS).toISOString();
  }
  return undefined;
}

async function scan(
  api: ReaderClient,
  filter: (item: ReaderDocument) => boolean,
  params: { updatedAfter?: string; limit?: number },
) {
  const found: Highlight[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < HIGHLIGHT_PAGES; page += 1) {
    if (!api.canRequest()) return { highlights: found, complete: false };
    const body = await api.listPage({ category: "highlight", updatedAfter: params.updatedAfter, pageCursor: cursor, limit: 100 });
    for (const item of body.results) {
      if (!filter(item)) continue;
      found.push(highlightOf(item));
      if (params.limit && found.length >= params.limit) return { highlights: found, complete: !body.nextPageCursor };
    }
    cursor = body.nextPageCursor;
    if (!cursor) return { highlights: found, complete: true };
  }
  return { highlights: found, complete: false };
}

function breakAt(window: string) {
  const floor = Math.floor(window.length * (1 - BREAK_WINDOW));
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= floor) return paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line >= floor) return line + 1;
  let sentence = -1;
  for (const match of window.matchAll(/[.!?…]["'”’)\]]*\s+/g)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= floor) sentence = end;
  }
  if (sentence > 0) return sentence;
  const space = window.lastIndexOf(" ");
  if (space >= floor) return space + 1;
  return window.length;
}

export function readerParts(text: string, size = READER_PART_CHARS) {
  const parts: string[] = [];
  let start = 0;
  while (text.length - start > size) {
    const cut = breakAt(text.slice(start, start + size));
    parts.push(text.slice(start, start + cut));
    start += cut;
  }
  if (start < text.length || parts.length === 0) parts.push(text.slice(start));
  return parts;
}

async function storedHighlights(actor: UserActor, documentId: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ highlights: Record<string, { text: string; note: string | null; updatedAt: string | null }> }>(
      "select highlights from crm.readwise_documents where workspace_id = $1 and user_id = $2 and document_id = $3",
      [actor.workspaceId, actor.userId, documentId],
    );
    return result.rows[0]?.highlights ?? {};
  });
}

export async function readerList(actor: UserActor, input: ReaderListInput, options: ReaderLiveOptions = {}) {
  const location = choice<ReaderLocation>(input.location, READER_LOCATIONS, "location");
  const category = choice<ReaderCategory>(input.category, READER_CATEGORIES, "category");
  const tags = (Array.isArray(input.tag) ? input.tag : input.tag ? [input.tag] : []).map((tag) => tag.trim()).filter(Boolean).slice(0, 5);
  const updatedAfter = isoDate(input.updatedAfter, "updatedAfter");
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 20)));
  const api = await client(actor, options);
  return live(async () => {
    const page = await api.listPage({ location, category, tags, updatedAfter, limit, pageCursor: input.pageCursor || null });
    return { total: page.count, nextPageCursor: page.nextPageCursor, documents: page.results.map(summaryOf) };
  });
}

export async function readerRead(actor: UserActor, documentId: string, part = 1, options: ReaderLiveOptions = {}) {
  const id = documentId.trim();
  if (!id || id.length > 200) throw new CrmError("invalid_input", "Give a Reader document id from reader_list.", 400, { field: "id" });
  if (!Number.isInteger(part) || part < 1) throw new CrmError("invalid_input", "Give a part number from 1.", 400, { field: "part" });
  const api = await client(actor, options);
  return live(async () => {
    const page = await api.listPage({ id, withHtmlContent: true });
    const document = page.results.find((item) => item.id === id);
    if (!document) throw new CrmError("not_found", "That document isn't in your Reader.", 404);
    const text = readerText(document);
    const parts = readerParts(text);
    if (part > parts.length) {
      throw new CrmError("invalid_input", `That document has ${parts.length} ${parts.length === 1 ? "part" : "parts"}. Ask for part 1 to ${parts.length}.`, 400, { field: "part" });
    }
    const reading = {
      document: summaryOf(document),
      part,
      parts: parts.length,
      characters: text.length,
      nextPart: part < parts.length ? part + 1 : null,
    };
    if (part > 1) return { ...reading, text: parts[part - 1] };
    const found = await scan(api, (item) => item.parent_id === id, { updatedAfter: since(document) });
    let highlights = found.highlights;
    if (!found.complete) {
      const known = new Set(highlights.map((item) => item.id));
      const saved = Object.entries(await storedHighlights(actor, id))
        .filter(([key]) => !known.has(key))
        .map(([key, item]) => ({ id: key, documentId: id, text: item.text, note: item.note, tags: [], updatedAt: item.updatedAt, createdAt: null }));
      highlights = [...highlights, ...saved];
    }
    return {
      ...reading,
      notes: document.notes?.trim() || null,
      text: parts[0],
      highlights,
      highlightsComplete: found.complete,
    };
  });
}

export async function readerHighlights(actor: UserActor, input: ReaderHighlightsInput, options: ReaderLiveOptions = {}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50)));
  const updatedAfter = isoDate(input.updatedAfter, "updatedAfter");
  const documentId = input.documentId?.trim() || null;
  const tag = input.tag?.trim() || null;
  const api = await client(actor, options);
  return live(async () => {
    const titles = new Map<string, string | null>();
    let after = updatedAfter;
    let documentsTruncated = false;
    if (documentId) {
      const page = await api.listPage({ id: documentId });
      const document = page.results.find((item) => item.id === documentId);
      if (!document) throw new CrmError("not_found", "That document isn't in your Reader.", 404);
      titles.set(document.id, document.title);
      after = updatedAfter ?? since(document);
    } else if (tag) {
      const tagged = await api.listDocuments({ tags: [tag], limit: 100, pages: 3 });
      for (const document of tagged.results) if (!document.parent_id) titles.set(document.id, document.title);
      documentsTruncated = Boolean(tagged.nextPageCursor);
      if (titles.size === 0) return { highlights: [], complete: !documentsTruncated, documentsTruncated };
    }
    const filter = (item: ReaderDocument) => {
      if (!item.parent_id) return false;
      if (documentId) return item.parent_id === documentId;
      if (tag) return titles.has(item.parent_id);
      return true;
    };
    const found = await scan(api, filter, { updatedAfter: after, limit });
    return {
      highlights: found.highlights.map((item) => ({ ...item, documentTitle: item.documentId ? (titles.get(item.documentId) ?? null) : null })),
      complete: found.complete && !documentsTruncated,
      ...(tag ? { documentsTruncated } : {}),
    };
  });
}
