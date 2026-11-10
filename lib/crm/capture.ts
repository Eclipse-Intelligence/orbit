import { cache } from "react";
import { EMPTY_WAITING, waitingIn, waitingOnce, type Waiting } from "@/lib/crm/action-needed";
import { withActor } from "@/lib/crm/context";
import type { CaptureSection, CaptureSectionCounts } from "@/lib/crm/capture-format";
import { listPeopleMet, type CalendarStatus, type MetPerson } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { listUnfiledImports, type UnfiledImport } from "@/lib/crm/conversations";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { MailboxSummary } from "@/lib/crm/inbox";
import { iso } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { CALL_FOLLOW_UP_LIMIT } from "@/lib/crm/follow-ups";
import { workspaceActors } from "@/lib/crm/workspaces";
import { relevantMailOnce, type RelevantMail, type SkippedEmail } from "@/lib/mail/capture-filter";
import type { UnknownEmail } from "@/lib/mail/filing";
import { meetingNoiseSql } from "@/lib/mail/senders";

export type ToFile = { unfiled: UnfiledImport[]; people: MetPerson[] };

export type CaptureStatus = {
  waiting: number;
  fresh: number;
  newestAt: string | null;
  seenAt: string | null;
  sections: CaptureSectionCounts;
  failed: CaptureSection[];
};

export type CaptureContext = {
  actors: UserActor[];
  unknown: UnknownEmail[];
  skipped: SkippedEmail[];
  held: UnknownEmail[];
  waiting: Waiting;
  failed: CaptureSection[];
};

const HAS_MAILBOX = `exists (
  select 1 from crm.mailbox_connections mc
  where mc.user_id = $1 and mc.provider = 'microsoft'
)`;

const UNFILED_COUNTS = `
  with seen as (
    select seen_at from crm.capture_seen where user_id = $1 and workspace_id = $2
  ),
  unfiled as (
    select coalesce(i.unfiled_at, i.created_at) as arrived
    from crm.conversation_imports i
    where i.workspace_id = $2 and i.user_id = $1 and i.status = 'unfiled'
  )
  select
    (select seen_at from seen) as seen_at,
    count(*)::int as waiting,
    count(*) filter (where (select seen_at from seen) is null or arrived > (select seen_at from seen))::int as fresh,
    max(arrived) as newest
  from unfiled`;

const PEOPLE_COUNTS = `
  with own as (
    select lower(btrim(raw.email)) as email
    from (
      select p.email from crm.workspace_members m join crm.profiles p on p.id = m.user_id where m.workspace_id = $2
      union all
      select unnest(p.other_emails) from crm.workspace_members m join crm.profiles p on p.id = m.user_id where m.workspace_id = $2
      union all
      select $3::text
      union all
      select mc.email from crm.mailbox_connections mc where mc.user_id = $1 and mc.provider = 'microsoft'
      union all
      select ca.email from crm.calendar_accounts ca where ca.user_id = $1
    ) raw
    where raw.email is not null and btrim(raw.email) <> ''
  ),
  own_domains as (
    select distinct split_part(email, '@', 2) as domain
    from own
    where email like '%@%' and split_part(email, '@', 2) <> all($4::text[])
  ),
  met as (
    select lower(btrim(person->>'email')) as email, min(e.starts_at) as first_at
    from crm.calendar_events e
    join crm.calendars c on c.id = e.calendar_id and c.use_for_crm
    cross join lateral jsonb_array_elements(
      (case when jsonb_typeof(e.attendees) = 'array' then e.attendees else '[]'::jsonb end)
      || (case when jsonb_typeof(e.organizer) = 'object' then jsonb_build_array(e.organizer) else '[]'::jsonb end)
    ) as person
    where e.user_id = $1 and not e.is_cancelled
      and jsonb_typeof(person) = 'object' and jsonb_typeof(person->'email') = 'string'
      and ${HAS_MAILBOX}
    group by 1
  ),
  outside as (
    select met.email, met.first_at
    from met
    where char_length(met.email) <= 200
      and met.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      and met.email not in (select email from own)
      and not ${meetingNoiseSql("met.email")}
      and split_part(met.email, '@', 2) not in (select domain from own_domains)
      and not exists (
        select 1 from crm.contacts ct
        where ct.workspace_id = $2 and ct.archived_at is null and ct.normalized_email = met.email
      )
      and not exists (
        select 1 from crm.hidden_attendees h
        where h.user_id = $1 and h.email = met.email
      )
  )
  select
    count(*)::int as waiting,
    count(*) filter (where first_at <= $5 and ($6::timestamptz is null or first_at > $6))::int as fresh,
    max(first_at) filter (where first_at <= $5) as newest
  from outside`;

const FOLLOW_UP_COUNTS = `
  select
    count(*)::int as waiting,
    count(*) filter (where $3::timestamptz is null or s.created_at > $3)::int as fresh,
    max(s.created_at) as newest
  from (
    select s.created_at from crm.follow_up_suggestions s
    where s.user_id = $1 and s.workspace_id = $2 and s.state = 'ready' and s.body is not null and s.person_email is not null
    order by s.created_at desc
    limit $4
  ) s`;

export async function listToFile(actor: UserActor, now = Date.now()): Promise<ToFile> {
  assertScope(actor.scopes, "crm:read");
  const [unfiled, mailbox] = await Promise.all([
    listUnfiledImports(actor, 50, { mine: true }),
    withActor(actor, async (db) => (await db.query(`select ${HAS_MAILBOX} as connected`, [actor.userId])).rows[0]?.connected === true),
  ]);
  const people = mailbox ? await listPeopleMet(actor, now) : [];
  return { unfiled, people };
}

function later(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

async function unknownFor(actor: UserActor, now: number, actors: UserActor[], inline: boolean): Promise<RelevantMail | null> {
  return relevantMailOnce(actor, actors, now, { inline }).catch((error) => {
    console.error("Reading email from new people failed", error instanceof Error ? error.message : error);
    return null;
  });
}

async function waitingFor(actor: UserActor, actors: UserActor[], now: number) {
  return waitingOnce(actor, actors, new Date(now)).catch((error) => {
    console.error("Reading what is waiting on you failed", error instanceof Error ? error.message : error);
    return { ...EMPTY_WAITING, failed: ["approvals", "followUps", "replies", "tasks"] as CaptureSection[] };
  });
}

const requestContext = cache(() => new Map<string, Promise<CaptureContext>>());

export function captureContext(actor: UserActor, now = Date.now(), options: { inline?: boolean } = {}) {
  assertScope(actor.scopes, "crm:read");
  const store = requestContext();
  const key = `${actor.userId}|${actor.workspaceId}|${options.inline ? "inline" : ""}`;
  const found = store.get(key);
  if (found) return found;
  const pending = (async () => {
    const actors = await workspaceActors(actor);
    const [mail, waiting] = await Promise.all([unknownFor(actor, now, actors, Boolean(options.inline)), waitingFor(actor, actors, now)]);
    const failed: CaptureSection[] = [...waiting.failed, ...(mail ? [] : ["toFile" as const])];
    return { actors, unknown: mail?.shown ?? [], skipped: mail?.skipped ?? [], held: mail?.pending ?? [], waiting, failed };
  })();
  store.set(key, pending);
  pending.catch(() => store.delete(key));
  return pending;
}

export function waitingHere(context: CaptureContext, workspaceId: string) {
  return waitingIn(context.waiting, workspaceId, [...context.unknown.map((item) => item.key), ...context.skipped.map((item) => item.key), ...context.held.map((item) => item.key)]);
}

export async function captureStatuses(actor: UserActor, now = Date.now()) {
  const context = await captureContext(actor, now);
  const others = context.actors.length < 2 ? [actor] : context.actors;
  const statuses = await Promise.all(others.map((item) => captureStatus(item, now, context).catch(() => null)));
  return new Map(others.map((item, index) => [item.workspaceId, statuses[index]]));
}

function arrivals(items: { arrivedAt: string }[], now: number, seenAt: string | null) {
  const arrived = items.map((item) => item.arrivedAt).filter((at) => new Date(at).getTime() <= now);
  return {
    fresh: arrived.filter((at) => !seenAt || at > seenAt).length,
    newest: arrived.reduce<string | null>((latest, at) => (!latest || at > latest ? at : latest), null),
  };
}

export async function captureStatus(actor: UserActor, now = Date.now(), known?: CaptureContext): Promise<CaptureStatus> {
  assertScope(actor.scopes, "crm:read");
  const context = known ?? (await captureContext(actor, now));
  const emails = context.unknown.filter((item) => item.workspaceId === actor.workspaceId);
  const here = waitingHere(context, actor.workspaceId);
  return withActor(actor, async (db) => {
    const unfiled = (
      await db.query<{ seen_at: Date | null; waiting: number; fresh: number; newest: Date | null }>(UNFILED_COUNTS, [actor.userId, actor.workspaceId])
    ).rows[0];
    const seenAt = iso(unfiled.seen_at);
    const people = (
      await db.query<{ waiting: number; fresh: number; newest: Date | null }>(PEOPLE_COUNTS, [
        actor.userId,
        actor.workspaceId,
        actor.email,
        [...FREE_MAIL_DOMAINS],
        new Date(now),
        seenAt,
      ])
    ).rows[0];
    const followUps = (
      await db.query<{ waiting: number; fresh: number; newest: Date | null }>(FOLLOW_UP_COUNTS, [actor.userId, actor.workspaceId, seenAt, CALL_FOLLOW_UP_LIMIT])
    ).rows[0];
    const freshEmails = emails.filter((item) => !seenAt || item.at > seenAt).length;
    const newestEmail = emails.reduce<string | null>((latest, item) => (!latest || item.at > latest ? item.at : latest), null);
    const waiting = arrivals([...here.approvals, ...here.nudges, ...here.reminders, ...here.replies, ...here.tasks], now, seenAt);
    const sections: CaptureSectionCounts = {
      approvals: here.approvals.length,
      followUps: followUps.waiting + here.nudges.length + here.reminders.length,
      replies: here.replies.length,
      tasks: here.tasks.length,
      toFile: unfiled.waiting + people.waiting + emails.length,
    };
    return {
      waiting: sections.approvals + sections.followUps + sections.replies + sections.tasks + sections.toFile,
      fresh: unfiled.fresh + people.fresh + followUps.fresh + freshEmails + waiting.fresh,
      newestAt: later(later(later(later(iso(unfiled.newest), iso(people.newest)), iso(followUps.newest)), newestEmail), waiting.newest),
      seenAt,
      sections,
      failed: context.failed,
    };
  });
}

export async function markCaptureSeen(actor: UserActor, at: Date = new Date()) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<{ seen_at: Date | string }>(
      `insert into crm.capture_seen (workspace_id, user_id, seen_at) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set seen_at = greatest(crm.capture_seen.seen_at, excluded.seen_at)
       returning seen_at`,
      [actor.workspaceId, actor.userId, at],
    );
    return iso(result.rows[0].seen_at);
  });
}

export type ConnectionHealth = {
  mailbox: MailboxSummary | null;
  calendar: CalendarStatus | null;
  calls: CallSyncSummary | null;
  transcripts: TeamsTranscriptStatus | null;
  granola: GranolaStatus | null;
};

function joinNames(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

export function connectionAlert(health: ConnectionHealth): string | null {
  const live = health.mailbox?.status === "connected";
  const broken: string[] = [];
  if (live && health.mailbox?.lastError) broken.push("Microsoft 365");
  if (live && health.calendar && !health.calendar.scopeMissing && health.calendar.lastError) broken.push("Outlook calendar");
  if (live && health.calls?.lastError) broken.push("Teams calls");
  if (live && health.transcripts?.lastError) broken.push("Teams transcripts");
  if (health.granola?.configured && health.granola.lastError) broken.push("Granola");
  const reconnect = Boolean(live && health.calendar?.scopeMissing);
  if (broken.length === 0) return reconnect ? "Reconnect Microsoft to include your calendar." : null;
  const line = `${joinNames(broken)} ${broken.length === 1 ? "needs" : "need"} attention.`;
  return reconnect ? `${line} Reconnect Microsoft to include your calendar.` : line;
}
