import type { Db } from "@/lib/db/pool";
import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import { captureWorkspaceInDb } from "@/lib/crm/call-routing";
import { attachTeamsTranscripts, summarisePendingAcross } from "@/lib/crm/conversations";
import { settleTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import { workspaceActors } from "@/lib/crm/workspaces";
import {
  currentToken,
  readSecret,
  readStored,
  storeToken,
  type StoredConnection,
} from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";
import { formatCallDuration } from "@/lib/crm/timeline";
import type { UserActor } from "@/lib/crm/types";
import {
  appAccessToken,
  configuredTenant,
  fetchPstnCalls,
  callErrorText,
  tokenClaims,
  type PstnCallRow,
} from "@/lib/microsoft/calls";
import { MicrosoftError, type MicrosoftToken } from "@/lib/microsoft/oauth";
import { notSetUp } from "@/lib/crm/errors";
import { normalizePhone } from "@/lib/phone";

const CALL_SYNC_GAP_MS = 5 * 60 * 1000;
const CALL_OVERLAP_MS = 24 * 60 * 60 * 1000;
const CALL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CALL_MAX_WINDOW_MS = 89 * 24 * 60 * 60 * 1000;
const REMATCH_LIMIT = 500;

type CallDirection = "inbound" | "outbound";

export type CallSyncSummary = {
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  logged: number;
  unmatched: number;
};

type CallSyncResult = {
  ran: boolean;
  logged: number;
  unmatched: number;
  skipped: number;
  transcripts?: number;
  error?: string;
};

type ContactPhone = {
  id: string;
  name: string;
  email: string | null;
  companyId: string | null;
};

type CallRow = {
  providerCallId: string;
  teamsCallId?: string | null;
  direction: CallDirection;
  counterpartNumber: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
};

type Claim = {
  tenantId: string | null;
  lastSyncedAt: string | null;
};

function callDirection(callType: string | null | undefined) {
  const type = callType?.trim().toLowerCase();
  if (type === "user_out") return "outbound" as const;
  if (type === "user_in") return "inbound" as const;
  return null;
}

export { formatCallDuration };

export function callTitle(direction: CallDirection, name: string) {
  return `${direction === "outbound" ? "Call with" : "Call from"} ${name}`.slice(
    0,
    200,
  );
}

export function callBody(
  direction: CallDirection,
  durationSeconds: number | null,
) {
  return `${direction === "outbound" ? "Outgoing" : "Incoming"} call · ${formatCallDuration(durationSeconds)}`;
}

function rowForUser(
  row: PstnCallRow,
  user: { email: string; objectId: string | null },
) {
  const email = canonicalEmail(user.email);
  const principal = canonicalEmail(row.userPrincipalName ?? "");
  if (email && principal && principal === email) return true;
  if (
    user.objectId &&
    row.userId &&
    row.userId.toLowerCase() === user.objectId.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function toCallRow(row: PstnCallRow): CallRow | null {
  const providerCallId = row.id?.trim().slice(0, 400);
  const direction = callDirection(row.callType);
  if (!providerCallId || !direction) return null;
  const raw = direction === "outbound" ? row.calleeNumber : row.callerNumber;
  const counterpart = normalizePhone(raw) ?? (raw?.trim().slice(0, 64) || null);
  const started = row.startDateTime ? new Date(row.startDateTime) : null;
  const duration =
    typeof row.duration === "number" && Number.isFinite(row.duration)
      ? Math.max(0, Math.round(row.duration))
      : null;
  return {
    providerCallId,
    teamsCallId: row.callId?.trim().slice(0, 200) || null,
    direction,
    counterpartNumber: counterpart,
    startedAt:
      started && !Number.isNaN(started.getTime())
        ? started.toISOString()
        : null,
    durationSeconds: duration,
  };
}

export async function getCallSync(
  actor: UserActor,
): Promise<CallSyncSummary | null> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored) return null;
    const result = await db.query<{
      last_synced_at: Date | string | null;
      last_attempt_at: Date | string | null;
      last_error: string | null;
      logged: number;
      unmatched: number;
    }>(
      `select
         s.last_synced_at,
         s.last_attempt_at,
         s.last_error,
         (select count(*)::int from crm.call_records r
          where r.connection_id = $1 and r.activity_id is not null) as logged,
         (select count(*)::int from crm.call_records r
          where r.connection_id = $1 and r.activity_id is null) as unmatched
       from (select 1) one
       left join crm.call_sync_state s on s.connection_id = $1`,
      [stored.id],
    );
    const row = result.rows[0];
    return {
      lastSyncedAt: iso(row?.last_synced_at ?? null),
      lastAttemptAt: iso(row?.last_attempt_at ?? null),
      lastError: row?.last_error ?? null,
      logged: row?.logged ?? 0,
      unmatched: row?.unmatched ?? 0,
    };
  });
}

export async function syncCalls(
  actor: UserActor,
  options: { force?: boolean; fetchImpl?: typeof fetch; deadline?: number } = {},
): Promise<CallSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idle: CallSyncResult = {
    ran: false,
    logged: 0,
    unmatched: 0,
    skipped: 0,
  };
  const prepared = await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored || stored.status !== "connected" || !stored.refreshTokenCipher)
      return null;
    const claim = await claimAttempt(
      db,
      actor,
      stored.id,
      Boolean(options.force),
    );
    return { stored, claim };
  });
  if (!prepared) {
    return { ...idle, error: "Connect Microsoft to sync Teams calls." };
  }
  const { stored, claim } = prepared;
  if (!claim) return idle;

  try {
    const identity = await resolveIdentity(stored, claim, fetchImpl, actor);
    const to = new Date();
    const floor = to.getTime() - CALL_MAX_WINDOW_MS;
    const start = claim.lastSyncedAt
      ? new Date(claim.lastSyncedAt).getTime() - CALL_OVERLAP_MS
      : to.getTime() - CALL_LOOKBACK_MS;
    const from = new Date(Math.max(start, floor));
    const appToken = await appAccessToken(identity.tenantId, fetchImpl, Date.now(), actor);
    const fetched = await fetchPstnCalls(appToken, from, to, fetchImpl);
    const rows: CallRow[] = [];
    let skipped = 0;
    for (const row of fetched.rows) {
      const call = rowForUser(row, {
        email: stored.email,
        objectId: identity.objectId,
      })
        ? toCallRow(row)
        : null;
      if (call) rows.push(call);
      else skipped += 1;
    }
    const watermark = fetched.complete ? to.toISOString() : null;

    const actors = await workspaceActors(actor);
    const result: CallSyncResult = await withActor(actor, async (db) => {
      await lockCalls(db, stored.id);
      if (identity.refreshed)
        await storeToken(db, stored.id, identity.refreshed);
      const phones = await contactPhonesAcross(db, actor, actors);
      const captureId = await captureWorkspaceInDb(db, actor, actors, [], [stored.email]);
      const counts = await fileCalls(db, actors, stored.id, rows, phones, captureId);
      counts.logged += await rematchCalls(db, actors, stored.id, phones);
      let transcripts = 0;
      for (const item of actors) transcripts += await attachTeamsTranscripts(db, item.workspaceId);
      await db.query(
        `update crm.call_sync_state
         set tenant_id = $2,
             last_synced_at = coalesce($3::timestamptz, last_synced_at),
             last_error = null
         where connection_id = $1`,
        [stored.id, identity.tenantId, watermark],
      );
      return {
        ran: true,
        logged: counts.logged,
        unmatched: counts.unmatched,
        skipped: skipped + counts.skipped,
        transcripts,
      };
    });
    try {
      const settled = await settleTeamsTranscripts(actor, Date.now(), actors);
      result.transcripts = (result.transcripts ?? 0) + settled.attached;
    } catch (error) {
      console.error("Settling Teams transcripts failed", error);
    }
    if (result.transcripts) {
      try {
        await summarisePendingAcross(actor, { fetchImpl, deadline: options.deadline, actors });
      } catch (error) {
        console.error("Teams transcript summary failed", error);
      }
    }
    return result;
  } catch (error) {
    const message = callErrorText(error, "Couldn't sync Teams calls. Try again.");
    await withActor(actor, async (db) => {
      await db.query(
        `update crm.call_sync_state
         set last_attempt_at = now(), last_error = $2
         where connection_id = $1`,
        [stored.id, message],
      );
    });
    return { ...idle, ran: true, error: message };
  }
}

async function claimAttempt(
  db: Db,
  actor: UserActor,
  connectionId: string,
  force: boolean,
): Promise<Claim | null> {
  const result = await db.query<{
    tenant_id: string | null;
    last_synced_at: Date | string | null;
  }>(
    `insert into crm.call_sync_state (workspace_id, connection_id, last_attempt_at)
     values ($1, $2, now())
     on conflict (connection_id) do update
       set last_attempt_at = now()
       where $3::boolean
          or crm.call_sync_state.last_attempt_at is null
          or crm.call_sync_state.last_attempt_at <= now() - make_interval(secs => $4::double precision)
     returning tenant_id, last_synced_at`,
    [actor.workspaceId, connectionId, force, CALL_SYNC_GAP_MS / 1000],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, lastSyncedAt: iso(row.last_synced_at) };
}

async function resolveIdentity(
  stored: StoredConnection,
  claim: Claim,
  fetchImpl: typeof fetch,
  viewer?: UserActor,
) {
  let claims = tokenClaims(readSecret(stored.accessTokenCipher));
  let refreshed: MicrosoftToken | null = null;
  const fixed = configuredTenant();
  if (!fixed && !claims?.tenantId && !claim.tenantId) {
    refreshed = await currentToken(
      { ...stored, accessTokenCipher: null },
      fetchImpl,
    );
    claims = tokenClaims(refreshed.accessToken);
  }
  const tenantId = fixed ?? claims?.tenantId ?? claim.tenantId;
  if (!tenantId) {
    throw new MicrosoftError(notSetUp("Microsoft tenant", "MICROSOFT_TENANT", viewer));
  }
  return { tenantId, objectId: claims?.objectId ?? null, refreshed };
}

export async function teamsIdentity(actor: UserActor, fetchImpl: typeof fetch = fetch) {
  const prepared = await withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored || stored.status !== "connected" || !stored.refreshTokenCipher) return null;
    const state = await db.query<{ tenant_id: string | null }>(
      "select tenant_id from crm.call_sync_state where connection_id = $1",
      [stored.id],
    );
    return { stored, tenantId: state.rows[0]?.tenant_id ?? null };
  });
  if (!prepared) return null;
  const { stored } = prepared;
  const identity = await resolveIdentity(
    stored,
    { tenantId: prepared.tenantId, lastSyncedAt: null },
    fetchImpl,
    actor,
  );
  let { objectId, refreshed } = identity;
  if (!objectId) {
    refreshed = await currentToken({ ...stored, accessTokenCipher: null }, fetchImpl);
    objectId = tokenClaims(refreshed.accessToken)?.objectId ?? null;
  }
  if (refreshed) {
    const token = refreshed;
    await withActor(actor, (db) => storeToken(db, stored.id, token));
  }
  if (!objectId) {
    throw new MicrosoftError("Reconnect Microsoft to read Teams transcripts.");
  }
  return { tenantId: identity.tenantId, objectId, connectionId: stored.id };
}

async function lockCalls(db: Db, connectionId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `calls:${connectionId}`,
  ]);
}

type WorkspacePhone = ContactPhone & { workspaceId: string };

async function contactPhonesAcross(db: Db, owner: UserActor, actors: UserActor[]) {
  const workspaceIds = actors.map((item) => item.workspaceId);
  const rules = await db.query<{ domain: string; workspace_ids: string[] }>(
    "select domain, workspace_ids from crm.mail_domain_rules where user_id = $1",
    [owner.userId],
  );
  const ruled = new Map(rules.rows.map((row) => [row.domain, row.workspace_ids]));
  const phones = new Map<string, WorkspacePhone[]>();
  for (const workspaceId of workspaceIds) {
    for (const [number, contact] of await contactPhones(db, workspaceId)) {
      const domain = contact.email?.split("@")[1]?.toLowerCase() ?? "";
      const rule = domain ? ruled.get(domain) : undefined;
      if (rule && !rule.includes(workspaceId)) continue;
      phones.set(number, [...(phones.get(number) ?? []), { ...contact, workspaceId }]);
    }
  }
  return phones;
}

async function contactPhones(db: Db, workspaceId: string) {
  const result = await db.query<{
    id: string;
    phone: string;
    name: string;
    email: string | null;
    company_id: string | null;
  }>(
    `select
       id,
       phone,
       coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email, phone) as name,
       normalized_email as email,
       company_id
     from crm.contacts
     where workspace_id = $1 and archived_at is null and phone is not null
     order by created_at asc, id asc`,
    [workspaceId],
  );
  const phones = new Map<string, ContactPhone>();
  for (const row of result.rows) {
    const number = normalizePhone(row.phone);
    if (!number || phones.has(number)) continue;
    phones.set(number, {
      id: row.id,
      name: row.name,
      email: row.email,
      companyId: row.company_id,
    });
  }
  return phones;
}

function workspaceActor(actors: UserActor[], workspaceId: string) {
  return actors.find((item) => item.workspaceId === workspaceId) ?? null;
}

async function fileCalls(
  db: Db,
  actors: UserActor[],
  connectionId: string,
  rows: CallRow[],
  phones: Map<string, WorkspacePhone[]>,
  captureId: string,
) {
  const counts = { logged: 0, unmatched: 0, skipped: 0 };
  const workspaceIds = actors.map((item) => item.workspaceId);
  for (const call of rows) {
    const existing = await db.query<{ workspace_id: string }>(
      `select workspace_id from crm.call_records
       where connection_id = $1 and provider_call_id = $2 and workspace_id = any($3::uuid[])`,
      [connectionId, call.providerCallId, workspaceIds],
    );
    if (existing.rows.length > 0) {
      if (call.teamsCallId) {
        for (const row of existing.rows) {
          const actor = workspaceActor(actors, row.workspace_id);
          if (!actor) continue;
          await db.query(
            `update crm.call_records set teams_call_id = $3
             where workspace_id = $1 and provider_call_id = $2 and teams_call_id is null`,
            [row.workspace_id, call.providerCallId, call.teamsCallId],
          );
          const filed = await filedTranscript(db, actor, call.teamsCallId);
          if (filed) {
            await db.query(
              `update crm.call_records
               set activity_id = $3, contact_id = $4, company_id = $5
               where workspace_id = $1 and provider_call_id = $2
                 and activity_id is null and contact_id is null and company_id is null`,
              [row.workspace_id, call.providerCallId, filed.activity_id, filed.contact_id, filed.company_id],
            );
          }
        }
      }
      counts.skipped += 1;
      continue;
    }
    const targets = new Map<string, { contact: ContactPhone | null; activityId: string }>();
    for (const actor of actors) {
      const filed = call.teamsCallId ? await filedTranscript(db, actor, call.teamsCallId) : null;
      if (filed) {
        targets.set(actor.workspaceId, {
          contact: { id: filed.contact_id, name: "", email: null, companyId: filed.company_id },
          activityId: filed.activity_id,
        });
      }
    }
    for (const contact of call.counterpartNumber ? (phones.get(call.counterpartNumber) ?? []) : []) {
      const actor = workspaceActor(actors, contact.workspaceId);
      if (!actor || targets.has(contact.workspaceId)) continue;
      targets.set(contact.workspaceId, { contact, activityId: await logCall(db, actor, call, contact) });
    }
    const writes = targets.size > 0 ? [...targets] : [[captureId, null] as const];
    let inserted = 0;
    for (const [workspaceId, target] of writes) {
      const saved = await db.query(
        `insert into crm.call_records (
           workspace_id, connection_id, provider_call_id, direction,
           counterpart_number, started_at, duration_seconds,
           contact_id, company_id, activity_id, teams_call_id
         ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11)
         on conflict (workspace_id, provider_call_id) do nothing`,
        [
          workspaceId,
          connectionId,
          call.providerCallId,
          call.direction,
          call.counterpartNumber,
          call.startedAt,
          call.durationSeconds,
          target?.contact?.id ?? null,
          target?.contact?.companyId ?? null,
          target?.activityId ?? null,
          call.teamsCallId ?? null,
        ],
      );
      inserted += saved.rowCount ?? 0;
    }
    if (inserted === 0) {
      counts.skipped += 1;
      continue;
    }
    if (targets.size > 0) counts.logged += 1;
    else counts.unmatched += 1;
  }
  return counts;
}

async function filedTranscript(db: Db, actor: UserActor, teamsCallId: string) {
  const result = await db.query<{
    activity_id: string;
    contact_id: string;
    company_id: string | null;
  }>(
    `select activity_id, contact_id, company_id
     from crm.conversation_imports
     where workspace_id = $1 and source = 'teams' and user_id = $2 and call_id = $3
       and status = 'filed' and activity_id is not null and contact_id is not null
     order by updated_at desc
     limit 1`,
    [actor.workspaceId, actor.userId, teamsCallId],
  );
  return result.rows[0] ?? null;
}

async function rematchCalls(
  db: Db,
  actors: UserActor[],
  connectionId: string,
  phones: Map<string, WorkspacePhone[]>,
) {
  if (phones.size === 0) return 0;
  const pending = await db.query<{
    id: string;
    workspace_id: string;
    provider_call_id: string;
    direction: CallDirection;
    counterpart_number: string;
    started_at: Date | string | null;
    duration_seconds: number | null;
    teams_call_id: string | null;
  }>(
    `select id, workspace_id, provider_call_id, direction, counterpart_number, started_at, duration_seconds, teams_call_id
     from crm.call_records
     where connection_id = $1
       and workspace_id = any($2::uuid[])
       and contact_id is null
       and company_id is null
       and activity_id is null
       and counterpart_number = any($3::text[])
     order by started_at asc nulls last
     limit ${REMATCH_LIMIT}`,
    [connectionId, actors.map((item) => item.workspaceId), [...phones.keys()]],
  );
  let logged = 0;
  for (const row of pending.rows) {
    const call: CallRow = {
      providerCallId: row.provider_call_id,
      direction: row.direction,
      counterpartNumber: row.counterpart_number,
      startedAt: iso(row.started_at),
      durationSeconds: row.duration_seconds,
    };
    const present = await db.query<{ workspace_id: string }>(
      "select workspace_id from crm.call_records where connection_id = $1 and provider_call_id = $2",
      [connectionId, row.provider_call_id],
    );
    const matches = (phones.get(row.counterpart_number) ?? []).filter(
      (contact) => contact.workspaceId === row.workspace_id || !present.rows.some((item) => item.workspace_id === contact.workspaceId),
    );
    if (matches.length === 0) continue;
    const here = matches.find((contact) => contact.workspaceId === row.workspace_id) ?? matches[0];
    for (const contact of matches) {
      const actor = workspaceActor(actors, contact.workspaceId);
      if (!actor) continue;
      const activityId = await logCall(db, actor, call, contact);
      if (contact === here) {
        await db.query(
          `update crm.call_records
           set workspace_id = $2, contact_id = $3, company_id = $4, activity_id = $5
           where id = $1`,
          [row.id, contact.workspaceId, contact.id, contact.companyId, activityId],
        );
      } else {
        await db.query(
          `insert into crm.call_records (
             workspace_id, connection_id, provider_call_id, direction,
             counterpart_number, started_at, duration_seconds,
             contact_id, company_id, activity_id, teams_call_id
           ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11)
           on conflict (workspace_id, provider_call_id) do nothing`,
          [
            contact.workspaceId,
            connectionId,
            row.provider_call_id,
            row.direction,
            row.counterpart_number,
            iso(row.started_at),
            row.duration_seconds,
            contact.id,
            contact.companyId,
            activityId,
            row.teams_call_id,
          ],
        );
      }
    }
    logged += 1;
  }
  return logged;
}

async function logCall(
  db: Db,
  actor: UserActor,
  call: CallRow,
  contact: ContactPhone,
) {
  const activity = await createActivityInDb(
    db,
    actor,
    {
      type: "call",
      title: callTitle(call.direction, contact.name),
      body: callBody(call.direction, call.durationSeconds),
      occurredAt: call.startedAt ?? undefined,
      contactId: contact.id,
      companyId: contact.companyId,
      metadata: {
        source: "microsoft_teams",
        providerCallId: call.providerCallId,
        direction: call.direction,
        number: call.counterpartNumber,
        durationSeconds: call.durationSeconds,
      },
    },
    { operation: "sync_calls", source: "microsoft" },
  );
  return activity.id;
}

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}
