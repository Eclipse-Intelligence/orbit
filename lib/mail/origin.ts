import { originFrom } from "@/lib/microsoft/oauth";
import { siteOrigin } from "@/lib/site-url";

function publicOrigin(origin: string | null) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function mailOrigin(request?: Request) {
  return publicOrigin(siteOrigin() ?? (request ? originFrom(request) : null));
}
