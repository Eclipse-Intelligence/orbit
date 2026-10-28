import { CrmError } from "@/lib/crm/errors";

export const RECALL_BASE_URL = "https://backend.getrecall.ai/api/v1";
export const RECALL_TAG_PATHS = ["/tags", "/tags/", "/cards/tags"] as const;
export const RECALL_MAX_CHUNKS = 50;
export const RECALL_MAX_TAGS = 50;
const TIMEOUT_MS = 20_000;
const RETRY_WAIT_MS = 1_500;
const MAX_RETRY_WAIT_MS = 10_000;
const UNREADABLE = "Recall sent a reply Orbit couldn't read. Try again in a few minutes.";
export const RECALL_REJECTED =
  "Recall rejected the key. It may have expired or been revoked. Create a new key in Recall (Settings, API & MCP) and connect it again in Orbit's Settings, Integrations.";

export type RecallChunk = { chunk_id?: string; content?: string; source?: string; timestamps?: string[] };

export type RecallCardSummary = { id: string; title?: string | null; created_at?: string | null; image?: string; source_url?: string };

export type RecallCard = {
  card_id: string;
  title?: string | null;
  chunks: RecallChunk[];
  created_at?: string | null;
  image?: string;
  source_url?: string;
};

export type RecallSearchDocument = {
  card_id: string;
  title?: string | null;
  created_at?: string | null;
  image?: string;
  source_url?: string;
  chunks: RecallChunk[];
};

export type RecallFilters = { tags?: string[]; dateFrom?: string; dateTo?: string; site?: string };

export type RecallTag = { id: string; name: string; path: string };

export type RecallClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadline?: number;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function retryWait(response: Response) {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  return RETRY_WAIT_MS;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recallDetail(body: unknown) {
  const detail = record(body)?.detail;
  if (typeof detail === "string") return detail.trim() || null;
  const message = text(record(detail)?.message);
  if (message) return message;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        const entry = record(item);
        const msg = text(entry?.msg) ?? text(entry?.message);
        if (!msg) return null;
        const field = Array.isArray(entry?.loc)
          ? entry.loc.filter((part) => typeof part === "string" && !["query", "path", "body"].includes(part)).join(".")
          : "";
        return field ? `${field}: ${msg}` : msg;
      })
      .filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }
  return null;
}

function requestId(body: unknown) {
  const top = record(body);
  return text(top?.request_id) ?? text(record(top?.detail)?.request_id);
}

function chunksOf(value: unknown): RecallChunk[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item!.content === "string")
    .map((item) => ({
      chunk_id: typeof item.chunk_id === "string" ? item.chunk_id : undefined,
      content: item.content as string,
      source: typeof item.source === "string" ? item.source : undefined,
      timestamps: Array.isArray(item.timestamps) ? item.timestamps.filter((stamp): stamp is string => typeof stamp === "string") : undefined,
    }));
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function filterQuery(filters: RecallFilters, query = new URLSearchParams()) {
  for (const tag of (filters.tags ?? []).slice(0, RECALL_MAX_TAGS)) query.append("tags", tag);
  if (filters.dateFrom) query.set("date_from", filters.dateFrom);
  if (filters.dateTo) query.set("date_to", filters.dateTo);
  if (filters.site) query.set("source_url_contains", filters.site);
  return query;
}

export function recallTags(body: unknown): RecallTag[] | null {
  const top = record(body);
  const list = Array.isArray(body) ? body : (["tags", "results", "data", "items"].map((key) => top?.[key]).find(Array.isArray) as unknown[] | undefined);
  if (!list) return null;
  const found: RecallTag[] = [];
  const walk = (items: unknown[], parent: string | null, depth: number) => {
    for (const item of items) {
      const entry = record(item);
      if (!entry) continue;
      const id = text(entry.tag_id) ?? text(entry.id);
      const name = text(entry.name) ?? text(entry.title) ?? text(entry.label);
      const path = name ? (parent ? `${parent}/${name}` : name) : parent;
      if (id && name) found.push({ id, name, path: path! });
      const children = [entry.children, entry.subtags, entry.tags].find(Array.isArray) as unknown[] | undefined;
      if (children && depth < 10) walk(children, path ?? null, depth + 1);
    }
  };
  walk(list, null, 0);
  if (list.length > 0 && found.length === 0) return null;
  return found;
}

export function recallClient(options: RecallClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let requests = 0;

  function remaining() {
    return options.deadline ? options.deadline - Date.now() : Number.POSITIVE_INFINITY;
  }

  async function once(url: string) {
    if (remaining() < 2_000) throw new CrmError("upstream_error", "Ran out of time talking to Recall. Try a narrower request.", 504);
    requests += 1;
    try {
      return await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(TIMEOUT_MS, remaining()))),
      });
    } catch {
      throw new CrmError("upstream_error", "Couldn't reach Recall. Try again in a minute.", 502);
    }
  }

  async function send(path: string, query?: URLSearchParams) {
    const url = `${RECALL_BASE_URL}${path}${query && [...query.keys()].length > 0 ? `?${query}` : ""}`;
    const first = await once(url);
    if (first.status !== 429 && first.status < 500) return first;
    const wait = Math.min(retryWait(first), MAX_RETRY_WAIT_MS);
    if (wait > remaining() - 3_000) return first;
    await first.body?.cancel().catch(() => undefined);
    await sleep(wait);
    return once(url);
  }

  async function failure(response: Response, notFound: string): Promise<never> {
    const body: unknown = await response.json().catch(() => null);
    const detail = recallDetail(body)?.slice(0, 300) ?? null;
    if (response.status === 401 || response.status === 403) throw new CrmError("upstream_unauthorized", RECALL_REJECTED, 400);
    if (response.status === 422) {
      throw new CrmError("invalid_input", detail ? `Recall couldn't use that request: ${detail.replace(/\.$/, "")}.` : "Recall couldn't use that request. Check the filters.", 400);
    }
    if (response.status === 404) throw new CrmError("not_found", notFound, 404);
    if (response.status === 429) throw new CrmError("upstream_error", "Recall is limiting requests right now. Try again in a minute.", 429);
    const id = requestId(body);
    throw new CrmError(
      "upstream_error",
      `Recall had a problem on its side (${response.status}). Try again in a few minutes.${id ? ` If it keeps happening, give Recall the request id ${id}.` : ""}`,
      502,
    );
  }

  async function json(path: string, query: URLSearchParams | undefined, notFound = "Recall couldn't find that.") {
    const response = await send(path, query);
    if (!response.ok) return failure(response, notFound);
    const body = record(await response.json().catch(() => null));
    if (!body) throw new CrmError("upstream_error", UNREADABLE, 502);
    return body;
  }

  async function validate() {
    const now = Date.now();
    const query = filterQuery({ dateFrom: new Date(now - 60_000).toISOString(), dateTo: new Date(now).toISOString() });
    const response = await send("/cards", query);
    if (response.ok) return true;
    if (response.status === 401 || response.status === 403) return false;
    return failure(response, "Recall couldn't find its cards list.");
  }

  async function listCards(filters: RecallFilters = {}) {
    const body = await json("/cards", filterQuery(filters));
    if (!Array.isArray(body.results)) throw new CrmError("upstream_error", UNREADABLE, 502);
    const cards = body.results
      .map(record)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item!.id === "string")
      .map((item): RecallCardSummary => ({
        id: item.id as string,
        title: optional(item.title) ?? null,
        created_at: optional(item.created_at) ?? null,
        image: optional(item.image),
        source_url: optional(item.source_url),
      }));
    return { cards, total: typeof body.total_count === "number" ? body.total_count : cards.length };
  }

  async function getCard(cardId: string, params: { focusQuery?: string; maxChunks?: number } = {}): Promise<RecallCard> {
    const query = new URLSearchParams();
    if (params.focusQuery) query.set("focus_query", params.focusQuery);
    if (params.maxChunks) query.set("max_chunks", String(Math.min(RECALL_MAX_CHUNKS, Math.max(1, Math.trunc(params.maxChunks)))));
    const body = await json(`/cards/${encodeURIComponent(cardId)}`, query, "Recall has no card with that id. Find it with recall_search first.");
    return {
      card_id: typeof body.card_id === "string" ? body.card_id : cardId,
      title: optional(body.title) ?? null,
      chunks: chunksOf(body.chunks),
      created_at: optional(body.created_at) ?? null,
      image: optional(body.image),
      source_url: optional(body.source_url),
    };
  }

  async function search(q: string, params: RecallFilters & { mode?: "focused" | "exhaustive"; cardId?: string } = {}) {
    const query = new URLSearchParams({ q });
    if (params.mode) query.set("mode", params.mode);
    if (params.cardId) query.set("card_id", params.cardId);
    const body = await json("/search", filterQuery(params, query));
    if (!Array.isArray(body.documents)) throw new CrmError("upstream_error", UNREADABLE, 502);
    const documents = body.documents
      .map(record)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item!.card_id === "string")
      .map((item): RecallSearchDocument => ({
        card_id: item.card_id as string,
        title: optional(item.title) ?? null,
        created_at: optional(item.created_at) ?? null,
        image: optional(item.image),
        source_url: optional(item.source_url),
        chunks: chunksOf(item.chunks),
      }));
    return {
      documents,
      totalCards: typeof body.total_cards === "number" ? body.total_cards : documents.length,
      totalChunks: typeof body.total_chunks === "number" ? body.total_chunks : documents.reduce((sum, item) => sum + item.chunks.length, 0),
    };
  }

  async function probeTags(): Promise<{ path: string | null; tags: RecallTag[] }> {
    for (const path of RECALL_TAG_PATHS) {
      const response = await send(path);
      if (response.status === 401 || response.status === 403) return failure(response, "");
      if (response.status === 429 || response.status >= 500) return failure(response, "");
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const tags = recallTags(await response.json().catch(() => null));
      if (tags) return { path, tags };
    }
    return { path: null, tags: [] };
  }

  async function listTags(path: string) {
    const response = await send(path);
    if (!response.ok) return failure(response, "Recall's tag list has moved. Orbit will check again within a day.");
    const tags = recallTags(await response.json().catch(() => null));
    if (!tags) throw new CrmError("upstream_error", UNREADABLE, 502);
    return tags;
  }

  return {
    validate,
    listCards,
    getCard,
    search,
    probeTags,
    listTags,
    get requests() {
      return requests;
    },
  };
}

export type RecallClient = ReturnType<typeof recallClient>;
