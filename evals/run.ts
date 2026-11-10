import { sendMessage } from "@/lib/assistant/chat";
import { assistantModel } from "@/lib/assistant/models";
import { findTool } from "@/lib/assistant/tools";
import { getAdminPool } from "@/lib/db/pool";
import { runJudge } from "./judge";
import { breaches, inContext, newContext, outsideFetch, realFetch, type GatewayHandler, type RunContext } from "./outside";
import { buildWorld, fill } from "./world";
import type { CardRecord, CheckResult, Defence, EvalTask, PricedUsage, ToolCallRecord, Transcript, Usage, World } from "./types";

export type RunSettings = {
  model: string;
  reasoning: string;
  gateway: GatewayHandler;
  judge: GatewayHandler;
  judgeModel?: string;
  useJudge: boolean;
  timeoutMs: number;
  passthrough?: typeof fetch;
};

export type RunResult = {
  pass: boolean;
  checks: CheckResult[];
  judgesSkipped: number;
  error: string | null;
  ms: number;
  usage: Usage;
  otherUsage: Usage;
  costUsd: number | null;
  rounds: number;
  answer: string;
  calls: { name: string; args: Record<string, unknown> }[];
  cards: { name: string; title: string; lines: string[] }[];
};

type TaskReport = {
  id: string;
  suite: EvalTask["suite"];
  category: EvalTask["category"];
  model: string;
  runs: RunResult[];
  passes: number;
  passAll: boolean;
};

type ModelSummary = {
  model: string;
  tasks: number;
  passAll: number;
  runs: number;
  runPasses: number;
  usage: Usage;
  otherUsage: Usage;
  estimatedCostUsd: number | null;
};

export type Report = {
  startedAt: string;
  finishedAt: string;
  reasoning: string;
  repeat: number;
  judge: string | null;
  tasks: TaskReport[];
  models: ModelSummary[];
};

type Price = { input: number; output: number; cached: number; cacheWrite: number };

const PRICES_PER_MILLION: Record<string, { upTo?: number; price: Price; above?: Price }> = {
  "claude-sonnet-5-5": { price: { input: 2, output: 10, cached: 0.1, cacheWrite: 2.5 } },
  "claude-opus-5-5": { price: { input: 4, output: 20, cached: 0.2, cacheWrite: 5 } },
  "claude-haiku-5-5": { upTo: 100_000, price: { input: 0.1, output: 0.5, cached: 0.01, cacheWrite: 0.125 }, above: { input: 0.5, output: 2.5, cached: 0.05, cacheWrite: 0.625 } },
};

export const realGateway: GatewayHandler = ({ url, init }) => realFetch(url, init);

export function usableModel(id: string) {
  const model = assistantModel(id);
  if (!model) throw new Error(`${id} isn't one of the assistant's models. Pick one from lib/assistant/models.ts.`);
  if (model.source === "claude") {
    throw new Error(`${id} runs through Orbit Agent on a paired Mac, which the evaluation harness can't drive. Evaluate the API model of the same name (for example ${model.apiModel}) instead.`);
  }
  if (model.source === "chatgpt") throw new Error(`${id} needs a connected ChatGPT account, which the evaluation harness can't use. Evaluate one of Orbit's own models instead.`);
  return model;
}

const EMPTY: Usage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };

function addUsage(total: Usage, more: Usage): Usage {
  return { input: total.input + more.input, output: total.output + more.output, cached: total.cached + more.cached, cacheWrite: total.cacheWrite + more.cacheWrite };
}

export function costOf(requests: PricedUsage[]) {
  let total = 0;
  for (const request of requests) {
    const entry = PRICES_PER_MILLION[request.model];
    if (!entry) return null;
    const price = entry.upTo !== undefined && entry.above && request.input > entry.upTo ? entry.above : entry.price;
    const cached = Math.min(request.cached, request.input);
    const written = Math.min(request.cacheWrite, request.input - cached);
    total += (request.input - cached - written) * price.input + cached * price.cached + written * price.cacheWrite + request.output * price.output;
  }
  return total / 1_000_000;
}

function parseArgs(raw: string) {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Row = {
  role: string;
  content: string;
  tool_calls: { id: string; function: { name: string; arguments: string } }[] | null;
  tool_call_id: string | null;
  actions: { id: string; name: string; title: string; lines: string[]; status: string }[] | null;
  sources: { url: string }[] | null;
};

async function readTranscript(conversationId: string, context: RunContext, error: string | null): Promise<Transcript> {
  const rows = (
    await getAdminPool().query<Row>(
      `select role, content, tool_calls, tool_call_id, actions, sources from crm.assistant_messages
       where conversation_id = $1 and seq > (select max(seq) from crm.assistant_messages where conversation_id = $1 and role = 'user')
       order by seq`,
      [conversationId],
    )
  ).rows;
  const results = new Map(rows.filter((row) => row.role === "tool" && row.tool_call_id).map((row) => [row.tool_call_id!, row.content]));
  const calls: ToolCallRecord[] = [];
  const cards: CardRecord[] = [];
  const answer: string[] = [];
  const sources: string[] = [];
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    if (row.content.trim()) answer.push(row.content.trim());
    for (const source of row.sources ?? []) if (typeof source?.url === "string") sources.push(source.url);
    for (const call of row.tool_calls ?? []) {
      const raw = results.get(call.id);
      let result: unknown = raw ?? null;
      try {
        result = raw ? JSON.parse(raw) : null;
      } catch {
        result = raw;
      }
      const refused = Boolean(result && typeof result === "object" && (result as { field?: unknown }).field === "workspace");
      calls.push({ id: call.id, name: call.function.name, args: parseArgs(call.function.arguments), write: Boolean(findTool(call.function.name)?.write), result, refused });
    }
    for (const action of row.actions ?? []) {
      const call = (row.tool_calls ?? []).find((entry) => entry.id === action.id);
      cards.push({ id: action.id, name: action.name, title: action.title, lines: action.lines ?? [], args: parseArgs(call?.function.arguments ?? "{}"), status: action.status });
    }
  }
  return {
    calls,
    cards,
    answer: answer.join("\n\n"),
    outbound: context.outbound,
    eclipseCalls: context.eclipseCalls,
    offeredTools: [...context.offeredTools],
    sources,
    modelSaw: context.lastModelRequest,
    usage: context.usage,
    rounds: context.rounds,
    error: error ?? context.lastGatewayError,
  };
}

async function seedConversation(world: World, task: EvalTask, settings: RunSettings) {
  const admin = getAdminPool();
  const actor = world.actor;
  const conversation = await admin.query<{ id: string }>(
    `insert into crm.assistant_conversations (workspace_id, user_id, title, model, reasoning, web_search)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [actor.workspaceId, actor.userId, `Eval ${task.id}`, settings.model, settings.reasoning, task.webSearch === true],
  );
  for (const turn of task.earlier ?? []) {
    await admin.query("insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, $4, $5)", [
      conversation.rows[0].id,
      actor.workspaceId,
      actor.userId,
      turn.role,
      fill(turn.content, world),
    ]);
  }
  return conversation.rows[0].id;
}

function hardPass(checks: CheckResult[]) {
  return checks.every((item) => item.pass || item.pending);
}

async function grade(task: EvalTask, message: string, transcript: Transcript, world: World, settings: RunSettings, breached: string | null) {
  const checks: CheckResult[] = [];
  if (transcript.error) checks.push({ name: "the turn finished without an error", kind: "check", pass: false, detail: transcript.error });
  if (breached) checks.push({ name: "no request bypassed the fake outside world", kind: "check", pass: false, detail: breached });
  for (const item of task.checks) {
    if (item.kind !== "check") continue;
    const marker = item.pending ? { pending: item.pending } : {};
    try {
      const verdict = await item.test(transcript, world);
      checks.push({ name: item.name, kind: "check", pass: verdict === true, ...(verdict === true ? {} : { detail: typeof verdict === "string" ? verdict : "Failed." }), ...marker });
    } catch (error) {
      checks.push({ name: item.name, kind: "check", pass: false, detail: `The check broke: ${error instanceof Error ? error.message : String(error)}`, ...marker });
    }
  }
  const judges = task.checks.filter((item) => item.kind === "judge");
  if (judges.length === 0 || !settings.useJudge || !hardPass(checks)) return { checks, skipped: judges.length };
  for (const item of judges) checks.push(await runJudge(item, message, transcript, world, { model: settings.judgeModel, fetchImpl: outsideFetch }));
  return { checks, skipped: 0 };
}

function failedRun(error: unknown, started: number): RunResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    pass: false,
    checks: [{ name: "the run finished", kind: "check", pass: false, detail }],
    judgesSkipped: 0,
    error: detail,
    ms: Date.now() - started,
    usage: EMPTY,
    otherUsage: EMPTY,
    costUsd: 0,
    rounds: 0,
    answer: "",
    calls: [],
    cards: [],
  };
}

export async function runOnce(task: EvalTask, settings: RunSettings): Promise<RunResult> {
  const started = Date.now();
  const context = newContext({ model: settings.gateway, judge: settings.judge, passthrough: settings.passthrough ?? realFetch });
  const breachesBefore = breaches.length;
  return inContext(context, async () => {
    const world = await buildWorld(task.fixture, { workspace: task.workspace });
    context.world = world;
    const conversationId = task.earlier?.length ? await seedConversation(world, task, settings) : null;
    const message = fill(task.message, world);
    let opened = conversationId;
    let error: string | null = null;
    try {
      await sendMessage(
        world.actor,
        { conversationId, message, model: settings.model, reasoning: settings.reasoning, webSearch: task.webSearch === true },
        (event) => {
          if (event.type === "conversation") opened = event.conversation.id;
          if (event.type === "error") error = event.message;
        },
        { deadline: Date.now() + settings.timeoutMs, fetchImpl: outsideFetch },
      );
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const transcript: Transcript = opened
      ? await readTranscript(opened, context, error)
      : { calls: [], cards: [], answer: "", outbound: context.outbound, eclipseCalls: context.eclipseCalls, offeredTools: [], sources: [], modelSaw: "", usage: [], rounds: 0, error: error ?? "No conversation was opened." };
    const breached = breaches.slice(breachesBefore).map((breach) => `${breach.how} ${breach.host}${breach.port ? `:${breach.port}` : ""}`);
    const { checks, skipped } = await grade(task, message, transcript, world, settings, breached.length ? `Blocked: ${[...new Set(breached)].join(", ")}.` : null);
    await Promise.allSettled(context.reading);
    const assistant = context.usage.filter((entry) => entry.kind === "assistant").reduce(addUsage, EMPTY);
    const other = context.usage.filter((entry) => entry.kind === "other").reduce(addUsage, EMPTY);
    return {
      pass: checks.every((item) => item.pass),
      checks,
      judgesSkipped: skipped,
      error: transcript.error,
      ms: Date.now() - started,
      usage: assistant,
      otherUsage: other,
      costUsd: costOf(context.usage),
      rounds: transcript.rounds,
      answer: transcript.answer.slice(0, 4_000),
      calls: transcript.calls.map((call) => ({ name: call.name, args: call.args })),
      cards: transcript.cards.map((item) => ({ name: item.name, title: item.title, lines: item.lines })),
    };
  }).catch((error: unknown) => failedRun(error, started));
}

export type SuiteOptions = Omit<RunSettings, "model"> & {
  models: string[];
  repeat: number;
  concurrency?: number;
  onRun?: (task: EvalTask, model: string, attempt: number, result: RunResult) => void;
};

export async function runSuite(tasks: EvalTask[], options: SuiteOptions): Promise<Report> {
  const startedAt = new Date().toISOString();
  const jobs = tasks.flatMap((task) => options.models.flatMap((model) => Array.from({ length: options.repeat }, (_, attempt) => ({ task, model, attempt }))));
  const results = new Map<string, RunResult[]>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      const started = Date.now();
      const result = await runOnce(job.task, { ...options, model: job.model }).catch((error: unknown) => failedRun(error, started));
      const key = `${job.task.id}|${job.model}`;
      results.set(key, [...(results.get(key) ?? []), result]);
      try {
        options.onRun?.(job.task, job.model, job.attempt, result);
      } catch {
        continue;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, jobs.length)) }, worker));
  const reports: TaskReport[] = tasks.flatMap((task) =>
    options.models.map((model) => {
      const runs = results.get(`${task.id}|${model}`) ?? [];
      const passes = runs.filter((run) => run.pass).length;
      return { id: task.id, suite: task.suite, category: task.category, model, runs, passes, passAll: runs.length > 0 && passes === runs.length };
    }),
  );
  const models = options.models.map((model): ModelSummary => {
    const runs = reports.filter((report) => report.model === model).flatMap((report) => report.runs);
    const costs = runs.map((run) => run.costUsd);
    return {
      model,
      tasks: reports.filter((report) => report.model === model).length,
      passAll: reports.filter((report) => report.model === model && report.passAll).length,
      runs: runs.length,
      runPasses: runs.filter((run) => run.pass).length,
      usage: runs.map((run) => run.usage).reduce(addUsage, EMPTY),
      otherUsage: runs.map((run) => run.otherUsage).reduce(addUsage, EMPTY),
      estimatedCostUsd: costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    };
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    reasoning: options.reasoning,
    repeat: options.repeat,
    judge: options.useJudge ? (options.judgeModel ?? null) : null,
    tasks: reports,
    models,
  };
}

export function failures(report: Report, options: { waive?: Defence[] } = {}) {
  const waived = new Set(options.waive ?? []);
  return report.tasks.filter((task) => task.runs.length === 0 || task.runs.some((run) => run.checks.some((item) => !item.pass && !(item.pending && waived.has(item.pending)))));
}

export function stalePending(report: Report) {
  const stale: { task: string; model: string; check: string; defence: Defence }[] = [];
  for (const task of report.tasks) {
    const pendingNames = new Map<string, Defence>();
    for (const run of task.runs) for (const item of run.checks) if (item.pending) pendingNames.set(item.name, item.pending);
    for (const [name, defence] of pendingNames) {
      const everyRun = task.runs.length > 0 && task.runs.every((run) => run.checks.some((item) => item.name === name && item.pass));
      if (everyRun) stale.push({ task: task.id, model: task.model, check: name, defence });
    }
  }
  return stale;
}

function cell(text: string, width: number) {
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width);
}

function onlyPending(task: TaskReport) {
  return task.runs.every((run) => run.checks.every((item) => item.pass || item.pending));
}

export function summaryTable(report: Report) {
  const models = report.models.map((summary) => summary.model);
  const ids = [...new Set(report.tasks.map((task) => task.id))];
  const width = Math.max(28, ...ids.map((id) => id.length + 2));
  const column = Math.max(24, ...models.map((model) => model.length + 2));
  const lines = [`${cell("Task", width)}${cell("Category", 22)}${models.map((model) => cell(model, column)).join("")}`];
  for (const id of ids) {
    const rows = report.tasks.filter((task) => task.id === id);
    const marks = models.map((model) => {
      const row = rows.find((item) => item.model === model);
      if (!row) return cell("", column);
      return cell(`${row.passes}/${row.runs.length} ${row.passAll ? "pass" : "FAIL"}${!row.passAll && onlyPending(row) ? " (pending)" : ""}`, column);
    });
    lines.push(`${cell(id, width)}${cell(rows[0].category, 22)}${marks.join("")}`);
  }
  lines.push("");
  for (const summary of report.models) {
    const cost = summary.estimatedCostUsd === null ? "price unknown for a model used" : `about $${summary.estimatedCostUsd.toFixed(2)}`;
    const other = summary.otherUsage.input + summary.otherUsage.output;
    lines.push(
      `${summary.model}: pass@all ${summary.passAll}/${summary.tasks} tasks, ${summary.runPasses}/${summary.runs} runs, ${summary.usage.input.toLocaleString("en-GB")} input and ${summary.usage.output.toLocaleString("en-GB")} output tokens (${summary.usage.cached.toLocaleString("en-GB")} cached) in turns, ${other.toLocaleString("en-GB")} more in the judge and tools, ${cost}.`,
    );
  }
  return lines.join("\n");
}

export function failureDetails(report: Report) {
  const lines: string[] = [];
  for (const task of report.tasks.filter((item) => !item.passAll)) {
    lines.push(`${task.id} on ${task.model}`);
    task.runs.forEach((run, index) => {
      const failed = run.checks.filter((item) => !item.pass);
      if (failed.length === 0) return;
      lines.push(`  run ${index + 1}: ${failed.map((item) => `${item.name}${item.pending ? ` [waits on ${item.pending}]` : ""}${item.detail ? ` (${item.detail.slice(0, 240)})` : ""}`).join("; ")}`);
    });
  }
  return lines.join("\n");
}
