import { getBookingPage } from "@/lib/booking/pages";
import { BULK_LIMIT, runBulk } from "@/lib/crm/bulk";
import { listActivities } from "@/lib/crm/activities";
import { getCalendarStatus, getMeetings, listPeopleMet } from "@/lib/crm/calendar";
import { listCalendarItems } from "@/lib/crm/calendars";
import { getInsightTranscript, getInsightsForActivities } from "@/lib/crm/call-insights";
import { createTaskWithClickUp, getClickUpPicker, getClickUpState, pushClickUpTask } from "@/lib/crm/clickup";
import { createCompany, listCompanies, listMembers, updateCompany } from "@/lib/crm/companies";
import { createContact, getContact, listContacts, updateContact } from "@/lib/crm/contacts";
import { listUnfiledImports } from "@/lib/crm/conversations";
import { listEmailTemplates } from "@/lib/crm/email-templates";
import { CrmError } from "@/lib/crm/errors";
import { getGranolaStatus } from "@/lib/crm/granola";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { getMailbox, listInbox, sendContactEmail } from "@/lib/crm/inbox";
import { createInvite, getMeetingLink } from "@/lib/crm/invites";
import { createOpportunity, getOpportunity, listOpportunities, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { getMyEmails } from "@/lib/crm/profile";
import { REMINDER_OPTIONS } from "@/lib/crm/reminder-options";
import { findStaleRelationships, getCompanyContext, listAttention } from "@/lib/crm/relationships";
import { addTags, listTags, removeTags } from "@/lib/crm/tags";
import { completeTask, listTasks, updateTask } from "@/lib/crm/tasks";
import { logActivity } from "@/lib/crm/activities";
import {
  ACTIVITY_TYPES,
  LIFECYCLES,
  OPPORTUNITY_STATUSES,
  TASK_VIEWS,
  type Activity,
  type Company,
  type Contact,
  type Opportunity,
  type Task,
  type UserActor,
} from "@/lib/crm/types";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import type { Scope } from "@/lib/crm/scopes";
import { formatDateLabel, formatDateTimeLabel } from "@/lib/date-input";
import { appTimeZone, parseDateTime, zonedParts } from "@/lib/time";

type Args = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

export type AssistantTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  write?: boolean;
  label: string;
  run: (actor: UserActor, args: Args) => Promise<unknown>;
  describe?: (args: Args, name: Names) => { title: string; lines: string[] };
};

type Names = (id: unknown) => string;

const PROVENANCE = { source: "assistant" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStr(value: unknown) {
  const text = str(value);
  return text || undefined;
}

function nullableStr(value: unknown) {
  if (value === null) return null;
  return optionalStr(value);
}

function int(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function oneOf<T extends string>(value: unknown, options: readonly T[]) {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : undefined;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function required(value: unknown, label: string) {
  const text = str(value);
  if (!text) throw new CrmError("invalid_input", `${label} is required.`, 400);
  return text;
}

function withCompany(company: Company) {
  return { ...company, href: companyHref(company.id) };
}

function withContact(contact: Contact) {
  return { ...contact, href: contactHref(contact.id), companyHref: contact.companyId ? companyHref(contact.companyId) : null };
}

function withOpportunity(opportunity: Opportunity) {
  return {
    ...opportunity,
    href: `/opportunities?q=${encodeURIComponent(opportunity.name)}`,
    companyHref: companyHref(opportunity.companyId),
  };
}

function withTask(task: Task) {
  return {
    ...task,
    reminder: REMINDER_OPTIONS.find((option) => option.minutes === task.remindMinutes)?.label ?? null,
    inClickUp: Boolean(task.clickupTaskId),
    companyHref: task.companyId ? companyHref(task.companyId) : null,
    contactHref: task.contactId ? contactHref(task.contactId) : null,
  };
}

function withActivity(activity: Activity) {
  return {
    ...activity,
    companyHref: activity.companyId ? companyHref(activity.companyId) : null,
    contactHref: activity.contactId ? contactHref(activity.contactId) : null,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function londonTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const wall = zonedParts(date, appTimeZone());
  const offsetMinutes = Math.round(
    (Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(date.getTime() / 1000) * 1000) /
      60000,
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(offsetMinutes);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

export function toolJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "string" && ISO.test(item) ? londonTime(item) : item));
}

function dayStart(value: unknown, fallback: Date) {
  const text = str(value);
  if (!text) return fallback;
  const parsed = parseDateTime(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00` : text);
  return parsed ?? fallback;
}

function londonMidnight() {
  const wall = zonedParts(new Date(), appTimeZone());
  const pad = (value: number) => String(value).padStart(2, "0");
  return parseDateTime(`${wall.year}-${pad(wall.month)}-${pad(wall.day)}T00:00`) ?? new Date();
}

function pushIfLinked(actor: UserActor, task: Task) {
  if (!task.clickupListId) return Promise.resolve();
  return pushClickUpTask(actor, task.id).then(
    () => undefined,
    () => undefined,
  );
}

function shown(key: string, value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  const text = String(value);
  if (key === "dueAt" || key === "startLocal") return formatDateTimeLabel(text);
  if (key === "expectedCloseDate") return formatDateLabel(text);
  if (key === "remindMinutes") return REMINDER_OPTIONS.find((option) => option.minutes === value)?.label ?? text;
  if (key === "value" && typeof value === "number") return value.toLocaleString("en-GB");
  return text;
}

const ID_FIELDS = new Set(["companyId", "contactId", "ownerId", "stageId", "primaryContactId", "taskId", "opportunityId"]);

function fieldLines(args: Args, labels: Record<string, string>, name?: Names) {
  return Object.entries(labels)
    .filter(([key]) => args[key] !== undefined && args[key] !== null && args[key] !== "")
    .map(([key, label]) => `${label}: ${name && ID_FIELDS.has(key) ? name(args[key]) : shown(key, args[key])}`);
}

function nameList(ids: string[], name: Names, noun: string) {
  const shownNames = ids.slice(0, 6).map(name);
  const rest = ids.length - shownNames.length;
  return `${noun}: ${shownNames.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

function titled(verb: string, label: string | undefined) {
  return label ? `${verb}: ${label}` : verb;
}

const idParam = (description: string) => ({ type: "string", description });
const limitParam = { type: "integer", description: "How many to return, up to 100. Defaults to 50.", minimum: 1, maximum: 100 };
const offsetParam = { type: "integer", description: "How many to skip, for the next page.", minimum: 0 };

const TASK_FIELDS = {
  title: { type: "string", description: "What needs doing." },
  description: { type: "string", description: "Extra detail." },
  dueAt: { type: "string", description: "Due date and time in London time as YYYY-MM-DDTHH:mm, or null to clear." },
  remindMinutes: {
    type: "integer",
    enum: REMINDER_OPTIONS.map((option) => option.minutes),
    description: "Reminder before the due time in minutes: 0, 5, 10, 15, 30, 60, 120, 1440, 2880 or 10080. Needs a due date.",
  },
  priority: { type: "string", enum: ["low", "normal", "high"] },
};

const COMPANY_FIELDS = {
  name: { type: "string" },
  domain: { type: "string", description: "Website domain such as acme.com." },
  website: { type: "string" },
  description: { type: "string" },
  industry: { type: "string" },
  sizeCategory: { type: "string" },
  lifecycle: { type: "string", enum: [...LIFECYCLES] },
  ownerId: { type: "string", description: "Team member id from list_team_members." },
  source: { type: "string" },
};

const CONTACT_FIELDS = {
  firstName: { type: "string" },
  lastName: { type: "string" },
  email: { type: "string" },
  phone: { type: "string" },
  jobTitle: { type: "string" },
  linkedinUrl: { type: "string" },
  companyId: { type: "string", description: "Company id to link the person to." },
  ownerId: { type: "string" },
  source: { type: "string" },
  notes: { type: "string" },
};

const OPPORTUNITY_FIELDS = {
  name: { type: "string" },
  stageId: { type: "string", description: "Stage id from get_pipeline." },
  status: { type: "string", enum: [...OPPORTUNITY_STATUSES] },
  value: { type: "number" },
  currency: { type: "string", description: "Three-letter currency code. Defaults to GBP." },
  probability: { type: "integer", minimum: 0, maximum: 100 },
  expectedCloseDate: { type: "string", description: "YYYY-MM-DD." },
  primaryContactId: { type: "string" },
  ownerId: { type: "string" },
  source: { type: "string" },
};

const BULK_COMPANY_KEYS = ["ownerId", "lifecycle", "industry", "sizeCategory", "source"];
const BULK_CONTACT_KEYS = ["ownerId", "companyId", "jobTitle", "source"];

function pickSchema(fields: Record<string, JsonSchema>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, fields[key]]));
}

async function bulkUpdate(actor: UserActor, scope: Scope, ids: unknown, update: (id: string) => Promise<unknown>) {
  const outcomes = await runBulk(actor, scope, ids, update);
  const failed = outcomes.flatMap((outcome) => (outcome.ok ? [] : [{ id: outcome.id, error: outcome.error }]));
  const updated = outcomes.length - failed.length;
  if (updated === 0) return { error: failed[0]?.error ?? "Nothing was updated.", failed };
  return { updated, failed };
}

function pick(args: Args, keys: string[]) {
  const out: Args = {};
  for (const key of keys) {
    if (args[key] === undefined) continue;
    out[key] = typeof args[key] === "string" ? (args[key] as string).trim() || null : args[key];
  }
  return out;
}

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "get_overview",
    label: "Checking today",
    description:
      "Today at a glance: overdue tasks, tasks due today, meetings in the next two days, quiet relationships and counts. Use this for 'what should I focus on' style questions.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => {
      const now = new Date();
      const [attention, overdue, today, meetings, quiet] = await Promise.all([
        listAttention(actor),
        listTasks(actor, { view: "overdue", limit: 100 }),
        listTasks(actor, { view: "today", limit: 100 }),
        listCalendarItems(actor, { start: now, end: new Date(now.getTime() + 2 * DAY_MS) }),
        findStaleRelationships(actor, 21, 25),
      ]);
      return {
        now: now.toISOString(),
        overdueTasks: overdue.data.map(withTask),
        dueToday: today.data.map(withTask),
        attention,
        meetingsNextTwoDays: meetings,
        quietRelationships: quiet,
      };
    },
  },
  {
    name: "search_records",
    label: "Searching Orbit",
    description: "Search companies, people and opportunities by name, email, domain or company. Use it to find ids before other tools.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    run: async (actor, args) => {
      const query = required(args.query, "A search");
      const [companies, contacts, opportunities] = await Promise.all([
        listCompanies(actor, { query, limit: 25, sort: "name", order: "asc" }),
        listContacts(actor, { query, limit: 25 }),
        listOpportunities(actor, { query, limit: 25 }),
      ]);
      return {
        companies: companies.data.map(withCompany),
        contacts: contacts.data.map(withContact),
        opportunities: opportunities.data.map(withOpportunity),
      };
    },
  },
  {
    name: "list_companies",
    label: "Looking at companies",
    description: "List companies with optional search and filters. Returns total and a page of companies.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        lifecycle: { type: "string", enum: [...LIFECYCLES] },
        tag: { type: "string" },
        ownerId: { type: "string", description: "Member id, or 'unassigned'." },
        sort: { type: "string", enum: ["name", "domain", "updated", "created"] },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: limitParam,
        offset: offsetParam,
      },
    },
    run: async (actor, args) => {
      const result = await listCompanies(actor, {
        query: optionalStr(args.query),
        lifecycle: oneOf(args.lifecycle, LIFECYCLES),
        tag: optionalStr(args.tag),
        ownerId: optionalStr(args.ownerId),
        sort: oneOf(args.sort, ["name", "domain", "updated", "created"] as const),
        order: oneOf(args.order, ["asc", "desc"] as const),
        limit: int(args.limit, 50, 1, 100),
        offset: int(args.offset, 0, 0, 10000),
      });
      return { ...result, data: result.data.map(withCompany) };
    },
  },
  {
    name: "get_company",
    label: "Reading a company",
    description:
      "Everything about one company: details, people, opportunities, open and done tasks, the full activity timeline, call summaries, upcoming and recent meetings, and relationship status.",
    parameters: { type: "object", properties: { companyId: idParam("Company id.") }, required: ["companyId"] },
    run: async (actor, args) => {
      const id = required(args.companyId, "A company id");
      const [context, meetings] = await Promise.all([getCompanyContext(actor, id), getMeetings(actor, { companyId: id })]);
      return {
        ...context,
        company: withCompany(context.company),
        contacts: context.contacts.map(withContact),
        opportunities: context.opportunities.map(withOpportunity),
        tasks: context.tasks.map(withTask),
        timeline: context.timeline.map(withActivity),
        activities: undefined,
        meetings,
      };
    },
  },
  {
    name: "list_contacts",
    label: "Looking at people",
    description: "List people with optional search, company and tag filters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        companyId: { type: "string" },
        tag: { type: "string" },
        ownerId: { type: "string" },
        limit: limitParam,
        offset: offsetParam,
      },
    },
    run: async (actor, args) => {
      const result = await listContacts(actor, {
        query: optionalStr(args.query),
        companyId: optionalStr(args.companyId),
        tag: optionalStr(args.tag),
        ownerId: optionalStr(args.ownerId),
        limit: int(args.limit, 50, 1, 100),
        offset: int(args.offset, 0, 0, 10000),
      });
      return { ...result, data: result.data.map(withContact) };
    },
  },
  {
    name: "get_contact",
    label: "Reading a person",
    description: "Everything about one person: details, company, tasks, the activity timeline with call summaries, and meetings.",
    parameters: { type: "object", properties: { contactId: idParam("Contact id.") }, required: ["contactId"] },
    run: async (actor, args) => {
      const id = required(args.contactId, "A contact id");
      const [contact, tasks, activities, meetings] = await Promise.all([
        getContact(actor, id),
        listTasks(actor, { contactId: id, view: "all", limit: 100 }),
        listActivities(actor, { contactId: id, limit: 100 }),
        getMeetings(actor, { contactId: id }),
      ]);
      const completed = await listTasks(actor, { contactId: id, view: "completed", limit: 50 });
      const insights = await getInsightsForActivities(
        actor,
        activities.data.map((activity) => activity.id),
      );
      return {
        contact: withContact(contact),
        openTasks: tasks.data.map(withTask),
        completedTasks: completed.data.map(withTask),
        timeline: activities.data.map(withActivity),
        callSummaries: insights,
        meetings,
      };
    },
  },
  {
    name: "list_tasks",
    label: "Checking tasks",
    description:
      "List tasks. view: all (every open task), overdue, today, upcoming, completed. Each task includes due date, reminder, company, contact and ClickUp link and sync status.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: TASK_VIEWS.filter((view) => view !== "none") },
        query: { type: "string" },
        companyId: { type: "string" },
        contactId: { type: "string" },
        limit: limitParam,
        offset: offsetParam,
      },
    },
    run: async (actor, args) => {
      const result = await listTasks(actor, {
        view: oneOf(args.view, TASK_VIEWS) ?? "all",
        query: optionalStr(args.query),
        companyId: optionalStr(args.companyId),
        contactId: optionalStr(args.contactId),
        limit: int(args.limit, 100, 1, 100),
        offset: int(args.offset, 0, 0, 10000),
      });
      return { ...result, data: result.data.map(withTask) };
    },
  },
  {
    name: "get_pipeline",
    label: "Reviewing the pipeline",
    description:
      "The sales pipeline: every stage with its opportunities, values and totals, plus won and lost. Optionally only opportunities expected to close within N days.",
    parameters: {
      type: "object",
      properties: {
        closingWithinDays: { type: "integer", minimum: 1, maximum: 730, description: "Only include open opportunities closing within this many days." },
      },
    },
    run: async (actor, args) => {
      const pipeline = await listPipeline(actor);
      const all: Opportunity[] = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const page = await listOpportunities(actor, { limit: 100, offset });
        all.push(...page.data);
        if (page.data.length < 100) break;
      }
      const within = args.closingWithinDays === undefined ? null : int(args.closingWithinDays, 30, 1, 730);
      const cutoff = within ? Date.now() + within * DAY_MS : null;
      const shown = cutoff
        ? all.filter(
            (opportunity) =>
              opportunity.status === "open" &&
              opportunity.expectedCloseDate !== null &&
              new Date(`${opportunity.expectedCloseDate}T23:59:59Z`).getTime() <= cutoff,
          )
        : all;
      const value = (items: Opportunity[]) => items.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
      return {
        closingWithinDays: within,
        stages: pipeline.stages.map((stage) => {
          const items = shown.filter((opportunity) => opportunity.stageId === stage.id);
          return {
            ...stage,
            count: items.length,
            totalValue: value(items),
            weightedValue: items.reduce((sum, item) => sum + (Number(item.value) || 0) * ((item.probability ?? stage.probability) / 100), 0),
            opportunities: items.map(withOpportunity),
          };
        }),
        withoutStage: shown.filter((opportunity) => !opportunity.stageId).map(withOpportunity),
        totals: {
          open: value(shown.filter((item) => item.status === "open")),
          won: value(shown.filter((item) => item.status === "won")),
          lost: value(shown.filter((item) => item.status === "lost")),
          count: shown.length,
        },
      };
    },
  },
  {
    name: "list_opportunities",
    label: "Looking at opportunities",
    description: "List opportunities with optional search, company and status filters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        companyId: { type: "string" },
        status: { type: "string", enum: [...OPPORTUNITY_STATUSES] },
        limit: limitParam,
        offset: offsetParam,
      },
    },
    run: async (actor, args) => {
      const result = await listOpportunities(actor, {
        query: optionalStr(args.query),
        companyId: optionalStr(args.companyId),
        status: oneOf(args.status, OPPORTUNITY_STATUSES),
        limit: int(args.limit, 50, 1, 100),
        offset: int(args.offset, 0, 0, 10000),
      });
      return { ...result, data: result.data.map(withOpportunity) };
    },
  },
  {
    name: "list_activities",
    label: "Reading activity",
    description: "List logged activity (calls, emails, meetings, notes and more), newest first, with optional search and filters. Includes call summaries for calls.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        companyId: { type: "string" },
        contactId: { type: "string" },
        type: { type: "string", enum: [...ACTIVITY_TYPES] },
        limit: limitParam,
        offset: offsetParam,
      },
    },
    run: async (actor, args) => {
      const result = await listActivities(actor, {
        query: optionalStr(args.query),
        companyId: optionalStr(args.companyId),
        contactId: optionalStr(args.contactId),
        type: oneOf(args.type, ACTIVITY_TYPES),
        limit: int(args.limit, 50, 1, 100),
        offset: int(args.offset, 0, 0, 10000),
      });
      const insights = await getInsightsForActivities(
        actor,
        result.data.filter((activity) => activity.type === "call" || activity.type === "meeting").map((activity) => activity.id),
      );
      return { ...result, data: result.data.map(withActivity), callSummaries: insights };
    },
  },
  {
    name: "get_call_transcript",
    label: "Reading a transcript",
    description: "The full transcript behind a call summary. Use the insight id from callSummaries.",
    parameters: { type: "object", properties: { insightId: idParam("Call summary id.") }, required: ["insightId"] },
    run: async (actor, args) => ({ transcript: await getInsightTranscript(actor, required(args.insightId, "A call summary id")) }),
  },
  {
    name: "list_calendar_events",
    label: "Checking the calendar",
    description: "Calendar events across the connected calendars between two dates (London), up to 62 days apart.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        to: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to 7 days after from." },
      },
    },
    run: async (actor, args) => {
      const start = dayStart(args.from, londonMidnight());
      const requestedEnd = args.to ? dayStart(args.to, start) : new Date(start.getTime() + 7 * DAY_MS);
      const end = new Date(Math.min(requestedEnd.getTime() + (args.to ? DAY_MS : 0), start.getTime() + 62 * DAY_MS));
      const [events, status] = await Promise.all([listCalendarItems(actor, { start, end }), getCalendarStatus(actor)]);
      return { from: start.toISOString(), to: end.toISOString(), calendarConnected: status?.connected ?? false, events };
    },
  },
  {
    name: "get_inbox",
    label: "Checking the inbox",
    description: "Recent mail filed to records, unfiled conversations from Teams and Granola waiting to be filed, and people met in meetings who aren't contacts yet.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => {
      const [mailbox, messages, unfiled, people] = await Promise.all([
        getMailbox(actor),
        listInbox(actor),
        listUnfiledImports(actor, 50),
        listPeopleMet(actor),
      ]);
      return { mailbox, recentMail: messages, unfiledConversations: unfiled, peopleMet: people };
    },
  },
  {
    name: "list_quiet_relationships",
    label: "Finding quiet relationships",
    description: "Companies with no interaction in the last N days (default 21).",
    parameters: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 3650 } } },
    run: async (actor, args) => ({ companies: await findStaleRelationships(actor, int(args.days, 21, 1, 3650), 100) }),
  },
  {
    name: "list_tags",
    label: "Reading tags",
    description: "Every tag with how many companies and people use it.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => ({ tags: await listTags(actor) }),
  },
  {
    name: "list_team_members",
    label: "Reading the team",
    description: "Workspace members with their ids, for owners.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => ({ members: await listMembers(actor), you: { id: actor.userId, email: actor.email, name: actor.fullName } }),
  },
  {
    name: "list_email_templates",
    label: "Reading email templates",
    description: "Saved email templates with their subject, body and tags. Tokens like {{first_name}} are filled in per person.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => ({ templates: await listEmailTemplates(actor) }),
  },
  {
    name: "get_settings",
    label: "Checking settings",
    description: "Your meeting link, your email addresses, the booking page, and the status of Microsoft mail and calendar, ClickUp and Granola.",
    parameters: { type: "object", properties: {} },
    run: async (actor) => {
      const [meetingLink, emails, booking, mailbox, calendar, clickup, picker, granola] = await Promise.all([
        getMeetingLink(actor),
        getMyEmails(actor),
        getBookingPage(actor),
        getMailbox(actor),
        getCalendarStatus(actor),
        getClickUpState(actor),
        getClickUpPicker(actor),
        getGranolaStatus(actor),
      ]);
      return {
        meetingLink,
        myEmails: emails,
        bookingPage: { ...booking, publicUrl: booking.exists ? `/book/${booking.slug}` : null },
        microsoftMail: mailbox,
        calendar,
        clickup: clickup
          ? {
              connected: Boolean(clickup.teamId),
              defaultListId: clickup.defaultListId,
              lists: picker?.lists ?? [],
              instantSync: Boolean(clickup.webhookId),
              lastSyncedAt: clickup.lastSyncedAt,
              lastError: clickup.lastError,
            }
          : { connected: false },
        granola: {
          configured: granola.configured,
          lastSyncedAt: granola.lastSyncedAt,
          lastError: granola.lastError,
          instantSync: granola.webhookEnabled,
        },
      };
    },
  },

  {
    name: "create_task",
    label: "Creating a task",
    write: true,
    description: "Create a task. It goes to the default ClickUp list unless sendToClickUp is false.",
    parameters: {
      type: "object",
      properties: {
        ...TASK_FIELDS,
        companyId: { type: "string" },
        contactId: { type: "string" },
        sendToClickUp: { type: "boolean", description: "Defaults to true." },
      },
      required: ["title"],
    },
    describe: (args, name) => ({
      title: `Create task: ${str(args.title)}`,
      lines: [
        ...fieldLines(args, { companyId: "Company", contactId: "Person", dueAt: "Due", description: "Detail", priority: "Priority" }, name),
        ...fieldLines(args, { remindMinutes: "Reminder" }),
        `ClickUp: ${args.sendToClickUp === false ? "no" : "yes"}`,
      ],
    }),
    run: async (actor, args) => {
      const picker = args.sendToClickUp === false ? null : await getClickUpPicker(actor);
      const created = await createTaskWithClickUp(
        actor,
        {
          title: required(args.title, "A title"),
          description: nullableStr(args.description),
          dueAt: nullableStr(args.dueAt),
          remindMinutes: str(args.dueAt) && typeof args.remindMinutes === "number" ? args.remindMinutes : null,
          priority: oneOf(args.priority, ["low", "normal", "high"] as const) ?? "normal",
          companyId: optionalStr(args.companyId) ?? null,
          contactId: optionalStr(args.contactId) ?? null,
        },
        picker?.listId ?? null,
        { provenance: { operation: "create_task", ...PROVENANCE } },
      );
      return { task: withTask(created.task), clickupError: created.clickupError };
    },
  },
  {
    name: "update_task",
    label: "Updating a task",
    write: true,
    description: "Change a task's title, detail, due date, reminder or priority. ClickUp is updated too.",
    parameters: {
      type: "object",
      properties: { taskId: idParam("Task id."), ...TASK_FIELDS },
      required: ["taskId"],
    },
    describe: (args, name) => ({
      title: titled("Update task", name(args.taskId)),
      lines: fieldLines(args, { title: "Title", dueAt: "Due", remindMinutes: "Reminder", priority: "Priority", description: "Detail" }),
    }),
    run: async (actor, args) => {
      const id = required(args.taskId, "A task id");
      const updated = await updateTask(
        actor,
        id,
        {
          ...(args.title !== undefined ? { title: str(args.title) } : {}),
          ...(args.description !== undefined ? { description: nullableStr(args.description) ?? null } : {}),
          ...(args.dueAt !== undefined ? { dueAt: nullableStr(args.dueAt) ?? null } : {}),
          ...(args.remindMinutes !== undefined ? { remindMinutes: typeof args.remindMinutes === "number" ? args.remindMinutes : null } : {}),
          ...(args.priority !== undefined ? { priority: oneOf(args.priority, ["low", "normal", "high"] as const) } : {}),
        },
        { provenance: { operation: "update_task", ...PROVENANCE } },
      );
      await pushIfLinked(actor, updated.body.task);
      return { task: withTask(updated.body.task) };
    },
  },
  {
    name: "complete_task",
    label: "Completing a task",
    write: true,
    description: "Mark a task as done. ClickUp is updated too.",
    parameters: { type: "object", properties: { taskId: idParam("Task id.") }, required: ["taskId"] },
    describe: (args, name) => ({ title: titled("Mark task done", name(args.taskId)), lines: [] }),
    run: async (actor, args) => {
      const done = await completeTask(actor, required(args.taskId, "A task id"), {
        provenance: { operation: "complete_task", ...PROVENANCE },
      });
      await pushIfLinked(actor, done.body.task);
      return { task: withTask(done.body.task) };
    },
  },
  {
    name: "log_activity",
    label: "Logging activity",
    write: true,
    description: "Log a note, call or email against a company and/or person.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["note", "call", "email"] },
        companyId: { type: "string" },
        contactId: { type: "string" },
        title: { type: "string", description: "Subject or call summary line." },
        body: { type: "string" },
      },
      required: ["type", "body"],
    },
    describe: (args, name) => ({
      title: `Log ${str(args.type) || "note"}`,
      lines: fieldLines(args, { companyId: "Company", contactId: "Person", title: "Title", body: "Text" }, name),
    }),
    run: async (actor, args) => {
      const type = oneOf(args.type, ["note", "call", "email"] as const) ?? "note";
      const activity = await logActivity(
        actor,
        { companyId: optionalStr(args.companyId) ?? null, contactId: optionalStr(args.contactId) ?? null },
        type,
        str(args.title),
        str(args.body),
        { provenance: { operation: "assistant_log_activity", ...PROVENANCE } },
      );
      return { activity };
    },
  },
  {
    name: "create_company",
    label: "Creating a company",
    write: true,
    description: "Add a company.",
    parameters: {
      type: "object",
      properties: { ...COMPANY_FIELDS, tags: { type: "array", items: { type: "string" } } },
      required: ["name"],
    },
    describe: (args, name) => ({
      title: `Create company: ${str(args.name)}`,
      lines: fieldLines(args, { domain: "Domain", website: "Website", industry: "Industry", lifecycle: "Lifecycle", ownerId: "Owner", description: "About", tags: "Tags" }, name),
    }),
    run: async (actor, args) => {
      const created = await createCompany(
        actor,
        { ...pick(args, Object.keys(COMPANY_FIELDS)), name: required(args.name, "A name"), tags: strings(args.tags) },
        { provenance: { operation: "create_company", ...PROVENANCE } },
      );
      return { company: withCompany(created.body.company) };
    },
  },
  {
    name: "update_company",
    label: "Updating a company",
    write: true,
    description: "Change a company's details. Only the fields you pass change.",
    parameters: { type: "object", properties: { companyId: idParam("Company id."), ...COMPANY_FIELDS }, required: ["companyId"] },
    describe: (args, name) => ({
      title: titled("Update company", name(args.companyId)),
      lines: fieldLines(args, { name: "Name", domain: "Domain", website: "Website", industry: "Industry", lifecycle: "Lifecycle", ownerId: "Owner", description: "About" }, name),
    }),
    run: async (actor, args) => {
      const updated = await updateCompany(actor, required(args.companyId, "A company id"), pick(args, Object.keys(COMPANY_FIELDS)), {
        provenance: { operation: "update_company", ...PROVENANCE },
      });
      return { company: withCompany(updated.body.company) };
    },
  },
  {
    name: "update_companies",
    label: "Updating companies",
    write: true,
    description: `Make the same change to many companies at once, for example a new owner or lifecycle. Up to ${BULK_LIMIT} companies per call. Use this instead of many update_company calls.`,
    parameters: {
      type: "object",
      properties: { companyIds: { type: "array", items: { type: "string" } }, ...pickSchema(COMPANY_FIELDS, BULK_COMPANY_KEYS) },
      required: ["companyIds"],
    },
    describe: (args, name) => {
      const ids = strings(args.companyIds);
      return {
        title: `Update ${ids.length} ${ids.length === 1 ? "company" : "companies"}`,
        lines: [...fieldLines(args, { ownerId: "Owner", lifecycle: "Lifecycle", industry: "Industry", sizeCategory: "Size", source: "Source" }, name), nameList(ids, name, "Companies")],
      };
    },
    run: (actor, args) =>
      bulkUpdate(actor, "companies:write", args.companyIds, (id) =>
        updateCompany(actor, id, pick(args, BULK_COMPANY_KEYS), { provenance: { operation: "update_companies", ...PROVENANCE } }),
      ),
  },
  {
    name: "create_contact",
    label: "Creating a contact",
    write: true,
    description: "Add a person, optionally linked to a company.",
    parameters: {
      type: "object",
      properties: { ...CONTACT_FIELDS, tags: { type: "array", items: { type: "string" } } },
    },
    describe: (args, name) => ({
      title: `Create contact: ${[str(args.firstName), str(args.lastName)].filter(Boolean).join(" ") || str(args.email)}`,
      lines: fieldLines(args, { email: "Email", phone: "Phone", jobTitle: "Job title", companyId: "Company", ownerId: "Owner", tags: "Tags" }, name),
    }),
    run: async (actor, args) => {
      const created = await createContact(
        actor,
        { ...pick(args, Object.keys(CONTACT_FIELDS)), tags: strings(args.tags) },
        { provenance: { operation: "create_contact", ...PROVENANCE } },
      );
      return { contact: withContact(created.body.contact) };
    },
  },
  {
    name: "update_contact",
    label: "Updating a contact",
    write: true,
    description: "Change a person's details. Only the fields you pass change.",
    parameters: { type: "object", properties: { contactId: idParam("Contact id."), ...CONTACT_FIELDS }, required: ["contactId"] },
    describe: (args, name) => ({
      title: titled("Update contact", name(args.contactId)),
      lines: fieldLines(
        args,
        { firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone", jobTitle: "Job title", companyId: "Company", ownerId: "Owner", notes: "Notes" },
        name,
      ),
    }),
    run: async (actor, args) => {
      const updated = await updateContact(actor, required(args.contactId, "A contact id"), pick(args, Object.keys(CONTACT_FIELDS)), {
        provenance: { operation: "update_contact", ...PROVENANCE },
      });
      return { contact: withContact(updated.body.contact) };
    },
  },
  {
    name: "update_contacts",
    label: "Updating people",
    write: true,
    description: `Make the same change to many people at once, for example a new owner or company. Up to ${BULK_LIMIT} people per call. Use this instead of many update_contact calls.`,
    parameters: {
      type: "object",
      properties: { contactIds: { type: "array", items: { type: "string" } }, ...pickSchema(CONTACT_FIELDS, BULK_CONTACT_KEYS) },
      required: ["contactIds"],
    },
    describe: (args, name) => {
      const ids = strings(args.contactIds);
      return {
        title: `Update ${ids.length} ${ids.length === 1 ? "person" : "people"}`,
        lines: [...fieldLines(args, { ownerId: "Owner", companyId: "Company", jobTitle: "Job title", source: "Source" }, name), nameList(ids, name, "People")],
      };
    },
    run: (actor, args) =>
      bulkUpdate(actor, "contacts:write", args.contactIds, (id) =>
        updateContact(actor, id, pick(args, BULK_CONTACT_KEYS), { provenance: { operation: "update_contacts", ...PROVENANCE } }),
      ),
  },
  {
    name: "create_opportunity",
    label: "Creating an opportunity",
    write: true,
    description: "Add an opportunity to the pipeline for a company.",
    parameters: {
      type: "object",
      properties: { companyId: idParam("Company id."), ...OPPORTUNITY_FIELDS },
      required: ["companyId", "name"],
    },
    describe: (args, name) => ({
      title: `Create opportunity: ${str(args.name)}`,
      lines: fieldLines(
        args,
        { companyId: "Company", value: "Value", currency: "Currency", stageId: "Stage", expectedCloseDate: "Expected close", probability: "Probability", ownerId: "Owner" },
        name,
      ),
    }),
    run: async (actor, args) => {
      const created = await createOpportunity(
        actor,
        { ...pick(args, Object.keys(OPPORTUNITY_FIELDS)), companyId: required(args.companyId, "A company id"), name: required(args.name, "A name") },
        { provenance: { operation: "create_opportunity", ...PROVENANCE } },
      );
      return { opportunity: withOpportunity(created.body.opportunity) };
    },
  },
  {
    name: "update_opportunity",
    label: "Updating an opportunity",
    write: true,
    description: "Move an opportunity to another stage, mark it won or lost, or change its value, close date or probability.",
    parameters: {
      type: "object",
      properties: { opportunityId: idParam("Opportunity id."), ...OPPORTUNITY_FIELDS },
      required: ["opportunityId"],
    },
    describe: (args, name) => ({
      title: titled("Update opportunity", name(args.opportunityId)),
      lines: fieldLines(
        args,
        { name: "Name", stageId: "Stage", status: "Status", value: "Value", expectedCloseDate: "Expected close", probability: "Probability", ownerId: "Owner" },
        name,
      ),
    }),
    run: async (actor, args) => {
      const id = required(args.opportunityId, "An opportunity id");
      await getOpportunity(actor, id);
      const updated = await updateOpportunity(actor, id, pick(args, Object.keys(OPPORTUNITY_FIELDS)), {
        provenance: { operation: "update_opportunity", ...PROVENANCE },
      });
      return { opportunity: withOpportunity(updated.body.opportunity) };
    },
  },
  {
    name: "tag_records",
    label: "Tagging records",
    write: true,
    description: "Add and/or remove tags on companies or people.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["company", "contact"] },
        ids: { type: "array", items: { type: "string" } },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "ids"],
    },
    describe: (args, name) => ({
      title: `Tag ${strings(args.ids).length} ${args.kind === "contact" ? "people" : "companies"}`,
      lines: [...fieldLines(args, { add: "Add", remove: "Remove" }), nameList(strings(args.ids), name, args.kind === "contact" ? "People" : "Companies")],
    }),
    run: async (actor, args) => {
      const kind = oneOf(args.kind, ["company", "contact"] as const) ?? "company";
      const ids = strings(args.ids);
      if (strings(args.add).length) await addTags(actor, kind, ids, strings(args.add));
      if (strings(args.remove).length) await removeTags(actor, kind, ids, strings(args.remove));
      return { kind, ids, added: strings(args.add), removed: strings(args.remove) };
    },
  },
  {
    name: "send_email",
    label: "Sending an email",
    write: true,
    description: "Send an email to a person from your connected Outlook mailbox. It is logged on their timeline.",
    parameters: {
      type: "object",
      properties: { contactId: idParam("Contact id."), subject: { type: "string" }, body: { type: "string" } },
      required: ["contactId", "subject", "body"],
    },
    describe: (args, name) => ({
      title: `Send email: ${str(args.subject)}`,
      lines: [`To: ${name(args.contactId)}`, str(args.body)],
    }),
    run: async (actor, args) => {
      const result = await sendContactEmail(actor, required(args.contactId, "A contact id"), {
        subject: required(args.subject, "A subject"),
        body: required(args.body, "A message"),
      });
      return { sent: true, warning: result.warning };
    },
  },
  {
    name: "create_meeting_invite",
    label: "Sending an invite",
    write: true,
    description: "Create an Outlook meeting and send invites. Times are London time.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        startLocal: { type: "string", description: "YYYY-MM-DDTHH:mm London time." },
        durationMinutes: { type: "integer", minimum: 15, maximum: 480 },
        attendees: {
          type: "array",
          items: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] },
        },
        contactIds: { type: "array", items: { type: "string" }, description: "Orbit contacts the meeting is with." },
        notes: { type: "string" },
        includeMeetingLink: { type: "boolean", description: "Add your saved meeting link. Defaults to true." },
      },
      required: ["title", "startLocal", "durationMinutes", "attendees"],
    },
    describe: (args) => ({
      title: `Send invite: ${str(args.title)}`,
      lines: [
        `When: ${formatDateTimeLabel(str(args.startLocal))} for ${args.durationMinutes} minutes`,
        `Guests: ${(Array.isArray(args.attendees) ? args.attendees : [])
          .map((guest) => (guest && typeof guest === "object" ? str((guest as Args).name) || str((guest as Args).email) : ""))
          .filter(Boolean)
          .join(", ")}`,
        ...fieldLines(args, { notes: "Notes" }),
      ],
    }),
    run: async (actor, args) => {
      const result = await createInvite(actor, {
        title: args.title,
        startLocal: args.startLocal,
        durationMinutes: args.durationMinutes,
        attendees: args.attendees,
        contactIds: args.contactIds ?? [],
        notes: args.notes ?? "",
        includeMeetingLink: args.includeMeetingLink !== false,
      });
      return { invite: result };
    },
  },
];

export const TOOL_BY_NAME = new Map(ASSISTANT_TOOLS.map((tool) => [tool.name, tool]));

export function toolDefinitions() {
  return ASSISTANT_TOOLS.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function collectIds(value: unknown, into: Set<string>) {
  if (typeof value === "string" && isUuid(value)) into.add(value);
  else if (Array.isArray(value)) for (const item of value) collectIds(item, into);
}

export async function recordNames(actor: UserActor, args: Args[]) {
  const ids = new Set<string>();
  for (const entry of args) for (const value of Object.values(entry)) collectIds(value, ids);
  const names = new Map<string, string>();
  if (ids.size === 0) return names;
  const list = [...ids];
  await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string | null }>(
      `select id, name from crm.companies where id = any($1::uuid[])
       union all
       select id, nullif(trim(concat_ws(' ', first_name, last_name)), '') from crm.contacts where id = any($1::uuid[])
       union all
       select id, title from crm.tasks where id = any($1::uuid[])
       union all
       select id, name from crm.opportunities where id = any($1::uuid[])
       union all
       select id, name from crm.pipeline_stages where id = any($1::uuid[])
       union all
       select p.id, coalesce(nullif(p.full_name, ''), p.email) from crm.profiles p
         join crm.workspace_members m on m.user_id = p.id and m.workspace_id = $2
         where p.id = any($1::uuid[])`,
      [list, actor.workspaceId],
    );
    for (const row of result.rows) if (row.name) names.set(row.id, row.name);
  });
  return names;
}

export function describeAction(name: string, args: Args, names: Map<string, string> = new Map()) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool?.describe) return { title: tool?.label ?? name, lines: [] };
  const lookup: Names = (id) => {
    const key = str(id);
    return names.get(key) ?? (isUuid(key) ? "Unknown record" : key);
  };
  const described = tool.describe(args, lookup);
  return { title: described.title, lines: described.lines.filter(Boolean) };
}

export async function runTool(actor: UserActor, name: string, args: Args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { error: `There is no tool called ${name}.` };
  try {
    return await tool.run(actor, args);
  } catch (error) {
    if (error instanceof CrmError) return { error: error.message, field: error.details?.field ?? null };
    console.error(`Assistant tool ${name} failed`, error);
    return { error: "That did not work. Try again or check the details." };
  }
}
