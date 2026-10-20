import type { CompanionCall, CompanionJob, CompanionRequest, CompanionResult } from "@/companion/src/protocol";
import { TOOL_BY_NAME, runTool, toolJson } from "@/lib/assistant/tools";
import type { AuthenticatedCompanion } from "@/lib/companion/pairing";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";

const POLL_MS = 1_500;
const QUEUE_EXPIRY = "2 minutes";

type ToolEvent = { type: "tool"; id: string; name: string; label: string; status: "running" | "done" };

type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

type JobState = {
  status: JobStatus;
  events: ToolEvent[];
  result: { messageIds: string[] } | null;
  error: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enqueueCompanionJob(actor: UserActor, conversationId: string, request: CompanionRequest) {
  return withActor(actor, async (db) => {
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
      "select status, events, result, error from crm.ai_companion_jobs where id = $1 and user_id = $2",
      [jobId, actor.userId],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "That request is gone.", 404);
    return result.rows[0];
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
    await db.query(
      `update crm.ai_companion_jobs set status = 'cancelled', finished_at = now()
       where user_id = $1 and status = 'queued' and created_at < now() - interval '${QUEUE_EXPIRY}'`,
      [auth.actor.userId],
    );
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

export async function runCompanionTool(auth: AuthenticatedCompanion, jobId: string, call: CompanionCall) {
  await runningJob(auth, jobId);
  const tool = TOOL_BY_NAME.get(call.name);
  if (!tool) return { content: toolJson({ error: `There is no tool called ${call.name}.` }), isError: true };
  if (tool.write) return { content: toolJson({ error: "Changes need the user's approval in Orbit." }), isError: true };
  const id = String(call.id || `${call.name}-${Date.now()}`).slice(0, 120);
  await addEvent(auth, jobId, { type: "tool", id, name: tool.name, label: tool.label, status: "running" });
  const output = (await runTool(auth.actor, tool.name, parseArgs(call.arguments))) as Record<string, unknown> | null;
  await addEvent(auth, jobId, { type: "tool", id, name: tool.name, label: tool.label, status: "done" });
  return { content: toolJson(output), isError: Boolean(output && typeof output === "object" && "error" in output) };
}

export async function finishCompanionJob(
  auth: AuthenticatedCompanion,
  jobId: string,
  apply: (actor: UserActor, conversationId: string) => Promise<string[]>,
) {
  const job = await runningJob(auth, jobId);
  const messageIds = await apply(auth.actor, job.conversation_id);
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set status = 'done', result = $2::jsonb, finished_at = now() where id = $1", [
      jobId,
      JSON.stringify({ messageIds }),
    ]),
  );
}

export async function failCompanionJob(auth: AuthenticatedCompanion, jobId: string, error: unknown) {
  await runningJob(auth, jobId);
  const message = typeof error === "string" && error.trim() ? error.trim().slice(0, 1_000) : "Orbit Agent couldn't answer.";
  await withActor(auth.actor, (db) =>
    db.query("update crm.ai_companion_jobs set status = 'failed', error = $2, finished_at = now() where id = $1", [jobId, message]),
  );
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
