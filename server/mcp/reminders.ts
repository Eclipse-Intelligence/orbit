import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import { completeReminder, createReminder, deleteReminder, getReminder, listReminders, reopenReminder, updateReminder } from "@/lib/crm/reminders";
import { readReminderInput } from "@/lib/crm/reminder-input";
import type { UserActor } from "@/lib/crm/types";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof CrmError ? `${error.code}: ${error.message}` : "The CRM request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function run(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    return toolFailure(error);
  }
}

const repeatShape = z
  .looseObject({
    every: z.string().describe("day, weekday, week, month or year."),
    interval: z.number().optional().describe("Every 2 weeks and so on, 1 to 99."),
    days: z.array(z.string()).optional().describe("For week: the days, mo to su. Defaults to the date's weekday."),
    monthDay: z.number().optional().describe("For month: the date, 1 to 31."),
    monthWeek: z.looseObject({ n: z.number(), weekday: z.string() }).optional().describe("For month: { n: 1 to 4 or -1, weekday }."),
    ends: z
      .looseObject({ after: z.number().optional(), on: z.string().optional() })
      .nullable()
      .optional()
      .describe("{ after: N } more times, { on: YYYY-MM-DD }, or null for never."),
  })
  .nullable()
  .optional()
  .describe("Repeats from the reminder's date, like repeating tasks. null stops it repeating. Checked as REST checks it.");

const fields = {
  title: z.string().optional(),
  dueOn: z.string().nullable().optional().describe("A day, YYYY-MM-DD, in London. null takes the date (and time) off. On its own it keeps the reminder's time."),
  dueAt: z.string().nullable().optional().describe("A time, such as 2026-11-20T10:00 (London time) or an ISO instant. null keeps the day and drops the time."),
  blocksTime: z.boolean().optional().describe("Puts it in the person's calendar and Outlook as busy. Needs a time."),
  durationMinutes: z.number().int().min(5).max(480).optional().describe("Length of the block, 15 by default."),
  repeat: repeatShape,
};

export function registerReminderTools(server: McpServer, actor: UserActor) {
  server.registerTool(
    "list_reminders",
    {
      description:
        "List the person's own reminders: small personal to-dos that aren't tasks, with an optional date (dueOn), time (dueAt, time) and repeat. They are private to the person and the same in every workspace. Open ones come first; includeDone adds those done in the last 30 days. from and to (YYYY-MM-DD) keep only dated ones in that range. With id it returns that one reminder.",
      inputSchema: {
        id: z.uuid().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        includeDone: z.boolean().optional(),
      },
    },
    async (args) => run(async () => (args.id ? getReminder(actor, args.id) : listReminders(actor, { from: args.from, to: args.to, includeDone: args.includeDone }))),
  );

  server.registerTool(
    "create_reminder",
    {
      description:
        "Add a reminder for the person: a title, and optionally a day (dueOn) or a time (dueAt, which can't be in the past), Block time with a length, and a repeat (needs a date). Use a task instead for anything about a contact, company or opportunity. A timed reminder gets a push at its time; date-only ones are listed in one morning push. Only add what the person asked for.",
      inputSchema: { ...fields, title: z.string() },
    },
    async (args) => run(async () => createReminder(actor, readReminderInput(args))),
  );

  server.registerTool(
    "update_reminder",
    {
      description:
        "Change one of the person's open reminders. Omitted fields stay as they are. Changing the date or time of a repeating reminder changes it from then on. A done one has to be reopened first.",
      inputSchema: { id: z.uuid(), ...fields },
    },
    async ({ id, ...rest }) => run(async () => updateReminder(actor, id, readReminderInput(rest))),
  );

  server.registerTool(
    "complete_reminder",
    {
      description:
        "Tick off one of the person's reminders. For a repeating one, send dueOn, the date being ticked, as list_reminders shows it: a done copy is saved and the reminder moves to its next date. If it has already moved past that date nothing changes, so a retry never skips a date. doneId is what reopen_reminder takes to undo it.",
      inputSchema: { id: z.uuid(), dueOn: z.string().optional().describe("YYYY-MM-DD. Required for a repeating reminder.") },
    },
    async (args) => run(async () => completeReminder(actor, args.id, { dueOn: args.dueOn })),
  );

  server.registerTool(
    "reopen_reminder",
    {
      description:
        "Undo a tick: reopen a done reminder by its id, or by the doneId complete_reminder returned. For a repeating one this deletes the done copy and moves the reminder back, unless it has moved on since.",
      inputSchema: { id: z.uuid() },
    },
    async (args) => run(async () => reopenReminder(actor, args.id)),
  );

  server.registerTool(
    "delete_reminder",
    {
      description: "Delete one of the person's reminders for good. Done copies of a repeating reminder are kept. Only delete when the person asks.",
      inputSchema: { id: z.uuid() },
    },
    async (args) => run(async () => deleteReminder(actor, args.id)),
  );
}
