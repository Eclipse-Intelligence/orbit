import { publicDocPdf } from "@/lib/docs/public";
import { guardPublic } from "@/lib/proposals/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NOT_FOUND = "This page doesn't exist or isn't public.";
const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublic(request, "doc-pdf", 60);
  if ("error" in guard) return new Response("Too many requests. Wait a few minutes and try again.", { status: 429, headers: HEADERS });
  try {
    const file = await publicDocPdf(token);
    if (!file) return new Response(NOT_FOUND, { status: 404, headers: HEADERS });
    return new Response(new Uint8Array(file.data), {
      headers: { ...HEADERS, "content-type": "application/pdf", "content-disposition": file.disposition },
    });
  } catch {
    return new Response("Couldn't make the PDF. Try again.", { status: 500, headers: HEADERS });
  }
}
