import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { readYouTube, youtubeId } from "@/lib/knowledge/media";
import { CONTENT_LIMIT, READ_WINDOW } from "@/lib/knowledge/store";
import { RECALL_MAX_CHUNKS, RECALL_MAX_TAGS, recallClient, type RecallChunk, type RecallClient, type RecallTag } from "@/lib/recall";
import { requireRecallKey, saveTagProbe, tagProbeDue, type RecallKeyRow } from "@/lib/recall/keys";
import type { Renderer } from "@/lib/browserbase";
import { readWebPage, type Lookup } from "@/lib/web-page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERIES = 3;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

export const SEARCH_NOTE =
  "These are the passages Recall matched, not whole cards. Read more of a card with recall_read, or its original with recall_read full: true.";
export const TAG_IDS_ONLY =
  "Recall's API filters by tag id, not by name, and has no way for Orbit to look tag names up. Ask the user for the tag id (Settings, Integrations, Recall says where to find it), or search without tags.";

export type RecallLiveOptions = {
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  render?: Renderer | null;
  deadline?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type RecallSearchInput = {
  query?: string | string[];
  mode?: string;
  cardId?: string;
  tags?: string[];
  from?: string;
  to?: string;
  site?: string;
  limit?: number;
};

export type RecallReadInput = { cardId: string; focusQuery?: string; maxChunks?: number; full?: boolean; offset?: number };

export type Passage = { text: string; source?: string; timestamps?: string[] };

export type RecallCardOut = { cardId: string; title: string | null; createdAt: string | null; sourceUrl: string | null };

export type RecallSearchResult = {
  note: string;
  cards: (RecallCardOut & { passages?: Passage[]; notebook?: Passage[] })[];
  total?: number;
  shown?: number;
  truncated?: boolean;
  totalCards?: number;
};

export type RecallReadResult = {
  card: RecallCardOut;
  note: string;
  full?: boolean;
  excerpts?: boolean;
  order?: "time" | "page" | "relevance";
  content?: Passage[];
  notebook?: Passage[];
  originalError?: string;
  original?: { url: string; kind: "article" | "youtube"; title: string | null };
  offset?: number;
  characters?: number;
  text?: string;
  nextOffset?: number | null;
};

function bounded(value: string | undefined, max: number, field: string, label: string) {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > max) throw new CrmError("invalid_input", `${label} can be up to ${max} characters.`, 400, { field });
  return text;
}

function dateFilter(value: string | undefined, field: string, endOfDay: boolean) {
  const text = value?.trim();
  if (!text) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const time = Date.parse(dateOnly ? `${text}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : text);
  if (!Number.isFinite(time)) throw new CrmError("invalid_input", "Give dates as YYYY-MM-DD or an ISO date and time.", 400, { field });
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cardIdOf(value: string | undefined, field: string) {
  return bounded(value, 128, field, "A Recall card id");
}

function sourceUrl(value: string | undefined) {
  return value && /^https?:\/\//i.test(value) ? value.slice(0, 2000) : null;
}

function cardSummary(card: { card_id?: string; id?: string; title?: string | null; created_at?: string | null; source_url?: string }): RecallCardOut {
  return { cardId: card.card_id ?? card.id ?? "", title: card.title ?? null, createdAt: card.created_at ?? null, sourceUrl: sourceUrl(card.source_url) };
}

function passage(chunk: RecallChunk): Passage {
  const source = chunk.source && chunk.source !== "reader" && chunk.source !== "notebook" ? chunk.source : undefined;
  return {
    text: (chunk.content ?? "").trim(),
    ...(source ? { source } : {}),
    ...(chunk.timestamps?.length ? { timestamps: chunk.timestamps } : {}),
  };
}

function seconds(stamp: string) {
  const parts = stamp.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function pageNumber(source: string | undefined) {
  const match = source?.match(/\bpage\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function orderChunks(chunks: RecallChunk[]) {
  const timed = chunks.map((chunk) => (chunk.timestamps?.length ? seconds(chunk.timestamps[0]) : null));
  if (chunks.length > 1 && timed.every((value) => value !== null)) {
    return { order: "time" as const, chunks: chunks.map((chunk, index) => ({ chunk, key: timed[index]! })).sort((a, b) => a.key - b.key).map((item) => item.chunk) };
  }
  const pages = chunks.map((chunk) => pageNumber(chunk.source));
  if (chunks.length > 1 && pages.every((value) => value !== null)) {
    return { order: "page" as const, chunks: chunks.map((chunk, index) => ({ chunk, key: pages[index]! })).sort((a, b) => a.key - b.key).map((item) => item.chunk) };
  }
  return { order: "relevance" as const, chunks };
}

async function connect(actor: UserActor, options: RecallLiveOptions) {
  const { row, apiKey } = await requireRecallKey(actor);
  return { row, api: recallClient({ apiKey, fetchImpl: options.fetchImpl, sleep: options.sleep, deadline: options.deadline }) };
}

function tagLabel(tag: RecallTag) {
  return tag.path === tag.name ? tag.name : tag.path;
}

async function resolveTags(actor: UserActor, row: RecallKeyRow, api: RecallClient, wanted: string[]) {
  const tags = [...new Set(wanted.map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > RECALL_MAX_TAGS) throw new CrmError("invalid_input", `Recall filters by up to ${RECALL_MAX_TAGS} tags at once.`, 400, { field: "tags" });
  if (tags.length === 0) return [];
  let path = row.tags_path;
  let known: RecallTag[] | null = null;
  if (tagProbeDue(row)) {
    try {
      const probe = await api.probeTags();
      path = probe.path;
      known = probe.path ? probe.tags : null;
      await saveTagProbe(actor, probe.path);
    } catch (error) {
      if (error instanceof CrmError && error.code === "upstream_unauthorized") throw error;
    }
  }
  const names = tags.filter((tag) => !UUID.test(tag));
  if (names.length === 0) return tags;
  if (!path) throw new CrmError("invalid_input", TAG_IDS_ONLY, 400, { field: "tags" });
  const list = known ?? (await api.listTags(path));
  const ids = new Set(tags.filter((tag) => UUID.test(tag)));
  for (const name of names) {
    const lower = name.toLowerCase();
    const match = list.find((tag) => tag.id === name || tag.path.toLowerCase() === lower) ?? list.find((tag) => tag.name.toLowerCase() === lower);
    if (!match) {
      const shown = list.slice(0, 40).map(tagLabel).join(", ");
      throw new CrmError("invalid_input", `Recall has no tag called ${name}.${shown ? ` Its tags are: ${shown}${list.length > 40 ? " and more" : ""}.` : ""}`, 400, { field: "tags" });
    }
    ids.add(match.id);
  }
  return [...ids];
}

function queriesOf(value: string | string[] | undefined) {
  const list = (Array.isArray(value) ? value : value ? [value] : []).map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length > MAX_QUERIES) throw new CrmError("invalid_input", `Give up to ${MAX_QUERIES} phrasings of the query.`, 400, { field: "query" });
  for (const query of unique) bounded(query, 1000, "query", "Each query");
  return unique;
}

export async function recallSearch(actor: UserActor, input: RecallSearchInput, options: RecallLiveOptions = {}): Promise<RecallSearchResult> {
  const queries = queriesOf(input.query);
  const mode = input.mode?.trim() || undefined;
  if (mode && mode !== "focused" && mode !== "exhaustive") throw new CrmError("invalid_input", "mode must be focused or exhaustive.", 400, { field: "mode" });
  const cardId = cardIdOf(input.cardId, "cardId");
  const site = bounded(input.site, 500, "site", "site");
  const dateFrom = dateFilter(input.from, "from", false);
  const dateTo = dateFilter(input.to, "to", true);
  if (dateFrom && dateTo && dateFrom > dateTo) throw new CrmError("invalid_input", "from must be on or before to.", 400, { field: "from" });
  if (queries.length === 0 && cardId) throw new CrmError("invalid_input", "To read one card, use recall_read with its cardId, or give a query to search inside it.", 400, { field: "cardId" });
  const { row, api } = await connect(actor, options);
  const tags = await resolveTags(actor, row, api, input.tags ?? []);
  const filters = { tags, dateFrom, dateTo, site };

  if (queries.length === 0) {
    const limit = Math.min(LIST_MAX, Math.max(1, Math.trunc(input.limit ?? LIST_DEFAULT)));
    const listed = await api.listCards(filters);
    const cards = listed.cards.slice(0, limit).map(cardSummary);
    return {
      total: listed.total,
      shown: cards.length,
      truncated: listed.cards.length > cards.length,
      cards,
      note: "Card titles only. Search inside them with a query, or read one with recall_read.",
    };
  }

  const results = await Promise.all(queries.map((query) => api.search(query, { ...filters, mode: mode as "focused" | "exhaustive" | undefined, cardId })));
  const merged = new Map<string, { card: RecallCardOut; passages: Passage[]; notebook: Passage[]; seen: Set<string> }>();
  for (const result of results) {
    for (const document of result.documents) {
      let entry = merged.get(document.card_id);
      if (!entry) {
        entry = { card: cardSummary(document), passages: [], notebook: [], seen: new Set() };
        merged.set(document.card_id, entry);
      }
      for (const chunk of document.chunks) {
        const key = chunk.chunk_id ?? chunk.content ?? "";
        if (entry.seen.has(key)) continue;
        entry.seen.add(key);
        (chunk.source === "notebook" ? entry.notebook : entry.passages).push(passage(chunk));
      }
    }
  }
  return {
    note: SEARCH_NOTE,
    totalCards: Math.max(...results.map((result) => result.totalCards), merged.size),
    cards: [...merged.values()].map((entry) => ({
      ...entry.card,
      passages: entry.passages,
      ...(entry.notebook.length ? { notebook: entry.notebook } : {}),
    })),
  };
}

function excerptNote(url: string | null) {
  return url
    ? `These are excerpts Recall chose, not the full text. The original is at ${url}. To read it end to end, call recall_read again with full: true.`
    : "These are excerpts Recall chose, not the full text. This card has no source link (it's a note or an uploaded file), so only excerpts are available.";
}

async function original(url: string, options: RecallLiveOptions) {
  if (youtubeId(url)) {
    const video = await readYouTube(url, { fetchImpl: options.fetchImpl, lookup: options.lookup, deadline: options.deadline });
    return { kind: "youtube" as const, title: video.title, text: video.text };
  }
  const page = await readWebPage(url, { fetchImpl: options.fetchImpl, lookup: options.lookup, textMax: CONTENT_LIMIT, render: options.render });
  return { kind: "article" as const, title: page.title, text: page.text };
}

export async function recallRead(actor: UserActor, input: RecallReadInput, options: RecallLiveOptions = {}): Promise<RecallReadResult> {
  const cardId = cardIdOf(input.cardId, "cardId");
  if (!cardId) throw new CrmError("invalid_input", "Give a Recall card id from recall_search.", 400, { field: "cardId" });
  const focusQuery = bounded(input.focusQuery, 1000, "focusQuery", "focusQuery");
  const maxChunks = Math.min(RECALL_MAX_CHUNKS, Math.max(1, Math.trunc(input.maxChunks ?? RECALL_MAX_CHUNKS)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const { api } = await connect(actor, options);
  const card = await api.getCard(cardId, { focusQuery, maxChunks: input.full && offset > 0 ? 1 : maxChunks });
  const summary = cardSummary(card);
  const notebook = card.chunks.filter((chunk) => chunk.source === "notebook").map(passage);
  const content = card.chunks.filter((chunk) => chunk.source !== "notebook");
  const ordered = focusQuery ? { order: "relevance" as const, chunks: content } : orderChunks(content);
  const excerpts: RecallReadResult = {
    card: summary,
    excerpts: true,
    note: excerptNote(summary.sourceUrl),
    order: ordered.order,
    content: ordered.chunks.map(passage),
    notebook,
  };
  if (!input.full) return excerpts;
  if (!summary.sourceUrl) return { ...excerpts, full: false };
  let read: Awaited<ReturnType<typeof original>>;
  try {
    read = await original(summary.sourceUrl, options);
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message.slice(0, 200).replace(/\.$/, "")})` : "";
    return {
      ...excerpts,
      full: false,
      originalError: `Couldn't open the original at ${summary.sourceUrl}${reason}. Only Recall's excerpts are below, not the full text.`,
    };
  }
  const total = read.text.length;
  if (offset > 0 && offset >= total) {
    throw new CrmError("invalid_input", `The original has ${total} characters. Give an offset below ${total}.`, 400, { field: "offset" });
  }
  const end = Math.min(total, offset + READ_WINDOW);
  return {
    card: summary,
    full: true,
    original: { url: summary.sourceUrl, kind: read.kind, title: read.title },
    note: "The original, read live from its source and not stored in Orbit. For a full review, keep calling with offset: nextOffset until nextOffset is null.",
    offset,
    characters: total,
    text: read.text.slice(offset, end),
    nextOffset: end < total ? end : null,
    ...(offset === 0 ? { notebook } : {}),
  };
}
