export type UploadState = { name: string; status: "uploading" | "ready" | "failed" };

export function attachmentBlock(items: UploadState[]): string | null {
  const failed = items.filter((item) => item.status === "failed");
  if (failed.length === 1) return `${failed[0].name} didn't upload. Remove it or attach it again to send.`;
  if (failed.length > 1) return `${failed.length} attachments didn't upload. Remove them or attach them again to send.`;
  const uploading = items.filter((item) => item.status === "uploading");
  if (uploading.length === 1) return `Wait for ${uploading[0].name} to finish uploading.`;
  if (uploading.length > 1) return `Wait for ${uploading.length} attachments to finish uploading.`;
  return null;
}
