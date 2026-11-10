import { ShownError, notFoundMessage } from "@/lib/crm/errors";
import { webChecksNotSetUp } from "@/lib/ai-fields/types";
import { logUpstream, unreachable, upstreamMessage } from "@/lib/upstream";
const DECISIONS_URL = "https://api.parallel.ai/v1/decisions";
const TIMEOUT_MS = 20_000;
const QUESTIONS_MAX = 100;
const QUESTION_CHARS_MAX = 5_000;
const RETRY_PAUSE_MS = 1_500;

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> }
  | { type: "refusal" };

export type DecisionCitation = { url: string; title: string | null; excerpts: string[] };

export type Decision = { answers: Record<string, DecisionAnswer>; citations: DecisionCitation[]; id: string | null };

export class ParallelError extends ShownError {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ParallelError";
    this.status = status;
  }
}

const STOPPING_STATUSES = new Set([401, 402, 403, 429]);

export function stopsParallel(error: unknown) {
  return error instanceof ParallelError && error.status !== null && STOPPING_STATUSES.has(error.status);
}

type Viewer = { type?: string; role?: string } | null;

let missingKeyLogged = false;

function missingKey(viewer?: Viewer) {
  const log = !missingKeyLogged;
  missingKeyLogged = true;
  return new ParallelError(webChecksNotSetUp(viewer, log), 401);
}

function timeLeft(deadline: number | undefined, wanted: number) {
  if (deadline === undefined) return wanted;
  return Math.max(500, Math.min(wanted, deadline - Date.now()));
}

export function parallelKey(env: Record<string, string | undefined> = process.env) {
  return env.PARALLEL_API_KEY?.trim() || null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function probabilities(value: unknown) {
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record(value))) if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  return out;
}

function readAnswer(value: unknown): DecisionAnswer {
  const answer = record(value);
  if (answer.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)) return { type: "noul", noul: answer.noul };
  if (answer.type === "choice" && typeof answer.choice === "string") return { type: "choice", choice: answer.choice, probabilities: probabilities(answer.probabilities) };
  if (answer.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)) {
    return { type: "score", score: answer.score, probabilities: probabilities(answer.probabilities) };
  }
  return { type: "refusal" };
}

function readCitation(value: unknown): DecisionCitation | null {
  const citation = record(value);
  if (typeof citation.url !== "string" || !/^https?:\/\//.test(citation.url)) return null;
  return {
    url: citation.url.slice(0, 1000),
    title: typeof citation.title === "string" ? citation.title.slice(0, 300) : null,
    excerpts: Array.isArray(citation.excerpts) ? citation.excerpts.filter((item): item is string => typeof item === "string") : [],
  };
}

function checkLimits(questions: Record<string, DecisionQuestion>) {
  const names = Object.keys(questions);
  if (names.length > QUESTIONS_MAX) throw new ParallelError(`A web check can ask up to ${QUESTIONS_MAX} questions at once.`);
  for (const name of names) {
    const question = questions[name];
    if (name.length + JSON.stringify(question).length > QUESTION_CHARS_MAX) throw new ParallelError(`${name} is too long. Shorten it or its options.`);
    if (question.type === "choice" && (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)) {
      throw new ParallelError(`The question ${name} needs 2 to 255 options.`);
    }
    if (question.type === "score" && (question.criteria.length < 2 || question.criteria.length > 10)) throw new ParallelError(`The question ${name} needs 2 to 10 levels.`);
  }
}

function retryable(status: number) {
  return status === 429 || status >= 500;
}

export async function decide(
  state: Record<string, unknown>,
  questions: Record<string, DecisionQuestion>,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; excerpts?: boolean; retryPauseMs?: number; deadline?: number; viewer?: Viewer } = {},
): Promise<Decision> {
  const key = parallelKey(options.env);
  if (!key) throw missingKey(options.viewer);
  if (Object.keys(questions).length === 0) return { answers: {}, citations: [], id: null };
  checkLimits(questions);
  const send = async () => {
    try {
      return await (options.fetchImpl ?? fetch)(DECISIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ state, questions, ...(options.excerpts === false ? { include_excerpts: false } : {}) }),
        signal: AbortSignal.timeout(timeLeft(options.deadline, options.timeoutMs ?? TIMEOUT_MS)),
      });
    } catch (error) {
      logUpstream("Parallel", null, error);
      return null;
    }
  };
  const pause = options.retryPauseMs ?? RETRY_PAUSE_MS;
  let response = await send();
  if ((!response || retryable(response.status)) && (options.deadline === undefined || options.deadline - Date.now() > pause + 3_000)) {
    await response?.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, pause));
    response = await send();
  }
  if (!response) throw new ParallelError(unreachable("Parallel"), 0);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ParallelError(taskFailure(response.status), response.status);
  }
  const body = record(await response.json().catch(() => null));
  const answers: Record<string, DecisionAnswer> = {};
  for (const name of Object.keys(questions)) answers[name] = readAnswer(record(body.answers)[name]);
  const citations = (Array.isArray(body.citations) ? body.citations : []).map(readCitation).filter((item): item is DecisionCitation => item !== null);
  return { answers, citations, id: typeof body.decision_id === "string" ? body.decision_id : null };
}

const TASK_RUNS_URL = "https://api.parallel.ai/v1/tasks/runs";
const TASK_SPEC_CHARS_MAX = 15_000;
const TASK_TOTAL_CHARS_MAX = 25_000;

export type TaskStatus = "queued" | "action_required" | "running" | "completed" | "failed" | "cancelling" | "cancelled";

export type TaskFieldBasis = { field: string; citations: DecisionCitation[]; reasoning: string | null; confidence: "high" | "medium" | "low" | null };

export type TaskRun = { runId: string; status: TaskStatus; active: boolean; error: string | null };

export type TaskResult = { run: TaskRun; content: Record<string, unknown>; basis: TaskFieldBasis[] };

export type TaskField = { type: "number" | "string"; description: string };

const TASK_STATUSES: TaskStatus[] = ["queued", "action_required", "running", "completed", "failed", "cancelling", "cancelled"];

type TaskOptions = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number; deadline?: number; viewer?: Viewer };

function taskKey(options: TaskOptions) {
  const key = parallelKey(options.env);
  if (!key) throw missingKey(options.viewer);
  return key;
}

function taskFailure(status: number) {
  logUpstream("Parallel", status);
  if (status === 402) return "Parallel is out of credit.";
  return upstreamMessage("Parallel", status);
}

function fatal(status: number) {
  return status === 401 || status === 402 || status === 403;
}

async function taskRequest(url: string, init: RequestInit, options: TaskOptions) {
  try {
    return await (options.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(timeLeft(options.deadline, options.timeoutMs ?? TIMEOUT_MS)) });
  } catch {
    return null;
  }
}

function readTaskRun(value: unknown): TaskRun | null {
  const run = record(value);
  if (typeof run.run_id !== "string" || !run.run_id) return null;
  const status = TASK_STATUSES.find((item) => item === run.status) ?? "failed";
  const error = record(run.error);
  return {
    runId: run.run_id.slice(0, 200),
    status,
    active: typeof run.is_active === "boolean" ? run.is_active : status === "queued" || status === "running" || status === "cancelling",
    error: typeof error.message === "string" ? error.message.slice(0, 300) : null,
  };
}

function readBasis(value: unknown): TaskFieldBasis | null {
  const basis = record(value);
  if (typeof basis.field !== "string") return null;
  const confidence = basis.confidence === "high" || basis.confidence === "medium" || basis.confidence === "low" ? basis.confidence : null;
  return {
    field: basis.field,
    citations: (Array.isArray(basis.citations) ? basis.citations : []).map(readCitation).filter((item): item is DecisionCitation => item !== null),
    reasoning: typeof basis.reasoning === "string" ? basis.reasoning.slice(0, 2000) : null,
    confidence,
  };
}

export function taskJsonSchema(fields: Record<string, TaskField>) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { type: [field.type, "null"], description: field.description }])),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

export async function createTaskRun(
  input: Record<string, unknown>,
  fields: Record<string, TaskField>,
  options: TaskOptions & { processor?: string; metadata?: Record<string, string> } = {},
): Promise<TaskRun> {
  const key = taskKey(options);
  const names = Object.keys(fields);
  if (names.length === 0) throw new ParallelError("A task needs at least one field.");
  if (names.length > 100) throw new ParallelError("A task can fill up to 100 fields at once.");
  const taskSpec = { output_schema: { type: "json", json_schema: taskJsonSchema(fields) } };
  const specLength = JSON.stringify(taskSpec).length;
  if (specLength > TASK_SPEC_CHARS_MAX || specLength + JSON.stringify(input).length > TASK_TOTAL_CHARS_MAX) {
    throw new ParallelError("These questions are too long. Shorten them.");
  }
  const response = await taskRequest(
    TASK_RUNS_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ input, processor: options.processor ?? "base", task_spec: taskSpec, ...(options.metadata ? { metadata: options.metadata } : {}) }),
    },
    options,
  );
  if (!response) throw new ParallelError(unreachable("Parallel"), 0);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ParallelError(taskFailure(response.status), response.status);
  }
  const run = readTaskRun(await response.json().catch(() => null));
  if (!run) {
    logUpstream("Parallel", response.status, "no run in reply");
    throw new ParallelError("Couldn't start the web check. Try again.");
  }
  return run;
}

export async function getTaskRun(runId: string, options: TaskOptions = {}): Promise<TaskRun | null> {
  const key = taskKey(options);
  const response = await taskRequest(`${TASK_RUNS_URL}/${encodeURIComponent(runId)}`, { headers: { "x-api-key": key } }, options);
  if (!response) return null;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (fatal(response.status)) throw new ParallelError(taskFailure(response.status), response.status);
    if (response.status === 404) return { runId, status: "failed", active: false, error: notFoundMessage("web check run") };
    return null;
  }
  return readTaskRun(await response.json().catch(() => null));
}

export async function getTaskResult(runId: string, options: TaskOptions & { waitSeconds?: number } = {}): Promise<TaskResult | null> {
  const key = taskKey(options);
  const wait = Math.max(1, Math.min(600, Math.round(options.waitSeconds ?? 5)));
  const response = await taskRequest(
    `${TASK_RUNS_URL}/${encodeURIComponent(runId)}/result?timeout=${wait}`,
    { headers: { "x-api-key": key } },
    { ...options, timeoutMs: options.timeoutMs ?? (wait + 10) * 1000 },
  );
  if (!response) return null;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (fatal(response.status)) throw new ParallelError(taskFailure(response.status), response.status);
    if (response.status === 404) return { run: { runId, status: "failed", active: false, error: "The run failed." }, content: {}, basis: [] };
    return null;
  }
  const body = record(await response.json().catch(() => null));
  const run = readTaskRun(body.run) ?? { runId, status: "completed" as const, active: false, error: null };
  const output = record(body.output);
  return {
    run,
    content: output.type === "json" ? record(output.content) : {},
    basis: (Array.isArray(output.basis) ? output.basis : []).map(readBasis).filter((item): item is TaskFieldBasis => item !== null),
  };
}
