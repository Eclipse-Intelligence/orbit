import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { query } from "@/lib/db/pool";
import { transcriptToText } from "@/lib/crm/call-insights";
import { teamsIdentity } from "@/lib/crm/calls";
import { withActor } from "@/lib/crm/context";
import {
  attachTeamsTranscripts,
  claimIntegration,
  configuredSiteOrigin,
  ensureIntegration,
  errorText,
  finishIntegration,
  getIntegrationStatus,
  importConflict,
  knownImports,
  lockImportKey,
  memberActor,
  readIntegration,
  recordImportFailure,
  recordIntegrationError,
  retryableImports,
  safeEqual,
  summarisePendingImports,
  timeLeft,
  validTime,
  type IntegrationKey,
  type IntegrationStatus,
  type Participant,
} from "@/lib/crm/conversations";
import { readStored } from "@/lib/crm/inbox";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { appAccessToken } from "@/lib/microsoft/calls";
import {
  createSubscription,
  fetchTranscript,
  fetchTranscriptContent,
  fetchTranscripts,
  parseTranscriptResource,
  renewSubscription,
  sanitizeTranscriptError,
  type CallTranscript,
} from "@/lib/microsoft/transcripts";

const SYNC_GAP_MS = 5 * 60 * 1000;
const OVERLAP_MS = 6 * 60 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const UNFILED_AFTER_MS = 48 * 60 * 60 * 1000;
const SUBSCRIPTION_MS = 2 * 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
const STEP_RESERVE_MS = 5_000;
const HANDLER_BUDGET_MS = 50_000;
const MAX_NOTIFICATIONS = 50;
const NOT_CONNECTED = "Connect Microsoft to import Teams transcripts.";

type TranscriptSyncResult = {
  ran: boolean;
  imported: number;
  filed: number;
  unfiled: number;
  pending: number;
  failed: number;
  summarised: number;
  error?: string;
};

type SubscriptionResult = {
  status: "skipped" | "active" | "renewed" | "created" | "failed";
  expiresAt?: string | null;
  error?: string;
};

export type TeamsTranscriptStatus = IntegrationStatus & {
  instant: boolean;
  pending: number;
};

type GraphNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  lifecycleEvent?: string;
};

type VerifiedNotification = { actor: UserActor; item: GraphNotification };

type SubscriptionOwner = { actor: UserActor; clientState: string | null };

type OwnerLookup = (subscriptionIds: string[]) => Promise<Map<string, SubscriptionOwner>>;

type Identity = { tenantId: string; objectId: string; connectionId: string };

type Options = { fetchImpl?: typeof fetch; deadline?: number; now?: number };

type Schedule = (task: () => Promise<unknown>) => void;

type SubscriptionRow = {
  subscription_id: string;
  client_state: string | null;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
};

function subscriptionOrigin() {
  const origin = configuredSiteOrigin();
  return origin && origin.startsWith("https://") ? origin : null;
}

function teamsKey(actor: UserActor, connectionId: string): IntegrationKey {
  return {
    workspaceId: actor.workspaceId,
    source: "teams_transcripts",
    connectionId,
    userId: actor.userId,
  };
}

async function connectedMailbox(actor: UserActor) {
  const stored = await withActor(actor, (db) => readStored(db, actor));
  if (!stored || stored.status !== "connected" || !stored.refreshTokenCipher) return null;
  return stored.id;
}

export async function getTeamsTranscriptStatus(
  actor: UserActor,
): Promise<TeamsTranscriptStatus | null> {
  const connectionId = await connectedMailbox(actor);
  if (!connectionId) return null;
  const status = await getIntegrationStatus(actor, teamsKey(actor, connectionId));
  const pending = await withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.conversation_imports
       where workspace_id = $1 and source = 'teams' and status = 'pending' and user_id = $2`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0]?.total ?? 0;
  });
  return { ...status, instant: Boolean(subscriptionOrigin()), pending };
}

function speakers(text: string): Participant[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([^:\n]{1,120}):\s/.exec(line);
    if (match) names.add(match[1].trim());
  }
  return [...names].slice(0, 50).map((name) => ({ name, email: null }));
}

async function settleTranscripts(actor: UserActor, now: number) {
  return withActor(actor, async (db) => {
    const attached = await attachTeamsTranscripts(db, actor.workspaceId);
    const expired = await db.query(
      `update crm.conversation_imports
       set status = 'unfiled'
       where workspace_id = $1 and source = 'teams' and user_id = $2 and status = 'pending'
         and coalesce(occurred_at, created_at) < $3::timestamptz`,
      [actor.workspaceId, actor.userId, new Date(now - UNFILED_AFTER_MS).toISOString()],
    );
    const pending = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.conversation_imports
       where workspace_id = $1 and source = 'teams' and user_id = $2 and status = 'pending'`,
      [actor.workspaceId, actor.userId],
    );
    return { attached, expired: expired.rowCount ?? 0, pending: pending.rows[0]?.total ?? 0 };
  });
}

async function importTeamsTranscript(
  actor: UserActor,
  token: string,
  identity: Identity,
  transcript: CallTranscript,
  fetchImpl: typeof fetch = fetch,
  deadline?: number,
): Promise<"skipped" | "filed" | "pending"> {
  const externalId = transcript.id.trim().slice(0, 400);
  if (!externalId) return "skipped";
  const known = await withActor(actor, (db) =>
    knownImports(db, actor.workspaceId, "teams", [externalId]),
  );
  if (known.has(externalId)) return "skipped";
  const raw = await fetchTranscriptContent(token, identity.objectId, transcript, fetchImpl, deadline);
  const text = transcriptToText(raw).slice(0, 1_000_000);
  return withActor(actor, async (db) => {
    await lockImportKey(db, actor.workspaceId, "teams", `${actor.userId}:${externalId}`);
    const again = await knownImports(db, actor.workspaceId, "teams", [externalId]);
    if (again.has(externalId)) return "skipped";
    const saved = await db.query<{ id: string }>(
      `insert into crm.conversation_imports (
         workspace_id, user_id, source, external_id, kind, call_id, title,
         occurred_at, ended_at, participants, transcript, status
       ) values (
         $1, $2, 'teams', $3, 'call', $4, 'Teams call', $5::timestamptz, $6::timestamptz,
         $7::jsonb, $8, 'pending'
       )
       on conflict ${importConflict("teams")} do update
         set transcript = excluded.transcript,
             participants = excluded.participants,
             occurred_at = coalesce(crm.conversation_imports.occurred_at, excluded.occurred_at),
             ended_at = coalesce(crm.conversation_imports.ended_at, excluded.ended_at),
             error = null,
             attempts = 0
       returning id`,
      [
        actor.workspaceId,
        actor.userId,
        externalId,
        transcript.callId?.trim().slice(0, 200) || null,
        validTime(transcript.createdDateTime),
        validTime(transcript.endDateTime),
        JSON.stringify(speakers(text)),
        text || null,
      ],
    );
    await attachTeamsTranscripts(db, actor.workspaceId);
    const status = await db.query<{ status: string }>(
      "select status from crm.conversation_imports where id = $1",
      [saved.rows[0].id],
    );
    return status.rows[0]?.status === "filed" ? "filed" : "pending";
  });
}

async function importOrRecord(
  actor: UserActor,
  token: string,
  identity: Identity,
  transcript: CallTranscript,
  options: Options,
) {
  try {
    return await importTeamsTranscript(
      actor,
      token,
      identity,
      transcript,
      options.fetchImpl ?? fetch,
      options.deadline,
    );
  } catch (error) {
    const message = sanitizeTranscriptError(errorText(error, "Could not import a Teams transcript."));
    await recordImportFailure(
      actor,
      {
        source: "teams",
        kind: "call",
        externalId: transcript.id,
        callId: transcript.callId?.trim().slice(0, 200) || null,
        occurredAt: validTime(transcript.createdDateTime),
      },
      message,
    );
    return { error: message };
  }
}

export async function syncTeamsTranscripts(
  actor: UserActor,
  options: Options & { force?: boolean } = {},
): Promise<TranscriptSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idle: TranscriptSyncResult = {
    ran: false,
    imported: 0,
    filed: 0,
    unfiled: 0,
    pending: 0,
    failed: 0,
    summarised: 0,
  };
  const connectionId = await connectedMailbox(actor);
  if (!connectionId) return { ...idle, error: NOT_CONNECTED };
  const key = teamsKey(actor, connectionId);
  const claim = await withActor(actor, (db) =>
    claimIntegration(db, key, Boolean(options.force), SYNC_GAP_MS),
  );
  if (!claim) return idle;
  const now = options.now ?? Date.now();
  try {
    const identity = await teamsIdentity(actor, fetchImpl);
    if (!identity) {
      await withActor(actor, (db) => finishIntegration(db, key, { error: NOT_CONNECTED }));
      return { ...idle, error: NOT_CONNECTED };
    }
    const to = new Date(now);
    const from = claim.lastSyncedAt
      ? new Date(new Date(claim.lastSyncedAt).getTime() - OVERLAP_MS)
      : new Date(now - LOOKBACK_MS);
    const token = await appAccessToken(identity.tenantId, fetchImpl);
    const fetched = await fetchTranscripts(
      token,
      identity.objectId,
      from,
      to,
      fetchImpl,
      options.deadline,
    );
    const listed = fetched.transcripts.map((item) => item.id);
    const known = await withActor(actor, (db) =>
      knownImports(db, actor.workspaceId, "teams", listed),
    );
    const result: TranscriptSyncResult = { ...idle, ran: true };
    let complete = fetched.complete;
    let firstError: string | null = null;
    const outcome = (value: Awaited<ReturnType<typeof importOrRecord>>) => {
      if (typeof value === "object") {
        firstError ??= value.error;
        result.failed += 1;
        return;
      }
      if (value !== "skipped") result.imported += 1;
      if (value === "filed") result.filed += 1;
    };
    for (const transcript of fetched.transcripts) {
      if (known.has(transcript.id)) continue;
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
        complete = false;
        break;
      }
      outcome(await importOrRecord(actor, token, identity, transcript, options));
    }
    for (const retry of await retryableImports(actor, "teams")) {
      if (listed.includes(retry.externalId) || !retry.callId) continue;
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) break;
      try {
        const transcript = await fetchTranscript(
          token,
          { userId: identity.objectId, callId: retry.callId, transcriptId: retry.externalId },
          fetchImpl,
          options.deadline,
        );
        if (!transcript) throw new Error("Microsoft no longer returns this transcript.");
        outcome(
          await importOrRecord(
            actor,
            token,
            identity,
            { ...transcript, callId: transcript.callId ?? retry.callId },
            options,
          ),
        );
      } catch (error) {
        const message = sanitizeTranscriptError(errorText(error, "Could not import a Teams transcript."));
        await recordImportFailure(
          actor,
          { source: "teams", kind: "call", externalId: retry.externalId, callId: retry.callId },
          message,
        );
        firstError ??= message;
        result.failed += 1;
      }
    }
    const settled = await settleTranscripts(actor, now);
    result.filed += settled.attached;
    result.unfiled = settled.expired;
    result.pending = settled.pending;
    await withActor(actor, (db) =>
      finishIntegration(db, key, {
        syncedAt: complete ? to.toISOString() : null,
        error: firstError,
      }),
    );
    if (firstError) result.error = firstError;
    result.summarised = await summarisePendingImports(actor, {
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
    });
    return result;
  } catch (error) {
    const message = sanitizeTranscriptError(errorText(error, "Could not sync Teams transcripts."));
    await withActor(actor, (db) => finishIntegration(db, key, { error: message }));
    return { ...idle, ran: true, error: message };
  }
}

async function storeSubscription(
  actor: UserActor,
  key: IntegrationKey,
  values: { id: string | null; expiresAt: string | null; clientState?: string | null },
) {
  await withActor(actor, async (db) => {
    await ensureIntegration(db, key);
    await db.query(
      `update crm.integration_state
       set subscription_id = $2,
           subscription_expires_at = $3::timestamptz,
           client_state = case when $4::boolean then $5 else client_state end
       where connection_id = $1 and source = 'teams_transcripts'`,
      [
        key.connectionId,
        values.id ? values.id.slice(0, 200) : null,
        values.expiresAt,
        values.clientState !== undefined,
        values.clientState ?? null,
      ],
    );
  });
}

export async function ensureTranscriptSubscription(
  actor: UserActor,
  options: Options & { mode?: "auto" | "renew" | "recreate" } = {},
): Promise<SubscriptionResult> {
  const origin = subscriptionOrigin();
  if (!origin) return { status: "skipped" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const mode = options.mode ?? "auto";
  const connectionId = await connectedMailbox(actor);
  if (!connectionId) return { status: "skipped" };
  const key = teamsKey(actor, connectionId);
  try {
    const identity = await teamsIdentity(actor, fetchImpl);
    if (!identity) return { status: "skipped" };
    const state = await withActor(actor, (db) => readIntegration(db, key));
    const expires = state?.subscription_expires_at
      ? new Date(state.subscription_expires_at).getTime()
      : 0;
    if (mode === "auto" && state?.subscription_id && expires - now > RENEW_BEFORE_MS) {
      return { status: "active", expiresAt: new Date(expires).toISOString() };
    }
    const token = await appAccessToken(identity.tenantId, fetchImpl);
    const expiresAt = new Date(now + SUBSCRIPTION_MS);
    if (mode !== "recreate" && state?.subscription_id) {
      const renewed = await renewSubscription(token, state.subscription_id, expiresAt, fetchImpl);
      if (renewed) {
        const at = validTime(renewed.expirationDateTime) ?? expiresAt.toISOString();
        await storeSubscription(actor, key, { id: state.subscription_id, expiresAt: at });
        return { status: "renewed", expiresAt: at };
      }
    }
    const clientState = randomBytes(32).toString("base64url");
    const created = await createSubscription(
      token,
      {
        userId: identity.objectId,
        notificationUrl: `${origin}/api/microsoft/notifications`,
        lifecycleNotificationUrl: `${origin}/api/microsoft/lifecycle`,
        clientState,
        expiresAt,
      },
      fetchImpl,
    );
    const at = validTime(created.expirationDateTime) ?? expiresAt.toISOString();
    await storeSubscription(actor, key, {
      id: created.id,
      expiresAt: at,
      clientState: encryptSecret(clientState),
    });
    return { status: "created", expiresAt: at };
  } catch (error) {
    const message = sanitizeTranscriptError(
      errorText(error, "Could not set up instant Teams transcripts."),
    );
    await recordIntegrationError(actor, key, message);
    return { status: "failed", error: message };
  }
}

async function lookupSubscriptions(subscriptionIds: string[]) {
  const owners = new Map<string, SubscriptionOwner>();
  if (subscriptionIds.length === 0) return owners;
  const result = await query<SubscriptionRow>(
    "select * from private.transcript_subscriptions($1::text[])",
    [subscriptionIds],
  );
  for (const row of result.rows) {
    owners.set(row.subscription_id, { actor: memberActor(row), clientState: row.client_state });
  }
  return owners;
}

function validationResponse(request: Request) {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token === null) return null;
  return new Response(token.slice(0, 1000), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function verifyNotifications(
  items: GraphNotification[],
  lookup: OwnerLookup = lookupSubscriptions,
): Promise<VerifiedNotification[]> {
  const usable = items.filter(
    (item) =>
      item &&
      typeof item.subscriptionId === "string" &&
      item.subscriptionId.length > 0 &&
      item.subscriptionId.length <= 200 &&
      typeof item.clientState === "string",
  );
  const ids = [...new Set(usable.map((item) => item.subscriptionId!))];
  if (ids.length === 0) return [];
  const owners = await lookup(ids);
  const verified: VerifiedNotification[] = [];
  const seen = new Set<string>();
  for (const item of usable) {
    const owner = owners.get(item.subscriptionId!);
    if (!owner?.clientState) continue;
    let expected: string;
    try {
      expected = decryptSecret(owner.clientState);
    } catch {
      continue;
    }
    if (!safeEqual(item.clientState!, expected)) continue;
    const dedupe = `${item.subscriptionId}|${item.resource ?? ""}|${item.lifecycleEvent ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    verified.push({ actor: owner.actor, item });
  }
  return verified;
}

async function receiveGraphNotifications(request: Request, lookup?: OwnerLookup) {
  let items: unknown[];
  try {
    const body = (await request.json()) as { value?: unknown };
    items = Array.isArray(body?.value) ? body.value : [];
  } catch {
    return { status: 400, accepted: [] as VerifiedNotification[] };
  }
  if (items.length > MAX_NOTIFICATIONS) {
    return { status: 413, accepted: [] as VerifiedNotification[] };
  }
  const accepted = await verifyNotifications(items as GraphNotification[], lookup);
  if (items.length > 0 && accepted.length === 0) return { status: 401, accepted };
  return { status: 202, accepted };
}

async function processTranscriptNotification(
  actor: UserActor,
  item: GraphNotification,
  options: Options = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ref = parseTranscriptResource(item.resource);
  if (!ref) {
    await syncTeamsTranscripts(actor, options);
    return;
  }
  let identity: Identity | null = null;
  try {
    identity = await teamsIdentity(actor, fetchImpl);
    if (!identity || identity.objectId.toLowerCase() !== ref.userId.toLowerCase()) return;
    const token = await appAccessToken(identity.tenantId, fetchImpl);
    const transcript = await fetchTranscript(token, ref, fetchImpl, options.deadline);
    if (!transcript) return;
    const outcome = await importOrRecord(
      actor,
      token,
      identity,
      { ...transcript, callId: transcript.callId ?? ref.callId },
      options,
    );
    if (typeof outcome === "object") return;
    await summarisePendingImports(actor, { fetchImpl: options.fetchImpl, deadline: options.deadline });
  } catch (error) {
    if (!identity) return;
    await recordIntegrationError(
      actor,
      teamsKey(actor, identity.connectionId),
      sanitizeTranscriptError(errorText(error, "Could not import a Teams transcript.")),
    );
  }
}

async function processLifecycleEvent(
  actor: UserActor,
  item: GraphNotification,
  options: Options = {},
) {
  if (item.lifecycleEvent === "reauthorizationRequired") {
    return ensureTranscriptSubscription(actor, { ...options, mode: "renew" });
  }
  if (item.lifecycleEvent === "subscriptionRemoved") {
    return ensureTranscriptSubscription(actor, { ...options, mode: "recreate" });
  }
  if (item.lifecycleEvent === "missed") {
    return syncTeamsTranscripts(actor, { ...options, force: true });
  }
  return null;
}

function background(task: () => Promise<unknown>) {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Teams transcript notification failed", error);
    }
  });
}

async function handleGraphRequest(
  request: Request,
  options: Options & { schedule?: Schedule; lookup?: OwnerLookup },
  process: (actor: UserActor, item: GraphNotification, options: Options) => Promise<unknown>,
) {
  const deadline = options.deadline ?? Date.now() + HANDLER_BUDGET_MS;
  const validation = validationResponse(request);
  if (validation) return validation;
  try {
    const received = await receiveGraphNotifications(request, options.lookup);
    if (received.accepted.length > 0) {
      const schedule = options.schedule ?? background;
      schedule(async () => {
        for (const { actor, item } of received.accepted) {
          if (!timeLeft(deadline, STEP_RESERVE_MS)) break;
          await process(actor, item, { ...options, deadline });
        }
      });
    }
    return new Response(null, { status: received.status });
  } catch (error) {
    console.error("Graph notification failed", error);
    return new Response(null, { status: 503 });
  }
}

export async function handleNotificationRequest(
  request: Request,
  options: Options & { schedule?: Schedule; lookup?: OwnerLookup } = {},
) {
  return handleGraphRequest(request, options, processTranscriptNotification);
}

export async function handleLifecycleRequest(
  request: Request,
  options: Options & { schedule?: Schedule; lookup?: OwnerLookup } = {},
) {
  return handleGraphRequest(request, options, processLifecycleEvent);
}
