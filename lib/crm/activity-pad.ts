import { z } from "zod";
import type { PadActivityType } from "@/lib/activity-pad";
import { createActivity } from "@/lib/crm/activities";
import { createTaskWithClickUp, getClickUpPicker } from "@/lib/crm/clickup";
import { getContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Activity, UserActor } from "@/lib/crm/types";
import { completeJson } from "@/lib/llm";
import { mentionsIn, namedMentions, plainMentions } from "@/lib/mentions";
import { londonParts } from "@/lib/task-pad";

const TYPES: PadActivityType[] = ["call", "email", "meeting", "note"];
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SUGGESTION_WINDOW_HOURS = 18;

export type PadActivityInput = {
  text: string;
  type: string;
  when: string | null;
  contactId: string | null;
  companyId: string | null;
  title: string | null;
  followUp: { title: string; due: string } | null;
  eventId: string | null;
};

export type ActivitySuggestion = {
  eventId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  contacts: { id: string; name: string }[];
  company: { id: string; name: string } | null;
};

export type ActivityTidy = {
  type: PadActivityType;
  title: string;
  summary: string;
  followUpTitle: string | null;
  followUpDue: string | null;
};

function headline(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return (first.length <= 120 ? first : `${first.slice(0, 119).trimEnd()}…`).replace(/[.!?]$/, "");
}

export async function logPadActivity(actor: UserActor, input: PadActivityInput): Promise<{ activity: Activity; warning: string | null }> {
  const raw = typeof input.text === "string" ? input.text.trim() : "";
  const text = namedMentions(raw).replace(/[ \t]+([,.;:!?])/g, "$1");
  if (!text) throw new CrmError("invalid_input", "Write what happened first.", 400);
  if (text.length > 10_000) throw new CrmError("invalid_input", "That's too long for one activity.", 400);
  const type = TYPES.includes(input.type as PadActivityType) ? (input.type as PadActivityType) : "note";
  const tags = mentionsIn(raw);
  let contactId = input.contactId && isUuid(input.contactId) ? input.contactId : (tags.find((tag) => tag.kind === "contact")?.id ?? null);
  let companyId = input.companyId && isUuid(input.companyId) ? input.companyId : (tags.find((tag) => tag.kind === "company")?.id ?? null);
  if (contactId && !companyId) {
    const contact = await getContact(actor, contactId).catch(() => null);
    if (!contact) contactId = null;
    else companyId = contact.companyId;
  }
  if (!contactId && !companyId) throw new CrmError("invalid_input", "Tag who it was with using @.", 400, { field: "contactId" });

  const title = (input.title?.trim() || headline(text)).slice(0, 200);
  const body = text === title ? null : text;
  const created = await createActivity(
    actor,
    {
      type,
      title,
      body,
      occurredAt: input.when && LOCAL.test(input.when) ? input.when : null,
      contactId,
      ...(companyId ? { companyId } : {}),
      metadata: { source: "pad", ...(input.eventId && isUuid(input.eventId) ? { eventId: input.eventId } : {}), ...(tags.length ? { mentions: tags } : {}) },
    },
    { provenance: { operation: "log_activity", source: "activity_pad" } },
  );

  let warning: string | null = null;
  if (input.followUp?.title?.trim() && LOCAL.test(input.followUp.due ?? "")) {
    const picker = await getClickUpPicker(actor).catch(() => null);
    try {
      const task = await createTaskWithClickUp(
        actor,
        {
          title: input.followUp.title.trim().slice(0, 200),
          dueAt: input.followUp.due,
          companyId,
          contactId,
          priority: "normal",
          description: title,
        },
        picker?.listId ?? null,
        { provenance: { operation: "create_task", source: "activity_pad" } },
      );
      if (task.clickupError) warning = `Task saved in Orbit, but ClickUp said: ${task.clickupError}`;
    } catch (error) {
      warning = error instanceof CrmError ? `Activity saved, but the task wasn't: ${error.message}` : "Activity saved, but the task wasn't.";
    }
  }
  return { activity: created.body.activity, warning };
}

const TIDY_SCHEMA = z.object({
  type: z.enum(["call", "email", "meeting", "note"]),
  title: z.string(),
  summary: z.string(),
  followUpTitle: z.string().nullable(),
  followUpDue: z.string().nullable(),
});

export async function tidyActivity(text: string, names: string[], now = new Date()): Promise<ActivityTidy | null> {
  const clean = plainMentions(text).trim().slice(0, 4000);
  if (!clean) return null;
  const wall = londonParts(now);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Europe/London" }).format(now);
  const today = `${weekday} ${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
  const result = await completeJson({
    system:
      "You tidy a CRM activity someone typed or dictated after talking to a client, in UK English. Reply with JSON only: " +
      '{"type": "call" | "email" | "meeting" | "note", "title": string, "summary": string, "followUpTitle": string or null, "followUpDue": "YYYY-MM-DDTHH:mm" or null}. ' +
      "title is a short headline of what happened, under 80 characters, no full stop. " +
      "summary is the useful detail as plain sentences, without filler, and empty if the title already says it all. Never invent facts. " +
      "followUpTitle is a short imperative task title if the text implies something to do next (for example 'Send Jane revised pricing'), otherwise null. " +
      "followUpDue is when that task is due in Europe/London time, using 09:00 if no time is given, or null. " +
      "No em dashes. " +
      (names.length ? `People and companies mentioned: ${names.join(", ")}. ` : "") +
      `Now is ${today} in London.`,
    user: clean,
    schema: TIDY_SCHEMA,
    maxTokens: 600,
    timeoutMs: 15_000,
  });
  const data = result.data;
  return {
    type: data.type,
    title: data.title.trim().replace(/[.]$/, "").slice(0, 120) || headline(clean),
    summary: data.summary.trim().slice(0, 4000),
    followUpTitle: data.followUpTitle?.trim().slice(0, 200) || null,
    followUpDue: data.followUpDue && LOCAL.test(data.followUpDue) ? data.followUpDue : null,
  };
}

export async function activitySuggestions(actor: UserActor, now = new Date()): Promise<ActivitySuggestion[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      subject: string | null;
      starts_at: Date;
      ends_at: Date;
      contacts: { id: string; name: string }[] | null;
      company: { id: string; name: string } | null;
    }>(
      `select e.id, e.subject, e.starts_at, e.ends_at,
         (select jsonb_agg(jsonb_build_object('id', c.id, 'name', trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))) order by c.first_name)
            from crm.contacts c where c.id = any(e.contact_ids) and c.archived_at is null) as contacts,
         (select jsonb_build_object('id', co.id, 'name', co.name)
            from crm.companies co where co.id = any(e.company_ids) and co.archived_at is null limit 1) as company
       from (
         select distinct on (coalesce(e.ical_uid, e.id::text)) e.*
         from crm.calendar_events e
         join crm.calendars cal on cal.id = e.calendar_id and cal.use_for_crm
         where e.user_id = $1 and e.workspace_id = $2
           and not e.is_cancelled and not e.is_all_day
           and e.ends_at <= $3 and e.ends_at > $3::timestamptz - interval '${SUGGESTION_WINDOW_HOURS} hours'
           and (cardinality(e.contact_ids) > 0 or cardinality(e.company_ids) > 0)
         order by coalesce(e.ical_uid, e.id::text), e.id
       ) e
       where not exists (
         select 1 from crm.activities a
         where a.workspace_id = $2
           and (a.metadata->>'eventId' = e.id::text
             or (a.type in ('meeting', 'call') and a.occurred_at between e.starts_at - interval '30 minutes' and e.ends_at + interval '2 hours'
                 and (a.contact_id = any(e.contact_ids) or a.company_id = any(e.company_ids))))
       )
       order by e.ends_at desc
       limit 4`,
      [actor.userId, actor.workspaceId, now.toISOString()],
    );
    return result.rows.map((row) => ({
      eventId: row.id,
      subject: row.subject?.trim() || "Meeting",
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      contacts: (row.contacts ?? []).filter((contact) => contact.name).slice(0, 3),
      company: row.company,
    }));
  });
}
