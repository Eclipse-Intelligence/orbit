import { CrmError } from "@/lib/crm/errors";
import { hashClient, visitorKeyOf } from "@/lib/docs/public-comments";

export const COMMENT_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
export const VISITOR_KEY_HEADER = "x-visitor-key";

const NOT_FOUND = "This page doesn't exist or isn't public.";

export function notFound() {
  return Response.json({ error: NOT_FOUND }, { status: 404, headers: COMMENT_HEADERS });
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400, headers: COMMENT_HEADERS });
}

export function failure(error: unknown, fallback: string) {
  if (error instanceof CrmError && (error.status === 400 || error.status === 429)) {
    return Response.json({ error: error.message }, { status: error.status, headers: COMMENT_HEADERS });
  }
  return Response.json({ error: fallback }, { status: 500, headers: COMMENT_HEADERS });
}

export function visitor(request: Request) {
  return { key: visitorKeyOf(request.headers.get(VISITOR_KEY_HEADER)), client: hashClient(request.headers) };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text.length > 20_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
