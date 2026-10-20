import { after } from "next/server";
import { query } from "@/lib/db/pool";
import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import {
  backgroundTargets,
  claimIntegration,
  clip,
  configuredSiteOrigin,
  ensureIntegration,
  errorText,
  finishIntegration,
  getIntegrationStatus,
  importActivityInput,
  importConflict,
  internalAddresses,
  knownImports,
  lockImportKey,
  matchEmails,
  memberActor,
  readIntegration,
  recordImportFailure,
  recordIntegrationError,
  retryableImports,
  summarisePendingImports,
  timeLeft,
  validTime,
  type BackgroundTarget,
  type IntegrationKey,
  type IntegrationStatus,
  type Participant,
} from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { matchParties } from "@/lib/crm/inbox";
import { canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import {
  GranolaError,
  granolaApiKey,
  granolaClient,
  granolaTranscriptText,
  noteIdFromPayload,
  verifyWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
  type GranolaClient,
  type GranolaNote,
} from "@/lib/granola";

const SYNC_GAP_MS = 2 * 60 * 1000;
const OVERLAP_MS = 60 * 60 * 1000;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 2;
const MAX_LIST_PAGES = 50;
const STEP_RESERVE_MS = 5_000;
const WEBHOOK_BUDGET_MS = 50_000;

const GRANOLA_NOT_CONFIGURED = "Set GRANOLA_API_KEY to import Granola meetings.";
export const GRANOLA_WEBHOOK_UNAVAILABLE =
  "Granola webhooks aren't available for this workspace; Orbit will check every 10 minutes instead.";
const GRANOLA_NO_WORKSPACE =
  "Orbit could not work out which workspace the Granola notes belong to.";
const GRANOLA_OTHER_WORKSPACE = "Granola notes are imported into another workspace.";

type GranolaSyncResult = {
  ran: boolean;
  fetched: number;
  filed: number;
  unfiled: number;
  skipped: number;
  failed: number;
  summarised: number;
  complete: boolean;
  error?: string;
};

export type GranolaStatus = IntegrationStatus & {
  configured: boolean;
  personal: { connected: boolean; hint: string | null };
  sharedKey: boolean;
};

type GranolaOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadline?: number;
  targets?: BackgroundTarget[];
};

type ImportOutcome = "filed" | "unfiled" | "skipped" | "missing";

type Schedule = (task: () => Promise<unknown>) => void;

const ownerEmails = new Map<string, string>();

function client(apiKey: string, options: GranolaOptions) {
  return granolaClient({
    apiKey,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    deadline: options.deadline,
  });
}

function granolaKey(actor: UserActor): IntegrationKey {
  return { workspaceId: actor.workspaceId, source: "granola", userId: actor.userId };
}

function granolaParticipants(note: GranolaNote): Participant[] {
  const owner = canonicalEmail(note.owner?.email ?? "");
  const people = new Map<string, Participant>();
  const add = (name: string | null | undefined, email: string | null | undefined) => {
    const canonical = email ? canonicalEmail(email) : null;
    if (!canonical || canonical === owner) return;
    const existing = people.get(canonical);
    if (existing) {
      if (!existing.name && name?.trim()) existing.name = name.trim();
      return;
    }
    people.set(canonical, { name: name?.trim() || null, email: canonical });
  };
  for (const attendee of note.attendees ?? []) add(attendee.name, attendee.email);
  for (const invitee of note.calendar_event?.invitees ?? []) add(null, invitee.email);
  return [...people.values()];
}

export async function resolveGranolaActor(
  api: GranolaClient,
  apiKey: string,
  targets?: BackgroundTarget[],
): Promise<UserActor | null> {
  const list = targets ?? (await backgroundTargets());
  if (list.length === 0) return null;
  const workspaces = new Set(list.map((target) => target.actor.workspaceId));
  let ownerEmail = ownerEmails.get(apiKey) ?? null;
  if (!ownerEmail && (workspaces.size > 1 || list.some((target) => target.members.length > 1))) {
    const page = await api.listNotes({ pageSize: 1 });
    ownerEmail = canonicalEmail(page.notes[0]?.owner?.email ?? "");
    if (ownerEmail) ownerEmails.set(apiKey, ownerEmail);
  }
  if (ownerEmail) {
    for (const target of list) {
      const member = target.members.find((item) => canonicalEmail(item.email) === ownerEmail);
      if (member) return member;
    }
  }
  return workspaces.size === 1 ? list[0].actor : null;
}

async function workspaceActor(actor: UserActor, api: GranolaClient, apiKey: string) {
  const resolved = await resolveGranolaActor(api, apiKey);
  if (!resolved) throw new CrmError("invalid_input", GRANOLA_NO_WORKSPACE, 400);
  if (resolved.workspaceId !== actor.workspaceId) {
    throw new CrmError("invalid_input", GRANOLA_OTHER_WORKSPACE, 400);
  }
  return actor;
}

async function readPersonalKey(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ key_cipher: string; key_hint: string | null }>(
      "select key_cipher, key_hint from crm.granola_keys where workspace_id = $1 and user_id = $2",
      [actor.workspaceId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

export async function personalGranolaKey(actor: UserActor) {
  const row = await readPersonalKey(actor);
  if (!row) return null;
  try {
    return decryptSecret(row.key_cipher);
  } catch {
    return null;
  }
}

export async function saveGranolaKey(actor: UserActor, key: string, options: GranolaOptions = {}) {
  const trimmed = key.trim();
  if (trimmed.length < 10 || trimmed.length > 500 || /\s/.test(trimmed)) {
    throw new CrmError("invalid_input", "Paste the whole Granola API key.", 400, { field: "key" });
  }
  try {
    await client(trimmed, options).listNotes({ pageSize: 1 });
  } catch (error) {
    const reason = errorText(error, "");
    const rejected = /reject|401|403|unauthori[sz]ed|invalid/i.test(reason);
    throw new CrmError(
      "invalid_input",
      rejected ? "Granola didn't accept that key. Check you copied all of it." : `Couldn't reach Granola to check the key. ${reason}`.trim(),
      400,
      { field: "key" },
    );
  }
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.granola_keys (workspace_id, user_id, key_cipher, key_hint)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, user_id)
       do update set key_cipher = excluded.key_cipher, key_hint = excluded.key_hint, updated_at = now()`,
      [actor.workspaceId, actor.userId, encryptSecret(trimmed), trimmed.slice(-4)],
    ),
  );
}

export async function removeGranolaKey(actor: UserActor) {
  await withActor(actor, (db) =>
    db.query("delete from crm.granola_keys where workspace_id = $1 and user_id = $2", [actor.workspaceId, actor.userId]),
  );
}

export async function getGranolaStatus(actor: UserActor): Promise<GranolaStatus> {
  const [status, personal] = await Promise.all([getIntegrationStatus(actor, granolaKey(actor)), readPersonalKey(actor)]);
  return {
    ...status,
    configured: Boolean(granolaApiKey()) || Boolean(personal),
    personal: { connected: Boolean(personal), hint: personal?.key_hint ?? null },
    sharedKey: Boolean(granolaApiKey()),
  };
}

export async function syncGranolaOnVisit(actor: UserActor) {
  if (await readPersonalKey(actor)) return syncGranola({ actor });
  if (granolaApiKey()) return syncGranola();
  return null;
}

async function fileGranolaNote(actor: UserActor, note: GranolaNote): Promise<ImportOutcome> {
  const participants = granolaParticipants(note);
  const transcript = granolaTranscriptText(note.transcript, note.owner?.name ?? actor.fullName);
  const title = clip(note.title, 500) ?? clip(note.calendar_event?.event_title, 500);
  const occurredAt =
    validTime(note.calendar_event?.scheduled_start_time) ?? validTime(note.created_at);
  const lastLine = note.transcript?.[note.transcript.length - 1];
  const endedAt =
    validTime(note.calendar_event?.scheduled_end_time) ?? validTime(lastLine?.end_time);
  const externalUrl = clip(note.web_url, 2000);
  return withActor(actor, async (db) => {
    await lockImportKey(db, actor.workspaceId, "granola", note.id);
    const known = await knownImports(db, actor.workspaceId, "granola", [note.id]);
    if (known.has(note.id)) return "skipped";
    const internal = await internalAddresses(db, actor.workspaceId, [note.owner?.email, actor.email]);
    const emails = matchEmails(participants, [note.owner?.email, actor.email]).filter(
      (email) => !internal.isInternal(email),
    );
    const match = await matchParties(db, actor.workspaceId, emails);
    let activityId: string | null = null;
    if (match.contactId || match.companyId) {
      const activity = await createActivityInDb(
        db,
        actor,
        importActivityInput(
          {
            source: "granola",
            kind: "meeting",
            external_id: note.id,
            call_id: null,
            title,
            occurred_at: occurredAt,
            participants,
            external_url: externalUrl,
          },
          {
            contactId: match.contactId,
            companyId: match.companyId,
            contactName: match.contactName,
          },
        ),
        { operation: "import_granola", source: "granola" },
      );
      activityId = activity.id;
    }
    await db.query(
      `insert into crm.conversation_imports (
         workspace_id, user_id, source, external_id, kind, title, occurred_at, ended_at,
         participants, external_url, transcript, source_summary, status,
         activity_id, contact_id, company_id
       ) values (
         $1, $2, 'granola', $3, 'meeting', $4, $5::timestamptz, $6::timestamptz,
         $7::jsonb, $8, $9, $10, $11, $12, $13, $14
       )
       on conflict ${importConflict("granola")} do update
         set title = excluded.title,
             occurred_at = excluded.occurred_at,
             ended_at = excluded.ended_at,
             participants = excluded.participants,
             external_url = excluded.external_url,
             transcript = excluded.transcript,
             source_summary = excluded.source_summary,
             status = excluded.status,
             activity_id = excluded.activity_id,
             contact_id = excluded.contact_id,
             company_id = excluded.company_id,
             error = null,
             attempts = 0`,
      [
        actor.workspaceId,
        actor.userId,
        note.id,
        title,
        occurredAt,
        endedAt,
        JSON.stringify(participants),
        externalUrl,
        transcript ? transcript.slice(0, 1_000_000) : null,
        clip(note.summary_markdown ?? note.summary_text, 100_000),
        activityId ? "filed" : "unfiled",
        activityId,
        activityId ? match.contactId : null,
        activityId ? match.companyId : null,
      ],
    );
    return activityId ? "filed" : "unfiled";
  });
}

async function importGranolaNote(
  actor: UserActor,
  api: GranolaClient,
  noteId: string,
): Promise<ImportOutcome> {
  const known = await withActor(actor, (db) =>
    knownImports(db, actor.workspaceId, "granola", [noteId]),
  );
  if (known.has(noteId)) return "skipped";
  const note = await api.getNote(noteId);
  if (!note || note.deleted_at) return "missing";
  return fileGranolaNote(actor, note);
}

async function inPool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export async function syncGranola(
  options: GranolaOptions & { actor?: UserActor; force?: boolean } = {},
): Promise<GranolaSyncResult> {
  const idle: GranolaSyncResult = {
    ran: false,
    fetched: 0,
    filed: 0,
    unfiled: 0,
    skipped: 0,
    failed: 0,
    summarised: 0,
    complete: false,
  };
  const personal = options.actor ? await personalGranolaKey(options.actor).catch(() => null) : null;
  const apiKey = personal ?? granolaApiKey();
  if (!apiKey) return { ...idle, error: GRANOLA_NOT_CONFIGURED };
  const api = client(apiKey, options);
  let actor = options.actor ?? null;
  if (!actor) {
    try {
      actor = await resolveGranolaActor(api, apiKey, options.targets);
    } catch (error) {
      return { ...idle, ran: true, error: errorText(error, "Could not reach Granola.") };
    }
  }
  if (!actor) return { ...idle, error: GRANOLA_NO_WORKSPACE };
  const owner = actor;
  const key = granolaKey(owner);
  const claim = await withActor(owner, (db) =>
    claimIntegration(db, key, Boolean(options.force), SYNC_GAP_MS),
  );
  if (!claim) return idle;
  const started = new Date();
  try {
    const since = claim.lastSyncedAt
      ? new Date(new Date(claim.lastSyncedAt).getTime() - OVERLAP_MS)
      : new Date(started.getTime() - LOOKBACK_MS);
    const ids: string[] = [];
    let complete = true;
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_LIST_PAGES || !timeLeft(options.deadline, STEP_RESERVE_MS)) {
        complete = false;
        break;
      }
      const body = await api.listNotes({ updatedAfter: since.toISOString(), cursor, pageSize: 30 });
      for (const note of body.notes ?? []) {
        if (!note.deleted_at && !ids.includes(note.id)) ids.push(note.id);
      }
      if (!body.hasMore || !body.cursor) break;
      cursor = body.cursor;
    }
    const known = await withActor(owner, (db) =>
      knownImports(db, owner.workspaceId, "granola", ids),
    );
    const retries = (await retryableImports(owner, "granola"))
      .map((item) => item.externalId)
      .filter((id) => !ids.includes(id));
    const fresh = [...ids.filter((id) => !known.has(id)), ...retries];
    const result: GranolaSyncResult = {
      ...idle,
      ran: true,
      fetched: ids.length,
      skipped: ids.length - ids.filter((id) => !known.has(id)).length,
    };
    let firstError: string | null = null;
    await inPool(fresh, CONCURRENCY, async (id) => {
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
        complete = false;
        return;
      }
      try {
        const outcome = await importGranolaNote(owner, api, id);
        if (outcome === "missing" && retries.includes(id)) {
          throw new Error("Granola no longer returns this note.");
        }
        if (outcome === "filed") result.filed += 1;
        else if (outcome === "unfiled") result.unfiled += 1;
        else result.skipped += 1;
      } catch (error) {
        const message = errorText(error, "Could not import a Granola note.");
        firstError ??= message;
        result.failed += 1;
        await recordImportFailure(
          owner,
          { source: "granola", kind: "meeting", externalId: id },
          message,
        );
      }
    });
    await withActor(owner, (db) =>
      finishIntegration(db, key, {
        syncedAt: complete ? started.toISOString() : null,
        error: firstError,
      }),
    );
    result.complete = complete;
    if (firstError) result.error = firstError;
    result.summarised = await summarisePendingImports(owner, {
      fetchImpl: options.fetchImpl,
      deadline: options.deadline,
    });
    return result;
  } catch (error) {
    const message = errorText(error, "Could not sync Granola.");
    await withActor(owner, (db) => finishIntegration(db, key, { error: message }));
    return { ...idle, ran: true, error: message };
  }
}

export async function syncGranolaFor(actor: UserActor, options: GranolaOptions = {}) {
  if (await readPersonalKey(actor)) return syncGranola({ ...options, actor, force: true });
  const apiKey = granolaApiKey();
  if (!apiKey) throw new CrmError("invalid_input", GRANOLA_NOT_CONFIGURED, 400);
  await workspaceActor(actor, client(apiKey, options), apiKey);
  return syncGranola({ ...options, actor, force: true });
}

export async function enableGranolaWebhook(
  actor: UserActor,
  origin: string,
  options: GranolaOptions = {},
): Promise<{ enabled: boolean; message: string }> {
  assertScope(actor.scopes, "admin");
  const apiKey = granolaApiKey();
  if (!apiKey) throw new CrmError("invalid_input", GRANOLA_NOT_CONFIGURED, 400);
  const api = client(apiKey, options);
  await workspaceActor(actor, api, apiKey);
  const key = granolaKey(actor);
  const state = await withActor(actor, (db) => readIntegration(db, key));
  if (state?.webhook_id && state.webhook_secret) {
    return { enabled: true, message: "Instant Granola sync is already on." };
  }
  const url = `${configuredSiteOrigin() ?? origin}/api/granola/webhook`;
  let endpoint;
  try {
    endpoint = await api.createWebhookEndpoint({
      url,
      scopes: ["personal"],
      events: ["note.generated"],
    });
  } catch (error) {
    throw new CrmError(
      "upstream_error",
      error instanceof GranolaError ? error.message : "Could not reach Granola.",
      502,
    );
  }
  if (!endpoint) return { enabled: false, message: GRANOLA_WEBHOOK_UNAVAILABLE };
  if (!endpoint.signing_secret) {
    throw new CrmError("upstream_error", "Granola did not return a signing secret.", 502);
  }
  await withActor(actor, async (db) => {
    await ensureIntegration(db, key);
    await db.query(
      `update crm.integration_state
       set webhook_id = $3, webhook_secret = $4, user_id = $5
       where workspace_id = $1 and source = $2 and connection_id is null`,
      [
        actor.workspaceId,
        "granola",
        endpoint.id.slice(0, 200),
        encryptSecret(endpoint.signing_secret),
        actor.userId,
      ],
    );
  });
  return { enabled: true, message: "Instant Granola sync is on." };
}

type WebhookTarget = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
  webhook_secret: string;
};

async function claimReceipt(actor: UserActor, messageId: string) {
  return withActor(actor, async (db) => {
    await db.query(
      `delete from crm.webhook_receipts
       where workspace_id = $1 and source = 'granola'
         and received_at < now() - make_interval(secs => $2::double precision)`,
      [actor.workspaceId, WEBHOOK_TOLERANCE_SECONDS * 2],
    );
    const inserted = await db.query(
      `insert into crm.webhook_receipts (workspace_id, source, message_id)
       values ($1, 'granola', $2)
       on conflict (workspace_id, source, message_id) do nothing
       returning id`,
      [actor.workspaceId, messageId.slice(0, 200)],
    );
    return (inserted.rowCount ?? 0) > 0;
  });
}

async function receiveGranolaWebhook(
  headers: Headers,
  body: string,
  options: { now?: number } = {},
): Promise<
  | { ok: false; status: number }
  | { ok: true; duplicate: boolean; actor: UserActor; noteId: string | null }
> {
  if (!granolaApiKey()) return { ok: false, status: 404 };
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  const now = options.now ?? Date.now();
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, status: 401 };
  }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, status: 401 };
  }
  const targets = await query<WebhookTarget>("select * from private.granola_webhook_targets()");
  let actor: UserActor | null = null;
  for (const row of targets.rows) {
    let secret: string;
    try {
      secret = decryptSecret(row.webhook_secret);
    } catch {
      continue;
    }
    if (verifyWebhook({ secret, id, timestamp, signature, body, now })) {
      actor = memberActor(row);
      break;
    }
  }
  if (!actor) return { ok: false, status: 401 };
  const fresh = await claimReceipt(actor, id);
  return { ok: true, duplicate: !fresh, actor, noteId: noteIdFromPayload(body) };
}

export async function processGranolaWebhook(
  actor: UserActor,
  noteId: string | null,
  options: GranolaOptions = {},
) {
  const apiKey = granolaApiKey();
  if (!apiKey) return;
  if (!noteId) {
    await syncGranola({ ...options, actor });
    return;
  }
  try {
    await importGranolaNote(actor, client(apiKey, options), noteId);
  } catch (error) {
    const message = errorText(error, "Could not import a Granola note.");
    await recordImportFailure(actor, { source: "granola", kind: "meeting", externalId: noteId }, message);
    await recordIntegrationError(actor, granolaKey(actor), message);
    return;
  }
  await summarisePendingImports(actor, { fetchImpl: options.fetchImpl, deadline: options.deadline });
}

function background(task: () => Promise<unknown>) {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("Granola webhook processing failed", error);
    }
  });
}

export async function handleGranolaWebhook(
  request: Request,
  options: GranolaOptions & { now?: number; schedule?: Schedule } = {},
) {
  const deadline = options.deadline ?? Date.now() + WEBHOOK_BUDGET_MS;
  try {
    const body = await request.text();
    const received = await receiveGranolaWebhook(request.headers, body, options);
    if (!received.ok) {
      return Response.json({ error: "Webhook not accepted." }, { status: received.status });
    }
    if (received.duplicate) return Response.json({ ok: true, duplicate: true });
    const schedule = options.schedule ?? background;
    schedule(() =>
      processGranolaWebhook(received.actor, received.noteId, { ...options, deadline }),
    );
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Granola webhook failed", error);
    return Response.json({ error: "Try again later." }, { status: 503 });
  }
}
