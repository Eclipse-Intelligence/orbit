import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { DEFAULT_REASONING } from "@/lib/assistant/models";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { installClock, pinnedWednesday } from "@/evals/clock";
import { evalDatabase } from "@/evals/guard";
import { DEFAULT_JUDGE_MODEL } from "@/evals/judge";
import { installOutside } from "@/evals/outside";
import { failureDetails, failures, realGateway, runSuite, stalePending, summaryTable, usableModel } from "@/evals/run";
import { selectTasks } from "@/evals/tasks";
import { DEFENCES, type Defence, type Suite } from "@/evals/types";
import { resetDatabase } from "@/tests/helpers";

const DEFAULT_DATABASE = "postgres://crm_app:crm_app_dev@127.0.0.1:5432/crm_eval";
const DEFAULT_ADMIN = "postgres://postgres:postgres@127.0.0.1:5432/crm_eval";

const { values } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    repeat: { type: "string", default: "3" },
    suite: { type: "string", default: "all" },
    task: { type: "string", multiple: true },
    category: { type: "string", multiple: true },
    reasoning: { type: "string", default: DEFAULT_REASONING },
    "judge-model": { type: "string", default: DEFAULT_JUDGE_MODEL },
    "no-judge": { type: "boolean", default: false },
    concurrency: { type: "string", default: "1" },
    timeout: { type: "string", default: "300" },
    now: { type: "string" },
    out: { type: "string" },
    ci: { type: "boolean", default: false },
    "allow-pending": { type: "string", multiple: true },
    list: { type: "boolean", default: false },
  },
});

const split = (items: string[] | undefined) => (items ?? []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);

function whole(raw: string, label: string, min: number, max: number) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is a whole number from ${min} to ${max}.`);
  return value;
}

function waived(): Defence[] {
  const named = split(values["allow-pending"]);
  if (named.includes("all")) return Object.keys(DEFENCES) as Defence[];
  const unknown = named.filter((name) => !(name in DEFENCES));
  if (unknown.length > 0) throw new Error(`--allow-pending takes ${Object.keys(DEFENCES).join(", ")} or all, not ${unknown.join(", ")}.`);
  return named as Defence[];
}

async function ensureDatabase(adminUrl: URL, name: string) {
  const server = new URL(adminUrl.href);
  server.pathname = "/postgres";
  const client = new Client({ connectionString: server.href });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

async function main() {
  const suite = values.suite as Suite | "all";
  if (!["core", "security", "all"].includes(suite)) throw new Error("--suite is core, security or all.");
  const tasks = selectTasks({ suite, ids: split(values.task), categories: split(values.category) });
  const waive = waived();
  if (values.list) {
    for (const item of tasks) {
      const marks = [...new Set(item.checks.flatMap((check) => (check.pending ? [check.pending] : [])))];
      console.log(`${item.id.padEnd(40)}${item.suite.padEnd(10)}${item.category.padEnd(22)}${marks.length ? `pending: ${marks.join(", ")}` : ""}`);
    }
    console.log(`\n${tasks.length} tasks.`);
    return 0;
  }
  if (!process.env.LLM_API_KEY?.trim()) {
    console.log("Skipped: set LLM_API_KEY to run the evaluations against real models.");
    return values.ci ? 1 : 0;
  }
  const models = split(values.model);
  if (models.length === 0) throw new Error("Pick at least one model with --model, for example --model claude-sonnet-5-5.");
  for (const model of models) usableModel(model);
  const repeat = whole(values.repeat, "--repeat", 1, 20);
  const concurrency = whole(values.concurrency, "--concurrency", 1, 16);
  const timeoutMs = whole(values.timeout, "--timeout", 30, 1_800) * 1000;
  const clock = values.now ? new Date(values.now) : pinnedWednesday();
  if (Number.isNaN(clock.getTime())) throw new Error("--now is a date and time, for example 2026-11-11T15:00:00Z.");
  const database = evalDatabase(process.env.EVAL_DATABASE_URL?.trim() || DEFAULT_DATABASE, "EVAL_DATABASE_URL");
  const admin = evalDatabase(process.env.EVAL_DATABASE_ADMIN_URL?.trim() || DEFAULT_ADMIN, "EVAL_DATABASE_ADMIN_URL");
  if (database.name !== admin.name) throw new Error("EVAL_DATABASE_URL and EVAL_DATABASE_ADMIN_URL must name the same database.");
  process.env.DATABASE_URL = database.url.href;
  process.env.DATABASE_ADMIN_URL = admin.url.href;
  process.env.APP_SECRET ||= "orbit-evaluation-secret";
  await ensureDatabase(admin.url, admin.name);
  await resetDatabase();
  const restoreOutside = installOutside({ realGateway: true });
  const restoreClock = installClock(clock);
  const useJudge = !values["no-judge"];
  console.log(`Running ${tasks.length} tasks x ${repeat} on ${models.join(", ")} (reasoning ${values.reasoning}${useJudge ? `, judge ${values["judge-model"]}` : ", no judge"}), with the clock at ${clock.toISOString()}.`);
  if (waive.length > 0) console.log(`Waiving pending checks for: ${waive.map((name) => `${name} (${DEFENCES[name]})`).join("; ")}.`);
  let report;
  try {
    report = await runSuite(tasks, {
      models,
      repeat,
      reasoning: values.reasoning,
      gateway: realGateway,
      judge: realGateway,
      judgeModel: values["judge-model"],
      useJudge,
      timeoutMs,
      concurrency,
      onRun: (item, model, attempt, result) => {
        const failed = result.checks.filter((check) => !check.pass).map((check) => `${check.name}${check.pending ? ` [waits on ${check.pending}]` : ""}`);
        console.log(`${result.pass ? "pass" : "FAIL"}  ${item.id} on ${model}, run ${attempt + 1} (${Math.round(result.ms / 1000)}s)${failed.length ? `: ${failed.join("; ")}` : ""}`);
      },
    });
  } finally {
    restoreClock();
    restoreOutside();
  }
  const out = values.out ?? `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...report, clock: clock.toISOString(), waived: waive }, null, 2)}\n`);
  console.log(`\n${summaryTable(report)}`);
  const details = failureDetails(report);
  if (details) console.log(`\nFailures\n${details}`);
  const stale = stalePending(report);
  if (stale.length > 0) {
    console.log(`\nThese checks wait on a defence but passed on every run. Remove their pending marker in evals/tasks:`);
    for (const item of stale) console.log(`  ${item.task} on ${item.model}: ${item.check} (${item.defence})`);
  }
  console.log(`\nResults are in ${out}.`);
  if (!values.ci) return 0;
  const failing = failures(report, { waive });
  if (failing.length > 0) console.log(`\n${failing.length} task and model pairs failed at least one run.`);
  return failing.length > 0 || stale.length > 0 ? 1 : 0;
}

async function closePools() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_ADMIN_URL) return;
  await Promise.allSettled([getPool().end(), getAdminPool().end()]);
}

main()
  .then(async (code) => {
    await closePools();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closePools();
    process.exit(1);
  });
