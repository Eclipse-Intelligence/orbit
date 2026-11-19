import { requireCaller } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { deleteReminder, getReminder, personOf, updateReminder } from "@/lib/crm/reminders";
import { readReminderInput } from "@/lib/crm/reminder-input";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireCaller(request);
    const { id } = await context.params;
    return Response.json(await getReminder(actor, id));
  });
}

export async function PATCH(request: Request, context: Context) {
  return withApi(async () => {
    const actor = personOf(await requireCaller(request), "tasks:write");
    const { id } = await context.params;
    return Response.json(await updateReminder(actor, id, readReminderInput(await readJson(request), { strict: true })));
  });
}

export async function DELETE(request: Request, context: Context) {
  return withApi(async () => {
    const actor = await requireCaller(request);
    const { id } = await context.params;
    return Response.json(await deleteReminder(actor, id));
  });
}
