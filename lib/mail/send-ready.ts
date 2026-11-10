export type UploadState = { name: string; status: "uploading" | "ready" | "failed" };

export function attachmentBlock(items: UploadState[]): string | null {
  const failed = items.filter((item) => item.status === "failed");
  if (failed.length === 1) return `${failed[0].name} didn't upload. Remove or re-attach it.`;
  if (failed.length > 1) return `${failed.length} attachments didn't upload. Remove or re-attach them.`;
  const uploading = items.filter((item) => item.status === "uploading");
  if (uploading.length === 1) return `${uploading[0].name} is still uploading, or remove it.`;
  if (uploading.length > 1) return `${uploading.length} attachments are still uploading, or remove them.`;
  return null;
}
