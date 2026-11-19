import { requireCaller } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { completeReminder, personOf } from "@/lib/crm/reminders";
import { readTickDay } from "@/lib/crm/reminder-input";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return withApi(async () => {
    const actor = personOf(await requireCaller(request), "tasks:write");
    const { id } = await context.params;
    return Response.json(await completeReminder(actor, id, { dueOn: readTickDay(await readJson(request)) }));
  });
}
