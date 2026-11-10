import { createHmac, timingSafeEqual } from "node:crypto";
import { ShownError } from "@/lib/crm/errors";
import { logUpstream, redactSecrets, unreachable, upstreamMessage } from "@/lib/upstream";

const META_GRAPH_VERSION = "v27.0";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const META_ENV = ["META_APP_SECRET", "META_VERIFY_TOKEN", "META_ACCESS_TOKEN"] as const;

const LEAD_FIELDS = [
  "created_time",
  "field_data",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "form_id",
  "platform",
  "is_organic",
].join(",");

type MetaOptions = { fetchImpl?: typeof fetch; token?: string | null; deadline?: number };

export type MetaLead = {
  id: string;
  created_time?: string;
  field_data?: { name?: unknown; values?: unknown }[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
};

type MetaForm = { id: string; name: string | null };

export class MetaError extends ShownError {
  readonly status: number;
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null = null) {
    super(message);
    this.name = "MetaError";
    this.status = status;
    this.code = code;
  }
}

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function metaGraphVersion() {
  const value = env("META_GRAPH_VERSION");
  return value && /^v\d{1,3}\.\d{1,2}$/.test(value) ? value : META_GRAPH_VERSION;
}

function graphOrigin() {
  const value = env("META_GRAPH_URL");
  if (!value) return GRAPH_ORIGIN;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) ? url.origin : GRAPH_ORIGIN;
  } catch {
    return GRAPH_ORIGIN;
  }
}

export function metaAccessToken() {
  return env("META_ACCESS_TOKEN");
}

export function metaEnvStatus() {
  return META_ENV.map((name) => ({ name, set: Boolean(env(name)) }));
}

export function metaConfigured() {
  return META_ENV.every((name) => Boolean(env(name)));
}

export function verifyMetaChallenge(params: URLSearchParams, expected = env("META_VERIFY_TOKEN")) {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (!expected || mode !== "subscribe" || token === null || challenge === null) return null;
  if (!sameSecret(token, expected)) return null;
  return challenge.slice(0, 200);
}

function sameSecret(given: string, expected: string) {
  const left = createHmac("sha256", "meta-compare").update(given).digest();
  const right = createHmac("sha256", "meta-compare").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function metaSignature(raw: string | Buffer, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export function verifyMetaSignature(raw: string | Buffer, header: string | null, secret = env("META_APP_SECRET")) {
  if (!secret || !header) return false;
  const given = header.trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(given)) return false;
  const expected = Buffer.from(metaSignature(raw, secret), "utf8");
  const actual = Buffer.from(given.toLowerCase(), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function graphUrl(path: string, params: Record<string, string> = {}) {
  const url = new URL(`${graphOrigin()}/${metaGraphVersion()}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function graphFailure(status: number, body: unknown, token: string | null) {
  const error = (body as { error?: { code?: unknown; message?: unknown; type?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } } | null)?.error;
  const code = typeof error?.code === "number" ? error.code : null;
  logUpstream(
    "Meta",
    status,
    error ? { code, subcode: error.error_subcode ?? null, type: error.type ?? null, message: error.message ?? null, trace: error.fbtrace_id ?? null } : body,
    [token, env("META_APP_SECRET")],
  );
  let effective = status;
  if (code === 190 || code === 102) effective = 401;
  else if (code === 10 || code === 200 || (code !== null && code >= 200 && code < 300)) effective = 403;
  else if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001 || code === 80005) effective = 429;
  else if (code === 1 || code === 2) effective = 503;
  return new MetaError(upstreamMessage("Meta", effective, { credential: "access token" }), effective, code);
}

async function graphGet<T>(url: URL, options: MetaOptions): Promise<T> {
  const token = options.token ?? metaAccessToken();
  if (!token) throw new MetaError("Meta lead ads isn't set up.", 503);
  if (url.origin !== graphOrigin()) throw new MetaError("Meta returned an error.", 502);
  const remaining = options.deadline ? options.deadline - Date.now() : TIMEOUT_MS;
  if (remaining < 500) throw new MetaError(unreachable("Meta"), 504);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining)),
      cache: "no-store",
    });
  } catch (error) {
    logUpstream("Meta", null, error instanceof Error ? error.name : "fetch failed", [token]);
    throw new MetaError(unreachable("Meta"), 0);
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = redactSecrets(text.slice(0, 300), [token]);
  }
  if (!response.ok || (body && typeof body === "object" && "error" in body)) {
    throw graphFailure(response.ok ? 400 : response.status, body, token);
  }
  if (!body || typeof body !== "object") throw graphFailure(502, body, token);
  return body as T;
}

export async function fetchMetaLead(leadgenId: string, options: MetaOptions = {}) {
  const lead = await graphGet<MetaLead>(graphUrl(encodeURIComponent(leadgenId), { fields: LEAD_FIELDS }), options);
  return { ...lead, id: String(lead.id ?? leadgenId) };
}

export async function fetchMetaForm(formId: string, options: MetaOptions = {}): Promise<MetaForm> {
  const form = await graphGet<{ id?: unknown; name?: unknown }>(graphUrl(encodeURIComponent(formId), { fields: "id,name" }), options);
  return { id: formId, name: typeof form.name === "string" ? form.name : null };
}

export async function fetchMetaPage(pageId: string, options: MetaOptions = {}) {
  const page = await graphGet<{ name?: unknown; access_token?: unknown }>(graphUrl(encodeURIComponent(pageId), { fields: "name,access_token" }), options);
  return {
    name: typeof page.name === "string" ? page.name.slice(0, 200) : null,
    accessToken: typeof page.access_token === "string" && page.access_token ? page.access_token : null,
  };
}

type Paged<T> = { data?: T[]; paging?: { next?: unknown; cursors?: { after?: unknown } } };

async function* pages<T>(first: URL, options: MetaOptions) {
  let url: URL | null = first;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body: Paged<T> = await graphGet<Paged<T>>(url, options);
    const data = Array.isArray(body.data) ? body.data : [];
    yield data;
    const next = typeof body.paging?.next === "string" ? body.paging.next : null;
    const after = typeof body.paging?.cursors?.after === "string" ? body.paging.cursors.after : null;
    if (next) {
      const parsed = new URL(next);
      url = parsed.origin === graphOrigin() ? parsed : null;
      url?.searchParams.delete("access_token");
    } else if (after && data.length >= PAGE_SIZE) {
      url = new URL(first);
      url.searchParams.set("after", after);
    } else {
      url = null;
    }
  }
}

export async function listMetaForms(pageId: string, options: MetaOptions = {}) {
  const forms: MetaForm[] = [];
  for await (const batch of pages<{ id?: unknown; name?: unknown }>(
    graphUrl(`${encodeURIComponent(pageId)}/leadgen_forms`, { fields: "id,name", limit: String(PAGE_SIZE) }),
    options,
  )) {
    for (const form of batch) {
      const id = metaId(form.id);
      if (id) forms.push({ id, name: typeof form.name === "string" ? form.name : null });
    }
  }
  return forms;
}

export async function listMetaLeads(formId: string, since: Date, options: MetaOptions = {}) {
  const leads: MetaLead[] = [];
  const filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }]);
  for await (const batch of pages<MetaLead>(
    graphUrl(`${encodeURIComponent(formId)}/leads`, { fields: `id,${LEAD_FIELDS}`, filtering, limit: String(PAGE_SIZE) }),
    options,
  )) {
    for (const lead of batch) {
      const id = metaId(lead.id);
      if (id) leads.push({ ...lead, id });
    }
  }
  return leads;
}

export function metaId(value: unknown) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,40}$/.test(text) ? text : null;
}
