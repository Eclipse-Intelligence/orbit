import type { CompanionCall, CompanionJob, CompanionRequest, CompanionResult } from "@/companion/src/protocol";
import { EXTERNAL_NOTICE, findTool, runTool, toolJson } from "@/lib/assistant/tools";
import type { AuthenticatedCompanion } from "@/lib/companion/pairing";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";

const POLL_MS = 1_500;
const QUEUE_EXPIRY = "20 minutes";
const RUNNING_LIMIT = "20 minutes";
const SILENT_LIMIT = "3 minutes";
const WIND_DOWN = "45 seconds";
const KEEP_FINISHED = "1 day";
export function failureReply(message: string) {
  const reason = message.trim();
  return `I couldn't finish that. ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Say "try again" to have another go.`;
}

export const EXPIRED_MESSAGE = "I couldn't finish that. Orbit Agent on your Mac didn't get to it in time. Say \"try again\" to have another go.";
export const LOST_MESSAGE = "I couldn't finish that. Orbit Agent on your Mac stopped before it finished. Check it's running, then say \"try again\".";

type ToolEvent = { type: "tool"; id: string; name: string; label: string; status: "running" | "done" };

type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

type JobState = {
  status: JobStatus;
  events: ToolEvent[];
  result: { messageIds: string[] } | null;
  error: string | null;
  draft: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeJobs(db: Db, actor: UserActor, conversationIds: string[], message: string) {
  for (const conversationId of new Set(conversationIds)) {
    await db.query(
      `insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content)
       values ($1, $2, $3, 'assistant', $4)`,
      [conversationId, actor.workspaceId, actor.userId, message],
    );
    await db.query("update crm.assistant_conversations set updated_at = now() where id = $1", [conversationId]);
  }
}

async function expireStale(db: Db, actor: UserActor) {
  const expired = await db.query<{ conversation_id: string }>(
    `update crm.ai_companion_jobs set status = 'cancelled', finished_at = now()
     where user_id = $1 and status = 'queued' and created_at < now() - interval '${QUEUE_EXPIRY}'
     returning conversation_id`,
    [actor.userId],
  );
  await closeJobs(db, actor, expired.rows.map((row) => row.conversation_id), EXPIRED_MESSAGE);
  const lost = await db.query<{ conversation_id: string }>(
    `update crm.ai_companion_jobs j set status = 'cancelled', finished_at = now()
     where j.user_id = $1 and j.status = 'running'
       and (j.claimed_at < now() - interval '${RUNNING_LIMIT}' or j.updated_at < now() - interval '${SILENT_LIMIT}')
     returning j.conversation_id`,
    [actor.userId],
  );
  await closeJobs(db, actor, lost.rows.map((row) => row.conversation_id), LOST_MESSAGE);
}

async function pruneFinished(actor: UserActor) {
  await withActor(actor, (db) =>
    db.query(
      `delete from crm.ai_companion_jobs
       where user_id = $1 and status in ('done', 'failed', 'cancelled') and coalesce(finished_at, updated_at) < now() - interval '${KEEP_FINISHED}'`,
      [actor.userId],
    ),
  ).catch(() => undefined);
}

export async function enqueueCompanionJob(actor: UserActor, conversationId: string, request: CompanionRequest) {
  await pruneFinished(actor);
  return withActor(actor, async (db) => {
    await expireStale(db, actor);
    await db.query(
      `update crm.ai_companion_jobs set status = 'cancelled', finished_at = now()
       where conversation_id = $1 and status in ('queued', 'running')`,
      [conversationId],
    );
    const result = await db.query<{ id: string }>(
      `insert into crm.ai_companion_jobs (workspace_id, user_id, conversation_id, request)
       values ($1, $2, $3, $4::jsonb) returning id`,
      [actor.workspaceId, actor.userId, conversationId, JSON.stringify(request)],
    );
    return result.rows[0].id;
  });
}

export async function readCompanionJob(actor: UserActor, jobId: string): Promise<JobState> {
  return withActor(actor, async (db) => {
    const result = await db.query<JobState>(
      "select status, events, result, error, draft from crm.ai_companion_jobs where id = $1 and user_id = $2",
      [jobId, actor.userId],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "That request is gone.", 404);
    return result.rows[0];
  });
}

export async function companionBusy(actor: UserActor, exceptJobId: string) {
  return withActor(actor, async (db) => {
    await expireStale(db, actor);
    const result = await db.query<{ busy: boolean }>(
      `select exists (
         select 1 from crm.ai_companion_jobs j
         join crm.ai_companions c on c.id = j.companion_id and c.revoked_at is null
         where j.user_id = $1 and j.id <> $2
           and (
             (j.status = 'running' and j.updated_at > now() - interval '${SILENT_LIMIT}')
             or (j.status = 'cancelled' and j.finished_at > now() - interval '${WIND_DOWN}' and c.last_seen_at > now() - interval '${SILENT_LIMIT}')
           )
       ) as busy`,
      [actor.userId, exceptJobId],
    );
    return result.rows[0]?.busy === true;
  });
}

export async function companionWorking(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ working: boolean }>(
      `select exists (
         select 1 from crm.ai_companion_jobs j
         join crm.ai_companions c on c.id = j.companion_id and c.revoked_at is null
         where j.user_id = $1 and j.status = 'running' and j.updated_at > now() - interval '${SILENT_LIMIT}'
       ) as working`,
      [actor.userId],
    );
    return result.rows[0]?.working === true;
  });
}

export async function cancelCompanionJob(actor: UserActor, jobId: string) {
  await withActor(actor, (db) =>
    db.query(
      "update crm.ai_companion_jobs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'running')",
      [jobId],
    ),
  );
}

async function claim(auth: AuthenticatedCompanion): Promise<CompanionJob | null> {
  return withActor(auth.actor, async (db) => {
    await expireStale(db, auth.actor);
    const result = await db.query<{ id: string; request: CompanionRequest }>(
      `update crm.ai_companion_jobs set status = 'running', companion_id = $2, claimed_at = now()
       where id = (
         select id from crm.ai_companion_jobs
         where user_id = $1 and workspace_id = $3 and status = 'queued'
         order by created_at limit 1 for update skip locked
       )
       returning id, request`,
      [auth.actor.userId, auth.companionId, auth.actor.workspaceId],
    );
    return result.rows[0] ?? null;
  });
}

export async function nextCompanionJob(auth: AuthenticatedCompanion, waitMs: number) {
  const until = Date.now() + waitMs;
  for (;;) {
    const job = await claim(auth);
    if (job || Date.now() + POLL_MS > until) return job;
    await sleep(POLL_MS);
  }
}

async function runningJob(auth: AuthenticatedCompanion, jobId: string) {
  if (!isUuid(jobId)) throw new CrmError("not_found", "That request is gone.", 404);
  const job = await withActor(auth.actor, async (db) => {
    const result = await db.query<{ status: JobStatus; companion_id: string | null; conversation_id: string }>(
      "select status, companion_id, conversation_id from crm.ai_companion_jobs where id = $1 and user_id = $2",
      [jobId, auth.actor.userId],
    );
    return result.rows[0];
  });
  if (!job || job.companion_id !== auth.companionId) throw new CrmError("not_found", "That request is gone.", 404);
  if (job.status !== "running") throw new CrmError("conflict", "That request was cancelled.", 409);
  return job;
}

async function addEvent(auth: AuthenticatedCompanion, jobId: string, event: ToolEvent) {
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set events = events || $2::jsonb where id = $1", [jobId, JSON.stringify([event])]),
  );
}

function parseArgs(raw: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const RESULT_PIECE_BYTES = 36_000;
export const CONTINUE_RESULT_TOOL = {
  name: "continue_result",
  description:
    "Read the next piece of a tool result that was too long to send in one go. Pass the resultId and offset from the note at the end of the last piece, and keep going until the note says it's the end before you answer.",
  parameters: {
    type: "object",
    properties: {
      resultId: { type: "string", description: "The resultId from the note." },
      offset: { type: "integer", minimum: 0, description: "The offset from the note." },
    },
    required: ["resultId", "offset"],
  },
  write: false,
};

function pieceEnd(text: string, start: number) {
  let end = Math.min(text.length, start + RESULT_PIECE_BYTES);
  while (end > start + 1 && Buffer.byteLength(text.slice(start, end)) > RESULT_PIECE_BYTES) end = start + Math.floor((end - start) * 0.9);
  const code = text.charCodeAt(end - 1);
  return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function piece(resultId: string, text: string, offset: number) {
  const end = pieceEnd(text, offset);
  const lead = offset > 0 && text.includes(EXTERNAL_NOTICE) ? `[Continued. ${EXTERNAL_NOTICE}]\n` : "";
  const note =
    end < text.length
      ? `\n[This result is ${text.length} characters long and was sent in pieces. This piece is characters ${offset} to ${end}. Call continue_result with resultId "${resultId}" and offset ${end} for the next piece, and read to the end before you answer.]`
      : offset > 0
        ? `\n[End of the result: characters ${offset} to ${end} of ${text.length}.]`
        : "";
  return `${lead}${text.slice(offset, end)}${note}`;
}

async function sendResult(auth: AuthenticatedCompanion, jobId: string, resultId: string, content: string, isError: boolean) {
  if (Buffer.byteLength(content) <= RESULT_PIECE_BYTES) return { content, isError };
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set results = results || jsonb_build_object($2::text, $3::text) where id = $1 and user_id = $4", [
      jobId,
      resultId,
      content,
      auth.actor.userId,
    ]),
  );
  return { content: piece(resultId, content, 0), isError };
}

async function continueResult(auth: AuthenticatedCompanion, jobId: string, raw: string) {
  const args = parseArgs(raw);
  const resultId = typeof args.resultId === "string" ? args.resultId.slice(0, 120) : "";
  const offset = typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : -1;
  const stored = await withActor(auth.actor, async (db) => {
    const result = await db.query<{ content: string | null }>(
      "select results ->> $2 as content from crm.ai_companion_jobs where id = $1 and user_id = $3",
      [jobId, resultId, auth.actor.userId],
    );
    return result.rows[0]?.content ?? null;
  });
  if (!stored) return { content: toolJson({ error: "That result isn't available any more. Run the tool again." }), isError: true };
  if (offset < 0 || offset >= stored.length) {
    return { content: toolJson({ error: `Use an offset from 0 to ${stored.length - 1}, as given in the note.` }), isError: true };
  }
  return { content: piece(resultId, stored, offset), isError: false };
}

export async function runCompanionTool(auth: AuthenticatedCompanion, jobId: string, call: CompanionCall) {
  await runningJob(auth, jobId);
  if (call.name === CONTINUE_RESULT_TOOL.name) return continueResult(auth, jobId, call.arguments);
  const tool = findTool(call.name);
  if (!tool) return { content: toolJson({ error: `There is no tool called ${call.name}.` }), isError: true };
  if (tool.write) return { content: toolJson({ error: "Changes need the user's approval in Orbit." }), isError: true };
  const id = String(call.id || `${call.name}-${Date.now()}`).slice(0, 120);
  await addEvent(auth, jobId, { type: "tool", id, name: tool.name, label: tool.label, status: "running" });
  const output = (await runTool(auth.actor, call.name, parseArgs(call.arguments))) as Record<string, unknown> | null;
  await addEvent(auth, jobId, { type: "tool", id, name: tool.name, label: tool.label, status: "done" });
  return sendResult(auth, jobId, id, toolJson(output), Boolean(output && typeof output === "object" && "error" in output));
}

export const DRAFT_MAX = 200_000;

export async function saveCompanionDraft(auth: AuthenticatedCompanion, jobId: string, text: unknown) {
  await runningJob(auth, jobId);
  const draft = typeof text === "string" ? text.slice(0, DRAFT_MAX) : "";
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set draft = $2, updated_at = now() where id = $1 and status = 'running'", [jobId, draft || null]),
  );
}

export async function checkCompanionJob(auth: AuthenticatedCompanion, jobId: string) {
  await runningJob(auth, jobId);
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set updated_at = now() where id = $1 and status = 'running'", [jobId]),
  );
}

export async function finishCompanionJob(
  auth: AuthenticatedCompanion,
  jobId: string,
  apply: (actor: UserActor, conversationId: string) => Promise<string[]>,
) {
  await runningJob(auth, jobId);
  const claimed = await withActor(auth.actor, (db) =>
    db.query<{ conversation_id: string }>(
      "update crm.ai_companion_jobs set status = 'done', finished_at = now(), results = '{}'::jsonb where id = $1 and companion_id = $2 and status = 'running' returning conversation_id",
      [jobId, auth.companionId],
    ),
  );
  const conversationId = claimed.rows[0]?.conversation_id;
  if (!conversationId) throw new CrmError("conflict", "That request was cancelled.", 409);
  try {
    const messageIds = await apply(auth.actor, conversationId);
    await withActor(auth.actor, (db) =>
      db.query("update crm.ai_companion_jobs set result = $2::jsonb where id = $1", [jobId, JSON.stringify({ messageIds })]),
    );
  } catch (error) {
    await withActor(auth.actor, async (db) => {
      await db.query("update crm.ai_companion_jobs set status = 'failed', error = $2 where id = $1", [jobId, "Orbit couldn't save the answer."]);
      await closeJobs(db, auth.actor, [conversationId], failureReply("Orbit couldn't save the answer."));
    });
    throw error;
  }
}

export async function failCompanionJob(auth: AuthenticatedCompanion, jobId: string, error: unknown) {
  await runningJob(auth, jobId);
  const message = typeof error === "string" && error.trim() ? error.trim().slice(0, 1_000) : "Orbit Agent couldn't answer.";
  await withActor(auth.actor, async (db) => {
    const failed = await db.query<{ conversation_id: string }>(
      "update crm.ai_companion_jobs set status = 'failed', error = $2, finished_at = now(), results = '{}'::jsonb where id = $1 and status = 'running' returning conversation_id",
      [jobId, message],
    );
    await closeJobs(db, auth.actor, failed.rows.map((row) => row.conversation_id), failureReply(message));
  });
}

export function readCompanionResult(body: unknown): CompanionResult {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 200).map((raw) => {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const calls = (Array.isArray(step.calls) ? step.calls : []).slice(0, 100).flatMap((entry) => {
      const call = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      if (typeof call.id !== "string" || typeof call.name !== "string") return [];
      return [{ id: call.id.slice(0, 120), name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : "{}" }];
    });
    return { text: typeof step.text === "string" ? step.text.slice(0, 200_000) : "", calls };
  });
  const results: CompanionResult["results"] = {};
  if (input.results && typeof input.results === "object") {
    for (const [id, raw] of Object.entries(input.results as Record<string, unknown>)) {
      const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      if (typeof entry.content === "string") results[id] = { content: entry.content.slice(0, 1_000_000), isError: entry.isError === true };
    }
  }
  const sources = (Array.isArray(input.sources) ? input.sources : []).slice(0, 30).flatMap((raw) => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return typeof source.url === "string" && /^https?:\/\//.test(source.url)
      ? [{ url: source.url, title: typeof source.title === "string" ? source.title : null }]
      : [];
  });
  return {
    steps,
    results,
    sources,
    model: typeof input.model === "string" ? input.model : null,
    usage: input.usage && typeof input.usage === "object" ? (input.usage as Record<string, unknown>) : null,
  };
}
