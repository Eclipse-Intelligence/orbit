import { randomBytes } from "node:crypto";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { MEDIA_MAX_BYTES, publicObjectUrl, putObject, signedUploadUrl, storageConfigured, StorageError } from "@/lib/storage";
import { downloadPublic, WebPageError } from "@/lib/web-page";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function sniffImage(bytes: Uint8Array) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function storageReady() {
  if (!storageConfigured()) throw new CrmError("invalid_input", "Images need SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
}

function imagePath(actor: UserActor, extension: string) {
  return `${actor.workspaceId}/${randomBytes(12).toString("hex")}.${extension}`;
}

export async function prepareProposalImage(actor: UserActor, input: { name?: unknown; size?: unknown; contentType?: unknown }, fetchImpl: typeof fetch = fetch) {
  storageReady();
  const type = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
  const extension = IMAGE_TYPES[type];
  if (!extension) throw new CrmError("invalid_input", "Use a JPEG, PNG, WebP or GIF image.", 400, { field: "image" });
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : 0;
  if (size < 1) throw new CrmError("invalid_input", "That image is empty.", 400, { field: "image" });
  if (size > MEDIA_MAX_BYTES) throw new CrmError("invalid_input", "Images can be up to 10 MB.", 400, { field: "image" });
  const path = imagePath(actor, extension);
  try {
    return { uploadUrl: await signedUploadUrl(path, fetchImpl, "media"), url: publicObjectUrl(path) };
  } catch (error) {
    throw new CrmError("upstream_error", error instanceof StorageError ? error.message : "Couldn't prepare the upload.", 502);
  }
}

export async function copyProposalImage(
  actor: UserActor,
  url: unknown,
  options: { fetchImpl?: typeof fetch; storageFetch?: typeof fetch; lookup?: Parameters<typeof downloadPublic>[1]["lookup"] } = {},
) {
  storageReady();
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) throw new CrmError("invalid_input", "Give an image link starting with https.", 400, { field: "url" });
  let download;
  try {
    download = await downloadPublic(url, { fetchImpl: options.fetchImpl, lookup: options.lookup, maxBytes: MEDIA_MAX_BYTES, timeoutMs: 30_000, accept: "image/*" });
  } catch (error) {
    throw new CrmError("invalid_input", error instanceof WebPageError ? error.message : "Couldn't download that image.", 400, { field: "url" });
  }
  if (download.truncated) throw new CrmError("invalid_input", "Images can be up to 10 MB.", 400, { field: "url" });
  const type = sniffImage(download.bytes);
  if (!type) throw new CrmError("invalid_input", "That link isn't a JPEG, PNG, WebP or GIF image.", 400, { field: "url" });
  const path = imagePath(actor, IMAGE_TYPES[type]);
  try {
    await putObject(path, download.bytes, type, options.storageFetch ?? fetch, "media");
  } catch (error) {
    throw new CrmError("upstream_error", error instanceof StorageError ? error.message : "Couldn't store the image.", 502);
  }
  return { url: publicObjectUrl(path), from: download.url, contentType: type, bytes: download.bytes.length };
}
