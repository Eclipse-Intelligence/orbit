import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { AccountInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { ApiError, createApi, type Api } from "./api";
import { clearConfig, loadConfig, prepareWorkspace, saveConfig } from "./config";
import { installLaunchAgent, LOG_FILE, uninstallLaunchAgent } from "./launch";
import type { CompanionJob } from "./protocol";
import { cleanEnv, runTurn, type Sdk } from "./turn";

const VERSION = "1.1.0";
const DEFAULT_URL = "https://orbit.geteclipse.co";
const ACCOUNT_TIMEOUT_MS = 45_000;
const sdk: Sdk = { query, createSdkMcpServer, tool };

type Args = { pair?: string; url?: string; name?: string; logout: boolean; help: boolean; version: boolean; install: boolean; uninstall: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { logout: false, help: false, version: false, install: false, uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index];
    if (value === "--pair") args.pair = next();
    else if (value.startsWith("--pair=")) args.pair = value.slice(7);
    else if (value === "--url") args.url = next();
    else if (value.startsWith("--url=")) args.url = value.slice(6);
    else if (value === "--name") args.name = next();
    else if (value === "--logout") args.logout = true;
    else if (value === "--install") args.install = true;
    else if (value === "--uninstall") args.uninstall = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--version" || value === "-v") args.version = true;
  }
  return args;
}

function log(message: string) {
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  process.stdout.write(`${time}  ${message}\n`);
}

function stop(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function ask(question: string) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

async function claudeAccount(cwd: string): Promise<AccountInfo> {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await hold;
  }
  const session = query({
    prompt: idle(),
    options: { cwd, settingSources: [], tools: [], env: cleanEnv(process.env), persistSession: false },
  });
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code didn't respond.")), ACCOUNT_TIMEOUT_MS));
  try {
    return await Promise.race([session.accountInfo(), timer]);
  } finally {
    release();
    session.close();
  }
}

async function pair(url: string, code: string, name: string) {
  const result = await createApi(url, null).pair(code, name);
  await saveConfig({ url, token: result.token, email: result.email });
  log(`Paired with Orbit${result.email ? ` as ${result.email}` : ""}.`);
  return result.token;
}

async function handle(api: Api, job: CompanionJob, cwd: string) {
  const started = Date.now();
  log(`Answering on ${job.request.model}…`);
  try {
    const result = await runTurn(job.request, {
      sdk,
      cwd,
      env: process.env,
      callTool: (call) => api.tool(job.id, call),
      onTool: (name) => log(`  ${name}`),
    });
    await api.complete(job.id, result);
    log(`Done in ${Math.round((Date.now() - started) / 1000)}s.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      log("That question was cancelled in Orbit.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`Couldn't answer: ${message}`);
    await api.fail(job.id, message).catch(() => undefined);
  }
}

async function serve(api: Api, cwd: string) {
  let backoff = 1_000;
  for (;;) {
    try {
      const { job } = await api.next();
      backoff = 1_000;
      if (job) await handle(api, job, cwd);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await clearConfig();
        stop(`${error.message}\nRun orbit-agent again with --pair and a new code from Orbit › Settings › Integrations.`);
      }
      log(`${error instanceof Error ? error.message : String(error)} Retrying in ${Math.round(backoff / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(
      [
        "orbit-agent: answers Orbit assistant questions with your own Claude Code login.",
        "",
        "  orbit-agent --pair CODE   pair this Mac using the code from Orbit › Settings › Integrations",
        "  orbit-agent               start answering (after pairing)",
        "  orbit-agent --install     keep it running: start at login and restart if it stops (Mac)",
        "  orbit-agent --uninstall   stop starting at login",
        "  orbit-agent --logout      forget this Mac's pairing (and stop starting at login)",
        "",
        "  --url URL    Orbit address (default https://orbit.geteclipse.co)",
        "  --name NAME  how this Mac appears in Orbit",
        "",
      ].join("\n"),
    );
    return;
  }
  if (args.logout) {
    await uninstallLaunchAgent();
    await clearConfig();
    log("Forgot this Mac's pairing.");
    return;
  }
  if (args.uninstall) {
    const removed = await uninstallLaunchAgent();
    log(removed ? "Orbit Agent won't start at login any more." : "Orbit Agent wasn't set to start at login.");
    return;
  }

  const saved = await loadConfig();
  const url = (args.url ?? saved.url ?? DEFAULT_URL).replace(/\/+$/, "");
  let token = args.pair ? null : (saved.token ?? null);
  if (!token) {
    if (!args.pair && !process.stdin.isTTY) stop("This Mac isn't paired. Run orbit-agent --pair CODE in Terminal with a code from Orbit › Settings › Integrations.");
    const code = args.pair ?? (await ask("Pairing code from Orbit › Settings › Integrations: "));
    if (!code) stop("A pairing code is needed.");
    try {
      token = await pair(url, code, args.name ?? hostname().replace(/\.local$/, ""));
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error));
    }
  }

  if (args.install) {
    try {
      await installLaunchAgent(url);
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error));
    }
    log(`Orbit Agent now runs in the background, starts when you log in, and restarts if it stops. You can close this window. Its log is ${LOG_FILE}.`);
    return;
  }

  const cwd = await prepareWorkspace();
  log("Checking Claude Code…");
  let account: AccountInfo;
  try {
    account = await claudeAccount(cwd);
  } catch (error) {
    stop(`Couldn't start Claude Code: ${error instanceof Error ? error.message : String(error)}\nInstall Claude Code and sign in by running \`claude\` then \`/login\`.`);
  }
  if (!account.email && !account.subscriptionType) {
    stop("Claude Code isn't signed in. Run `claude`, then `/login`, then start orbit-agent again.");
  }
  if (account.apiKeySource && account.apiKeySource !== "none") {
    log(`Note: Claude Code is using an API key (${account.apiKeySource}), not your Claude plan.`);
  }

  const api = createApi(url, token);
  let me;
  try {
    me = await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await clearConfig();
      stop(`${error.message}\nRun orbit-agent again with --pair and a new code from Orbit.`);
    }
    stop(error instanceof Error ? error.message : String(error));
  }
  log(
    `Connected to Orbit as ${me.email} on "${me.name}". Claude: ${account.email ?? "signed in"}${account.subscriptionType ? ` (${account.subscriptionType})` : ""}.`,
  );
  log(
    process.stdin.isTTY
      ? "Waiting for questions. Leave this running; press Ctrl+C to stop. To keep it running without this window, run it again with --install."
      : "Waiting for questions.",
  );
  process.on("SIGINT", () => {
    log("Stopped.");
    process.exit(0);
  });
  await serve(api, cwd);
}

main().catch((error) => stop(error instanceof Error ? error.message : String(error)));
