import { MEDIA_TYPES } from "@/lib/media-types";
import type { ChatAttachment } from "@/lib/chat/types";

export const INLINE_TYPES = [...MEDIA_TYPES, "application/pdf"];

export function baseType(type: string | null | undefined) {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

export function isChatImage(attachment: Pick<ChatAttachment, "contentType">) {
  return MEDIA_TYPES.includes(baseType(attachment.contentType));
}

export function opensInline(contentType: string) {
  return INLINE_TYPES.includes(baseType(contentType));
}

export function chatFileHref(id: string, options: { download?: boolean } = {}) {
  return `/api/chat/files/${id}${options.download ? "?download=1" : ""}`;
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function fileBadge(name: string, contentType: string) {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  if (extension) return extension.slice(0, 4).toUpperCase();
  const sub = baseType(contentType).split("/")[1];
  return sub ? sub.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "FILE" : "FILE";
}

export type FileTone = "pdf" | "sheet" | "doc" | "other";

export function fileTone(name: string, contentType: string): FileTone {
  const badge = fileBadge(name, contentType);
  if (badge === "PDF") return "pdf";
  if (["XLS", "XLSX", "CSV", "NUMB"].includes(badge) || baseType(contentType).includes("spreadsheet")) return "sheet";
  if (["DOC", "DOCX", "TXT", "RTF", "PAGE", "MD"].includes(badge) || baseType(contentType).includes("word")) return "doc";
  return "other";
}

export function pasteAttaches(types: readonly string[], fileCount: number) {
  if (fileCount === 0) return false;
  return !types.some((type) => type === "text/html" || type === "text/rtf");
}

export function filesTitle(count: number) {
  return count === 1 ? "a file" : `${count} files`;
}
