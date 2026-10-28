import { htmlToText } from "@/lib/mail/text";

const BASE_URL = "https://readwise.io/api";
const TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 65_000;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

export const READER_LOCATIONS = ["new", "later", "shortlist", "archive", "feed"] as const;
export const READER_CATEGORIES = ["article", "email", "rss", "highlight", "note", "pdf", "epub", "tweet", "video"] as const;
export type ReaderLocation = (typeof READER_LOCATIONS)[number];
export type ReaderCategory = (typeof READER_CATEGORIES)[number];

export type ReaderDocument = {
  id: string;
  url: string | null;
  source_url: string | null;
  title: string | null;
  author: string | null;
  source: string | null;
  category: string | null;
  location: string | null;
  tags: unknown;
  site_name: string | null;
  word_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  published_date: string | number | null;
  saved_at: string | null;
  summary: string | null;
  notes: string | null;
  content: string | null;
  html_content?: string | null;
  parent_id: string | null;
  highlight_offset?: number | null;
};

export type ReaderPage = { count: number; nextPageCursor: string | null; results: ReaderDocument[] };

export type ReaderListParams = {
  id?: string;
  updatedAfter?: string;
  location?: ReaderLocation;
  category?: ReaderCategory;
  tags?: string[];
  limit?: number;
  pageCursor?: string | null;
  withHtmlContent?: boolean;
  pages?: number;
};

export type ReaderTag = { key: string; name: string };

export class ReadwiseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ReadwiseError";
    this.status = status;
  }
}

export type ReaderClientOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadline?: number;
  maxRequests?: number;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response) {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 60_000;
}

function waitLabel(ms: number) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function failure(status: number) {
  if (status === 401 || status === 403) return "Readwise didn't accept the access token. Connect Readwise Reader again in Settings.";
  if (status === 404) return "Readwise couldn't find that.";
  return `Readwise returned ${status}.`;
}

export function readerClient(options: ReaderClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let requests = 0;

  function remaining() {
    return options.deadline ? options.deadline - Date.now() : Number.POSITIVE_INFINITY;
  }

  function canRequest() {
    return (options.maxRequests === undefined || requests < options.maxRequests) && remaining() > 2_000;
  }

  async function get(path: string, query?: URLSearchParams) {
    for (let attempt = 0; ; attempt += 1) {
      if (!canRequest()) throw new ReadwiseError("Ran out of time talking to Readwise.", 0);
      requests += 1;
      const url = `${BASE_URL}${path}${query && [...query.keys()].length > 0 ? `?${query}` : ""}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Token ${options.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(1_000, Math.min(TIMEOUT_MS, remaining()))),
        });
      } catch {
        throw new ReadwiseError("Couldn't reach Readwise.", 0);
      }
      if (response.status !== 429) return response;
      const wait = retryAfterMs(response);
      if (attempt > 0 || wait > MAX_WAIT_MS || wait > remaining() - 3_000) {
        throw new ReadwiseError(`Readwise is limiting requests (20 a minute). Try again in ${waitLabel(wait)}.`, 429);
      }
      await sleep(wait);
    }
  }

  async function json<T>(path: string, query?: URLSearchParams) {
    const response = await get(path, query);
    if (!response.ok) throw new ReadwiseError(failure(response.status), response.status);
    return (await response.json()) as T;
  }

  async function validate() {
    const response = await get("/v2/auth/");
    if (response.status === 204 || response.status === 200) return true;
    if (response.status === 401 || response.status === 403) return false;
    throw new ReadwiseError(failure(response.status), response.status);
  }

  async function listPage(params: ReaderListParams): Promise<ReaderPage> {
    const query = new URLSearchParams();
    if (params.id) query.set("id", params.id);
    if (params.updatedAfter) query.set("updatedAfter", params.updatedAfter);
    if (params.location) query.set("location", params.location);
    if (params.category) query.set("category", params.category);
    for (const tag of (params.tags ?? []).slice(0, 5)) query.append("tag", tag);
    if (params.limit) query.set("limit", String(Math.min(100, Math.max(1, Math.trunc(params.limit)))));
    if (params.pageCursor) query.set("pageCursor", params.pageCursor);
    if (params.withHtmlContent) query.set("withHtmlContent", "true");
    const body = await json<{ count?: unknown; nextPageCursor?: unknown; results?: unknown }>("/v3/list/", query);
    return {
      count: typeof body.count === "number" ? body.count : 0,
      nextPageCursor: typeof body.nextPageCursor === "string" && body.nextPageCursor ? body.nextPageCursor : null,
      results: Array.isArray(body.results) ? (body.results as ReaderDocument[]).filter((item) => item && typeof item.id === "string") : [],
    };
  }

  async function listDocuments(params: ReaderListParams): Promise<ReaderPage> {
    const pages = Math.max(1, params.pages ?? 1);
    const results: ReaderDocument[] = [];
    let cursor = params.pageCursor ?? null;
    let count = 0;
    for (let page = 0; page < pages; page += 1) {
      const body = await listPage({ ...params, pageCursor: cursor });
      count = body.count;
      results.push(...body.results);
      cursor = body.nextPageCursor;
      if (!cursor || !canRequest()) break;
    }
    return { count, nextPageCursor: cursor, results };
  }

  async function listTags(): Promise<ReaderTag[]> {
    const tags: ReaderTag[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams();
      if (cursor) query.set("pageCursor", cursor);
      const body: { nextPageCursor?: unknown; results?: unknown } = await json("/v3/tags/", query);
      for (const item of Array.isArray(body.results) ? body.results : []) {
        const entry = item as { key?: unknown; name?: unknown };
        if (typeof entry.key === "string") tags.push({ key: entry.key, name: typeof entry.name === "string" ? entry.name : entry.key });
      }
      cursor = typeof body.nextPageCursor === "string" && body.nextPageCursor ? body.nextPageCursor : null;
      if (!cursor) break;
    }
    return tags;
  }

  return {
    validate,
    listPage,
    listDocuments,
    listTags,
    canRequest,
    get requests() {
      return requests;
    },
  };
}

export type ReaderClient = ReturnType<typeof readerClient>;

export async function validateReadwiseToken(token: string, fetchImpl?: typeof fetch) {
  return readerClient({ token, fetchImpl, deadline: Date.now() + 20_000 }).validate();
}

export async function listReaderDocuments(token: string, params: ReaderListParams = {}, fetchImpl?: typeof fetch) {
  return readerClient({ token, fetchImpl }).listDocuments(params);
}

export async function listReaderTags(token: string, fetchImpl?: typeof fetch) {
  return readerClient({ token, fetchImpl }).listTags();
}

export function readerTags(document: Pick<ReaderDocument, "tags">): ReaderTag[] {
  const value = document.tags;
  const found: ReaderTag[] = [];
  const add = (key: unknown, name: unknown) => {
    const tagKey = typeof key === "string" ? key.trim() : "";
    const tagName = typeof name === "string" && name.trim() ? name.trim() : tagKey;
    if (tagKey || tagName) found.push({ key: tagKey || tagName, name: tagName || tagKey });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item, item);
      else if (item && typeof item === "object") add((item as { key?: unknown }).key ?? (item as { name?: unknown }).name, (item as { name?: unknown }).name);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      add(key, item && typeof item === "object" ? (item as { name?: unknown }).name : key);
    }
  }
  return found;
}

export function hasReaderTag(document: Pick<ReaderDocument, "tags">, tag: string) {
  const wanted = tag.toLowerCase();
  return readerTags(document).some((item) => item.key.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
}

export function readerText(document: Pick<ReaderDocument, "html_content" | "content">) {
  if (document.html_content?.trim()) return htmlToText(document.html_content, NO_LIMIT);
  if (document.content?.trim()) return /<[a-z][\s\S]*>/i.test(document.content) ? htmlToText(document.content, NO_LIMIT) : document.content.trim();
  return "";
}

export function highlightText(highlight: Pick<ReaderDocument, "content" | "html_content" | "title">) {
  return readerText(highlight) || highlight.title?.trim() || "";
}

export function readerUrl(document: Pick<ReaderDocument, "source_url" | "url">) {
  const candidate = document.source_url?.trim() || document.url?.trim() || "";
  return /^https?:\/\//i.test(candidate) ? candidate.slice(0, 2000) : null;
}
