import { CrmError } from "@/lib/crm/errors";
import { guardPublic, signedIn } from "@/lib/proposals/guard";
import { publicFile } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const guard = await guardPublic(request, "pdf", 60);
  if ("error" in guard) return new Response("Too many requests. Wait a few minutes and try again.", { status: 429 });
  const kind = new URL(request.url).searchParams.get("kind") === "signed" ? "executed" : "issued";
  try {
    const file = await publicFile(token, kind, { track: !(await signedIn()) });
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex",
      },
    });
  } catch (error) {
    if (error instanceof CrmError) return new Response(error.message, { status: error.status });
    return new Response("The PDF isn't available.", { status: 500 });
  }
}
