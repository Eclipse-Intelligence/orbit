import { withActor } from "@/lib/crm/context";
import { listPeopleMet, type CalendarStatus, type MetPerson } from "@/lib/crm/calendar";
import type { CallSyncSummary } from "@/lib/crm/calls";
import { listUnfiledImports, type UnfiledImport } from "@/lib/crm/conversations";
import type { GranolaStatus } from "@/lib/crm/granola";
import type { MailboxSummary } from "@/lib/crm/inbox";
import { iso } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { TeamsTranscriptStatus } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";

export type ToFile = { unfiled: UnfiledImport[]; people: MetPerson[] };

export type CaptureStatus = {
  waiting: number;
  fresh: number;
  newestAt: string | null;
  seenAt: string | null;
};

async function hasMailbox(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query("select 1 from crm.mailbox_connections where user_id = $1 and workspace_id = $2 and provider = 'microsoft' limit 1", [
      actor.userId,
      actor.workspaceId,
    ]);
    return (result.rowCount ?? 0) > 0;
  });
}

export async function listToFile(actor: UserActor, now = Date.now()): Promise<ToFile> {
  assertScope(actor.scopes, "crm:read");
  const [unfiled, mailbox] = await Promise.all([listUnfiledImports(actor), hasMailbox(actor)]);
  const people = mailbox ? await listPeopleMet(actor, now) : [];
  return { unfiled, people };
}

export function arrivals(items: ToFile) {
  return [
    ...items.unfiled.map((item) => item.unfiledAt ?? item.createdAt),
    ...items.people.map((person) => person.firstSeenAt),
  ].filter((value): value is string => Boolean(value));
}

export function newestArrival(items: ToFile) {
  return arrivals(items).reduce<string | null>((latest, value) => (!latest || value > latest ? value : latest), null);
}

async function readSeen(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ seen_at: Date | string }>(
      "select seen_at from crm.capture_seen where user_id = $1 and workspace_id = $2",
      [actor.userId, actor.workspaceId],
    );
    return result.rows[0] ? iso(result.rows[0].seen_at) : null;
  });
}

export function summariseCapture(items: ToFile, seenAt: string | null): CaptureStatus {
  const seen = seenAt ? new Date(seenAt).getTime() : null;
  const times = arrivals(items);
  const fresh = seen === null ? items.unfiled.length + items.people.length : times.filter((value) => new Date(value).getTime() > seen).length;
  return { waiting: items.unfiled.length + items.people.length, fresh, newestAt: newestArrival(items), seenAt };
}

export async function captureStatus(actor: UserActor, now = Date.now()): Promise<CaptureStatus> {
  const [items, seenAt] = await Promise.all([listToFile(actor, now), readSeen(actor)]);
  return summariseCapture(items, seenAt);
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
