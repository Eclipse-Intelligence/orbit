export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const KNOWLEDGE_MAX_BYTES = 50 * 1024 * 1024;

const BUCKETS = {
  attachments: { id: "email-attachments", limit: ATTACHMENT_MAX_BYTES },
  knowledge: { id: "knowledge", limit: KNOWLEDGE_MAX_BYTES },
} as const;

export type Bucket = keyof typeof BUCKETS;

export class StorageError extends Error {}

function baseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "") || null;
}

function secretKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim() || null;
}

export function storageConfigured() {
  return Boolean(baseUrl() && secretKey());
}

function headers(extra: Record<string, string> = {}) {
  const key = secretKey();
  if (!key) throw new StorageError("Set SUPABASE_SERVICE_ROLE_KEY to send attachments.");
  return { apikey: key, ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}), ...extra };
}

function endpoint(path: string) {
  const base = baseUrl();
  if (!base) throw new StorageError("Set NEXT_PUBLIC_SUPABASE_URL to send attachments.");
  return `${base}/storage/v1${path}`;
}

async function failure(response: Response, action: string) {
  const text = await response.text().catch(() => "");
  let message = "";
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    message = body.message || body.error || "";
  } catch {}
  return new StorageError(`Couldn't ${action}${message ? `: ${message.slice(0, 200)}` : ""}.`);
}

const bucketsReady = new Map<Bucket, Promise<void>>();

async function ensureBucket(bucket: Bucket, fetchImpl: typeof fetch) {
  const { id, limit } = BUCKETS[bucket];
  const response = await fetchImpl(endpoint("/bucket"), {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ id, name: id, public: false, file_size_limit: limit }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok || response.status === 409) return;
  const text = await response.text().catch(() => "");
  if (/already exists|Duplicate/i.test(text)) return;
  throw new StorageError("Couldn't prepare file storage.");
}

export function resetStorageBucketCache() {
  bucketsReady.clear();
}

export async function signedUploadUrl(path: string, fetchImpl: typeof fetch = fetch, bucket: Bucket = "attachments") {
  let ready = bucketsReady.get(bucket);
  if (!ready) {
    ready = ensureBucket(bucket, fetchImpl).catch((error) => {
      bucketsReady.delete(bucket);
      throw error;
    });
    bucketsReady.set(bucket, ready);
  }
  await ready;
  const response = await fetchImpl(endpoint(`/object/upload/sign/${BUCKETS[bucket].id}/${path}`), {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await failure(response, "prepare the upload");
  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new StorageError("Couldn't prepare the upload.");
  return endpoint(body.url);
}

export async function readObject(path: string, fetchImpl: typeof fetch = fetch, bucket: Bucket = "attachments") {
  const response = await fetchImpl(endpoint(`/object/${BUCKETS[bucket].id}/${path}`), {
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await failure(response, "read the attachment");
  return new Uint8Array(await response.arrayBuffer());
}

export async function removeObjects(paths: string[], fetchImpl: typeof fetch = fetch, bucket: Bucket = "attachments") {
  if (paths.length === 0) return;
  const response = await fetchImpl(endpoint(`/object/${BUCKETS[bucket].id}`), {
    method: "DELETE",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await failure(response, "remove the attachments");
}
