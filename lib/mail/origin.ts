import { originFrom } from "@/lib/microsoft/oauth";
import { siteOrigin } from "@/lib/site-url";

export function mailOrigin(request: Request) {
  const origin = siteOrigin() ?? originFrom(request);
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}
