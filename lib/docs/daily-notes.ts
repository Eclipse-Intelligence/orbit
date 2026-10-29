import { withActor } from "@/lib/crm/context";
import { listCalendarItems } from "@/lib/crm/calendars";
import { CrmError } from "@/lib/crm/errors";
import { iso } from "@/lib/crm/mutate";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { appendDailyEntry, isDailyDate, localDate, localTime, shiftDate } from "@/lib/docs/daily";
import { excerptFrom } from "@/lib/docs/markdown";
import { assertDocsRead, assertDocsWrite, changeDocContent, docDetail, loadPage } from "@/lib/docs/store";
import type { DailyMeeting, DailyNote, DailyNoteDay } from "@/lib/docs/types";
import { appTimeZone, zonedTimeToDate } from "@/lib/time";

const AGENT_REFUSAL = "Daily notes are private to each person, so workspace agent tokens can't open them.";

function person(actor: Actor): UserActor {
  if (actor.type !== "user") throw new CrmError("forbidden", AGENT_REFUSAL, 403);
  return actor;
}

function dayOf(value: string | undefined, now: Date) {
  if (value === undefined || value === "" || value === "today") return localDate(now);
  if (value === "yesterday") return shiftDate(localDate(now), -1);
  if (value === "tomorrow") return shiftDate(localDate(now), 1);
  if (!isDailyDate(value)) throw new CrmError("invalid_input", "Give the day as YYYY-MM-DD, for example 2026-10-29.", 400, { field: "date" });
  return value;
}

async function ensureDaily(db: Db, actor: UserActor, date: string) {
  await db.query(
    `insert into crm.pages (workspace_id, user_id, kind, daily_date, title, edited_by, edited_by_user_id)
     values ($1, $2, 'daily', $3::date, $3, 'person', $2)
     on conflict (workspace_id, user_id, daily_date) where kind = 'daily' do nothing`,
    [actor.workspaceId, actor.userId, date],
  );
  const result = await db.query<{ id: string }>(
    "select id from crm.pages where workspace_id = $1 and user_id = $2 and kind = 'daily' and daily_date = $3::date",
    [actor.workspaceId, actor.userId, date],
  );
  return result.rows[0].id;
}

export async function dailyMeetings(actor: UserActor, date: string): Promise<DailyMeeting[]> {
  const [year, month, day] = date.split("-").map(Number);
  const start = zonedTimeToDate({ year, month, day, hour: 0, minute: 0, second: 0 }, appTimeZone());
  const next = shiftDate(date, 1).split("-").map(Number);
  const end = zonedTimeToDate({ year: next[0], month: next[1], day: next[2], hour: 0, minute: 0, second: 0 }, appTimeZone());
  const items = await listCalendarItems(actor, { start, end });
  return items
    .filter((item) => item.myResponse !== "declined")
    .map((item) => ({
      id: item.id,
      subject: item.subject?.trim() || "Untitled event",
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      isAllDay: item.isAllDay,
      joinUrl: item.joinUrl,
      webLink: item.webLink,
    }));
}

async function withMeetings(actor: UserActor, date: string, wanted: boolean) {
  if (!wanted) return null;
  try {
    return await dailyMeetings(actor, date);
  } catch (error) {
    console.error("Daily note meetings failed", error);
    return [];
  }
}

export async function openDailyNote(actor: Actor, date?: string, options: { meetings?: boolean; now?: Date } = {}): Promise<DailyNote> {
  const owner = person(actor);
  assertDocsRead(owner);
  const now = options.now ?? new Date();
  const day = dayOf(date, now);
  const page = await withActor(owner, async (db) => docDetail(db, owner, await ensureDaily(db, owner, day)));
  return { page, date: day, isToday: day === localDate(now), meetings: await withMeetings(owner, day, options.meetings === true) };
}

export async function getDailyNote(actor: Actor, date?: string, options: { meetings?: boolean; now?: Date } = {}): Promise<DailyNote | null> {
  const owner = person(actor);
  assertDocsRead(owner);
  const now = options.now ?? new Date();
  const day = dayOf(date, now);
  const page = await withActor(owner, async (db) => {
    const found = await db.query<{ id: string }>(
      "select id from crm.pages where workspace_id = $1 and user_id = $2 and kind = 'daily' and daily_date = $3::date",
      [owner.workspaceId, owner.userId, day],
    );
    return found.rows[0] ? docDetail(db, owner, found.rows[0].id) : null;
  });
  if (!page) return null;
  return { page, date: day, isToday: day === localDate(now), meetings: await withMeetings(owner, day, options.meetings === true) };
}

function meetingLine(meetings: DailyMeeting[]) {
  if (meetings.length === 0) return "No meetings in the calendar.";
  const time = (value: string) => localTime(new Date(value));
  return `Meetings: ${meetings.map((meeting) => (meeting.isAllDay ? `${meeting.subject} (all day)` : `${meeting.subject}, ${time(meeting.startsAt)}`)).join("; ")}`;
}

export async function appendToDailyNote(
  actor: Actor,
  input: { text?: string; date?: string; meetings?: boolean; now?: Date },
  provenance?: Provenance,
): Promise<DailyNote> {
  const owner = person(actor);
  assertDocsWrite(owner);
  const now = input.now ?? new Date();
  const day = dayOf(input.date, now);
  const text = (input.text ?? "").trim();
  const meetings = input.meetings ? await dailyMeetings(owner, day).catch(() => []) : null;
  const entry = [text, meetings ? meetingLine(meetings) : ""].filter(Boolean).join("\n");
  if (!entry) throw new CrmError("invalid_input", "Say what to write in the daily note.", 400, { field: "text" });
  const page = await withActor(owner, async (db) => {
    const id = await ensureDaily(db, owner, day);
    const current = await loadPage(db, owner, id, { lock: true });
    if (current.archived_at) await db.query("update crm.pages set archived_at = null where id = $1", [id]);
    const fresh = current.archived_at ? await loadPage(db, owner, id, { lock: true }) : current;
    await changeDocContent(db, owner, fresh, appendDailyEntry(fresh.content, localTime(now), entry), { provenance, summary: "Added an entry" });
    return docDetail(db, owner, id);
  });
  return { page, date: day, isToday: day === localDate(now), meetings };
}

export async function listDailyNotes(actor: Actor, options: { from?: string; to?: string; limit?: number } = {}): Promise<DailyNoteDay[]> {
  const owner = person(actor);
  assertDocsRead(owner);
  if (options.from !== undefined && !isDailyDate(options.from)) throw new CrmError("invalid_input", "Give from as YYYY-MM-DD.", 400, { field: "from" });
  if (options.to !== undefined && !isDailyDate(options.to)) throw new CrmError("invalid_input", "Give to as YYYY-MM-DD.", 400, { field: "to" });
  const limit = Math.min(400, Math.max(1, Math.trunc(options.limit ?? 60)));
  return withActor(owner, async (db) => {
    const result = await db.query<{ id: string; date: string; entries: number; head: string; edited_at: Date }>(
      `select p.id, p.daily_date::text as date, p.edited_at, left(p.content, 600) as head,
         (select count(*)::int from regexp_matches(p.content, '^\\d{2}:\\d{2}( |$)', 'gm')) as entries
       from crm.pages p
       where p.workspace_id = $1 and p.user_id = $2 and p.kind = 'daily' and p.archived_at is null and p.content <> ''
         and ($3::date is null or p.daily_date >= $3::date) and ($4::date is null or p.daily_date <= $4::date)
       order by p.daily_date desc limit $5`,
      [owner.workspaceId, owner.userId, options.from ?? null, options.to ?? null, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      date: row.date,
      entryCount: row.entries,
      excerpt: excerptFrom(row.head.replace(/^\d{2}:\d{2}( |$)/gm, ""), 160),
      editedAt: iso(row.edited_at)!,
    }));
  });
}
