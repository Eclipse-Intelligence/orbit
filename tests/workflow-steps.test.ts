import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact, getContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { verifyEmail } from "@/lib/enrichment/email-check";
import type { WorkflowDefinition } from "@/lib/workflows/definition";
import { executeRun, runWorkflowTick, LONG_TICK_MS } from "@/lib/workflows/engine";
import { takeService } from "@/lib/workflows/limits";
import { variableOptions } from "@/lib/workflows/variables";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

type Node = WorkflowDefinition["nodes"][number];

function node(id: string, type: Node["type"], config: Record<string, unknown>, label?: string): Node {
  return { id, type, config, position: { x: 0, y: 0 }, ...(label ? { label } : {}) };
}

function chain(trigger: WorkflowDefinition["trigger"], nodes: Node[], extra: [string, string, string][] = []): WorkflowDefinition {
  const sources = new Set(extra.map(([source]) => source));
  const targets = new Set(extra.map(([, , target]) => target));
  const edges = nodes
    .map((item, index) => ({ source: index === 0 ? "trigger" : nodes[index - 1].id, handle: "out", target: item.id }))
    .filter((edge) => !sources.has(edge.source) && !targets.has(edge.target));
  return {
    version: 2,
    trigger,
    triggerPosition: { x: 0, y: 0 },
    nodes,
    edges: [...edges, ...extra.map(([source, handle, target]) => ({ source, handle, target }))],
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Route = (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> } | null;

function fake(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json", ...hit.headers } });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, hits: (part: string) => calls.filter((call) => call.url.includes(part)).length };
}

function param(url: string, name: string) {
  return new URL(url).searchParams.get(name);
}

const hunterFinds = (found: Record<string, string | null>): Route => (call) => {
  if (!call.url.includes("api.hunter.io/v2/email-finder")) return null;
  const email = found[param(call.url, "last_name") ?? ""] ?? null;
  return { body: { data: { email, score: email ? 96 : null, verification: { status: email ? "valid" : null } } } };
};

const hunterChecks = (verdicts: Record<string, string>): Route => (call) => {
  if (!call.url.includes("api.hunter.io/v2/email-verifier")) return null;
  return { body: { data: { status: verdicts[param(call.url, "email") ?? ""] ?? "accept_all" } } };
};

const busyOnce = (part: string): Route => {
  let sent = false;
  return (call) => {
    if (sent || !call.url.includes(part)) return null;
    sent = true;
    return { status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "1" } };
  };
};

const contextNone: Route = (call) => (call.url.endsWith("/v1/people/enrich") ? { body: { match: { status: "not_found" } } } : null);
const contextFinds = (email: string): Route => (call) =>
  call.url.endsWith("/v1/people/enrich")
    ? { body: { match: { status: "candidate", score: 90, person: { email, current_role: { organization: { domain: "acme-steps.test" } } } } } }
    : null;

const KEYS = ["HUNTER_API_KEY", "CONTEXT_DEV_API_KEY", "ENROW_API_KEY", "ICYPEAS_API_KEY"];
const LIMITS = ["WORKFLOW_LIMIT_HUNTER_PER_MINUTE", "WORKFLOW_LIMIT_CONTEXT_DEV_PER_MINUTE", "WORKFLOW_LIMIT_HUNTER_AT_ONCE"];

async function runRow(id: string) {
  return (
    await getAdminPool().query<{ status: string; error: string | null; skip_reason: string | null; resume_at: Date | null; state: Record<string, unknown> }>(
      "select status, error, skip_reason, resume_at, state from crm.workflow_runs where id = $1",
      [id],
    )
  ).rows[0];
}

async function children(parentId: string) {
  return (
    await getAdminPool().query<{ status: string; skip_reason: string | null; name: string }>(
      "select status, skip_reason, state->>'itemName' as name from crm.workflow_runs where parent_run_id = $1 order by item_index",
      [parentId],
    )
  ).rows;
}

async function wakeUp(runId: string) {
  await getAdminPool().query("update crm.workflow_runs set resume_at = now() - interval '1 second' where id = $1 or parent_run_id = $1", [runId]);
}

async function drain(fetchImpl: typeof fetch, rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    const tick = await runWorkflowTick({ fetchImpl, budgetMs: LONG_TICK_MS, long: true, limit: 25 });
    if (tick.processed === 0) return;
  }
}

async function notes(owner: UserActor, title: string) {
  return (
    await getAdminPool().query<{ body: string; contact_id: string | null }>(
      "select body, contact_id from crm.activities where workspace_id = $1 and type = 'note' and title = $2 order by created_at",
      [owner.workspaceId, title],
    )
  ).rows;
}

describe("workflow tags and Find and check email", () => {
  let owner: UserActor;
  let outsider: UserActor;
  let acme: string;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@steps.test", "Mark Ridgeon");
    outsider = await createUser("olga@elsewhere.test", "Olga Other");
    acme = (await createCompany(owner, { name: "Acme", domain: "acme-steps.test" })).body.company.id;
  });

  beforeEach(() => {
    for (const key of [...KEYS, ...LIMITS]) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    process.env.HUNTER_API_KEY = "hun";
    process.env.WORKFLOW_LIMIT_HUNTER_PER_MINUTE = "100000";
    process.env.WORKFLOW_LIMIT_CONTEXT_DEV_PER_MINUTE = "100000";
    delete process.env.WORKFLOW_LIMIT_HUNTER_AT_ONCE;
  });

  afterEach(() => {
    for (const key of [...KEYS, ...LIMITS]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  after(async () => {
    for (const key of KEYS) delete process.env[key];
  });

  useServerlessPool();

  async function workflow(definition: WorkflowDefinition) {
    const created = await createWorkflow(owner, { name: `Steps ${Math.random()}` });
    await saveWorkflow(owner, created.id, { definition });
    await setWorkflowStatus(owner, created.id, "active");
    return created.id;
  }

  async function start(definition: WorkflowDefinition, record: { type: "company" | "contact"; id: string }, fetchImpl?: typeof fetch, test = false) {
    const id = await workflow(definition);
    return startRun(owner, id, { test, record, fetchImpl });
  }

  async function person(firstName: string, lastName: string | null, email: string | null = null, tags: string[] = []) {
    return (await createContact(owner, { firstName, lastName, email, companyId: acme, tags })).body.contact;
  }

  async function audits(entityId: string, operation: string) {
    return (
      await getAdminPool().query<{ event_type: string; changes: Record<string, unknown> }>(
        "select event_type, changes from crm.audit_events where entity_id = $1 and operation = $2 order by created_at",
        [entityId, operation],
      )
    ).rows;
  }

  describe("tags", () => {
    it("adds tags with fields to a contact it creates, and audits the change as the workflow", async () => {
      const definition = chain({ type: "manual", object: "company" }, [
        node("upsert_record_1", "upsert_record", {
          object: "contact",
          email: "new.lead@acme-steps.test",
          firstName: "Nia",
          lastName: "Lead",
          tags: "Agency run {{today}}, Prospect",
        }),
      ]);
      const started = await start(definition, { type: "company", id: acme });
      assert.equal(started.status, "succeeded");
      const { steps } = await getRunSteps(owner, started.runId);
      const output = steps.find((step) => step.stepId === "upsert_record_1")!.output as { id: string; created: boolean; tags: string[] };
      assert.equal(output.created, true);
      const contact = await getContact(owner, output.id);
      assert.equal(contact.tags.length, 2);
      assert.ok(contact.tags.some((tag) => /^agency run \w{3}, \d{1,2} \w{3} \d{4}$/.test(tag)), `the date keeps its comma inside one tag: ${contact.tags}`);
      assert.ok(contact.tags.includes("prospect"));
      assert.deepEqual(output.tags, contact.tags);
      const changes = await audits(output.id, "workflow_upsert_record");
      assert.ok(changes.some((row) => row.event_type === "contact.updated"), "the tag change is audited with the workflow's provenance");
    });

    it("adds tags to a record it finds, without dropping the ones it has", async () => {
      const existing = await person("Finn", "Found", "finn@acme-steps.test", ["warm"]);
      const definition = chain({ type: "manual", object: "company" }, [
        node("upsert_record_1", "upsert_record", { object: "contact", email: "finn@acme-steps.test", tags: "Batch {{company.name}}", create: false }),
      ]);
      const started = await start(definition, { type: "company", id: acme });
      assert.equal(started.status, "succeeded");
      assert.deepEqual((await getContact(owner, existing.id)).tags, ["warm", "batch acme"]);
    });

    it("refuses a tag over 40 characters before finding or creating anything", async () => {
      const definition = chain({ type: "manual", object: "company" }, [
        node("upsert_record_1", "upsert_record", { object: "contact", email: "toolong@acme-steps.test", firstName: "Tom", tags: "x".repeat(41) }),
      ]);
      const started = await start(definition, { type: "company", id: acme });
      assert.equal(started.status, "failed");
      const run = await runRow(started.runId);
      assert.match(run.error ?? "", /40/);
      const made = await getAdminPool().query("select 1 from crm.contacts where normalized_email = 'toolong@acme-steps.test'");
      assert.equal(made.rowCount, 0);
    });

    it("fails the step rather than going past 20 tags on a record", async () => {
      const full = await person("Fay", "Full", "fay@acme-steps.test", Array.from({ length: 20 }, (_, index) => `tag ${index}`));
      const definition = chain({ type: "manual", object: "contact" }, [node("upsert_record_1", "upsert_record", { object: "contact", email: "fay@acme-steps.test", tags: "one more" })]);
      const started = await start(definition, { type: "contact", id: full.id });
      assert.equal(started.status, "failed");
      assert.match((await runRow(started.runId)).error ?? "", /20 tags/);
      assert.equal((await getContact(owner, full.id)).tags.length, 20);
    });

    it("adds and removes tags with Update record", async () => {
      const contact = await person("Una", "Update", "una@acme-steps.test", ["old", "keep"]);
      const definition = chain({ type: "manual", object: "contact" }, [
        node("update_record_1", "update_record", { object: "contact", field: "tags", tagAction: "add", value: "Run {{contact.firstName}}" }),
        node("update_record_2", "update_record", { object: "contact", field: "tags", tagAction: "remove", value: "old" }),
        node("add_note_1", "add_note", { title: "Tags now", body: "{{contact.tags}}" }),
      ]);
      const started = await start(definition, { type: "contact", id: contact.id });
      assert.equal(started.status, "succeeded");
      assert.deepEqual((await getContact(owner, contact.id)).tags, ["keep", "run una"]);
      assert.equal((await notes(owner, "Tags now"))[0].body, "- keep\n- run una", "later steps see the new tags");
      assert.equal((await audits(contact.id, "workflow_update_record")).length, 2);
    });

    it("gives one tag per item of a list field", async () => {
      const lister = await person("Lou", "List", "lou@acme-steps.test", ["alpha", "beta"]);
      const definition = chain({ type: "manual", object: "contact" }, [
        node("upsert_record_1", "upsert_record", { object: "company", name: "List Co", tags: "{{contact.tags}}, gamma" }),
      ]);
      const started = await start(definition, { type: "contact", id: lister.id });
      assert.equal(started.status, "succeeded");
      const tags = (await getAdminPool().query<{ tags: string[] }>("select tags from crm.companies where name = 'List Co'")).rows[0].tags;
      assert.deepEqual(tags, ["alpha", "beta", "gamma"]);
    });

    it("leaves Update record and Find or create without tags as they were", async () => {
      const plain = await person("Pat", "Plain", "pat@acme-steps.test");
      const definition = chain({ type: "manual", object: "contact" }, [
        node("update_record_1", "update_record", { object: "contact", field: "jobTitle", value: "CTO" }),
        node("upsert_record_1", "upsert_record", { object: "contact", email: "plain.new@acme-steps.test", firstName: "Nell" }),
      ]);
      const started = await start(definition, { type: "contact", id: plain.id });
      assert.equal(started.status, "succeeded");
      const { steps } = await getRunSteps(owner, started.runId);
      assert.deepEqual(steps.find((step) => step.stepId === "update_record_1")?.output, { field: "jobTitle", value: "CTO" });
      const upserted = steps.find((step) => step.stepId === "upsert_record_1")?.output as Record<string, unknown>;
      assert.deepEqual(Object.keys(upserted).sort(), ["created", "found", "id", "name", "url"]);
      assert.deepEqual((await audits(plain.id, "workflow_update_record")).map((row) => row.event_type), ["contact.updated"]);
      assert.deepEqual((await audits(String(upserted.id), "workflow_upsert_record")).map((row) => row.event_type), ["contact.created"]);
    });

    it("tags a company with Update record", async () => {
      const company = (await createCompany(owner, { name: "Tagged Co" })).body.company;
      const definition = chain({ type: "manual", object: "company" }, [
        node("update_record_1", "update_record", { object: "company", field: "tags", value: "Agency, {{company.name}}" }),
      ]);
      const started = await start(definition, { type: "company", id: company.id });
      assert.equal(started.status, "succeeded");
      const tags = (await getAdminPool().query<{ tags: string[] }>("select tags from crm.companies where id = $1", [company.id])).rows[0].tags;
      assert.deepEqual(tags, ["agency", "tagged co"]);
    });
  });

  describe("Find and check email", () => {
    function findEmail(trigger: WorkflowDefinition["trigger"] = { type: "manual", object: "contact" }) {
      return chain(trigger, [
        node("find_email_1", "find_email", {}, "Check email"),
        node("add_note_1", "add_note", { title: "Checked", body: "{{steps.find_email_1.status}} {{steps.find_email_1.address}} {{contact.email}}" }),
      ]);
    }

    it("finds a missing email, checks it and gives status and address to later steps", async () => {
      const ada = await person("Ada", "Finder");
      const fake1 = fake([hunterFinds({ Finder: "ada@acme-steps.test" }), hunterChecks({})]);
      const started = await start(findEmail(), { type: "contact", id: ada.id }, fake1.fetchImpl);
      assert.equal(started.status, "paused", "the step waits for a long tick");
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal((await getContact(owner, ada.id)).email, "ada@acme-steps.test");
      const note = (await notes(owner, "Checked")).find((row) => row.contact_id === ada.id);
      assert.equal(note?.body, "valid ada@acme-steps.test ada@acme-steps.test");
      assert.equal(fake1.hits("email-verifier"), 0, "a found email carries its check, so it isn't paid for twice");
    });

    it("ends a top-level run as succeeded with its skip reason and no failure notification when the email is invalid", async () => {
      const ivan = await person("Ivan", "Invalid", "ivan@acme-steps.test");
      const fake1 = fake([hunterChecks({ "ivan@acme-steps.test": "invalid" })]);
      const started = await start(findEmail(), { type: "contact", id: ivan.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "succeeded");
      assert.equal(run.skip_reason, "Check email: ivan@acme-steps.test is invalid.");
      assert.equal(run.error, "Check email: ivan@acme-steps.test is invalid.");
      const { steps } = await getRunSteps(owner, started.runId);
      const logged = steps.find((step) => step.stepId === "find_email_1");
      assert.equal(logged?.status, "skipped");
      assert.deepEqual(logged?.output, { status: "invalid", address: "ivan@acme-steps.test" });
      const alerts = await getAdminPool().query("select 1 from crm.notifications where user_id = $1 and href like '%' || $2 || '%'", [owner.userId, started.runId]);
      assert.equal(alerts.rowCount, 0, "no failure notification");
      assert.equal((await notes(owner, "Checked")).filter((row) => row.contact_id === ivan.id).length, 0);
    });

    it("skips parallel items that are invalid, unknown, not found or can't be searched, with the reason, and carries on with valid ones", async () => {
      const tag = "check batch";
      const valid = await person("Val", "Good", null, [tag]);
      await person("Ivy", "Bad", "ivy@acme-steps.test", [tag]);
      await person("Uma", "Maybe", "uma@acme-steps.test", [tag]);
      await person("Nora", "Nobody", null, [tag]);
      await person("Solo", null, null, [tag]);
      const fake1 = fake([
        hunterFinds({ Good: "val@acme-steps.test", Nobody: null }),
        hunterChecks({ "ivy@acme-steps.test": "invalid", "uma@acme-steps.test": "accept_all" }),
      ]);
      const definition = chain(
        { type: "manual", object: "company" },
        [
          node("find_records_1", "find_records", { object: "contact", tag, order: "oldest", limit: 10 }),
          node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: true, atOnce: 10 }),
          node("find_email_1", "find_email", {}, "Check email"),
          node("add_note_1", "add_note", { title: "Batch checked", body: "{{steps.find_email_1.status}} {{steps.find_email_1.address}}" }),
          node("add_note_2", "add_note", { title: "Batch done", body: "{{steps.loop_1.succeeded}} ok, {{steps.loop_1.skipped}} skipped" }),
        ],
        [
          ["loop_1", "each", "find_email_1"],
          ["loop_1", "done", "add_note_2"],
        ],
      );
      const started = await start(definition, { type: "company", id: acme }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      const items = await children(started.runId);
      assert.deepEqual(
        items.map((item) => [item.name, item.status, item.skip_reason]),
        [
          ["Val Good", "succeeded", null],
          ["Ivy Bad", "succeeded", "Check email: ivy@acme-steps.test is invalid."],
          ["Uma Maybe", "succeeded", "Check email: Couldn't confirm uma@acme-steps.test."],
          ["Nora Nobody", "succeeded", "Check email: No email found for Nora Nobody."],
          ["Solo", "succeeded", "Check email: Add Solo's first and last name first."],
        ],
      );
      const checked = await notes(owner, "Batch checked");
      assert.deepEqual(checked.map((row) => [row.contact_id, row.body]), [[valid.id, "valid val@acme-steps.test"]]);
      assert.equal((await notes(owner, "Batch done"))[0].body, "1 ok, 4 skipped");
    });

    it("skips an item in a one-at-a-time loop and moves to the next one", async () => {
      const tag = "slow batch";
      await person("Sam", "Nothing", null, [tag]);
      const later = await person("Lia", "Later", "lia@acme-steps.test", [tag]);
      const fake1 = fake([hunterFinds({}), hunterChecks({ "lia@acme-steps.test": "valid" })]);
      const definition = chain(
        { type: "manual", object: "company" },
        [
          node("find_records_1", "find_records", { object: "contact", tag, order: "oldest", limit: 10 }),
          node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: false, limit: 10 }),
          node("find_email_1", "find_email", {}),
          node("add_note_1", "add_note", { title: "Slow checked", body: "{{steps.find_email_1.address}}" }),
        ],
        [["loop_1", "each", "find_email_1"]],
      );
      const started = await start(definition, { type: "company", id: acme }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "succeeded");
      assert.match(run.error ?? "", /Sam Nothing \(No email found for Sam Nothing\.\)/);
      assert.deepEqual((await notes(owner, "Slow checked")).map((row) => [row.contact_id, row.body]), [[later.id, "lia@acme-steps.test"]]);
    });

    it("skips the item when the run has no contact", async () => {
      const definition = chain({ type: "manual", object: "company" }, [node("find_email_1", "find_email", {})]);
      const started = await start(definition, { type: "company", id: acme });
      await drain(fake([]).fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "succeeded");
      assert.equal(run.skip_reason, "Find and check email: This run has no contact to find an email for.");
    });

    it("only describes the step in a test run", async () => {
      const tess = await person("Tess", "Test");
      const fake1 = fake([hunterFinds({ Test: "tess@acme-steps.test" })]);
      const started = await start(findEmail(), { type: "contact", id: tess.id }, fake1.fetchImpl, true);
      assert.equal(started.status, "succeeded");
      assert.equal(fake1.calls.length, 0);
      assert.equal((await getContact(owner, tess.id)).email, null);
    });

    it("waits and tries again when a provider answers 429, without repeating the lookups already paid for", async () => {
      process.env.CONTEXT_DEV_API_KEY = "ctx";
      const bea = await person("Bea", "Busy");
      const fake1 = fake([contextNone, busyOnce("email-finder"), hunterFinds({ Busy: "bea@acme-steps.test" }), hunterChecks({})]);
      const started = await start(findEmail(), { type: "contact", id: bea.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const waiting = await runRow(started.runId);
      assert.equal(waiting.status, "waiting");
      assert.ok(waiting.resume_at, "it waits for its turn instead of failing");
      assert.equal(fake1.hits("people/enrich"), 1);
      await wakeUp(started.runId);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("people/enrich"), 1, "context.dev isn't asked again after the wait");
      assert.equal(fake1.hits("email-finder"), 2);
      assert.equal((await getContact(owner, bea.id)).email, "bea@acme-steps.test");
      const lookups = await getAdminPool().query<{ attempts: { provider: string; outcome: string }[] }>(
        "select attempts from crm.enrichment_lookups where record_id = $1 and field = 'email'",
        [bea.id],
      );
      assert.deepEqual(
        lookups.rows[0].attempts.map((attempt) => [attempt.provider, attempt.outcome]),
        [
          ["context", "not_found"],
          ["hunter", "found"],
        ],
      );
    });

    it("keeps a context.dev email found before a busy checker, and checks it after the wait", async () => {
      process.env.CONTEXT_DEV_API_KEY = "ctx";
      const cal = await person("Cal", "Candidate");
      const fake1 = fake([contextFinds("cal@acme-steps.test"), busyOnce("email-verifier"), hunterChecks({ "cal@acme-steps.test": "valid" }), hunterFinds({})]);
      const started = await start(findEmail(), { type: "contact", id: cal.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "waiting");
      await wakeUp(started.runId);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("people/enrich"), 1);
      assert.equal(fake1.hits("email-finder"), 0);
      assert.equal(fake1.hits("email-verifier"), 2);
      assert.equal((await getContact(owner, cal.id)).email, "cal@acme-steps.test");
    });

    it("re-queues when the provider has too many calls running, and goes ahead once one ends", async () => {
      process.env.WORKFLOW_LIMIT_HUNTER_AT_ONCE = "1";
      const held = await takeService("hunter");
      const dot = await person("Dot", "Queued");
      const fake1 = fake([hunterFinds({ Queued: "dot@acme-steps.test" }), hunterChecks({})]);
      const started = await start(findEmail(), { type: "contact", id: dot.id }, fake1.fetchImpl);
      try {
        await drain(fake1.fetchImpl);
        assert.equal((await runRow(started.runId)).status, "waiting");
        assert.equal(fake1.calls.length, 0, "nothing is paid for while it waits");
      } finally {
        await held.release();
      }
      await wakeUp(started.runId);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("email-finder"), 1, "the deferred search runs once");
      assert.equal(fake1.hits("email-verifier"), 0, "the found email isn't checked again");
      assert.equal(fake1.calls.length, 1);
    });

    it("doesn't count towards the hourly lookup limit, which app routes still apply", async () => {
      await getAdminPool().query(
        `insert into private.rate_limit_buckets (bucket_key, window_start, request_count)
         values ($1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600), 100000)
         on conflict (bucket_key) do update set window_start = excluded.window_start, request_count = excluded.request_count`,
        [`enrich:${owner.userId}`],
      );
      const lee = await person("Lee", "Limited", "lee@acme-steps.test");
      const fake1 = fake([hunterChecks({ "lee@acme-steps.test": "valid" })]);
      await assert.rejects(
        () => verifyEmail(owner, "lee@acme-steps.test", { fetchImpl: fake1.fetchImpl }),
        (error: unknown) => error instanceof CrmError && error.code === "rate_limited",
      );
      assert.equal(fake1.calls.length, 0);
      const started = await start(findEmail(), { type: "contact", id: lee.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("email-verifier"), 1);
      await getAdminPool().query("delete from private.rate_limit_buckets where bucket_key = $1", [`enrich:${owner.userId}`]);
    });

    it("keeps polling Enrow and Icypeas through a 429 instead of searching again", async () => {
      delete process.env.HUNTER_API_KEY;
      process.env.ENROW_API_KEY = "enr";
      const enrowPolls = busyOnce("/email/find/single?id=");
      const enrowFake = fake([
        enrowPolls,
        (call) => (call.url.endsWith("/email/find/single") && call.method === "POST" ? { body: { id: "find_1" } } : null),
        (call) => (call.url.includes("/email/find/single?id=") ? { body: { email: "pia@acme-steps.test", qualification: "valid" } } : null),
      ]);
      const pia = await person("Pia", "Poll");
      const first = await start(findEmail(), { type: "contact", id: pia.id }, enrowFake.fetchImpl);
      await drain(enrowFake.fetchImpl);
      assert.equal((await runRow(first.runId)).status, "succeeded");
      assert.equal(enrowFake.calls.filter((call) => call.url.endsWith("/email/find/single") && call.method === "POST").length, 1);
      assert.equal((await getContact(owner, pia.id)).email, "pia@acme-steps.test");

      delete process.env.ENROW_API_KEY;
      process.env.ICYPEAS_API_KEY = "icy";
      const icyFake = fake([
        busyOnce("/api/bulk-single-searchs/read"),
        (call) => (call.url.endsWith("/api/email-search") ? { body: { success: true, item: { _id: "icy_1", status: "NONE" } } } : null),
        (call) =>
          call.url.endsWith("/api/bulk-single-searchs/read")
            ? { body: { items: [{ _id: "icy_1", status: "DEBITED", results: { emails: [{ email: "ike@acme-steps.test", certainty: "very_sure" }] } }] } }
            : null,
      ]);
      const ike = await person("Ike", "Icy");
      const second = await start(findEmail(), { type: "contact", id: ike.id }, icyFake.fetchImpl);
      await drain(icyFake.fetchImpl);
      assert.equal((await runRow(second.runId)).status, "succeeded");
      assert.equal(icyFake.hits("/api/email-search"), 1);
      assert.equal((await getContact(owner, ike.id)).email, "ike@acme-steps.test");
    });

    it("waits inside a parallel item and carries on after the wait", async () => {
      const tag = "busy batch";
      const kit = await person("Kit", "Parallel", null, [tag]);
      const fake1 = fake([busyOnce("email-finder"), hunterFinds({ Parallel: "kit@acme-steps.test" }), hunterChecks({})]);
      const definition = chain(
        { type: "manual", object: "company" },
        [
          node("find_records_1", "find_records", { object: "contact", tag, limit: 10 }),
          node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: true, atOnce: 5 }),
          node("find_email_1", "find_email", {}),
        ],
        [["loop_1", "each", "find_email_1"]],
      );
      const started = await start(definition, { type: "company", id: acme }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const [item] = await children(started.runId);
      assert.equal(item.status, "waiting");
      await wakeUp(started.runId);
      await drain(fake1.fetchImpl);
      assert.equal((await children(started.runId))[0].status, "succeeded");
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("email-finder"), 2);
      assert.equal((await getContact(owner, kit.id)).email, "kit@acme-steps.test");
    });

    it("moves on to the next provider after three waits for one that stays busy", async () => {
      process.env.CONTEXT_DEV_API_KEY = "ctx";
      const ray = await person("Ray", "Fallback");
      const fake1 = fake([
        (call) => (call.url.endsWith("/v1/people/enrich") ? { status: 429, body: { message: "slow down" }, headers: { "retry-after": "1" } } : null),
        hunterFinds({ Fallback: "ray@acme-steps.test" }),
        hunterChecks({}),
      ]);
      const started = await start(findEmail(), { type: "contact", id: ray.id }, fake1.fetchImpl);
      for (let wait = 0; wait < 3; wait += 1) {
        await drain(fake1.fetchImpl);
        assert.equal((await runRow(started.runId)).status, "waiting");
        await wakeUp(started.runId);
      }
      await drain(fake1.fetchImpl);
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.equal(fake1.hits("people/enrich"), 4);
      assert.equal(fake1.hits("email-finder"), 1);
      const lookups = await getAdminPool().query<{ attempts: { provider: string; outcome: string; detail?: string }[] }>(
        "select attempts from crm.enrichment_lookups where record_id = $1 and field = 'email'",
        [ray.id],
      );
      assert.deepEqual(lookups.rows[0].attempts.map((attempt) => [attempt.provider, attempt.outcome, attempt.detail ?? null]), [
        ["context", "failed", "Busy."],
        ["hunter", "found", null],
      ]);
    });

    it("doesn't count waits for Orbit's own limiter as a busy provider", async () => {
      process.env.WORKFLOW_LIMIT_HUNTER_AT_ONCE = "1";
      const tag = "local batch";
      for (const last of ["One", "Two", "Three"]) await person("Lo", last, null, [tag]);
      const fake1 = fake([hunterFinds({ One: "lo1@acme-steps.test", Two: "lo2@acme-steps.test", Three: "lo3@acme-steps.test" }), hunterChecks({})]);
      const definition = chain(
        { type: "manual", object: "company" },
        [
          node("find_records_1", "find_records", { object: "contact", tag, limit: 10 }),
          node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: true, atOnce: 5 }),
          node("find_email_1", "find_email", {}),
        ],
        [["loop_1", "each", "find_email_1"]],
      );
      const held = await takeService("hunter");
      const started = await start(definition, { type: "company", id: acme }, fake1.fetchImpl);
      try {
        for (let wait = 0; wait < 4; wait += 1) {
          await drain(fake1.fetchImpl);
          await wakeUp(started.runId);
        }
        assert.equal(fake1.calls.length, 0);
      } finally {
        await held.release();
      }
      for (let round = 0; round < 20 && (await runRow(started.runId)).status !== "succeeded"; round += 1) {
        await drain(fake1.fetchImpl);
        await wakeUp(started.runId);
      }
      assert.equal((await runRow(started.runId)).status, "succeeded");
      assert.deepEqual((await children(started.runId)).map((item) => item.skip_reason), [null, null, null]);
      const lookups = await getAdminPool().query<{ attempts: { provider: string; outcome: string; detail?: string }[] }>(
        "select l.attempts from crm.enrichment_lookups l join crm.contacts c on c.id = l.record_id where $1 = any(c.tags) and l.field = 'email'",
        [tag],
      );
      assert.equal(lookups.rowCount, 3);
      for (const row of lookups.rows) assert.deepEqual(row.attempts.map((attempt) => [attempt.provider, attempt.outcome]), [["hunter", "found"]]);
    });

    it("skips the item when the email found belongs to another contact", async () => {
      await person("Dee", "Taken", "dee.taken@acme-steps.test");
      const dup = await person("Dee", "Copy");
      const fake1 = fake([hunterFinds({ Copy: "dee.taken@acme-steps.test" }), hunterChecks({})]);
      const started = await start(findEmail(), { type: "contact", id: dup.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "succeeded");
      assert.equal(run.skip_reason, "Check email: Another contact already has dee.taken@acme-steps.test.");
    });

    it("names both when a found email comes with a LinkedIn profile another contact has", async () => {
      const profile = "https://www.linkedin.com/in/shared-steps-person";
      await createContact(owner, { firstName: "Lin", lastName: "Owner", linkedinUrl: profile, companyId: acme });
      const clash = await person("Lin", "Clash");
      const fake1 = fake([
        (call) =>
          call.url.includes("api.hunter.io/v2/email-finder")
            ? { body: { data: { email: "lin.clash@acme-steps.test", score: 96, verification: { status: "valid" }, linkedin_url: profile } } }
            : null,
        hunterChecks({}),
      ]);
      const started = await start(findEmail(), { type: "contact", id: clash.id }, fake1.fetchImpl);
      await drain(fake1.fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "succeeded");
      assert.equal(run.skip_reason, "Check email: Another contact already has this email or LinkedIn profile.");
      assert.equal((await getContact(owner, clash.id)).email, null);
    });

    it("fails the step inside a loop when no email finder is set up", async () => {
      delete process.env.HUNTER_API_KEY;
      const tag = "setup batch";
      await person("Gus", "Setup", null, [tag]);
      const definition = chain(
        { type: "manual", object: "company" },
        [
          node("find_records_1", "find_records", { object: "contact", tag, limit: 10 }),
          node("loop_1", "loop", { items: "{{steps.find_records_1.records}}", parallel: false, limit: 10 }),
          node("find_email_1", "find_email", {}),
        ],
        [["loop_1", "each", "find_email_1"]],
      );
      const started = await start(definition, { type: "company", id: acme });
      await drain(fake([]).fetchImpl);
      const run = await runRow(started.runId);
      assert.equal(run.status, "failed");
      assert.equal(run.error, "find_email_1: No email finder is set up.");
    });

    it("lists its outputs as fields for later steps", () => {
      const definition = findEmail();
      const paths = variableOptions(definition, "add_note_1").map((option) => option.path);
      assert.ok(paths.includes("steps.find_email_1.status"));
      assert.ok(paths.includes("steps.find_email_1.address"));
    });
  });

  describe("a reclaimed Find and check email", () => {
    it("never calls a provider twice for one contact when its worker dies between the find and the check", async () => {
      process.env.CONTEXT_DEV_API_KEY = "ctx";
      const rae = await person("Rae", "Reclaim");
      const answered: string[] = [];
      let reached: () => void = () => undefined;
      const atCheck = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let died = false;
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("email-verifier") && !died) {
          died = true;
          reached();
          return new Promise<Response>(() => undefined);
        }
        answered.push(url);
        if (url.endsWith("/v1/people/enrich")) {
          return Response.json({ match: { status: "candidate", score: 90, person: { email: "rae@acme-steps.test", current_role: { organization: { domain: "acme-steps.test" } } } } });
        }
        if (url.includes("email-verifier")) return Response.json({ data: { status: "valid" } });
        return Response.json({ message: "unexpected" }, { status: 404 });
      }) as typeof fetch;
      const definition = chain({ type: "manual", object: "contact" }, [
        node("find_email_1", "find_email", {}),
        node("add_note_1", "add_note", { title: "Reclaimed", body: "{{contact.email}}" }),
      ]);
      const started = await start(definition, { type: "contact", id: rae.id }, fetchImpl);
      await getAdminPool().query("update crm.workflow_runs set status = 'running', claimed_at = now() where id = $1", [started.runId]);
      void executeRun(started.runId, owner.userId, owner.workspaceId, { deadline: Date.now() + LONG_TICK_MS, fetchImpl }).catch(() => undefined);
      await atCheck;
      const outcome = await executeRun(started.runId, owner.userId, owner.workspaceId, { deadline: Date.now() + LONG_TICK_MS, fetchImpl });
      assert.equal(outcome, "succeeded");
      const counts = new Map<string, number>();
      for (const url of answered) counts.set(new URL(url).pathname, (counts.get(new URL(url).pathname) ?? 0) + 1);
      assert.deepEqual([...counts.values()].filter((count) => count > 1), [], `calls: ${JSON.stringify([...counts])}`);
      assert.equal(counts.get("/v1/people/enrich"), 1);
      assert.equal((await getContact(owner, rae.id)).email, "rae@acme-steps.test");
      assert.equal((await notes(owner, "Reclaimed"))[0]?.body, "rae@acme-steps.test");
    });
  });

  describe("a checker that answered before the worker died", () => {
    it("isn't called again on resume", async () => {
      delete process.env.HUNTER_API_KEY;
      process.env.ICYPEAS_API_KEY = "icy";
      process.env.HUNTER_API_KEY = "hun";
      const cy = await person("Cy", "Checked", "cy@acme-steps.test");
      const answered: string[] = [];
      let reached: () => void = () => undefined;
      const atHunter = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let died = false;
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("email-verifier") && !died) {
          died = true;
          reached();
          return new Promise<Response>(() => undefined);
        }
        answered.push(url);
        if (url.endsWith("/api/email-verification")) return Response.json({ success: true, item: { _id: "icy_v", status: "NONE" } });
        if (url.endsWith("/api/bulk-single-searchs/read")) {
          return Response.json({ items: [{ _id: "icy_v", status: "DEBITED", results: { emails: [{ email: "cy@acme-steps.test", certainty: "risky" }] } }] });
        }
        if (url.includes("email-verifier")) return Response.json({ data: { status: "valid" } });
        return Response.json({ message: "unexpected" }, { status: 404 });
      }) as typeof fetch;
      const definition = chain({ type: "manual", object: "contact" }, [node("find_email_1", "find_email", {})]);
      const started = await start(definition, { type: "contact", id: cy.id }, fetchImpl);
      await getAdminPool().query("update crm.workflow_runs set status = 'running', claimed_at = now() where id = $1", [started.runId]);
      void executeRun(started.runId, owner.userId, owner.workspaceId, { deadline: Date.now() + LONG_TICK_MS, fetchImpl }).catch(() => undefined);
      await atHunter;
      const rows = await getAdminPool().query("select 1 from crm.enrichment_lookups where record_id = $1", [cy.id]);
      assert.equal(rows.rowCount, 0, "the worker died before the check was written");
      const outcome = await executeRun(started.runId, owner.userId, owner.workspaceId, { deadline: Date.now() + LONG_TICK_MS, fetchImpl });
      assert.equal(outcome, "succeeded");
      assert.equal(answered.filter((url) => url.endsWith("/api/email-verification")).length, 1, "Icypeas isn't asked again");
      assert.equal(answered.filter((url) => url.includes("email-verifier")).length, 1);
    });
  });

  describe("workspaces", () => {
    async function pointAt(runId: string, kind: "contact" | "company", id: string) {
      await getAdminPool().query(
        `update crm.workflow_runs set state = jsonb_set(state, $2::text[], $3::jsonb), resume_at = now() - interval '1 second' where id = $1`,
        [runId, ["vars", kind], JSON.stringify({ id, name: "Someone else's" })],
      );
    }

    it("never tags or enriches a record in another workspace, even when a run is pointed at it", async () => {
      const theirs = (await createContact(outsider, { firstName: "Zed", lastName: "Hidden", companyId: (await createCompany(outsider, { name: "Hidden", domain: "hidden.test" })).body.company.id })).body.contact;
      const mine = await person("Moe", "Mine");
      const fake1 = fake([hunterFinds({ Hidden: "zed@hidden.test", Mine: "moe@acme-steps.test" }), hunterChecks({})]);

      const tagging = chain({ type: "manual", object: "contact" }, [
        node("delay_1", "delay", { amount: 1, unit: "minutes" }),
        node("update_record_1", "update_record", { object: "contact", field: "tags", value: "hijack" }),
      ]);
      const tagRun = await start(tagging, { type: "contact", id: mine.id }, fake1.fetchImpl);
      assert.equal(tagRun.status, "waiting");
      await pointAt(tagRun.runId, "contact", theirs.id);

      const finding = chain({ type: "manual", object: "contact" }, [node("delay_1", "delay", { amount: 1, unit: "minutes" }), node("find_email_1", "find_email", {})]);
      const findRun = await start(finding, { type: "contact", id: mine.id }, fake1.fetchImpl);
      await pointAt(findRun.runId, "contact", theirs.id);

      await drain(fake1.fetchImpl);
      assert.equal((await runRow(tagRun.runId)).status, "failed");
      assert.equal((await runRow(findRun.runId)).status, "failed");
      const after = await getContact(outsider, theirs.id);
      assert.deepEqual(after.tags, []);
      assert.equal(after.email, null);
      assert.equal(fake1.calls.length, 0, "no lookup is paid for on their contact");
      const lookups = await getAdminPool().query("select 1 from crm.enrichment_lookups where record_id = $1", [theirs.id]);
      assert.equal(lookups.rowCount, 0);
    });
  });
});
