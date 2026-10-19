export const ATTACHMENT_BUCKET = "email-attachments";
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

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

let bucketReady: Promise<void> | null = null;

async function ensureBucket(fetchImpl: typeof fetch) {
  const response = await fetchImpl(endpoint("/bucket"), {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ id: ATTACHMENT_BUCKET, name: ATTACHMENT_BUCKET, public: false, file_size_limit: ATTACHMENT_MAX_BYTES }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok || response.status === 409) return;
  const text = await response.text().catch(() => "");
  if (/already exists|Duplicate/i.test(text)) return;
  throw new StorageError("Couldn't prepare storage for attachments.");
}

export function resetStorageBucketCache() {
  bucketReady = null;
}

export async function signedUploadUrl(path: string, fetchImpl: typeof fetch = fetch) {
  bucketReady ??= ensureBucket(fetchImpl).catch((error) => {
    bucketReady = null;
    throw error;
  });
  await bucketReady;
  const response = await fetchImpl(endpoint(`/object/upload/sign/${ATTACHMENT_BUCKET}/${path}`), {
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

export async function readObject(path: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(endpoint(`/object/${ATTACHMENT_BUCKET}/${path}`), {
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await failure(response, "read the attachment");
  return new Uint8Array(await response.arrayBuffer());
}

export async function removeObjects(paths: string[], fetchImpl: typeof fetch = fetch) {
  if (paths.length === 0) return;
  const response = await fetchImpl(endpoint(`/object/${ATTACHMENT_BUCKET}`), {
    method: "DELETE",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await failure(response, "remove the attachments");
}
