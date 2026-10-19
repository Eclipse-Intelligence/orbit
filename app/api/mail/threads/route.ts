import { mailResponse } from "@/app/api/mail/respond";
import { listThreads } from "@/lib/mail/threads";
import { readMailView, readThreadCursor } from "@/lib/mail/view";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return mailResponse((actor) =>
    listThreads(actor, {
      view: readMailView(params.get("view")),
      sourceId: params.get("account"),
      query: params.get("q") ?? undefined,
      before: readThreadCursor(params.get("before")),
      limit: Number(params.get("limit")) || undefined,
    }),
  );
}
