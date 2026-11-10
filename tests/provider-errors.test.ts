import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderWithBrowserbase } from "@/lib/browserbase";
import { clickupClient } from "@/lib/clickup";
import { clearEclipseToolCache, eclipseGuide } from "@/lib/eclipse-mcp";
import { verifyWith } from "@/lib/enrichment/providers";
import { resetLinearCache, searchLinearIssues } from "@/lib/linear";
import { readWebPage } from "@/lib/web-page";
import { redactSecrets } from "@/lib/upstream";
import { granolaClient } from "@/lib/granola";
import { completeJson, embedTexts, transcribeAudio } from "@/lib/llm";
import { ensureInbox, sendNewMessage } from "@/lib/machinemail";
import { readerClient } from "@/lib/readwise";
import { putObject, readObject, resetStorageBucketCache } from "@/lib/storage";
import { z } from "zod";

const SECRET_BODY = "internal trace 7f3a: db shard eu-2 refused tenant 991";
const realConsoleError = console.error;
const saved = { ...process.env };
let logged: string[] = [];

function replying(status: number, body: unknown): typeof fetch {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function offline(): typeof fetch {
  return async () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND internal-host.local");
  };
}

async function messageOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected a failure");
}

function assertClean(message: string) {
  assert.doesNotMatch(message, /internal trace|shard|tenant 991|ENOTFOUND|internal-host|getaddrinfo/);
}

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  process.env.LLM_API_KEY = "llm-test-key";
  process.env.MACHINE_MAIL_API_KEY = "mm-test-key";
  process.env.BROWSERBASE_API_KEY = "bb-test-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  process.env.ECLIPSE_MCP_TOKEN = "ecl_pat_test_token_123";
  resetStorageBucketCache();
});

afterEach(() => {
  console.error = realConsoleError;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("provider failures never show the provider's own text", () => {
  it("keeps the AI gateway's body and status in the log", async () => {
    const request = { system: "s", user: "u", schema: z.object({ ok: z.boolean() }) };
    const denied = await messageOf(() => completeJson({ ...request, fetchImpl: replying(401, { error: { message: SECRET_BODY } }) }));
    assert.equal(denied, "The AI rejected the key.");
    assertClean(denied);
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
    const owner = { type: "user", role: "owner" };
    assert.equal(await messageOf(() => completeJson({ ...request, viewer: owner, fetchImpl: replying(403, {}) })), "The AI rejected the key. Check LLM_API_KEY.");
    assert.equal(await messageOf(() => completeJson({ ...request, viewer: { type: "user", role: "member" }, fetchImpl: replying(401, {}) })), "The AI rejected the key.");
    assert.equal(await messageOf(() => completeJson({ ...request, fetchImpl: replying(429, {}) })), "The AI is busy. Try again in a minute.");
    assert.equal(await messageOf(() => completeJson({ ...request, fetchImpl: replying(402, { error: SECRET_BODY }) })), "The AI returned an error. Try again.");

    const unreachable = await messageOf(() => completeJson({ ...request, fetchImpl: offline() }));
    assert.equal(unreachable, "Couldn't reach the AI. Try again.");

    const notJson = await messageOf(() => completeJson({ ...request, fetchImpl: replying(200, { choices: [{ message: { content: "no json here" } }] }) }));
    assert.equal(notJson, "The AI gave an unusable answer. Try again.");

    const embeddings = await messageOf(() => embedTexts(["a"], { fetchImpl: replying(500, { error: SECRET_BODY }) }));
    assert.equal(embeddings, "The AI returned an error. Try again.");

    const transcript = await messageOf(() => transcribeAudio(new Uint8Array([1, 2]), "a.mp3", "audio/mpeg", { fetchImpl: replying(400, { error: { message: SECRET_BODY } }) }));
    assert.equal(transcript, "Couldn't transcribe. Try again.");

    delete process.env.LLM_API_KEY;
    assert.equal(await messageOf(() => completeJson(request)), "AI isn't set up.");
  });

  it("maps ClickUp failures to fixed sentences", async () => {
    const run = (status: number) => messageOf(() => clickupClient({ token: "t", fetchImpl: replying(status, { err: SECRET_BODY, ECODE: "X_1" }) }).getUser());
    assert.equal(await run(401), "ClickUp rejected the token.");
    assert.equal(await run(403), "ClickUp rejected the token. Check its access.");
    assert.equal(await run(400), "ClickUp returned an error (400).");
    assert.equal(await run(500), "Couldn't reach ClickUp. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
  });

  it("maps Granola failures to fixed sentences", async () => {
    const run = (status: number) => messageOf(() => granolaClient({ apiKey: "k", fetchImpl: replying(status, { message: SECRET_BODY }) }).listNotes({}));
    assert.equal(await run(401), "Granola rejected the key.");
    assert.equal(await run(422), "Granola returned an error (422).");
    assert.equal(await run(503), "Couldn't reach Granola. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
  });

  it("maps Readwise failures to fixed sentences", async () => {
    const run = (status: number) => messageOf(() => readerClient({ token: "t", fetchImpl: replying(status, { detail: SECRET_BODY }) }).listPage({}));
    assert.equal(await run(401), "Readwise rejected the token. Reconnect it in Settings › Connections.");
    assert.equal(await run(400), "Readwise returned an error (400).");
    assert.equal(await messageOf(() => readerClient({ token: "t", fetchImpl: offline() }).listPage({})), "Couldn't reach Readwise. Try again.");
  });

  it("keeps MachineMail's server errors out of messages, and gives the assistant its reason for a bad request", async () => {
    const rejected = await messageOf(() => sendNewMessage("agent@x.test", { to: ["a@x.test"], subject: "s", text: "t" }, replying(422, { error: { message: "Recipient   address is invalid." } })));
    assert.equal(rejected, "MachineMail returned an error: Recipient address is invalid.");
    const failed = await messageOf(() => sendNewMessage("agent@x.test", { to: ["a@x.test"], subject: "s", text: "t" }, replying(500, { error: { message: SECRET_BODY } })));
    assert.equal(failed, "Couldn't reach MachineMail. Try again.");
    assertClean(failed);
    assert.equal(await messageOf(() => ensureInbox("agent@x.test", "Agent", offline())), "Couldn't reach MachineMail. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
    delete process.env.MACHINE_MAIL_API_KEY;
    assert.equal(await messageOf(() => ensureInbox("agent@x.test", "Agent", offline())), "MachineMail isn't set up.");
  });

  it("keeps Browserbase's response body out of messages", async () => {
    const failed = await messageOf(() => renderWithBrowserbase("https://shy.test/", { proxies: false, fetchImpl: replying(402, SECRET_BODY) }));
    assert.equal(failed, "Browserbase returned an error (402).");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
  });

  it("keeps Supabase Storage's message out of messages", async () => {
    const storage: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/bucket")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ message: SECRET_BODY, error: "Bad Request" }), { status: 400 });
    };
    const stored = await messageOf(() => putObject("a/b.txt", new Uint8Array([1]), "text/plain", storage));
    assert.equal(stored, "Couldn't store the file. Try again.");
    const read = await messageOf(() => readObject("a/b.txt", storage));
    assert.equal(read, "Couldn't read the attachment. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetStorageBucketCache();
    assert.equal(await messageOf(() => putObject("a/b.txt", new Uint8Array([1]), "text/plain", storage)), "File storage isn't set up.");
  });

  it("keeps Linear's server bodies out of messages and gives the assistant Linear's reason for a bad query", async () => {
    resetLinearCache();
    const server = await messageOf(() => searchLinearIssues({}, { apiKey: "lin_api_secret_key_1", fetchImpl: replying(500, { errors: [{ message: SECRET_BODY }] }) }));
    assert.equal(server, "Couldn't reach Linear. Try again.");
    assertClean(server);
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
    resetLinearCache();
    const unprocessable = await messageOf(() => searchLinearIssues({}, { apiKey: "k", fetchImpl: replying(422, { errors: [{ message: SECRET_BODY }] }) }));
    assert.equal(unprocessable, "Linear returned an error (422).");
    resetLinearCache();
    const bad = await messageOf(() => searchLinearIssues({}, { apiKey: "k", fetchImpl: replying(400, { errors: [{ message: "Argument   'first' must be at most 250." }] }) }));
    assert.equal(bad, "Linear returned an error: Argument 'first' must be at most 250.");
  });

  it("keeps Eclipse's server bodies out of messages", async () => {
    clearEclipseToolCache();
    const failed = await messageOf(() => eclipseGuide({ fetchImpl: replying(502, SECRET_BODY) }));
    assert.equal(failed, "Couldn't reach Eclipse. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
    clearEclipseToolCache();
    assert.equal(await messageOf(() => eclipseGuide({ fetchImpl: replying(401, SECRET_BODY) })), "Eclipse rejected the token.");
  });

  it("maps contact lookup provider failures to fixed sentences", async () => {
    const env = { HUNTER_API_KEY: "hunter-test-key-1" };
    const run = async (status: number) =>
      (await verifyWith("a@x.test", { env, fetchImpl: replying(status, { errors: [{ details: SECRET_BODY }] }), deadline: Date.now() + 5_000 })).attempts[0]?.detail;
    assert.equal(await run(500), "Couldn't reach Hunter. Try again.");
    assert.equal(await run(401), "Hunter rejected the key.");
    assert.equal(await run(402), "Hunter is out of credits.");
    assert.equal(await run(429), "Hunter is busy. It may be out of credits.");
    const offlineDetail = (await verifyWith("a@x.test", { env, fetchImpl: offline(), deadline: Date.now() + 5_000 })).attempts[0]?.detail;
    assert.equal(offlineDetail, "Couldn't reach Hunter. Try again.");
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));
  });
});

describe("logs never carry keys", () => {
  it("redacts keys a provider echoes back, and key-bearing links", async () => {
    const echo: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const sent = headers.get("authorization") ?? headers.get("x-bb-api-key") ?? "";
      return new Response(JSON.stringify({ error: { message: `Invalid credentials: ${sent}`, api_key: "sk-live-abcdefgh12345678" } }), { status: 401 });
    };
    const request = { system: "s", user: "u", schema: z.object({ ok: z.boolean() }) };
    await messageOf(() => completeJson({ ...request, fetchImpl: echo }));
    await messageOf(() => sendNewMessage("agent@x.test", { to: ["a@x.test"], subject: "s", text: "t" }, echo));
    await messageOf(() => renderWithBrowserbase("https://shy.test/", { proxies: false, fetchImpl: echo }));
    await messageOf(() => eclipseGuide({ fetchImpl: echo }));
    resetLinearCache();
    await messageOf(() => searchLinearIssues({}, { apiKey: "lin_api_secret_key_1", fetchImpl: echo }));
    await readWebPage("https://shy.test/", {
      fetchImpl: replying(403, "blocked"),
      lookup: async () => ["93.184.216.34"],
      render: async () => {
        throw new Error("browserType.connectOverCDP: connect ECONNREFUSED wss://connect.browserbase.com?apiKey=bb_live_secret123&signingKey=xyz");
      },
    }).catch(() => undefined);
    assert.ok(logged.length >= 5);
    const all = logged.join("\n");
    for (const secret of ["llm-test-key", "mm-test-key", "bb-test-key", "ecl_pat_test_token_123", "lin_api_secret_key_1", "sk-live-abcdefgh12345678", "bb_live_secret123", "signingKey=xyz"]) {
      assert.ok(!all.includes(secret), `log contains ${secret}`);
    }
  });

  it("redacts common key shapes in any text", () => {
    process.env.SOME_PROVIDER_TOKEN = "tok_abcdef123456";
    const text = redactSecrets('{"token":"tok_abcdef123456","apiKey":"zzz999"} Bearer abc.def https://x.test/a?key=k123&b=2 sk-proj-ABCDEFGH1234');
    assert.doesNotMatch(text, /tok_abcdef123456|zzz999|abc\.def|k123|ABCDEFGH1234/);
  });
});
