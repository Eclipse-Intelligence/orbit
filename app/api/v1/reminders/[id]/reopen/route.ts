import { requireCaller } from "@/lib/api/agent";
import { withApi } from "@/lib/api/http";
import { reopenReminder } from "@/lib/crm/reminders";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireCaller(request);
    const { id } = await context.params;
    return Response.json(await reopenReminder(actor, id));
  });
}
