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
  dropPlaceholder,
  ensureIntegration,
  finishIntegration,
  getIntegrationStatus,
  importConflict,
  importPlaceholder,
  importSettled,
  knownImportsFor,
  lockImportKey,
  memberActor,
  readIntegration,
  recordImportFailure,
  recordIntegrationError,
  retryableImports,
  safeEqual,
  summarisePendingAcross,
  timeLeft,
  validTime,
  type IntegrationKey,
  type IntegrationStatus,
  type Participant,
} from "@/lib/crm/conversations";
import { captureWorkspaceInDb, moveImportToWorkspace, ownCallAddresses, routeCallInDb, suggestedWorkspace } from "@/lib/crm/call-routing";
import { readStored } from "@/lib/crm/inbox";
import { workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { appAccessToken } from "@/lib/microsoft/calls";
import { MicrosoftError } from "@/lib/microsoft/oauth";
import {
  createSubscription,
  fetchTranscript,
  fetchTranscriptContent,
  fetchTranscripts,
  parseTranscriptResource,
  renewSubscription,
  transcriptErrorText,
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

type Options = { fetchImpl?: typeof fetch; deadline?: number; now?: number; actors?: UserActor[] };

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
       where source = 'teams' and status = 'pending' and user_id = $1`,
      [actor.userId],
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

type Spread = { importId: string; to: string };

async function spreadPlan(db: Db, owner: UserActor, workspaceIds: string[]) {
  const result = await db.query<{ id: string; workspace_id: string; external_id: string; status: string; call_workspaces: string[] }>(
    `select i.id, i.workspace_id, i.external_id, i.status,
       array(
         select distinct r.workspace_id from crm.call_records r
         where r.teams_call_id = i.call_id and r.activity_id is not null and r.workspace_id = any($2::uuid[])
       ) as call_workspaces
     from crm.conversation_imports i
     where i.user_id = $1 and i.source = 'teams' and i.status in ('pending', 'unfiled', 'filed')
       and i.call_id is not null and i.workspace_id = any($2::uuid[])
     order by (i.status = 'filed') desc, i.created_at`,
    [owner.userId, workspaceIds],
  );
  const moves: Spread[] = [];
  const copies: Spread[] = [];
  const planned = new Set<string>();
  for (const row of result.rows) {
    if (row.call_workspaces.length === 0) continue;
    const present = await db.query<{ workspace_id: string }>(
      `select workspace_id from crm.conversation_imports
       where user_id = $1 and source = 'teams' and external_id = $2 and workspace_id = any($3::uuid[])`,
      [owner.userId, row.external_id, row.call_workspaces],
    );
    const missing = row.call_workspaces.filter(
      (id) => !present.rows.some((item) => item.workspace_id === id) && !planned.has(`${row.external_id}:${id}`),
    );
    if (missing.length === 0) continue;
    for (const id of missing) planned.add(`${row.external_id}:${id}`);
    if (row.status !== "filed" && !row.call_workspaces.includes(row.workspace_id)) {
      moves.push({ importId: row.id, to: missing[0] });
      for (const id of missing.slice(1)) copies.push({ importId: row.id, to: id });
    } else {
      for (const id of missing) copies.push({ importId: row.id, to: id });
    }
  }
  return { moves, copies };
}

async function copyImport(db: Db, importId: string, workspaceId: string) {
  const result = await db.query<{ id: string }>(
    `insert into crm.conversation_imports (
       workspace_id, user_id, source, external_id, kind, call_id, title, occurred_at, ended_at,
       participants, external_url, transcript, source_summary, status
     )
     select $2, user_id, source, external_id, kind, call_id, title, occurred_at, ended_at,
       participants, external_url, transcript, source_summary, 'pending'
     from crm.conversation_imports where id = $1
     on conflict do nothing
     returning id`,
    [importId, workspaceId],
  );
  return result.rows[0]?.id ?? null;
}

type NameFiling = { importId: string; workspaceId: string; targets: string[] };

async function expiredByName(db: Db, owner: UserActor, actors: UserActor[], cutoff: string, spread: string[]) {
  const workspaceIds = actors.map((item) => item.workspaceId);
  const result = await db.query<{ id: string; workspace_id: string; participants: Participant[] | null; occurred_at: Date | null }>(
    `select i.id, i.workspace_id, i.participants, i.occurred_at from crm.conversation_imports i
     where i.user_id = $1 and i.source = 'teams' and i.status = 'pending' and i.workspace_id = any($2::uuid[])
       and coalesce(i.occurred_at, i.created_at) < $3::timestamptz
       and not (i.id = any($4::uuid[]))
       and not exists (
         select 1 from crm.call_records r
         where r.teams_call_id = i.call_id and r.activity_id is not null and r.workspace_id = any($2::uuid[])
       )
     order by i.occurred_at nulls last
     limit 50`,
    [owner.userId, workspaceIds, cutoff, spread],
  );
  const own = await ownCallAddresses(db, owner);
  const filings: NameFiling[] = [];
  for (const row of result.rows) {
    const people = Array.isArray(row.participants) ? row.participants : [];
    const route = await routeCallInDb(db, owner, actors, people, { own, names: true, occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null });
    const targets = route.targets.filter((target) => target.match.contactId).map((target) => target.actor.workspaceId);
    if (targets.length === 0 && route.suggested.length > 0) targets.push(suggestedWorkspace(route.suggested, row.workspace_id));
    if (targets.length > 0) filings.push({ importId: row.id, workspaceId: row.workspace_id, targets });
  }
  return filings;
}

export async function settleTeamsTranscripts(owner: UserActor, now = Date.now(), everyone?: UserActor[]) {
  const actors = everyone ?? (await workspaceActors(owner));
  const workspaceIds = actors.map((item) => item.workspaceId);
  const cutoff = new Date(now - UNFILED_AFTER_MS).toISOString();
  const plan = await withActor(owner, (db) => spreadPlan(db, owner, workspaceIds));
  for (const move of plan.moves) {
    await moveImportToWorkspace(owner, move.importId, move.to).catch((error) => console.error("Moving a Teams transcript failed", error));
  }
  const spread = [...new Set([...plan.moves, ...plan.copies].map((item) => item.importId))];
  const named = await withActor(owner, (db) => expiredByName(db, owner, actors, cutoff, spread));
  for (const filing of named) {
    if (filing.targets.includes(filing.workspaceId)) continue;
    await moveImportToWorkspace(owner, filing.importId, filing.targets[0]).catch((error) =>
      console.error("Moving a Teams transcript failed", error),
    );
  }
  return withActor(owner, async (db) => {
    for (const copy of plan.copies) await copyImport(db, copy.importId, copy.to);
    let attached = 0;
    for (const workspaceId of workspaceIds) attached += await attachTeamsTranscripts(db, workspaceId);
    const expired = await db.query(
      `update crm.conversation_imports
       set status = 'unfiled'
       where workspace_id = any($1::uuid[]) and source = 'teams' and user_id = $2 and status = 'pending'
         and coalesce(occurred_at, created_at) < $3::timestamptz`,
      [workspaceIds, owner.userId, cutoff],
    );
    const pending = await db.query<{ total: number }>(
      `select count(*)::int as total from crm.conversation_imports
       where workspace_id = any($1::uuid[]) and source = 'teams' and user_id = $2 and status = 'pending'`,
      [workspaceIds, owner.userId],
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
  everyone?: UserActor[],
): Promise<"skipped" | "filed" | "pending"> {
  const externalId = transcript.id.trim().slice(0, 400);
  if (!externalId) return "skipped";
  const actors = everyone ?? (await workspaceActors(actor));
  const workspaceIds = actors.map((item) => item.workspaceId);
  const known = await withActor(actor, (db) => knownImportsFor(db, workspaceIds, "teams", [externalId], actor.userId));
  if (importSettled(known.get(externalId), workspaceIds)) return "skipped";
  const raw = await fetchTranscriptContent(token, identity.objectId, transcript, fetchImpl, deadline);
  const text = transcriptToText(raw).slice(0, 1_000_000);
  const callId = transcript.callId?.trim().slice(0, 200) || null;
  return withActor(actor, async (db) => {
    await lockImportKey(db, actor.userId, "teams", externalId);
    const again = (await knownImportsFor(db, workspaceIds, "teams", [externalId], actor.userId)).get(externalId);
    const calls = callId
      ? (
          await db.query<{ workspace_id: string }>(
            `select distinct workspace_id from crm.call_records
             where teams_call_id = $1 and activity_id is not null and workspace_id = any($2::uuid[])`,
            [callId, workspaceIds],
          )
        ).rows.map((row) => row.workspace_id)
      : [];
    if (importSettled(again, workspaceIds)) return "skipped";
    const open = calls.filter((id) => !again?.workspaces.has(id));
    if (again && open.length === 0) return "skipped";
    const stored = await readStored(db, actor);
    const placement = calls.length > 0 ? open : [await captureWorkspaceInDb(db, actor, actors, [], [stored?.email])];
    const placeholder = await importPlaceholder(db, workspaceIds, "teams", externalId, actor.userId);
    const ids: string[] = [];
    for (const workspaceId of placement) {
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
          workspaceId,
          actor.userId,
          externalId,
          callId,
          validTime(transcript.createdDateTime),
          validTime(transcript.endDateTime),
          JSON.stringify(speakers(text)),
          text || null,
        ],
      );
      ids.push(saved.rows[0].id);
      await attachTeamsTranscripts(db, workspaceId);
    }
    if (placeholder && !placement.includes(placeholder.workspace_id)) await dropPlaceholder(db, placeholder.id);
    const status = await db.query<{ filed: boolean }>(
      "select bool_or(status = 'filed') as filed from crm.conversation_imports where id = any($1::uuid[])",
      [ids],
    );
    return status.rows[0]?.filed ? "filed" : "pending";
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
      options.actors,
    );
  } catch (error) {
    const message = transcriptErrorText(error, "Couldn't import a Teams transcript. Try again.");
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
    const everyone = await workspaceActors(actor);
    const scoped = { ...options, actors: everyone };
    const everyoneIds = everyone.map((item) => item.workspaceId);
    const known = await withActor(actor, (db) => knownImportsFor(db, everyoneIds, "teams", listed, actor.userId));
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
      if (importSettled(known.get(transcript.id), everyoneIds)) continue;
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
        complete = false;
        break;
      }
      outcome(await importOrRecord(actor, token, identity, transcript, scoped));
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
        if (!transcript) throw new MicrosoftError("Transcript not found.");
        outcome(
          await importOrRecord(
            actor,
            token,
            identity,
            { ...transcript, callId: transcript.callId ?? retry.callId },
            scoped,
          ),
        );
      } catch (error) {
        const message = transcriptErrorText(error, "Couldn't import a Teams transcript. Try again.");
        await recordImportFailure(
          actor,
          { source: "teams", kind: "call", externalId: retry.externalId, callId: retry.callId },
          message,
        );
        firstError ??= message;
        result.failed += 1;
      }
    }
    const settled = await settleTeamsTranscripts(actor, now, everyone);
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
    result.summarised = await summarisePendingAcross(actor, {
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
      actors: everyone,
    });
    return result;
  } catch (error) {
    const message = transcriptErrorText(error, "Couldn't sync Teams transcripts. Try again.");
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
    const message = transcriptErrorText(error, "Couldn't turn on instant Teams transcripts. Try again.");
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
    await summarisePendingAcross(actor, { fetchImpl: options.fetchImpl, deadline: options.deadline });
  } catch (error) {
    if (!identity) return;
    await recordIntegrationError(
      actor,
      teamsKey(actor, identity.connectionId),
      transcriptErrorText(error, "Couldn't import a Teams transcript. Try again."),
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
