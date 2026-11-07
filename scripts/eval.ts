import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { DEFAULT_REASONING } from "@/lib/assistant/models";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { embedTexts } from "@/lib/llm";
import { DEFAULT_JUDGE_MODEL } from "@/evals/judge";
import { installOutside } from "@/evals/outside";
import { failureDetails, failures, realGateway, runSuite, summaryTable, usableModel } from "@/evals/run";
import { selectTasks } from "@/evals/tasks";
import type { Suite } from "@/evals/types";
import { resetDatabase } from "@/tests/helpers";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
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
    out: { type: "string" },
    ci: { type: "boolean", default: false },
    "allow-pending": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

const split = (items: string[] | undefined) => (items ?? []).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);

function checkedDatabase(raw: string, label: string) {
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, "");
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`${label} points at ${url.hostname}. Evaluations wipe their database, so they only run against a local one.`);
  if (!/eval|test/i.test(name)) throw new Error(`${label} uses the database ${name}. Evaluations wipe their database, so its name must contain "eval" or "test".`);
  return { url, name };
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
  if (values.list) {
    for (const item of tasks) console.log(`${item.id.padEnd(40)}${item.suite.padEnd(10)}${item.category.padEnd(22)}${item.pendingDefence ? `waits on: ${item.pendingDefence}` : ""}`);
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
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat is a whole number from 1 to 20.");
  const database = checkedDatabase(process.env.EVAL_DATABASE_URL?.trim() || DEFAULT_DATABASE, "EVAL_DATABASE_URL");
  const admin = checkedDatabase(process.env.EVAL_DATABASE_ADMIN_URL?.trim() || DEFAULT_ADMIN, "EVAL_DATABASE_ADMIN_URL");
  if (database.name !== admin.name) throw new Error("EVAL_DATABASE_URL and EVAL_DATABASE_ADMIN_URL must name the same database.");
  process.env.DATABASE_URL = database.url.href;
  process.env.DATABASE_ADMIN_URL = admin.url.href;
  process.env.APP_SECRET ||= "orbit-evaluation-secret";
  await ensureDatabase(admin.url, admin.name);
  await resetDatabase();
  const restore = installOutside();
  const useJudge = !values["no-judge"];
  console.log(`Running ${tasks.length} tasks x ${repeat} on ${models.join(", ")} (reasoning ${values.reasoning}${useJudge ? `, judge ${values["judge-model"]}` : ", no judge"}).`);
  let report;
  try {
    report = await runSuite(tasks, {
      models,
      repeat,
      reasoning: values.reasoning,
      gateway: realGateway,
      judge: realGateway,
      embed: (texts) => embedTexts(texts),
      judgeModel: values["judge-model"],
      useJudge,
      timeoutMs: Number(values.timeout) * 1000,
      concurrency: Number(values.concurrency) || 1,
      onRun: (item, model, attempt, result) => {
        const failed = result.checks.filter((check) => !check.pass).map((check) => check.name);
        console.log(`${result.pass ? "pass" : "FAIL"}  ${item.id} on ${model}, run ${attempt + 1} (${Math.round(result.ms / 1000)}s)${failed.length ? `: ${failed.join("; ")}` : ""}`);
      },
    });
  } finally {
    restore();
  }
  const out = values.out ?? `evals/results/${report.startedAt.replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${summaryTable(report)}`);
  const details = failureDetails(report);
  if (details) console.log(`\nFailures\n${details}`);
  console.log(`\nResults are in ${out}.`);
  if (!values.ci) return 0;
  const failing = failures(report, { allowPending: values["allow-pending"] });
  if (failing.length > 0) console.log(`\n${failing.length} task and model pairs failed at least one run.`);
  return failing.length > 0 ? 1 : 0;
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
