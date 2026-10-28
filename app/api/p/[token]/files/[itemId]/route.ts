import { contentDisposition, wantsDownload } from "@/lib/content-disposition";
import { CrmError } from "@/lib/crm/errors";
import { guardPublic, signedIn } from "@/lib/proposals/guard";
import { publicKnowledgeFile } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)/i;

export async function GET(request: Request, { params }: { params: Promise<{ token: string; itemId: string }> }) {
  const { token, itemId } = await params;
  const guard = await guardPublic(request, "file", 60);
  if ("error" in guard) return new Response("Too many requests. Wait a few minutes and try again.", { status: 429 });
  try {
    const file = await publicKnowledgeFile(token, itemId, { track: !(await signedIn()), ip: guard.ip, userAgent: guard.userAgent });
    if (file.kind === "link") return Response.redirect(file.url, 302);
    const inline = INLINE.test(file.contentType) && !wantsDownload(new URL(request.url).searchParams);
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": inline ? file.contentType : "application/octet-stream",
        "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.name),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof CrmError) return new Response(error.message, { status: error.status });
    console.error("Opening a proposal document failed", error);
    return new Response("That document isn't available.", { status: 500 });
  }
}
