import { headers } from "next/headers";
import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { CrmError } from "@/lib/crm/errors";
import { publicKnowledgeFile } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)/i;

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; itemId: string }> }) {
  const { token, itemId } = await params;
  const store = await headers();
  const viewer = await getUserActor().catch(() => null);
  try {
    const file = await publicKnowledgeFile(token, itemId, { track: !viewer, ip: clientIp(store), userAgent: store.get("user-agent") });
    if (file.kind === "link") return Response.redirect(file.url, 302);
    const inline = INLINE.test(file.contentType);
    const name = file.name.replace(/[\r\n"]/g, "_");
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": inline ? file.contentType : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
