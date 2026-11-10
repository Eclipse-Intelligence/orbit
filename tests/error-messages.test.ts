import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CrmError,
  ShownError,
  errorText,
  itemFailure,
  notFound,
  notSetUp,
  pgFailure,
  tooLong,
  tooMany,
  writtenForPeople,
} from "@/lib/crm/errors";
import { logUpstream, unreachable, upstreamFailure, upstreamMessage } from "@/lib/upstream";

const realConsoleError = console.error;
let logged: unknown[][] = [];

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
});

afterEach(() => {
  console.error = realConsoleError;
});

function loggedText() {
  return logged.map((args) => args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ")).join("\n");
}

describe("notFound", () => {
  it("builds one not found error for any noun", () => {
    const error = notFound("task");
    assert.ok(error instanceof CrmError);
    assert.equal(error.code, "not_found");
    assert.equal(error.status, 404);
    assert.equal(error.message, "Task not found.");
    assert.equal(notFound("AI field").message, "AI field not found.");
  });
});

describe("notSetUp", () => {
  it("names the environment variable only for workspace owners", () => {
    assert.equal(notSetUp("ClickUp", "CLICKUP_API_TOKEN", { type: "user", role: "owner" }), "ClickUp isn't set up. Add CLICKUP_API_TOKEN.");
    assert.equal(notSetUp("ClickUp", "CLICKUP_API_TOKEN", { type: "user", role: "admin" }), "ClickUp isn't set up.");
    assert.equal(notSetUp("ClickUp", "CLICKUP_API_TOKEN", { type: "user", role: "member" }), "ClickUp isn't set up.");
    assert.equal(notSetUp("ClickUp", "CLICKUP_API_TOKEN", { type: "agent" }), "ClickUp isn't set up.");
    assert.equal(notSetUp("ClickUp", "CLICKUP_API_TOKEN"), "ClickUp isn't set up.");
    assert.equal(notSetUp("file storage"), "File storage isn't set up.");
  });

  it("logs the missing variable when it isn't shown", () => {
    notSetUp("AI", "LLM_API_KEY");
    assert.match(loggedText(), /LLM_API_KEY/);
  });
});

describe("limits", () => {
  it("says length and count limits one way", () => {
    assert.equal(tooLong("the name", 60), "Keep the name to 60 characters.");
    assert.equal(tooLong("the transcript", 200_000), "Keep the transcript to 200,000 characters.");
    assert.equal(tooMany(30, "boards"), "Up to 30 boards.");
    assert.equal(tooMany(1000, "pages at a time"), "Up to 1,000 pages at a time.");
  });
});

describe("errorText", () => {
  it("passes typed errors through", () => {
    assert.equal(errorText(new CrmError("invalid_input", "Choose a company.", 400), "Couldn't save."), "Choose a company.");
    class ProviderError extends ShownError {}
    assert.equal(errorText(new ProviderError("ClickUp is busy.  Orbit will retry."), "Couldn't sync."), "ClickUp is busy. Orbit will retry.");
  });

  it("hides plain errors and logs them", () => {
    assert.equal(errorText(new Error("fetch failed"), "Couldn't sync ClickUp."), "Couldn't sync ClickUp.");
    assert.equal(errorText(new TypeError("Cannot read properties of undefined (reading 'id')"), "Couldn't sync."), "Couldn't sync.");
    assert.equal(errorText("raw string", "Couldn't sync."), "Couldn't sync.");
    assert.match(loggedText(), /fetch failed/);
    assert.match(loggedText(), /reading 'id'/);
  });

  it("hides Postgres errors", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "tasks_pkey"'), { code: "23505" });
    assert.equal(errorText(pg, "Couldn't sync Granola."), "Couldn't sync Granola.");
    assert.match(loggedText(), /tasks_pkey/);
  });
});

describe("pgFailure", () => {
  function pg(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }

  it("passes through messages written for people", () => {
    const error = pgFailure(pg("42501", "Only the owner or an admin can change roles."));
    assert.ok(error instanceof CrmError);
    assert.equal(error.code, "forbidden");
    assert.equal(error.status, 403);
    assert.equal(error.message, "Only the owner or an admin can change roles.");
  });

  it("maps developer text by code", () => {
    const forbidden = pgFailure(pg("42501", "forbidden"));
    assert.equal(forbidden?.code, "forbidden");
    assert.equal(forbidden?.message, "You don't have permission to do that.");
    assert.equal(pgFailure(pg("22023", "user required"))?.message, "That isn't valid.");
    assert.equal(pgFailure(pg("22023", "invalid email"))?.message, "That isn't valid.");
    assert.equal(pgFailure(pg("22023", "contact belongs to another workspace"))?.code, "invalid_input");
    assert.equal(pgFailure(pg("P0002", "Contact not found"))?.message, "Not found.");
    assert.equal(pgFailure(pg("P0002", "no rows"), { P0002: "Company not found." })?.message, "Company not found.");
    assert.match(loggedText(), /forbidden/);
  });

  it("hides check and foreign key text that names tables", () => {
    const check = pgFailure(pg("23514", 'new row for relation "tasks" violates check constraint "tasks_title_check"'));
    assert.equal(check?.message, "That isn't valid.");
    assert.doesNotMatch(check?.message ?? "", /tasks/);
    const foreign = pgFailure(pg("23503", 'insert or update on table "deals" violates foreign key constraint "deals_company_id_fkey"'));
    assert.equal(foreign?.message, "That record isn't in this workspace.");
  });

  it("leaves unknown errors alone", () => {
    assert.equal(pgFailure(new Error("boom")), null);
    assert.equal(pgFailure(pg("57014", "canceling statement due to statement timeout")), null);
    const crm = new CrmError("conflict", "Already exists.", 409);
    assert.equal(pgFailure(crm), crm);
  });

  it("recognises text written for people", () => {
    assert.equal(writtenForPeople("Only owners can do that."), true);
    assert.equal(writtenForPeople("forbidden"), false);
    assert.equal(writtenForPeople("Forbidden"), false);
    assert.equal(writtenForPeople("password must be at least 8 characters"), false);
    assert.equal(writtenForPeople("First line.\nSecond line."), false);
    assert.equal(writtenForPeople("eBay is archived, so it can't be merged into."), true);
    assert.equal(writtenForPeople("bob@example.com is already in this workspace."), true);
    const lowerName = pgFailure(Object.assign(new Error("eBay is archived, so it can't be merged into."), { code: "22023" }));
    assert.equal(lowerName?.message, "eBay is archived, so it can't be merged into.");
  });
});

describe("itemFailure", () => {
  it("hides constraint text", () => {
    const failure = itemFailure(Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" }));
    assert.deepEqual(failure, { code: "conflict", message: "This item duplicates a record or links to a missing one." });
  });
});

describe("upstream failures", () => {
  it("says four things and never the provider's body", async () => {
    assert.equal(upstreamMessage("ClickUp", 401, { credential: "token" }), "ClickUp rejected the token.");
    assert.equal(upstreamMessage("Recall", 403, { fix: "Add a new one in Settings › Connections." }), "Recall rejected the key. Add a new one in Settings › Connections.");
    assert.equal(upstreamMessage("Linear", 429), "Linear is busy. Try again in a minute.");
    assert.equal(upstreamMessage("ClickUp", 429, { busy: "Orbit will retry." }), "ClickUp is busy. Orbit will retry.");
    assert.equal(upstreamMessage("Granola", 502), "Couldn't reach Granola. Try again.");
    assert.equal(upstreamMessage("Granola", 0), "Couldn't reach Granola. Try again.");
    assert.equal(upstreamMessage("Mindcase", 422), "Mindcase returned an error (422).");
    assert.equal(unreachable("Readwise"), "Couldn't reach Readwise. Try again.");

    const response = new Response(JSON.stringify({ err: "Team not authorized for list 123 (internal ref abc)" }), { status: 400 });
    const message = await upstreamFailure("ClickUp", response);
    assert.equal(message, "ClickUp returned an error (400).");
    assert.doesNotMatch(message, /authorized|internal/);
    assert.match(loggedText(), /Team not authorized/);
  });

  it("logs the detail with the provider name", () => {
    logUpstream("Recall", 500, { request_id: "req_1" });
    assert.match(loggedText(), /Recall request failed 500 .*req_1/);
  });
});
