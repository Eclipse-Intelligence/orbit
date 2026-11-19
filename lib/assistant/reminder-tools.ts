import type { AssistantTool, Names } from "@/lib/assistant/tools";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import { completeReminder, createReminder, deleteReminder, getReminder, listReminders, reopenReminder, updateReminder } from "@/lib/crm/reminders";
import { readReminderInput } from "@/lib/crm/reminder-input";
import { readRepeat } from "@/lib/crm/task-series";
import { clockLabel, durationLabel } from "@/lib/crm/task-time";
import { dayKeyAt } from "@/lib/crm/working-days";
import { isDayKey, repeatSummary, shortDay } from "@/lib/task-repeat";
import { readDateTime } from "@/lib/time";

type Args = Record<string, unknown>;

export const REMINDER_ACTIONS = ["list", "create", "update", "complete", "reopen", "delete"] as const;
type ReminderAction = (typeof REMINDER_ACTIONS)[number];

export const REMINDER_ALIASES: Record<string, ReminderAction> = {
  list_reminders: "list",
  create_reminder: "create",
  update_reminder: "update",
  complete_reminder: "complete",
  reopen_reminder: "reopen",
  delete_reminder: "delete",
};

const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function actionOf(args: Args): ReminderAction | null {
  const action = text(args.action);
  return (REMINDER_ACTIONS as readonly string[]).includes(action) ? (action as ReminderAction) : null;
}

function titleKey(id: string) {
  return `${id}:reminder`;
}

function named(name: Names, args: Args) {
  const id = text(args.id);
  const found = id ? name(titleKey(id)) : "";
  return found && found !== titleKey(id) ? found : "a reminder";
}

function when(args: Args) {
  if (args.dueOn === null && args.dueAt === undefined) return "No date";
  const dueAt = text(args.dueAt);
  if (dueAt) {
    const reading = readDateTime(dueAt);
    if (!reading.ok) return `When: ${dueAt}`;
    const day = shortDay(dayKeyAt(reading.date));
    return reading.dateOnly ? day : `${day} at ${clockLabel(reading.date.toISOString())}`;
  }
  if (args.dueAt === null) return isDayKey(args.dueOn) ? `${shortDay(args.dueOn)}, no time` : "No time";
  return isDayKey(args.dueOn) ? shortDay(args.dueOn) : "";
}

function startDay(args: Args) {
  if (isDayKey(args.dueOn)) return args.dueOn;
  const reading = readDateTime(text(args.dueAt));
  return reading.ok ? dayKeyAt(reading.date) : dayKeyAt(new Date());
}

function repeatLine(args: Args) {
  if (args.repeat === undefined) return "";
  if (args.repeat === null) return "Stops repeating";
  try {
    const day = startDay(args);
    const { rule, ends } = readRepeat(args.repeat, day);
    return `Repeats: ${repeatSummary({ startsOn: day, at: null, rule, ends })}`;
  } catch {
    return "Repeats";
  }
}

function blockLine(args: Args) {
  if (args.blocksTime === true) return `Block time: ${durationLabel(typeof args.durationMinutes === "number" ? args.durationMinutes : 15)}`;
  if (args.blocksTime === false) return "Block time: off";
  if (typeof args.durationMinutes === "number") return `Length: ${durationLabel(args.durationMinutes)}`;
  return "";
}

function describeReminder(args: Args, name: Names) {
  const action = actionOf(args);
  if (action === "create") return { title: `Add reminder: ${text(args.title)}`, lines: [when(args) || "No date", blockLine(args), repeatLine(args)] };
  if (action === "update") {
    return {
      title: `Change reminder: ${named(name, args)}`,
      lines: [text(args.title) ? `Title: ${text(args.title)}` : "", when(args), blockLine(args), repeatLine(args)],
    };
  }
  if (action === "complete") return { title: `Tick off: ${named(name, args)}`, lines: [isDayKey(args.dueOn) ? `For ${shortDay(args.dueOn)}` : ""] };
  if (action === "reopen") return { title: `Undo tick: ${named(name, args)}`, lines: [] };
  if (action === "delete") return { title: `Delete reminder: ${named(name, args)}`, lines: [] };
  return { title: "Reminders", lines: [] };
}

async function reminderTitle(actor: Parameters<AssistantTool["run"]>[0], args: Args): Promise<Record<string, string>> {
  const id = text(args.id);
  if (!isUuid(id)) return {};
  const row = await withActor(actor, (db) => db.query<{ title: string }>("select title from crm.reminders where id = $1", [id]));
  return row.rows[0] ? { [titleKey(id)]: row.rows[0].title } : {};
}

async function runReminders(actor: Parameters<AssistantTool["run"]>[0], args: Args) {
  const action = actionOf(args);
  const id = text(args.id);
  if (!action) return { error: `Choose an action: ${REMINDER_ACTIONS.join(", ")}.`, field: "action" };
  if (action === "list") {
    if (id) return getReminder(actor, id);
    return listReminders(actor, {
      from: isDayKey(args.from) ? args.from : undefined,
      to: isDayKey(args.to) ? args.to : undefined,
      includeDone: args.includeDone === true,
    });
  }
  if (action === "create") return createReminder(actor, readReminderInput(args));
  if (!id) return { error: "Send the reminder's id from action list.", field: "id" };
  if (action === "update") return updateReminder(actor, id, readReminderInput(args));
  if (action === "complete") return completeReminder(actor, id, { dueOn: isDayKey(args.dueOn) ? args.dueOn : undefined });
  if (action === "reopen") return reopenReminder(actor, id);
  return deleteReminder(actor, id);
}

const WEEKDAY_LIST = { type: "string", enum: WEEKDAYS, description: "A weekday: mo, tu, we, th, fr, sa or su." };

export const REMINDERS_TOOL: AssistantTool = {
  name: "reminders",
  label: "Checking reminders",
  write: true,
  reads: (args) => actionOf(args) === "list",
  description:
    "The user's own reminders: small personal to-dos that aren't tasks, such as \"Remind me to put the bins out on Thursday\", with an optional date, time, Block time and repeat. They are private to the user and the same in every workspace. Anything about a contact, company or opportunity is a task, not a reminder. action list reads them (open first; includeDone adds those done in the last 30 days) and needs no approval. action create adds one; update changes one (omitted fields stay; a done one has to be reopened first); complete ticks one off (for a repeating one send dueOn, the date being ticked, as list shows it: a done copy is kept and it moves to its next date, and nothing changes if it has already moved past that date); reopen undoes a tick, by the id or the doneId complete returned; delete removes one. Every action but list needs the user's approval: proposing it shows them a card, and it only runs if they confirm. A timed reminder gets a push at its time; date-only ones are listed in one morning push.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...REMINDER_ACTIONS], description: "list, create, update, complete, reopen or delete." },
      id: { type: "string", description: "The reminder's id from action list. For list it returns just that one; needed for update, complete, reopen and delete." },
      title: { type: "string", description: "For create and update: what to be reminded of, up to 500 characters." },
      dueOn: {
        type: "string",
        description: "For create and update: the day, YYYY-MM-DD, in London. null takes the date (and time) off. Sent alone on update it keeps the reminder's time. For complete: the date being ticked, required for a repeating reminder.",
      },
      dueAt: {
        type: "string",
        description: "For create and update: a time, such as 2026-11-20T10:00 in London time, only when the user gave one. A new one can't be in the past. null keeps the day and drops the time.",
      },
      blocksTime: { type: "boolean", description: "For create and update: true puts it in the user's calendar and Outlook as busy. Needs a time. Only when the user asks to block the time." },
      durationMinutes: { type: "integer", minimum: 5, maximum: 480, description: "For create and update: the length of the block in minutes, 15 by default." },
      repeat: {
        type: "object",
        description: "For create and update: makes it repeat from its date, which it needs. null stops it repeating. Changing the date or time of a repeating reminder changes it from then on.",
        properties: {
          every: { type: "string", enum: ["day", "weekday", "week", "month", "year"], description: "weekday is Monday to Friday." },
          interval: { type: "integer", minimum: 1, maximum: 99, description: "Every 2 weeks and so on. Defaults to 1." },
          days: { type: "array", items: WEEKDAY_LIST, description: "For week: the days. Defaults to the date's weekday." },
          monthDay: { type: "integer", minimum: 1, maximum: 31, description: "For month: the date. The last day in shorter months." },
          monthWeek: {
            type: "object",
            description: "For month: a weekday such as the last Friday ({ n: -1, weekday: fr }).",
            properties: {
              n: { type: "integer", enum: [1, 2, 3, 4, -1], description: "Which one in the month: 1 to 4, or -1 for the last." },
              weekday: WEEKDAY_LIST,
            },
            required: ["n", "weekday"],
          },
          ends: {
            type: "object",
            description: "{ after: N } more times, or { on: YYYY-MM-DD }. Leave out to repeat for ever.",
            properties: {
              after: { type: "integer", minimum: 1, maximum: 999, description: "Stops after this many more times." },
              on: { type: "string", description: "The last day it can fall on, YYYY-MM-DD." },
            },
          },
        },
        required: ["every"],
      },
      from: { type: "string", description: "For list: only dated reminders on or after this day, YYYY-MM-DD." },
      to: { type: "string", description: "For list: only dated reminders on or before this day, YYYY-MM-DD." },
      includeDone: { type: "boolean", description: "For list: also those done in the last 30 days." },
    },
    required: ["action"],
  },
  details: (actor, args) => reminderTitle(actor, args),
  describe: (args, name) => describeReminder(args, name),
  run: (actor, args) => runReminders(actor, args),
};
