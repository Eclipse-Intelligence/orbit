import { siteOrigin } from "@/lib/site-url";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { createActivityInDb } from "@/lib/crm/activities";
import {
  PENDING_STALE_MS,
  summariseCall,
  transcriptToText,
  TRANSCRIPT_MAX_LENGTH,
} from "@/lib/crm/call-insights";
import { upsertCompanyInDb } from "@/lib/crm/companies";
import { upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { hasCalendarAccounts, hasCalendarFeeds } from "@/lib/crm/calendar-accounts";
import { readStored } from "@/lib/crm/inbox";
import { iso, isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import { assertScope, scopesForRole } from "@/lib/crm/scopes";
import type {
  ActivityWrite,
  ContactWrite,
  Provenance,
  UserActor,
  WorkspaceRole,
} from "@/lib/crm/types";

export type ConversationSource = "granola" | "teams";
export type ConversationKind = "meeting" | "call";
export type ConversationStatus = "pending" | "filed" | "unfiled" | "ignored";
export type IntegrationSource = "granola" | "teams_transcripts" | "clickup" | "calendar";

export type Participant = { name: string | null; email: string | null };

export type ConversationImport = {
  id: string;
  source: ConversationSource;
  kind: ConversationKind;
  title: string | null;
  occurredAt: string | null;
  endedAt: string | null;
  participants: Participant[];
  externalUrl: string | null;
  sourceSummary: string | null;
  status: ConversationStatus;
  error: string | null;
  contactId: string | null;
  companyId: string | null;
  activityId: string | null;
  transcriptLength: number;
  createdAt: string;
};

export type IntegrationStatus = {
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  webhookEnabled: boolean;
  subscriptionId: string | null;
  subscriptionExpiresAt: string | null;
};

type IntegrationRow = {
  last_synced_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_error: string | null;
  webhook_id: string | null;
  webhook_secret: string | null;
  subscription_id: string | null;
  subscription_expires_at: Date | string | null;
  client_state: string | null;
};

export type BackgroundTarget = {
  actor: UserActor;
  mailbox: boolean;
  calendarAccounts?: boolean;
  calendarFeeds?: boolean;
  members: UserActor[];
};

type MemberRow = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

type ImportRow = {
  id: string;
  source: ConversationSource;
  kind: ConversationKind;
  call_id: string | null;
  external_id: string;
  title: string | null;
  occurred_at: Date | string | null;
  ended_at: Date | string | null;
  participants: unknown;
  external_url: string | null;
  source_summary: string | null;
  status: ConversationStatus;
  error: string | null;
  contact_id: string | null;
  company_id: string | null;
  activity_id: string | null;
  transcript_length: number;
  created_at: Date | string;
};

type LockedImport = ImportRow & { transcript: string | null; attempts: number };

const IMPORT_COLUMNS = `
  i.id,
  i.source,
  i.kind,
  i.call_id,
  i.external_id,
  i.title,
  i.occurred_at,
  i.ended_at,
  i.participants,
  i.external_url,
  i.source_summary,
  i.status,
  i.error,
  i.contact_id,
  i.company_id,
  i.activity_id,
  coalesce(char_length(i.transcript), 0)::int as transcript_length,
  i.created_at
`;

const SUMMARY_ATTEMPTS = 3;
const SUMMARY_RESERVE_MS = 25_000;

export function configuredSiteOrigin() {
  return siteOrigin();
}

export function safeEqual(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function timeLeft(deadline: number | undefined, reserve = 0) {
  if (!deadline) return true;
  return deadline - Date.now() > reserve;
}

export function clip(value: string | null | undefined, max: number) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function validTime(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

export function errorText(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || fallback;
}

function mapParticipants(value: unknown): Participant[] {
  if (!Array.isArray(value)) return [];
  const people: Participant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
    const email = typeof item.email === "string" && item.email.trim() ? item.email.trim() : null;
    if (name || email) people.push({ name, email });
  }
  return people;
}

function mapImport(row: ImportRow): ConversationImport {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    occurredAt: iso(row.occurred_at),
    endedAt: iso(row.ended_at),
    participants: mapParticipants(row.participants),
    externalUrl: row.external_url,
    sourceSummary: row.source_summary,
    status: row.status,
    error: row.error,
    contactId: row.contact_id,
    companyId: row.company_id,
    activityId: row.activity_id,
    transcriptLength: row.transcript_length,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function memberActor(row: MemberRow): UserActor {
  return {
    type: "user",
    userId: row.user_id,
    email: row.email ?? "",
    fullName: row.full_name,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    role: row.role,
    scopes: scopesForRole(row.role),
  };
}

export async function backgroundTargets(): Promise<BackgroundTarget[]> {
  const result = await query<MemberRow>("select * from private.background_members()");
  const groups = new Map<string, UserActor[]>();
  for (const row of result.rows) {
    const members = groups.get(row.workspace_id) ?? [];
    members.push(memberActor(row));
    groups.set(row.workspace_id, members);
  }
  const targets: BackgroundTarget[] = [];
  for (const members of groups.values()) {
    let added = 0;
    for (const member of members) {
      const { mailbox, calendarAccounts, calendarFeeds } = await withActor(member, async (db) => {
        const stored = await readStored(db, member);
        return {
          mailbox: stored?.status === "connected" && Boolean(stored.refreshTokenCipher),
          calendarAccounts: await hasCalendarAccounts(db, member),
          calendarFeeds: await hasCalendarFeeds(db, member),
        };
      });
      if (mailbox || calendarAccounts || calendarFeeds) {
        targets.push({ actor: member, mailbox, calendarAccounts, calendarFeeds, members });
        added += 1;
      }
    }
    if (added === 0) targets.push({ actor: members[0], mailbox: false, members });
  }
  return targets;
}

function participantLine(people: Participant[]) {
  return people
    .map((person) =>
      person.name && person.email
        ? `${person.name} <${person.email}>`
        : (person.name ?? person.email ?? ""),
    )
    .filter(Boolean)
    .join(", ");
}

export function matchEmails(people: Participant[], exclude: (string | null | undefined)[]) {
  const skip = new Set(
    exclude.map((value) => (value ? canonicalEmail(value) : null)).filter(Boolean),
  );
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const person of people) {
    const email = person.email ? canonicalEmail(person.email) : null;
    if (!email || skip.has(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export type IntegrationKey = {
  workspaceId: string;
  source: IntegrationSource;
  connectionId?: string | null;
  userId?: string | null;
};

const ITEM_ATTEMPTS = 3;

function conflictTarget(key: IntegrationKey) {
  return key.connectionId
    ? "(connection_id, source) where connection_id is not null"
    : "(workspace_id, source) where connection_id is null";
}

const KEY_WHERE =
  "workspace_id = $1 and source = $2 and connection_id is not distinct from $3::uuid";

function keyValues(key: IntegrationKey) {
  return [key.workspaceId, key.source, key.connectionId ?? null];
}

export async function readIntegration(db: Db, key: IntegrationKey) {
  const result = await db.query<IntegrationRow>(
    `select last_synced_at, last_attempt_at, last_error, webhook_id, webhook_secret,
            subscription_id, subscription_expires_at, client_state
     from crm.integration_state
     where ${KEY_WHERE}`,
    keyValues(key),
  );
  return result.rows[0] ?? null;
}

export async function ensureIntegration(db: Db, key: IntegrationKey) {
  await db.query(
    `insert into crm.integration_state (workspace_id, source, connection_id, user_id)
     values ($1, $2, $3::uuid, $4::uuid)
     on conflict ${conflictTarget(key)} do nothing`,
    [...keyValues(key), key.userId ?? null],
  );
}

export async function claimIntegration(
  db: Db,
  key: IntegrationKey,
  force: boolean,
  gapMs: number,
) {
  const result = await db.query<{ last_synced_at: Date | string | null }>(
    `insert into crm.integration_state (workspace_id, source, connection_id, user_id, last_attempt_at)
     values ($1, $2, $3::uuid, $4::uuid, now())
     on conflict ${conflictTarget(key)} do update
       set last_attempt_at = now()
       where $5::boolean
          or crm.integration_state.last_attempt_at is null
          or crm.integration_state.last_attempt_at <= now() - make_interval(secs => $6::double precision)
     returning last_synced_at`,
    [...keyValues(key), key.userId ?? null, force, gapMs / 1000],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { lastSyncedAt: iso(row.last_synced_at) };
}

export async function finishIntegration(
  db: Db,
  key: IntegrationKey,
  values: { syncedAt?: string | null; error: string | null },
) {
  await db.query(
    `update crm.integration_state
     set last_synced_at = coalesce($4::timestamptz, last_synced_at),
         last_error = $5
     where ${KEY_WHERE}`,
    [...keyValues(key), values.syncedAt ?? null, values.error ? values.error.slice(0, 500) : null],
  );
}

export async function recordIntegrationError(
  actor: UserActor,
  key: IntegrationKey,
  error: string | null,
) {
  await withActor(actor, async (db) => {
    await ensureIntegration(db, key);
    await finishIntegration(db, key, { error });
  });
}

export async function getIntegrationStatus(
  actor: UserActor,
  key: IntegrationKey,
): Promise<IntegrationStatus> {
  return withActor(actor, async (db) => {
    const row = await readIntegration(db, key);
    return {
      lastSyncedAt: iso(row?.last_synced_at ?? null),
      lastAttemptAt: iso(row?.last_attempt_at ?? null),
      lastError: row?.last_error ?? null,
      webhookEnabled: Boolean(row?.webhook_id && row.webhook_secret),
      subscriptionId: row?.subscription_id ?? null,
      subscriptionExpiresAt: iso(row?.subscription_expires_at ?? null),
    };
  });
}

const RETRYABLE = `(status in ('pending', 'filed') and transcript is null and error is not null and attempts < ${ITEM_ATTEMPTS})`;

export async function knownImports(
  db: Db,
  workspaceId: string,
  source: ConversationSource,
  externalIds: string[],
) {
  if (externalIds.length === 0) return new Set<string>();
  const result = await db.query<{ external_id: string }>(
    `select external_id from crm.conversation_imports
     where workspace_id = $1 and source = $2 and external_id = any($3::text[])
       and not ${RETRYABLE}`,
    [workspaceId, source, externalIds],
  );
  return new Set(result.rows.map((row) => row.external_id));
}

export async function retryableImports(actor: UserActor, source: ConversationSource, limit = 20) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ external_id: string; call_id: string | null }>(
      `select external_id, call_id from crm.conversation_imports
       where workspace_id = $1 and source = $2 and ${RETRYABLE}
       order by updated_at asc
       limit $3`,
      [actor.workspaceId, source, limit],
    );
    return result.rows.map((row) => ({ externalId: row.external_id, callId: row.call_id }));
  });
}

export function importConflict(source: ConversationSource) {
  return source === "granola"
    ? "(workspace_id, external_id) where source = 'granola'"
    : "(user_id, external_id) where source = 'teams'";
}

export async function recordImportFailure(
  actor: UserActor,
  input: {
    source: ConversationSource;
    kind: ConversationKind;
    externalId: string;
    callId?: string | null;
    occurredAt?: string | null;
  },
  error: string,
) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ status: ConversationStatus; attempts: number }>(
      `insert into crm.conversation_imports (
         workspace_id, user_id, source, external_id, kind, call_id, occurred_at,
         status, error, attempts
       ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'pending', $8, 1)
       on conflict ${importConflict(input.source)} do update
         set attempts = crm.conversation_imports.attempts + 1,
             error = excluded.error,
             status = case
               when crm.conversation_imports.status = 'pending'
                 and crm.conversation_imports.transcript is null
                 and crm.conversation_imports.attempts + 1 >= $9
               then 'unfiled'
               else crm.conversation_imports.status
             end
       returning status, attempts`,
      [
        actor.workspaceId,
        actor.userId,
        input.source,
        input.externalId.slice(0, 400),
        input.kind,
        input.callId ?? null,
        input.occurredAt ?? null,
        error.slice(0, 1000),
        ITEM_ATTEMPTS,
      ],
    );
    return result.rows[0] ?? null;
  });
}

export async function internalAddresses(db: Db, workspaceId: string, extra: (string | null | undefined)[]) {
  const result = await db.query<{ email: string | null; other_emails: string[] | null }>(
    `select p.email, p.other_emails from crm.workspace_members m
     join crm.profiles p on p.id = m.user_id
     where m.workspace_id = $1`,
    [workspaceId],
  );
  const emails = new Set<string>();
  const domains = new Set<string>();
  const known = result.rows.flatMap((row) => [row.email, ...(row.other_emails ?? [])]);
  for (const value of [...known, ...extra]) {
    const email = value ? canonicalEmail(value) : null;
    if (!email) continue;
    emails.add(email);
    const domain = email.split("@")[1];
    if (domain && !isFreeMailDomain(domain)) domains.add(domain);
  }
  return {
    isInternal(email: string) {
      const canonical = canonicalEmail(email);
      if (!canonical) return true;
      return emails.has(canonical) || domains.has(canonical.split("@")[1] ?? "");
    },
  };
}

export async function lockImportKey(db: Db, workspaceId: string, source: ConversationSource, externalId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `import:${workspaceId}:${source}:${externalId}`,
  ]);
}

export type NewPerson = { name: string | null; email: string };
export type UnfiledImport = ConversationImport & { newPeople: NewPerson[] };

function personName(person: Participant) {
  const name = person.name?.trim();
  if (!name || canonicalEmail(name)) return null;
  return name;
}

function outsideAttendees(people: Participant[], isInternal: (email: string) => boolean) {
  const found = new Map<string, NewPerson>();
  for (const person of people) {
    const email = person.email ? canonicalEmail(person.email) : null;
    if (!email || isInternal(email)) continue;
    const current = found.get(email);
    if (!current) found.set(email, { name: personName(person), email });
    else if (!current.name) current.name = personName(person);
  }
  return [...found.values()];
}

export async function listUnfiledImports(actor: UserActor, limit = 50): Promise<UnfiledImport[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<ImportRow>(
      `select ${IMPORT_COLUMNS}
       from crm.conversation_imports i
       where i.workspace_id = $1 and i.status = 'unfiled'
       order by i.occurred_at desc nulls last, i.created_at desc
       limit $2`,
      [actor.workspaceId, Math.min(Math.max(limit, 1), 200)],
    );
    const imports = result.rows.map(mapImport);
    if (imports.length === 0) return [];
    const internal = await internalAddresses(db, actor.workspaceId, [actor.email]);
    const candidates = imports.map((item) => outsideAttendees(item.participants, internal.isInternal));
    const emails = [...new Set(candidates.flat().map((person) => person.email))];
    const existing =
      emails.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db.query<{ normalized_email: string }>(
                `select normalized_email from crm.contacts
                 where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])`,
                [actor.workspaceId, emails],
              )
            ).rows.map((row) => row.normalized_email),
          );
    return imports.map((item, index) => ({
      ...item,
      newPeople: candidates[index].filter((person) => !existing.has(person.email)),
    }));
  });
}

function meetingBody(people: Participant[], externalUrl: string | null) {
  const lines = [];
  const attendees = participantLine(people);
  if (attendees) lines.push(`Attendees: ${attendees}`);
  if (externalUrl) lines.push(`Open in Granola: ${externalUrl}`);
  return (lines.join("\n") || "Meeting recorded in Granola").slice(0, 10000);
}

export function importActivityInput(
  row: {
    source: ConversationSource;
    kind: ConversationKind;
    external_id: string;
    call_id: string | null;
    title: string | null;
    occurred_at: Date | string | null;
    participants: unknown;
    external_url: string | null;
  },
  target: { contactId: string | null; companyId: string | null; contactName: string | null },
): ActivityWrite {
  const occurredAt = iso(row.occurred_at) ?? undefined;
  if (row.kind === "meeting") {
    return {
      type: "meeting",
      title: clip(row.title, 200) ?? "Meeting",
      body: meetingBody(mapParticipants(row.participants), row.external_url),
      occurredAt,
      contactId: target.contactId,
      companyId: target.companyId,
      metadata: {
        source: row.source,
        externalId: row.external_id,
        externalUrl: row.external_url,
      },
    };
  }
  return {
    type: "call",
    title: clip(`Teams call with ${target.contactName ?? "contact"}`, 200),
    body: row.title && row.title !== "Teams call" ? row.title.slice(0, 10000) : "Teams call with a transcript",
    occurredAt,
    contactId: target.contactId,
    companyId: target.companyId,
    metadata: {
      source: "microsoft_teams",
      transcriptId: row.external_id,
      callId: row.call_id,
    },
  };
}

async function lockImport(db: Db, actor: UserActor, importId: string) {
  const result = await db.query<LockedImport>(
    `select ${IMPORT_COLUMNS}, i.transcript, i.attempts
     from crm.conversation_imports i
     where i.id = $1 and i.workspace_id = $2
     for update`,
    [importId, actor.workspaceId],
  );
  return result.rows[0] ?? null;
}

async function fileLockedImport(db: Db, actor: UserActor, row: LockedImport, contactId: string) {
  const found = await db.query<{ id: string; company_id: string | null; name: string | null }>(
    `select id, company_id,
            coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email, phone) as name
     from crm.contacts
     where id = $1 and workspace_id = $2 and archived_at is null`,
    [contactId, actor.workspaceId],
  );
  const contact = found.rows[0];
  if (!contact) throw new CrmError("not_found", "Contact not found.", 404);
  const activity = await createActivityInDb(
    db,
    actor,
    importActivityInput(row, {
      contactId: contact.id,
      companyId: contact.company_id,
      contactName: contact.name,
    }),
    { operation: "file_conversation", source: row.source === "granola" ? "granola" : "microsoft" },
  );
  await db.query(
    `update crm.conversation_imports
     set status = 'filed', activity_id = $2, contact_id = $3, company_id = $4, error = null
     where id = $1`,
    [row.id, activity.id, contact.id, contact.company_id],
  );
  if (row.source === "teams" && row.call_id) {
    await db.query(
      `update crm.call_records
       set activity_id = $3, contact_id = $4, company_id = $5
       where workspace_id = $1 and teams_call_id = $2
         and activity_id is null and contact_id is null and company_id is null`,
      [actor.workspaceId, row.call_id, activity.id, contact.id, contact.company_id],
    );
  }
  return { activityId: activity.id, contactName: contact.name };
}

async function lockUnfiled(db: Db, actor: UserActor, importId: string) {
  const row = await lockImport(db, actor, importId);
  if (!row) throw new CrmError("not_found", "Conversation not found.", 404);
  if (row.status === "filed") {
    throw new CrmError("conflict", "This conversation is already filed.", 409);
  }
  return row;
}

export async function fileImport(
  actor: UserActor,
  importId: string,
  contactId: string,
  options: { summarise?: boolean; fetchImpl?: typeof fetch } = {},
) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(importId)) throw new CrmError("not_found", "Conversation not found.", 404);
  if (!isUuid(contactId)) throw new CrmError("not_found", "Contact not found.", 404);
  const filed = await withActor(actor, async (db) => {
    const row = await lockUnfiled(db, actor, importId);
    const result = await fileLockedImport(db, actor, row, contactId);
    return { activityId: result.activityId };
  });
  if (options.summarise ?? true) {
    await summariseImport(actor, importId, { fetchImpl: options.fetchImpl });
  }
  return filed;
}

export function companyNameFromDomain(domain: string) {
  const label = domain.trim().toLowerCase().split(".")[0] ?? "";
  const words = label.split(/[-_]+/).filter(Boolean);
  const name = words
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
  return name || domain;
}

function splitName(name: string | null) {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0]?.slice(0, 80) ?? null,
    lastName: parts.slice(1).join(" ").slice(0, 80) || null,
  };
}

const ATTENDEE_PROVENANCE: Provenance = { operation: "create_from_attendee", source: "meeting" };

type AttendeePerson = { name?: string | null; email: string };

export async function createContactFromAttendeeInDb(
  db: Db,
  actor: UserActor,
  person: AttendeePerson,
  extraInternal: (string | null | undefined)[] = [],
) {
  const wanted = canonicalEmail(typeof person.email === "string" ? person.email : "");
  if (!wanted) {
    throw new CrmError("invalid_input", "Enter a valid email address.", 400, { field: "email" });
  }
  const internal = await internalAddresses(db, actor.workspaceId, [actor.email, ...extraInternal]);
  if (internal.isInternal(wanted)) {
    throw new CrmError(
      "invalid_input",
      "That address belongs to you or your workspace, so it can't become a contact.",
      400,
      { field: "email" },
    );
  }
  const existing = await db.query<{
    id: string;
    company_id: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(
    `select id, company_id, first_name, last_name from crm.contacts
     where workspace_id = $1 and archived_at is null and normalized_email = $2
     limit 1`,
    [actor.workspaceId, wanted],
  );
  const current = existing.rows[0];
  const names = splitName(personName({ name: person.name ?? null, email: wanted }));
  let contactId = current?.id ?? null;
  let created = false;
  if (!current?.company_id) {
    const domain = wanted.split("@")[1] ?? "";
    let companyId: string | null = null;
    if (domain && !isFreeMailDomain(domain)) {
      const byDomain = await db.query<{ id: string }>(
        `select id from crm.companies
         where workspace_id = $1 and archived_at is null and domain = $2
         order by updated_at desc
         limit 1`,
        [actor.workspaceId, domain],
      );
      companyId =
        byDomain.rows[0]?.id ??
        (
          await upsertCompanyInDb(
            db,
            actor,
            { name: companyNameFromDomain(domain), domain, source: "meeting" },
            ATTENDEE_PROVENANCE,
          )
        ).company.id;
    }
    if (current) {
      const fill: ContactWrite = { email: wanted };
      if (companyId) fill.companyId = companyId;
      if (!current.first_name && !current.last_name && names.firstName) Object.assign(fill, names);
      if (Object.keys(fill).length > 1) {
        await upsertContactInDb(db, actor, fill, ATTENDEE_PROVENANCE);
      }
    } else {
      const result = await upsertContactInDb(
        db,
        actor,
        { ...names, email: wanted, companyId, source: "meeting" },
        ATTENDEE_PROVENANCE,
      );
      contactId = result.contact.id;
      created = result.created;
    }
  }
  if (!contactId) throw new CrmError("internal_error", "Contact was not saved.", 500);
  return { contactId, email: wanted, created };
}

async function contactLabel(db: Db, contactId: string) {
  const result = await db.query<{ name: string | null }>(
    `select coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email, phone) as name
     from crm.contacts where id = $1`,
    [contactId],
  );
  return result.rows[0]?.name ?? null;
}

export async function createContactFromAttendee(
  actor: UserActor,
  person: AttendeePerson,
  extraInternal: (string | null | undefined)[] = [],
) {
  assertScope(actor.scopes, "contacts:write");
  assertScope(actor.scopes, "companies:write");
  return withActor(actor, async (db) => {
    const saved = await createContactFromAttendeeInDb(db, actor, person, extraInternal);
    return {
      contactId: saved.contactId,
      contactName: (await contactLabel(db, saved.contactId)) ?? saved.email,
      created: saved.created,
    };
  });
}

export async function createContactAndFile(
  actor: UserActor,
  importId: string,
  email: string,
  options: { summarise?: boolean; fetchImpl?: typeof fetch } = {},
) {
  assertScope(actor.scopes, "activities:write");
  assertScope(actor.scopes, "contacts:write");
  assertScope(actor.scopes, "companies:write");
  if (!isUuid(importId)) throw new CrmError("not_found", "Conversation not found.", 404);
  const wanted = canonicalEmail(typeof email === "string" ? email : "");
  if (!wanted) {
    throw new CrmError("invalid_input", "Enter a valid email address.", 400, { field: "email" });
  }
  const filed = await withActor(actor, async (db) => {
    const row = await lockUnfiled(db, actor, importId);
    const person = mapParticipants(row.participants).find(
      (item) => item.email && canonicalEmail(item.email) === wanted,
    );
    if (!person) {
      throw new CrmError("invalid_input", "That person wasn't in this conversation.", 400, {
        field: "email",
      });
    }
    const saved = await createContactFromAttendeeInDb(db, actor, { name: person.name, email: wanted });
    const result = await fileLockedImport(db, actor, row, saved.contactId);
    return {
      contactId: saved.contactId,
      contactName: result.contactName ?? wanted,
      activityId: result.activityId,
      created: saved.created,
    };
  });
  if (options.summarise ?? true) {
    await summariseImport(actor, importId, { fetchImpl: options.fetchImpl });
  }
  return filed;
}

export async function ignoreImport(actor: UserActor, importId: string) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(importId)) throw new CrmError("not_found", "Conversation not found.", 404);
  await withActor(actor, async (db) => {
    const row = await lockUnfiled(db, actor, importId);
    await db.query(
      "update crm.conversation_imports set status = 'ignored' where id = $1",
      [row.id],
    );
  });
}

function summaryTranscript(raw: string) {
  const text = transcriptToText(raw);
  if (text.length <= TRANSCRIPT_MAX_LENGTH) return text;
  const cut = text.slice(0, TRANSCRIPT_MAX_LENGTH);
  const line = cut.lastIndexOf("\n");
  return line > TRANSCRIPT_MAX_LENGTH / 2 ? cut.slice(0, line) : cut;
}

const BLOCKING_INSIGHT = `
  select 1 from crm.call_insights ci
  where ci.activity_id = $1
    and not (ci.status = 'pending' and ci.updated_at < now() - make_interval(secs => $2::double precision))`;

export async function summariseImport(
  actor: UserActor,
  importId: string,
  options: { fetchImpl?: typeof fetch; deadline?: number } = {},
) {
  const claimed = await withActor(actor, async (db) => {
    const row = await lockImport(db, actor, importId);
    if (!row || row.status !== "filed" || !row.activity_id || !row.transcript?.trim()) return null;
    const blocking = await db.query(BLOCKING_INSIGHT, [row.activity_id, PENDING_STALE_MS / 1000]);
    if ((blocking.rowCount ?? 0) > 0) return null;
    const existing = await db.query("select 1 from crm.call_insights where activity_id = $1", [
      row.activity_id,
    ]);
    await db.query(
      "update crm.conversation_imports set attempts = attempts + 1 where id = $1",
      [row.id],
    );
    return {
      activityId: row.activity_id,
      transcript: row.transcript,
      source: row.source,
      hasInsight: (existing.rowCount ?? 0) > 0,
    };
  });
  if (!claimed) return null;
  let error: string | null = null;
  try {
    const insight = await summariseCall(
      actor,
      claimed.activityId,
      claimed.hasInsight ? "" : summaryTranscript(claimed.transcript),
      {
        source: claimed.source === "granola" ? "granola" : "teams",
        fetchImpl: options.fetchImpl,
        deadline: options.deadline,
      },
    );
    if (insight.status === "failed") error = insight.error ?? "Could not summarise the conversation.";
    await withActor(actor, async (db) => {
      await db.query("update crm.conversation_imports set error = $2 where id = $1", [
        importId,
        error ? error.slice(0, 1000) : null,
      ]);
    });
    return insight;
  } catch (failure) {
    error = errorText(failure, "Could not summarise the conversation.");
    await withActor(actor, async (db) => {
      await db.query("update crm.conversation_imports set error = $2 where id = $1", [
        importId,
        error,
      ]);
    });
    return null;
  }
}

export async function summarisePendingImports(
  actor: UserActor,
  options: { fetchImpl?: typeof fetch; deadline?: number; limit?: number } = {},
) {
  const ids = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `select i.id
       from crm.conversation_imports i
       where i.workspace_id = $1
         and i.status = 'filed'
         and i.activity_id is not null
         and i.transcript is not null
         and i.attempts < $2
         and not exists (
           select 1 from crm.call_insights ci
           where ci.activity_id = i.activity_id
             and not (ci.status = 'pending' and ci.updated_at < now() - make_interval(secs => $4::double precision))
         )
       order by i.occurred_at desc nulls last
       limit $3`,
      [actor.workspaceId, SUMMARY_ATTEMPTS, options.limit ?? 5, PENDING_STALE_MS / 1000],
    );
    return result.rows.map((row) => row.id);
  });
  let summarised = 0;
  for (const id of ids) {
    if (!timeLeft(options.deadline, SUMMARY_RESERVE_MS)) break;
    const insight = await summariseImport(actor, id, {
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
    });
    if (insight) summarised += 1;
  }
  return summarised;
}

export async function attachTeamsTranscripts(db: Db, workspaceId: string) {
  const result = await db.query<{ id: string }>(
    `update crm.conversation_imports i
     set status = 'filed',
         activity_id = r.activity_id,
         contact_id = r.contact_id,
         company_id = r.company_id,
         error = null
     from crm.call_records r
     where i.workspace_id = $1
       and i.source = 'teams'
       and i.status in ('pending', 'unfiled')
       and i.call_id is not null
       and r.workspace_id = i.workspace_id
       and r.teams_call_id = i.call_id
       and r.activity_id is not null
     returning i.id`,
    [workspaceId],
  );
  return result.rowCount ?? 0;
}
