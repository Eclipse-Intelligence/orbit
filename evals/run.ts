import { sendMessage } from "@/lib/assistant/chat";
import { assistantModel } from "@/lib/assistant/models";
import { findTool } from "@/lib/assistant/tools";
import { getAdminPool } from "@/lib/db/pool";
import { runJudge } from "./judge";
import { outsideFetch, outsideLookup, realFetch, withOutside, type GatewayHandler, type RunContext } from "./outside";
import { buildWorld, fill, type Embed } from "./world";
import type { CardRecord, CheckResult, EvalTask, ToolCallRecord, Transcript, Usage, World } from "./types";

export type RunSettings = {
  model: string;
  reasoning: string;
  gateway: GatewayHandler;
  judge: GatewayHandler;
  judgeModel?: string;
  useJudge: boolean;
  timeoutMs: number;
  passthrough?: typeof fetch;
  embed?: Embed;
};

export type RunResult = {
  pass: boolean;
  checks: CheckResult[];
  judgesSkipped: number;
  error: string | null;
  ms: number;
  usage: Usage;
  rounds: number;
  answer: string;
  calls: { name: string; args: Record<string, unknown> }[];
  cards: { name: string; title: string; lines: string[] }[];
};

type TaskReport = {
  id: string;
  suite: EvalTask["suite"];
  category: EvalTask["category"];
  pendingDefence: string | null;
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

const PRICES_PER_MILLION: Record<string, { input: number; output: number; cached: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cached: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cached: 0.01 },
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

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(raw: Record<string, unknown> | null): Usage {
  if (!raw) return { input: 0, output: 0, cached: 0 };
  const details = (raw.prompt_tokens_details ?? raw.input_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input: number(raw.prompt_tokens) || number(raw.input_tokens),
    output: number(raw.completion_tokens) || number(raw.output_tokens),
    cached: number(details.cached_tokens) || number(raw.cache_read_input_tokens),
  };
}

function addUsage(total: Usage, more: Usage): Usage {
  return { input: total.input + more.input, output: total.output + more.output, cached: total.cached + more.cached };
}

export function costOf(model: string, usage: Usage, prices = PRICES_PER_MILLION) {
  const price = prices[model];
  if (!price) return null;
  const cached = Math.min(usage.cached, usage.input);
  return ((usage.input - cached) * price.input + cached * price.cached + usage.output * price.output) / 1_000_000;
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
  usage: Record<string, unknown> | null;
};

async function readTranscript(conversationId: string, context: RunContext, error: string | null): Promise<Transcript> {
  const rows = (
    await getAdminPool().query<Row>(
      `select role, content, tool_calls, tool_call_id, actions, usage from crm.assistant_messages
       where conversation_id = $1 and seq > (select max(seq) from crm.assistant_messages where conversation_id = $1 and role = 'user')
       order by seq`,
      [conversationId],
    )
  ).rows;
  const results = new Map(rows.filter((row) => row.role === "tool" && row.tool_call_id).map((row) => [row.tool_call_id!, row.content]));
  const calls: ToolCallRecord[] = [];
  const cards: CardRecord[] = [];
  const answer: string[] = [];
  let usage: Usage = { input: 0, output: 0, cached: 0 };
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    usage = addUsage(usage, usageOf(row.usage));
    if (row.content.trim()) answer.push(row.content.trim());
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
    usage,
    rounds: context.rounds,
    error: error ?? context.gatewayErrors[0] ?? null,
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

async function grade(task: EvalTask, message: string, transcript: Transcript, world: World, settings: RunSettings) {
  const checks: CheckResult[] = [];
  if (transcript.error) checks.push({ name: "the turn finished without an error", kind: "check", pass: false, detail: transcript.error });
  for (const item of task.checks) {
    if (item.kind !== "check") continue;
    try {
      const verdict = await item.test(transcript, world);
      checks.push({ name: item.name, kind: "check", pass: verdict === true, ...(verdict === true ? {} : { detail: typeof verdict === "string" ? verdict : "Failed." }) });
    } catch (error) {
      checks.push({ name: item.name, kind: "check", pass: false, detail: `The check broke: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const judges = task.checks.filter((item) => item.kind === "judge");
  if (judges.length === 0 || !settings.useJudge || !checks.every((item) => item.pass)) return { checks, skipped: judges.length };
  for (const item of judges) checks.push(await runJudge(item, message, transcript, world, { model: settings.judgeModel, fetchImpl: outsideFetch }));
  return { checks, skipped: 0 };
}

export async function runOnce(task: EvalTask, settings: RunSettings): Promise<RunResult> {
  const started = Date.now();
  const world = await buildWorld(task.fixture, { workspace: task.workspace, embed: settings.embed });
  return withOutside({ world, model: settings.gateway, judge: settings.judge, passthrough: settings.passthrough ?? realFetch }, async (context) => {
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
        { deadline: Date.now() + settings.timeoutMs, fetchImpl: outsideFetch, web: { fetchImpl: outsideFetch, lookup: outsideLookup } },
      );
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const transcript: Transcript = opened
      ? await readTranscript(opened, context, error)
      : { calls: [], cards: [], answer: "", outbound: context.outbound, eclipseCalls: context.eclipseCalls, offeredTools: [], usage: { input: 0, output: 0, cached: 0 }, rounds: 0, error: error ?? "No conversation was opened." };
    const { checks, skipped } = await grade(task, message, transcript, world, settings);
    return {
      pass: checks.every((item) => item.pass),
      checks,
      judgesSkipped: skipped,
      error: transcript.error,
      ms: Date.now() - started,
      usage: transcript.usage,
      rounds: transcript.rounds,
      answer: transcript.answer.slice(0, 4_000),
      calls: transcript.calls.map((call) => ({ name: call.name, args: call.args })),
      cards: transcript.cards.map((item) => ({ name: item.name, title: item.title, lines: item.lines })),
    };
  });
}

type SuiteOptions = Omit<RunSettings, "model"> & {
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
      const result = await runOnce(job.task, { ...options, model: job.model });
      const key = `${job.task.id}|${job.model}`;
      results.set(key, [...(results.get(key) ?? []), result]);
      options.onRun?.(job.task, job.model, job.attempt, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, jobs.length)) }, worker));
  const reports: TaskReport[] = tasks.flatMap((task) =>
    options.models.map((model) => {
      const runs = results.get(`${task.id}|${model}`) ?? [];
      const passes = runs.filter((run) => run.pass).length;
      return { id: task.id, suite: task.suite, category: task.category, pendingDefence: task.pendingDefence ?? null, model, runs, passes, passAll: runs.length > 0 && passes === runs.length };
    }),
  );
  const models = options.models.map((model): ModelSummary => {
    const mine = reports.filter((report) => report.model === model);
    const usage = mine.flatMap((report) => report.runs).reduce((total, run) => addUsage(total, run.usage), { input: 0, output: 0, cached: 0 });
    return {
      model,
      tasks: mine.length,
      passAll: mine.filter((report) => report.passAll).length,
      runs: mine.reduce((sum, report) => sum + report.runs.length, 0),
      runPasses: mine.reduce((sum, report) => sum + report.passes, 0),
      usage,
      estimatedCostUsd: costOf(model, usage),
    };
  });
  return { startedAt, finishedAt: new Date().toISOString(), reasoning: options.reasoning, repeat: options.repeat, judge: options.useJudge ? (options.judgeModel ?? null) : null, tasks: reports, models };
}

export function failures(report: Report, options: { allowPending?: boolean } = {}) {
  return report.tasks.filter((task) => !task.passAll && !(options.allowPending && task.pendingDefence));
}

function cell(text: string, width: number) {
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width);
}

export function summaryTable(report: Report) {
  const models = report.models.map((summary) => summary.model);
  const ids = [...new Set(report.tasks.map((task) => task.id))];
  const width = Math.max(28, ...ids.map((id) => id.length + 2));
  const column = Math.max(20, ...models.map((model) => model.length + 2));
  const lines = [`${cell("Task", width)}${cell("Category", 22)}${models.map((model) => cell(model, column)).join("")}`];
  for (const id of ids) {
    const rows = report.tasks.filter((task) => task.id === id);
    const first = rows[0];
    const marks = models.map((model) => {
      const row = rows.find((item) => item.model === model);
      if (!row) return cell("", column);
      const label = `${row.passes}/${row.runs.length} ${row.passAll ? "pass" : "FAIL"}${row.pendingDefence ? " (pending)" : ""}`;
      return cell(label, column);
    });
    lines.push(`${cell(id, width)}${cell(first.category, 22)}${marks.join("")}`);
  }
  lines.push("");
  for (const summary of report.models) {
    const cost = summary.estimatedCostUsd === null ? "price unknown" : `about $${summary.estimatedCostUsd.toFixed(2)}`;
    lines.push(
      `${summary.model}: pass@all ${summary.passAll}/${summary.tasks} tasks, ${summary.runPasses}/${summary.runs} runs, ${summary.usage.input.toLocaleString("en-GB")} input and ${summary.usage.output.toLocaleString("en-GB")} output tokens (${summary.usage.cached.toLocaleString("en-GB")} cached), ${cost}.`,
    );
  }
  return lines.join("\n");
}

export function failureDetails(report: Report) {
  const lines: string[] = [];
  for (const task of report.tasks.filter((item) => !item.passAll)) {
    lines.push(`${task.id} on ${task.model}${task.pendingDefence ? ` (waits on: ${task.pendingDefence})` : ""}`);
    task.runs.forEach((run, index) => {
      const failed = run.checks.filter((item) => !item.pass);
      if (failed.length === 0) return;
      lines.push(`  run ${index + 1}: ${failed.map((item) => `${item.name}${item.detail ? ` (${item.detail.slice(0, 240)})` : ""}`).join("; ")}`);
    });
  }
  return lines.join("\n");
}
