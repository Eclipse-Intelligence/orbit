import { mailResponse } from "@/app/api/mail/respond";
import { deleteDraftMessage } from "@/lib/mail/compose";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return mailResponse(async (actor) => {
    await deleteDraftMessage(actor, id);
    return { deleted: true };
  });
}
