import type { Db } from "@/lib/db/pool";
import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import {
  currentToken,
  readSecret,
  readStored,
  storeToken,
  type StoredConnection,
} from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import {
  appAccessToken,
  configuredTenant,
  fetchPstnCalls,
  sanitizeCallError,
  tokenClaims,
  type PstnCallRow,
} from "@/lib/microsoft/calls";
import type { MicrosoftToken } from "@/lib/microsoft/oauth";
import { normalizePhone } from "@/lib/phone";

const CALL_SYNC_GAP_MS = 5 * 60 * 1000;
const CALL_OVERLAP_MS = 24 * 60 * 60 * 1000;
const CALL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const CALL_MAX_WINDOW_MS = 89 * 24 * 60 * 60 * 1000;
const REMATCH_LIMIT = 500;

export type CallDirection = "inbound" | "outbound";

export type CallSyncSummary = {
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  logged: number;
  unmatched: number;
};

export type CallSyncResult = {
  ran: boolean;
  logged: number;
  unmatched: number;
  skipped: number;
  error?: string;
};

type ContactPhone = {
  id: string;
  name: string;
  companyId: string | null;
};

type CallRow = {
  providerCallId: string;
  direction: CallDirection;
  counterpartNumber: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
};

type Claim = {
  tenantId: string | null;
  lastSyncedAt: string | null;
};

export function callDirection(callType: string | null | undefined) {
  const type = callType?.trim().toLowerCase();
  if (type === "user_out") return "outbound" as const;
  if (type === "user_in") return "inbound" as const;
  return null;
}

export function formatCallDuration(seconds: number | null | undefined) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (rest || parts.length === 0) parts.push(`${rest} s`);
  return parts.join(" ");
}

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

export function rowForUser(
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

export function toCallRow(row: PstnCallRow): CallRow | null {
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
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
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
    const identity = await resolveIdentity(stored, claim, fetchImpl);
    const to = new Date();
    const floor = to.getTime() - CALL_MAX_WINDOW_MS;
    const start = claim.lastSyncedAt
      ? new Date(claim.lastSyncedAt).getTime() - CALL_OVERLAP_MS
      : to.getTime() - CALL_LOOKBACK_MS;
    const from = new Date(Math.max(start, floor));
    const appToken = await appAccessToken(identity.tenantId, fetchImpl);
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

    return await withActor(actor, async (db) => {
      await lockCalls(db, stored.id);
      if (identity.refreshed)
        await storeToken(db, stored.id, identity.refreshed);
      const phones = await contactPhones(db, actor.workspaceId);
      const counts = await fileCalls(db, actor, stored.id, rows, phones);
      counts.logged += await rematchCalls(db, actor, stored.id, phones);
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
      };
    });
  } catch (error) {
    const message = sanitizeCallError(
      error instanceof Error ? error.message : "Could not sync Teams calls.",
    );
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
    throw new Error(
      "Orbit could not work out the Microsoft tenant. Set MICROSOFT_TENANT to your tenant id.",
    );
  }
  return { tenantId, objectId: claims?.objectId ?? null, refreshed };
}

async function lockCalls(db: Db, connectionId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `calls:${connectionId}`,
  ]);
}

async function contactPhones(db: Db, workspaceId: string) {
  const result = await db.query<{
    id: string;
    phone: string;
    name: string;
    company_id: string | null;
  }>(
    `select
       id,
       phone,
       coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email, phone) as name,
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
      companyId: row.company_id,
    });
  }
  return phones;
}

async function fileCalls(
  db: Db,
  actor: UserActor,
  connectionId: string,
  rows: CallRow[],
  phones: Map<string, ContactPhone>,
) {
  const counts = { logged: 0, unmatched: 0, skipped: 0 };
  for (const call of rows) {
    const existing = await db.query(
      `select 1 from crm.call_records
       where workspace_id = $1 and provider_call_id = $2`,
      [actor.workspaceId, call.providerCallId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      counts.skipped += 1;
      continue;
    }
    const contact = call.counterpartNumber
      ? (phones.get(call.counterpartNumber) ?? null)
      : null;
    const activityId = contact ? await logCall(db, actor, call, contact) : null;
    const inserted = await db.query(
      `insert into crm.call_records (
         workspace_id, connection_id, provider_call_id, direction,
         counterpart_number, started_at, duration_seconds,
         contact_id, company_id, activity_id
       ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10)
       on conflict (workspace_id, provider_call_id) do nothing`,
      [
        actor.workspaceId,
        connectionId,
        call.providerCallId,
        call.direction,
        call.counterpartNumber,
        call.startedAt,
        call.durationSeconds,
        contact?.id ?? null,
        contact?.companyId ?? null,
        activityId,
      ],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      counts.skipped += 1;
      continue;
    }
    if (activityId) counts.logged += 1;
    else counts.unmatched += 1;
  }
  return counts;
}

async function rematchCalls(
  db: Db,
  actor: UserActor,
  connectionId: string,
  phones: Map<string, ContactPhone>,
) {
  if (phones.size === 0) return 0;
  const pending = await db.query<{
    id: string;
    provider_call_id: string;
    direction: CallDirection;
    counterpart_number: string;
    started_at: Date | string | null;
    duration_seconds: number | null;
  }>(
    `select id, provider_call_id, direction, counterpart_number, started_at, duration_seconds
     from crm.call_records
     where connection_id = $1
       and workspace_id = $2
       and contact_id is null
       and company_id is null
       and activity_id is null
       and counterpart_number = any($3::text[])
     order by started_at asc nulls last
     limit ${REMATCH_LIMIT}`,
    [connectionId, actor.workspaceId, [...phones.keys()]],
  );
  let logged = 0;
  for (const row of pending.rows) {
    const contact = phones.get(row.counterpart_number);
    if (!contact) continue;
    const activityId = await logCall(
      db,
      actor,
      {
        providerCallId: row.provider_call_id,
        direction: row.direction,
        counterpartNumber: row.counterpart_number,
        startedAt: iso(row.started_at),
        durationSeconds: row.duration_seconds,
      },
      contact,
    );
    await db.query(
      `update crm.call_records
       set contact_id = $2, company_id = $3, activity_id = $4
       where id = $1`,
      [row.id, contact.id, contact.companyId, activityId],
    );
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
