import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://public-api.granola.ai";
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 8_000;
const TIMEOUT_MS = 20_000;
const MAX_TRANSCRIPT_PAGES = 200;
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type GranolaUser = { name: string | null; email: string };

export type GranolaNoteSummary = {
  id: string;
  title: string | null;
  owner: GranolaUser;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type GranolaSpeaker = {
  source: "microphone" | "speaker";
  attribution?: "me" | "them";
  diarization_label?: string;
  name?: string;
};

export type GranolaTranscriptItem = {
  speaker: GranolaSpeaker;
  text: string;
  start_time: string;
  end_time: string;
};

export type GranolaCalendarEvent = {
  event_title: string | null;
  invitees: { email: string }[];
  organiser: string | null;
  calendar_event_id: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
};

export type GranolaNote = GranolaNoteSummary & {
  web_url: string;
  calendar_event: GranolaCalendarEvent | null;
  attendees: GranolaUser[];
  summary_text: string;
  summary_markdown: string | null;
  transcript: GranolaTranscriptItem[] | null;
};

type GranolaWebhookEndpoint = {
  id: string;
  url: string;
  events: string[];
  scopes: string[];
  enabled: boolean;
  signing_secret: string;
};

export class GranolaError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GranolaError";
    this.status = status;
  }
}

type GranolaClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  deadline?: number;
};

export function granolaApiKey() {
  return process.env.GRANOLA_API_KEY?.trim() || null;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    message?: unknown;
    error?: unknown;
    code?: unknown;
  };
  const detail =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : "";
  if (response.status === 401) return "Granola rejected the API key. Check GRANOLA_API_KEY.";
  if (response.status === 403) return "Granola refused the request. Check the API key's access in Granola.";
  if (response.status === 429) return "Granola is rate limiting Orbit. It will try again on the next sync.";
  return `Granola returned ${response.status}${detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 200)}` : "."}`;
}

export function granolaClient(options: GranolaClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const base = (options.baseUrl ?? (process.env.GRANOLA_API_BASE_URL?.trim() || DEFAULT_BASE_URL)).replace(/\/+$/, "");

  function remaining() {
    return options.deadline ? options.deadline - Date.now() : Number.POSITIVE_INFINITY;
  }

  async function request(path: string, init: RequestInit = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (remaining() < 1_000) throw new GranolaError("Ran out of time talking to Granola.", 0);
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(TIMEOUT_MS, remaining()))),
      });
      if (response.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const delay = retryDelay(response, attempt);
        if (delay > remaining() - 2_000) return response;
        await sleep(delay);
        continue;
      }
      return response;
    }
  }

  async function json<T>(path: string, init?: RequestInit) {
    const response = await request(path, init);
    if (!response.ok) throw new GranolaError(await errorMessage(response), response.status);
    return (await response.json()) as T;
  }

  async function listNotes(query: { updatedAfter?: string; cursor?: string | null; pageSize?: number }) {
    const params = new URLSearchParams();
    if (query.updatedAfter) params.set("updated_after", query.updatedAfter);
    if (query.cursor) params.set("cursor", query.cursor);
    params.set("page_size", String(query.pageSize ?? 30));
    return json<{ notes: GranolaNoteSummary[]; hasMore: boolean; cursor: string | null }>(
      `/v1/notes?${params.toString()}`,
    );
  }

  async function getTranscript(noteId: string) {
    const items: GranolaTranscriptItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("cursor", cursor);
      const body: { transcript: GranolaTranscriptItem[]; hasMore: boolean; cursor: string | null } =
        await json(`/v1/notes/${encodeURIComponent(noteId)}/transcript?${params.toString()}`);
      items.push(...(body.transcript ?? []));
      if (!body.hasMore || !body.cursor) return items;
      cursor = body.cursor;
    }
    return items;
  }

  async function getNote(noteId: string): Promise<GranolaNote | null> {
    const path = `/v1/notes/${encodeURIComponent(noteId)}`;
    const response = await request(`${path}?include=transcript`);
    if (response.status === 404) return null;
    if (response.status === 413) {
      const note = await json<GranolaNote>(path);
      return { ...note, transcript: await getTranscript(noteId) };
    }
    if (!response.ok) throw new GranolaError(await errorMessage(response), response.status);
    return (await response.json()) as GranolaNote;
  }

  async function createWebhookEndpoint(input: { url: string; scopes: string[]; events: string[] }) {
    const response = await request("/v1/webhook-endpoints", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new GranolaError(await errorMessage(response), response.status);
    return (await response.json()) as GranolaWebhookEndpoint;
  }

  return { listNotes, getNote, getTranscript, createWebhookEndpoint };
}

export type GranolaClient = ReturnType<typeof granolaClient>;

export function granolaTranscriptText(
  items: GranolaTranscriptItem[] | null | undefined,
  ownerName: string | null,
) {
  const turns: { speaker: string; text: string }[] = [];
  for (const item of items ?? []) {
    const text = item.text?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const speaker = item.speaker ?? { source: "speaker" };
    const mine = speaker.attribution
      ? speaker.attribution === "me"
      : speaker.source === "microphone";
    const label = mine ? ownerName?.trim() || "Me" : speaker.name?.trim() || "Them";
    const last = turns[turns.length - 1];
    if (last && last.speaker === label) last.text = `${last.text} ${text}`;
    else turns.push({ speaker: label, text });
  }
  return turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
}

export function signWebhook(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function noteIdFromPayload(body: string) {
  const match = /\bnot_[A-Za-z0-9]{14}\b/.exec(body);
  return match ? match[0] : null;
}

function sameText(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function verifyWebhook(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}) {
  if (!input.id || !input.timestamp || !input.signature) return false;
  if (!/^\d{1,12}$/.test(input.timestamp)) return false;
  const seconds = Number(input.timestamp);
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = signWebhook(input.secret, input.id, input.timestamp, input.body);
  let valid = false;
  for (const part of input.signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version === "v1" && value && sameText(value, expected)) valid = true;
  }
  return valid;
}
