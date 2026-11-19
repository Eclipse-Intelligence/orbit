import { requireCaller } from "@/lib/api/agent";
import { readJson, withApi } from "@/lib/api/http";
import { createReminder, listReminders, personOf } from "@/lib/crm/reminders";
import { readReminderInput } from "@/lib/crm/reminder-input";

export async function GET(request: Request) {
  return withApi(async () => {
    const actor = await requireCaller(request);
    const params = new URL(request.url).searchParams;
    return Response.json(
      await listReminders(actor, {
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        includeDone: params.get("includeDone") === "true",
      }),
    );
  });
}

export async function POST(request: Request) {
  return withApi(async () => {
    const actor = personOf(await requireCaller(request), "tasks:write");
    const input = readReminderInput(await readJson(request), { strict: true });
    return Response.json(await createReminder(actor, input), { status: 201 });
  });
}
