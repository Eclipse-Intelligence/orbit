import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderWithBrowserbase } from "@/lib/browserbase";
import { clickupClient } from "@/lib/clickup";
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
    assert.equal(denied, "The AI returned an error. Try again.");
    assertClean(denied);
    assert.ok(logged.some((line) => line.includes(SECRET_BODY)));

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

  it("keeps MachineMail's error text out of messages", async () => {
    const failed = await messageOf(() => sendNewMessage("agent@x.test", { to: ["a@x.test"], subject: "s", text: "t" }, replying(400, { error: { message: SECRET_BODY } })));
    assert.equal(failed, "MachineMail returned an error (400).");
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
});
