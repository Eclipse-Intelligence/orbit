import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { openMailAttachment } from "@/lib/mail/attachments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SAFE_INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)$/i;

export async function GET(request: Request) {
  const actor = await getUserActor();
  if (!actor) return new Response("Sign in again.", { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const { item, body } = await openMailAttachment(actor, params.get("message") ?? "", params.get("id") ?? "");
    const type = item.contentType && /^[\w.+-]+\/[\w.+-]+$/.test(item.contentType) ? item.contentType : "application/octet-stream";
    const inline = SAFE_INLINE.test(type) && params.get("download") !== "1";
    const name = item.name.replace(/[\r\n"]/g, "_");
    return new Response(body, {
      headers: {
        "content-type": inline ? type : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof CrmError) return new Response(error.message, { status: error.status });
    console.error("attachment failed", error);
    return new Response("The attachment didn't open. Try again.", { status: 500 });
  }
}
