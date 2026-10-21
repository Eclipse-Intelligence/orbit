import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { documentFile } from "@/lib/proposals/documents";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserActor();
  if (!user) return new Response("Sign in again.", { status: 401 });
  const { id } = await params;
  const kind = new URL(request.url).searchParams.get("kind") === "signed" ? "executed" : "issued";
  try {
    const file = await documentFile(user, id, kind);
    return new Response(new Uint8Array(file.data), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`, "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof CrmError) return new Response(error.message, { status: error.status });
    return new Response("The PDF isn't available.", { status: 500 });
  }
}
