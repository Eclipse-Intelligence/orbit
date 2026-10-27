import { randomBytes } from "node:crypto";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { MEDIA_MAX_BYTES, publicObjectUrl, signedUploadUrl, storageConfigured, StorageError } from "@/lib/storage";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export async function prepareProposalImage(actor: UserActor, input: { name?: unknown; size?: unknown; contentType?: unknown }, fetchImpl: typeof fetch = fetch) {
  if (!storageConfigured()) throw new CrmError("invalid_input", "Images need SUPABASE_SERVICE_ROLE_KEY set on the server.", 400);
  const type = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
  const extension = IMAGE_TYPES[type];
  if (!extension) throw new CrmError("invalid_input", "Use a JPEG, PNG, WebP or GIF image.", 400, { field: "image" });
  const size = typeof input.size === "number" && Number.isInteger(input.size) ? input.size : 0;
  if (size < 1) throw new CrmError("invalid_input", "That image is empty.", 400, { field: "image" });
  if (size > MEDIA_MAX_BYTES) throw new CrmError("invalid_input", "Images can be up to 10 MB.", 400, { field: "image" });
  const path = `${actor.workspaceId}/${randomBytes(12).toString("hex")}.${extension}`;
  try {
    return { uploadUrl: await signedUploadUrl(path, fetchImpl, "media"), url: publicObjectUrl(path) };
  } catch (error) {
    throw new CrmError("upstream_error", error instanceof StorageError ? error.message : "Couldn't prepare the upload.", 502);
  }
}
