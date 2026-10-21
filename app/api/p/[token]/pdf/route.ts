import { CrmError } from "@/lib/crm/errors";
import { publicFile } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const kind = new URL(request.url).searchParams.get("kind") === "signed" ? "executed" : "issued";
  try {
    const file = await publicFile(token, kind);
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
