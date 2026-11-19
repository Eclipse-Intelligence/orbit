import { MEDIA_TYPES } from "@/lib/media-types";

export function uploadWithProgress(url: string, file: Blob, name: string, onProgress: (fraction: number) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file, name);
    request.open("PUT", url);
    request.setRequestHeader("x-upsert", "false");
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (key) request.setRequestHeader("apikey", key);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("The upload didn't finish.")));
    request.onerror = () => reject(new Error("The upload didn't finish."));
    request.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(body);
  });
}

export async function imageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  if (!MEDIA_TYPES.includes(file.type) || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
