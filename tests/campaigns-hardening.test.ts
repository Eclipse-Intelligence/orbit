import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { campaignActionNames, replyInCampaign, runCampaignAction, sendsFromLine } from "@/lib/campaigns/agent";
import { auditJson } from "@/lib/campaigns/audit";
import { saveThread, threadFetched } from "@/lib/campaigns/messages";
import { registerCampaignTools } from "@/server/mcp/campaigns";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { connectedContext } from "@/lib/campaigns/context";
import { handleCampaignEvents, replyRecipients, THREAD_TRIES } from "@/lib/campaigns/events";
import { removeProspect, setProspectCategory, setProspectPaused } from "@/lib/campaigns/manage";
import { addProspects } from "@/lib/campaigns/prospects";
import { ACCOUNT_KEY, heyReachProvider, smartleadEvents, smartleadProvider } from "@/lib/campaigns/providers";
import { claimFillBatch, runFillBatch } from "@/lib/campaigns/push";
import { replyToProspect } from "@/lib/campaigns/replies";
import { processStops } from "@/lib/campaigns/stops";
import { contactSuppression, liftDoNotContact, setDoNotContact, STILL_BLOCKED } from "@/lib/campaigns/suppression";
import { saveProviderEvents, saveProviderLeads, syncCampaigns } from "@/lib/campaigns/sync";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { mergeContacts } from "@/lib/crm/merge";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { listHeyReachLeads } from "@/lib/heyreach";
import { findSmartleadLead, listSmartleadLeads, readSmartleadStatistics, SmartleadError, UNREADABLE } from "@/lib/smartlead";
import { fakeHeyReach, fakeSmartlead, sequenceOf, type FakeAccount, type FakeHeyReachAccount } from "./campaigns-fake";
import { createUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const SL_A = "sl_key_hardening_alpha_01";
const SL_MIXED = "sl_key_hardening_mixed_02";
const HR_A = "hr_key_hardening_alpha_03";
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE"];
const T0 = "2026-11-10T09:00:00.000Z";

type Write = { method: string; path: string; query: string; body: Record<string, unknown> | null };

const state = {
  found: new Set<string>(),
  writes: [] as Write[],
  refuse: null as RegExp | null,
  refuseStatus: 403,
  blockList: [] as { id: number; email_or_domain: string }[],
  llm: 0,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

function refused(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

describe("campaign hardening", () => {
  let owner: UserActor;
  let ann: UserActor;
  let campaignId: string;
  let otherCampaign: string;
  const saved: Record<string, string | undefined> = {};
  const alpha: FakeAccount = {
    key: SL_A,
    client: { id: 1, name: "Eclipse" },
    campaigns: [
      {
        id: 801,
        name: "Agency outreach",
        status: "ACTIVE",
        leads: [{ id: "lead-zoe", email: "zoe@live.test", first: "Zoe", last: "Live" }],
        stats: [],
        sequences: sequenceOf([{ subject: "Hello", body: "Hi {{first_name}}" }]),
        analytics: {},
        threads: {},
      },
      { id: 802, name: "Other outreach", status: "ACTIVE", leads: [], stats: [], sequences: [], analytics: {}, threads: {} },
    ],
    calls: [],
  };
  const smartlead = fakeSmartlead([alpha]);
  const hr: FakeHeyReachAccount = {
    key: HR_A,
    accounts: [{ id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@hardening.test", profileUrl: "https://www.linkedin.com/in/markridgeon" }],
    campaigns: [{ id: 901, name: "Agency founders", status: "IN_PROGRESS", accountIds: [1], sequence: [], leads: [], overall: {}, byDay: {} }],
    calls: [],
  };
  const heyreach = fakeHeyReach([hr]);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.heyreach.io") return heyreach(input, init);
    if (url.hostname === "api.llmapi.ai") {
      state.llm += 1;
      return json({ error: { message: "Not in this test" } }, 500);
    }
    if (url.hostname !== "server.smartlead.ai") throw new Error(`Unexpected request to ${url.href}`);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.searchParams.get("api_key") === SL_MIXED && path === "/campaigns") {
      return json([
        { id: 1, name: "Eclipse one", status: "ACTIVE", client_id: 1 },
        { id: 2, name: "Ridgeon one", status: "ACTIVE", client_id: 2 },
      ]);
    }
    if (state.refuse?.test(`${method} ${path}`)) return json({ message: "Not allowed" }, state.refuseStatus);
    if (method !== "GET") state.writes.push({ method, path, query: url.search, body });
    if (method === "GET" && path === "/leads/") {
      const email = url.searchParams.get("email") ?? "";
      return state.found.has(email) ? json({ id: `sl-${email}`, lead_campaign_data: [{ campaign_id: 801 }] }) : json({ message: "Not found" }, 404);
    }
    if (method === "GET" && path === "/leads/get-domain-block-list") {
      const wanted = url.searchParams.get("filter_email_or_domain");
      return json(state.blockList.filter((row) => row.email_or_domain === wanted));
    }
    if (method === "DELETE" && path === "/leads/delete-domain-block-list") {
      state.blockList = state.blockList.filter((row) => String(row.id) !== url.searchParams.get("id"));
      return json({ ok: true });
    }
    if (method !== "GET") return json({ ok: true });
    return smartlead(input, init);
  };

  async function person(first: string, email: string) {
    return (await createContact(owner, { firstName: first, lastName: "Test", email }, { provenance: { operation: "test" } })).body.contact.id;
  }

  async function prospect(input: { campaign?: string; contact?: string | null; email?: string | null; linkedin?: string | null; state?: string; lead?: string | null }) {
    const rows = await sql<{ id: string }>(
      `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, linkedin, state, external_lead_id, pushed_at, lead_status)
       values ($1, $2, $3, $4, $5, $6, $7, now(), 'in_progress') returning id`,
      [owner.workspaceId, input.campaign ?? campaignId, input.contact ?? null, input.email ?? null, input.linkedin ?? null, input.state ?? "pushed", input.lead ?? null],
    );
    return rows[0].id;
  }

  async function mcp(actor: UserActor) {
    const server = new McpServer({ name: "crm", version: "1.0.0" });
    registerCampaignTools(server, actor, { canReply: true, fetchImpl });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "hardening-test", version: "1.0.0" });
    await client.connect(clientSide);
    return {
      async call(name: string, args: Record<string, unknown>) {
        const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { error: result.isError === true, text: result.content.map((part) => part.text).join("") };
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  async function row(id: string) {
    return (
      await sql<{
        state: string;
        skip_reason: string | null;
        external_lead_id: string | null;
        stopped_at: Date | null;
        stop_requested_at: Date | null;
        stop_reason: string | null;
        stop_error: string | null;
        category: string | null;
        fill_attempts: number;
      }>(
        "select state, skip_reason, external_lead_id, stopped_at, stop_requested_at, stop_reason, stop_error, category, fill_attempts from crm.campaign_prospects where id = $1",
        [id],
      )
    )[0];
  }

  async function run(status: string) {
    const workflow = (await sql<{ id: string }>("insert into crm.workflows (workspace_id, owner_id, name, definition) values ($1, $2, 'Daily prospecting', '{}'::jsonb) returning id", [owner.workspaceId, owner.userId]))[0].id;
    return (
      await sql<{ id: string }>("insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, definition, status) values ($1, $2, $3, '{}'::jsonb, $4) returning id", [
        owner.workspaceId,
        workflow,
        owner.userId,
        status,
      ])
    )[0].id;
  }

  async function context() {
    return (await connectedContext(owner.workspaceId, "smartlead", { fetchImpl })).context;
  }

  before(async () => {
    await resetDatabase();
    for (const name of [...LIMITS, "SITE_URL"]) saved[name] = process.env[name];
    for (const name of LIMITS) process.env[name] = "100000";
    process.env.SITE_URL = "https://orbit.test";
    owner = await createUser("mark@hardening.test", "Mark Ridgeon");
    const second = await createUser("ann@hardening.test", "Ann Member");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    ann = { ...second, workspaceId: owner.workspaceId, role: "member" } as UserActor;
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    campaignId = (
      await sql<{ id: string }>(
        `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at, sync_state)
         values ($1, 'smartlead', 'email', '801', 'Agency outreach', 'active', now(), now(), '{"webhookId": "77"}'::jsonb) returning id`,
        [owner.workspaceId],
      )
    )[0].id;
    otherCampaign = (
      await sql<{ id: string }>(
        `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at)
         values ($1, 'smartlead', 'email', '802', 'Other outreach', 'active', now(), now()) returning id`,
        [owner.workspaceId],
      )
    )[0].id;
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  useServerlessPool();

  it("runs its migration twice", async () => {
    await reapplyMigrationsFrom("20270213100000_campaign_hardening.sql");
    await reapplyMigrationsFrom("20270213100000_campaign_hardening.sql");
  });

  it("looks up a lead with no id before stopping, pausing or resuming, and confirms a stop for a lead the provider doesn't have", async () => {
    state.found.add("ada@stop.test");
    state.found.add("cy@stop.test");
    const ada = await prospect({ email: "ada@stop.test" });
    const bo = await prospect({ email: "bo@stop.test" });
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'removed' where id = any($1::uuid[])", [[ada, bo]]);
    await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('leadsAt', (now() - interval '1 hour')::text) where id = $1", [campaignId]);
    const before = state.writes.length;
    assert.equal(await processStops(owner.workspaceId, smartleadProvider, await context()), 1);
    const adaRow = await row(ada);
    assert.equal(adaRow.external_lead_id, "sl-ada@stop.test", "the id found is kept");
    assert.ok(adaRow.stopped_at);
    assert.ok(state.writes.slice(before).some((write) => write.method === "DELETE" && write.path === "/campaigns/801/leads/sl-ada%40stop.test"));
    assert.equal((await row(bo)).stopped_at, null, "a lead pushed after the last full lead poll may not be listed yet, so its stop waits");
    await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('leadsAt', (now() + interval '1 second')::text) where id = $1", [campaignId]);
    assert.equal(await processStops(owner.workspaceId, smartleadProvider, await context()), 1);
    assert.ok((await row(bo)).stopped_at, "once a full poll has passed, a lead Smartlead doesn't have is stopped in Orbit, never left Stopping");
    assert.ok(!state.writes.slice(before).some((write) => write.path.includes("bo%40stop.test")));

    const cy = await prospect({ email: "cy@stop.test" });
    await setProspectPaused(owner, cy, true, { fetchImpl });
    assert.ok(state.writes.some((write) => write.path === "/campaigns/801/leads/sl-cy%40stop.test/pause"));
    const missing = await prospect({ email: "di@stop.test" });
    await assert.rejects(setProspectPaused(owner, missing, true, { fetchImpl }), refused("conflict", /^Smartlead doesn't have this person in the campaign\.$/));
  });

  it("stops a HeyReach lead with no id by its profile, never by a lookup, and only a 404 means it's gone", async () => {
    await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    const linkedinCampaign = (
      await sql<{ id: string }>(
        `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at)
         values ($1, 'heyreach', 'linkedin', '901', 'Agency founders', 'active', now(), now()) returning id`,
        [owner.workspaceId],
      )
    )[0].id;
    const hrContext = (await connectedContext(owner.workspaceId, "heyreach", { fetchImpl })).context;
    const ann = await prospect({ campaign: linkedinCampaign, linkedin: "linkedin.com/in/hr-ann" });
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'replied' where id = $1", [ann]);
    const before = hr.calls.length;
    await processStops(owner.workspaceId, heyReachProvider, hrContext);
    const calls = hr.calls.slice(before);
    assert.ok(calls.some((call) => call.path === "/campaign/StopLeadInCampaign" && call.body?.leadUrl === "https://www.linkedin.com/in/hr-ann"));
    assert.ok(!calls.some((call) => call.path === "/lead/GetLead"), "HeyReach stops by profile without looking the lead up");
    assert.ok((await row(ann)).stopped_at);

    const down = await prospect({ campaign: linkedinCampaign, linkedin: "linkedin.com/in/hr-down" });
    const gone = await prospect({ campaign: linkedinCampaign, linkedin: "linkedin.com/in/hr-gone", lead: "hr-gone-id" });
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'removed' where id = any($1::uuid[])", [[down, gone]]);
    hr.fail = (path) => (path === "/campaign/StopLeadInCampaign" ? new Response("{}", { status: 500 }) : null);
    await processStops(owner.workspaceId, heyReachProvider, hrContext);
    assert.equal((await row(down)).stopped_at, null, "a failing HeyReach keeps the stop pending");
    hr.fail = (path) => (path === "/campaign/StopLeadInCampaign" ? new Response("{}", { status: 404 }) : null);
    await processStops(owner.workspaceId, heyReachProvider, hrContext);
    assert.ok((await row(gone)).stopped_at, "a 404 for a lead HeyReach gave an id confirms the stop");
    assert.equal((await row(down)).stopped_at, null, "a 404 for a lead with no id may only mean HeyReach hasn't listed it yet, so the stop waits");
    await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('leadsAt', (now() + interval '1 second')::text) where id = $1", [linkedinCampaign]);
    await processStops(owner.workspaceId, heyReachProvider, hrContext);
    assert.ok((await row(down)).stopped_at, "once a full lead poll has passed since the push, the 404 confirms it");
    hr.fail = undefined;
    await sql("update crm.campaigns set status = 'archived' where id = $1", [linkedinCampaign]);
  });

  it("treats a Smartlead lookup as absent only on a 404 or an empty answer", async () => {
    const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    assert.equal(await findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(404, { message: "Not found" }) }), null);
    assert.equal(await findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(200, []) }), null);
    assert.equal(await findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(200, {}) }), null);
    assert.deepEqual(await findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(200, [{ id: 9, lead_campaign_data: [{ campaign_id: 801 }] }]) }), { id: "9" });
    assert.equal(await findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(200, { id: 9, lead_campaign_data: [{ campaign_id: 7 }] }) }), null, "in another campaign only");
    for (const odd of [{ unexpected: true }, { id: 9 }, [{ email: "x@shape.test" }], "text"]) {
      await assert.rejects(findSmartleadLead(SL_A, "801", "x@shape.test", { fetchImpl: answer(200, odd) }), (error: unknown) => error instanceof SmartleadError && error.message === UNREADABLE);
    }
  });

  it("records an endpoint's 401 or 403 where it belongs and never marks the key as rejected", async () => {
    const eve = await prospect({ email: "eve@refused.test", lead: "lead-eve" });
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'replied' where id = $1", [eve]);
    state.refuse = /\/leads\/lead-eve\/pause$/;
    await processStops(owner.workspaceId, smartleadProvider, await context());
    const eveRow = await row(eve);
    assert.equal(eveRow.stopped_at, null);
    assert.equal(eveRow.stop_error, "Couldn't stop at Smartlead. Smartlead refused this request (403).", "the row says why it's still stopping");
    const pending = async () => (await sql<{ prospect_id: string }>("select prospect_id from private.campaign_stops_due($1, 'smartlead', 500)", [owner.workspaceId])).map((item) => item.prospect_id);
    assert.ok(!(await pending()).includes(eve), "a refused stop waits an hour before it's tried again");
    await sql("update crm.campaign_prospects set stop_tried_at = now() - interval '61 minutes' where id = $1", [eve]);
    assert.ok((await pending()).includes(eve));

    state.refuse = /leads-statistics|\/webhooks$/;
    await sql("update crm.campaigns set sync_state = sync_state - 'webhookId' where id = $1", [campaignId]);
    await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents: handleCampaignEvents });
    const campaign = (await sql<{ sync_error: string | null; failed: string | null }>("select sync_error, sync_state->>'webhookFailedAt' as failed from crm.campaigns where id = $1", [campaignId]))[0];
    assert.equal(campaign.sync_error, "Smartlead refused this request (403).");
    assert.ok(campaign.failed, "the webhook refusal is kept on the campaign");
    const connection = (await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId]))[0];
    assert.equal(connection.last_error, null);

    state.refuse = /^GET \/campaigns$/;
    state.refuseStatus = 401;
    await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
    const rejected = (await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId]))[0];
    assert.equal(rejected.last_error, "Smartlead rejected the key. Save a new one.", "a refused campaign list is a rejected key");
    state.refuse = null;
    state.refuseStatus = 403;
    await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
    await sql("update crm.campaign_prospects set stopped_at = now() where id = $1", [eve]);
  });

  it("ends a stopped person as skipped when a push is retried, and never pushes them", async () => {
    const reasons: [string, string][] = [
      ["removed", "Removed"],
      ["suppressed", "Do not contact"],
      ["replied", "Already replied"],
    ];
    for (const [reason, line] of reasons) {
      const contact = await person("Push", `push-${reason}@retry.test`);
      const id = await prospect({ email: `push-${reason}@retry.test`, contact, state: "pushing" });
      await sql("update crm.campaign_prospects set claimed_by = 'fill:retry', claimed_at = now(), stop_requested_at = now(), stop_reason = $2 where id = $1", [id, reason]);
      const begun = await sql<{ ok: boolean; reason: string | null }>("select ok, reason from private.campaign_push_begin($1, $2, 'fill:retry')", [owner.workspaceId, id]);
      assert.deepEqual(begun, [{ ok: false, reason: line }]);
      const after = await row(id);
      assert.deepEqual([after.state, after.skip_reason, after.stop_requested_at], ["skipped", line, null]);
    }
  });

  it("never pushes for a run that was stopped or failed, and settles its half-pushed rows by looking them up", async () => {
    const stopped = await run("cancelled");
    const contact = await person("Run", "run-filling@stop.test");
    const filling = await prospect({ email: "run-filling@stop.test", contact, state: "filling" });
    await sql("update crm.campaign_prospects set added_by_run_id = $2, claimed_by = $3, claimed_at = now() where id = $1", [filling, stopped, `run:${stopped}`]);
    const begun = await sql<{ ok: boolean; reason: string | null }>("select ok, reason from private.campaign_push_begin($1, $2, $3)", [owner.workspaceId, filling, `run:${stopped}`]);
    assert.deepEqual(begun, [{ ok: false, reason: "The workflow run was stopped." }]);
    assert.equal((await row(filling)).state, "failed");

    state.found.add("run-landed@stop.test");
    const landed = await prospect({ email: "run-landed@stop.test", state: "pushing" });
    const lost = await prospect({ email: "run-lost@stop.test", state: "pushing" });
    const failedRun = await run("failed");
    const queued = await prospect({ email: "run-queued@stop.test", state: "queued" });
    await sql("update crm.campaign_prospects set added_by_run_id = $2, claimed_at = now() - interval '11 minutes' where id = any($1::uuid[])", [[landed, lost], stopped]);
    await sql("update crm.campaign_prospects set added_by_run_id = $2 where id = $1", [queued, failedRun]);
    const pushesBefore = state.writes.filter((write) => write.path === "/campaigns/801/leads").length;
    for (let round = 0; round < 3; round += 1) {
      const batch = await claimFillBatch();
      if (!batch) break;
      await runFillBatch(batch, { deadline: Date.now() + 300_000, fetchImpl });
    }
    assert.deepEqual([(await row(landed)).state, (await row(landed)).external_lead_id], ["pushed", "sl-run-landed@stop.test"]);
    assert.deepEqual([(await row(lost)).state, (await row(lost)).skip_reason], ["failed", "The workflow run was stopped."]);
    assert.deepEqual([(await row(queued)).state, (await row(queued)).skip_reason], ["failed", "The workflow run failed."]);
    assert.equal(state.writes.filter((write) => write.path === "/campaigns/801/leads").length, pushesBefore, "nothing is pushed for an ended run");
    assert.equal(state.llm, 0, "and nothing is filled");
  });

  it("lets the run that added a person claim them again during a backoff, and nobody else", async () => {
    const live = await run("waiting");
    const id = await prospect({ email: "backoff@run.test", state: "filling" });
    await sql("update crm.campaign_prospects set added_by_run_id = $2, claimed_by = null, claimed_at = now() + interval '20 minutes' where id = $1", [id, live]);
    const other = await sql<{ claimed: boolean }>("select claimed from private.campaign_claim_fill($1, $2, 'fill:someone')", [owner.workspaceId, id]);
    assert.deepEqual(other, [{ claimed: false }]);
    const mine = await sql<{ claimed: boolean }>("select claimed from private.campaign_claim_fill($1, $2, $3)", [owner.workspaceId, id, `run:${live}`]);
    assert.deepEqual(mine, [{ claimed: true }]);
    await sql("update crm.workflow_runs set status = 'failed' where id = $1", [live]);
    const gaveUp = await sql<{ state: string | null }>("select private.campaign_run_gave_up($1, $2, $3, 'Couldn''t add this person. Try again.') as state", [owner.workspaceId, id, live]);
    assert.deepEqual(gaveUp, [{ state: "failed" }], "an item that fails ends its prospect, so no worker adds them later without the run's research");
  });

  it("doesn't start a fill without time for a web fill, and costs no attempt", async () => {
    const contact = await person("Late", "late@tick.test");
    const id = (await addProspects(owner, otherCampaign, [contact], { operation: "test" })).prospects[0].prospectId;
    const batch = await claimFillBatch();
    assert.ok(batch);
    await runFillBatch(batch, { deadline: Date.now() + 60_000, fetchImpl });
    const after = await row(id);
    assert.deepEqual([after.state, after.fill_attempts], ["filling", 0]);
    assert.equal(state.llm, 0);
    await sql("update crm.campaign_prospects set state = 'skipped', skip_reason = 'test', claimed_by = null where id = $1", [id]);
  });

  it("clears a category at Smartlead, refuses when Smartlead won't, and sync never writes it back", async () => {
    const id = await prospect({ email: "cat@clear.test", lead: "lead-cat" });
    await setProspectCategory(owner, id, "Interested", { fetchImpl });
    await setProspectCategory(owner, id, null, { fetchImpl });
    const cleared = state.writes.filter((write) => write.path === "/campaigns/801/leads/lead-cat/category");
    assert.deepEqual(cleared[cleared.length - 1].body, { category_id: null, pause_lead: false });
    assert.equal((await row(id)).category, null);
    const stale = smartleadEvents("801", [
      { leadId: "lead-cat", email: "cat@clear.test", name: "Cat Clear", category: "Interested", step: 1, variant: null, sentAt: T0, openedAt: T0, clickedAt: null, repliedAt: null, bounced: false, unsubscribed: false },
    ]);
    await saveProviderEvents(campaignId, stale, true);
    assert.equal((await row(id)).category, null, "an old category in Smartlead's statistics doesn't come back");

    await setProspectCategory(owner, id, "Interested", { fetchImpl });
    state.refuse = /lead-cat\/category$/;
    state.refuseStatus = 400;
    await assert.rejects(setProspectCategory(owner, id, null, { fetchImpl }), refused("conflict", /^Smartlead wouldn't clear the category\. Set another one instead\.$/));
    assert.equal((await row(id)).category, "Interested");
    state.refuse = null;
    state.refuseStatus = 403;
  });

  it("notifies the person who added a prospect only while they're a member, and never a sender who left", async () => {
    assert.deepEqual(await replyRecipients({ workspaceId: owner.workspaceId, addedBy: ann.userId, senderUser: null, channel: "email" }), [ann.userId]);
    const gone = await createUser("gone@hardening.test", "Gone Person");
    assert.deepEqual(await replyRecipients({ workspaceId: owner.workspaceId, addedBy: gone.userId, senderUser: gone.userId, channel: "linkedin" }), [owner.userId]);
  });

  it("refuses a Smartlead account key and keeps only the stored client's campaigns", async () => {
    await assert.rejects(saveCampaignConnection(owner, "smartlead", SL_MIXED, { fetchImpl }), refused("invalid_input", /^Use the client's key, not the account key\.$/));
    await assert.rejects(smartleadProvider.listCampaigns({ key: SL_MIXED, workspaceId: owner.workspaceId, fetchImpl }), (error: unknown) => error instanceof SmartleadError && error.message === ACCOUNT_KEY);
    const kept = await smartleadProvider.listCampaigns({ key: SL_MIXED, workspaceId: owner.workspaceId, fetchImpl, details: { clientId: "1" } });
    assert.deepEqual(kept.map((item) => item.externalId), ["1"]);
  });

  it("stops the kept person's campaigns when either merged contact was on Do not contact or had replied", async () => {
    const keep = await person("Kept", "kept@merge.test");
    const merged = await person("Merged", "merged@merge.test");
    const running = await prospect({ email: "kept@merge.test", contact: keep });
    const duplicate = await prospect({ email: "merged@merge.test", contact: merged, lead: "lead-merged-dup" });
    const waiting = await prospect({ campaign: otherCampaign, email: "kept@merge.test", contact: keep, state: "queued" });
    await sql("insert into crm.suppressions (workspace_id, contact_id, kind, value, reason, source) values ($1, $2, 'email', 'merged@merge.test', 'manual', 'test')", [owner.workspaceId, merged]);
    await mergeContacts(owner, keep, merged, { operation: "test" });
    assert.deepEqual([(await row(running)).stop_reason, Boolean((await row(running)).stop_requested_at)], ["suppressed", true]);
    const detached = await sql<{ contact_id: string | null; stop_reason: string | null; external_lead_id: string | null }>(
      "select contact_id, stop_reason, external_lead_id from crm.campaign_prospects where id = $1",
      [duplicate],
    );
    assert.deepEqual(detached, [{ contact_id: null, stop_reason: "suppressed", external_lead_id: "lead-merged-dup" }], "the merged contact's live lead is stopped at the provider, not deleted and left running");
    assert.deepEqual([(await row(waiting)).state, (await row(waiting)).skip_reason], ["skipped", "Do not contact"]);

    const keepTwo = await person("Kept", "kept2@merge.test");
    const repliedTwo = await person("Replied", "replied2@merge.test");
    const runningTwo = await prospect({ email: "kept2@merge.test", contact: keepTwo });
    await prospect({ campaign: otherCampaign, email: "replied2@merge.test", contact: repliedTwo });
    await sql("update crm.campaign_prospects set replied_at = now() where contact_id = $1", [repliedTwo]);
    await mergeContacts(owner, keepTwo, repliedTwo, { operation: "test" });
    assert.equal((await row(runningTwo)).stop_reason, "replied");
  });

  it("links suppressions stored by value to the contact they belong to", async () => {
    await sql("insert into crm.suppressions (workspace_id, kind, value, reason, source) values ($1, 'email', 'byvalue@link.test', 'unsubscribed', 'smartlead')", [owner.workspaceId]);
    const later = await person("By", "byvalue@link.test");
    await prospect({ email: "byvalue@link.test", contact: later });
    const linked = await sql<{ contact_id: string | null }>("select contact_id from crm.suppressions where value = 'byvalue@link.test'");
    assert.deepEqual(linked, [{ contact_id: later }]);
    const known = await person("Known", "known@link.test");
    await sql("insert into crm.suppressions (workspace_id, kind, value, reason, source) values ($1, 'email', 'known@link.test', 'manual', 'test')", [owner.workspaceId]);
    assert.deepEqual(await sql("select contact_id from crm.suppressions where value = 'known@link.test'"), [{ contact_id: known }]);
  });

  it("refuses an agent's campaign reply to someone on Do not contact, while the web thread only warns", async () => {
    const contact = await person("Dee", "dee@dnc.test");
    const id = await prospect({ email: "dee@dnc.test", contact, lead: "lead-dee" });
    await sql(
      `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, stats_id, external_id)
       values ($1, $2, $3, 'email', 'inbound', 'Tell me more.', now(), 'stats-dee', 'm-dee')`,
      [owner.workspaceId, campaignId, id],
    );
    await setDoNotContact(owner, { contactId: contact }, { fetchImpl });
    await sql("update crm.campaign_prospects set stopped_at = null, stop_requested_at = null where id = $1", [id]);
    const line = /^Couldn't send\. Dee Test is on the do not contact list\.$/;
    const before = state.writes.filter((write) => write.path === "/campaigns/801/reply-email-thread").length;
    await assert.rejects(replyInCampaign(owner, { prospectId: id, text: "Thanks Dee." }, { fetchImpl, provenance: { operation: "test", source: "assistant" } }), refused("suppressed", line));
    await assert.rejects(replyInCampaign(owner, { contactId: contact, channel: "email", text: "Thanks Dee." }, { fetchImpl, provenance: { operation: "test", source: "assistant" } }), refused("suppressed", line));
    for (const target of [{ prospectId: id }, { contactId: contact, channel: "email" }]) {
      await assert.rejects(runCampaignAction(owner, { action: "reply", ...target, text: "Thanks Dee." }, { fetchImpl, provenance: { operation: "test", source: "assistant" }, allowReply: true }), refused("suppressed", line));
      const names = await campaignActionNames(owner, { action: "reply", ...target });
      assert.match(names["reply:refused"] ?? "", line, "the assistant's card says why before it's approved");
    }
    const client = await mcp(owner);
    try {
      for (const args of [{ prospect_id: id }, { contact_id: contact, channel: "email" }]) {
        const result = await client.call("campaign_reply", { ...args, text: "Thanks Dee." });
        assert.equal(result.error, true);
        assert.match(result.text, /^suppressed: Couldn't send\. Dee Test is on the do not contact list\.$/);
      }
    } finally {
      await client.close();
    }
    assert.equal(state.writes.filter((write) => write.path === "/campaigns/801/reply-email-thread").length, before, "nothing was sent by an agent");
    const sent = await replyToProspect(owner, id, { text: "Thanks Dee.", clientKey: "web-dee-1" }, { fetchImpl });
    assert.equal(sent.sendState, "sent");
  });

  it("turns an unsubscribed or bounced lead status into one event and one suppression", async () => {
    const leads = [{ externalId: "lead-uns", email: "uns@status.test", linkedin: null, lead: {}, leadStatus: "unsubscribed" as const, category: null, addedAt: T0 }];
    await saveProviderLeads(campaignId, leads, false);
    await saveProviderLeads(campaignId, leads, false);
    const events = await sql<{ kind: string }>("select e.kind from crm.campaign_events e join crm.campaign_prospects p on p.id = e.prospect_id where p.external_lead_id = 'lead-uns'");
    assert.deepEqual(events, [{ kind: "unsubscribed" }]);
    assert.deepEqual(await sql("select reason from crm.suppressions where value = 'uns@status.test'"), [{ reason: "unsubscribed" }]);
    await saveProviderEvents(
      campaignId,
      smartleadEvents("801", [{ leadId: "lead-uns", email: "uns@status.test", name: "Uns", category: null, step: 2, variant: null, sentAt: T0, openedAt: null, clickedAt: null, repliedAt: null, bounced: false, unsubscribed: true }]),
      true,
    );
    assert.equal((await sql("select 1 from crm.campaign_events e join crm.campaign_prospects p on p.id = e.prospect_id where p.external_lead_id = 'lead-uns' and e.kind = 'unsubscribed'")).length, 1, "statistics don't add a second one");
  });

  it("takes a lifted address off Smartlead's block list, and skips without a fill while it can't", async () => {
    const lia = await person("Lia", "lia@lift.test");
    await sql("insert into crm.suppressions (workspace_id, contact_id, kind, value, reason, source, blocked_at) values ($1, $2, 'email', 'lia@lift.test', 'manual', 'web', now())", [owner.workspaceId, lia]);
    state.blockList = [{ id: 55, email_or_domain: "lia@lift.test" }];
    await liftDoNotContact(owner, { contactId: lia }, { fetchImpl });
    assert.deepEqual(state.blockList, []);
    assert.equal((await sql("select 1 from crm.campaign_block_lifts where value = 'lia@lift.test'")).length, 0);

    const max = await person("Max", "max@lift.test");
    await sql("insert into crm.suppressions (workspace_id, contact_id, kind, value, reason, source, blocked_at) values ($1, $2, 'email', 'max@lift.test', 'manual', 'web', now())", [owner.workspaceId, max]);
    state.refuse = /get-domain-block-list/;
    await liftDoNotContact(owner, { contactId: max }, { fetchImpl });
    state.refuse = null;
    const added = (await addProspects(owner, otherCampaign, [max], { operation: "test" })).prospects[0];
    assert.deepEqual([added.outcome, added.skipReason], ["skipped", "Smartlead's block list still has this address"]);
    assert.equal(state.llm, 0);
    assert.equal((await contactSuppression(owner, max)).blockLine, STILL_BLOCKED, "the contact page says the address is still blocked at Smartlead");

    await sql("update crm.campaign_block_lifts set attempts = 5, last_tried_at = now() where value = 'max@lift.test'");
    const listed = async () => (await sql<{ value: string }>("select value from private.campaign_block_lifts_pending($1, 100)", [owner.workspaceId])).map((item) => item.value);
    assert.ok(!(await listed()).includes("max@lift.test"));
    await sql("update crm.campaign_block_lifts set last_tried_at = now() - interval '25 hours' where value = 'max@lift.test'");
    assert.ok((await listed()).includes("max@lift.test"), "an exhausted removal is tried again daily");
  });

  it("queues the block list removal again when Do not contact is set and lifted twice before Smartlead let go", async () => {
    const nia = await person("Nia", "nia@twice.test");
    await sql("insert into crm.suppressions (workspace_id, contact_id, kind, value, reason, source, blocked_at) values ($1, $2, 'email', 'nia@twice.test', 'manual', 'web', now())", [owner.workspaceId, nia]);
    state.blockList = [{ id: 77, email_or_domain: "nia@twice.test" }];
    state.refuse = /get-domain-block-list/;
    await liftDoNotContact(owner, { contactId: nia }, { fetchImpl });
    state.refuse = null;
    await setDoNotContact(owner, { contactId: nia }, { fetchImpl: async () => new Response("", { status: 503 }) });
    const kept = await sql<{ blocked: boolean }>("select blocked_at is not null as blocked from crm.suppressions where value = 'nia@twice.test'");
    assert.deepEqual(kept, [{ blocked: true }], "the address is still on Smartlead's list, so the row says so");
    await liftDoNotContact(owner, { contactId: nia }, { fetchImpl });
    assert.deepEqual(state.blockList, [], "the second lift still takes it off");
  });

  it("finishes a reply a thread read already confirmed, auditing it once", async () => {
    const id = await prospect({ email: "fin@confirmed.test", lead: "lead-fin" });
    const message = (
      await sql<{ id: string }>(
        `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, send_state, confirmed_at, client_key, sent_by_user_id)
         values ($1, $2, $3, 'email', 'outbound', 'Thanks.', now(), 'sent', now(), 'confirmed-fin', $4) returning id`,
        [owner.workspaceId, campaignId, id, owner.userId],
      )
    )[0].id;
    const audit = auditJson(owner, "campaign.reply_sent", "campaign_prospect", id, { operation: "test", source: "web" }, { campaignId });
    for (let round = 0; round < 2; round += 1) {
      const finished = await sql<{ done: boolean }>("select private.campaign_reply_finish($1, $2, 'sent', null, null, $3::jsonb) as done", [owner.workspaceId, message, audit]);
      assert.deepEqual(finished, [{ done: true }]);
    }
    assert.equal((await sql("select 1 from crm.audit_events where event_type = 'campaign.reply_sent' and entity_id = $1", [id])).length, 1);
    const unknown = (
      await sql<{ id: string }>(
        `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, send_state, client_key, sent_by_user_id)
         values ($1, $2, $3, 'email', 'outbound', 'Later.', now(), 'unknown', 'unknown-fin', $4) returning id`,
        [owner.workspaceId, campaignId, id, owner.userId],
      )
    )[0].id;
    await sql("select private.campaign_reply_finish($1, $2, 'sent', 'msg-1', null, $3::jsonb)", [owner.workspaceId, unknown, audit]);
    assert.deepEqual(await sql("select send_state from crm.campaign_messages where id = $1", [unknown]), [{ send_state: "sent" }]);
  });

  it("never takes a category from the lead list for a person Orbit already has", async () => {
    const id = await prospect({ email: "list@category.test", lead: "lead-list-cat" });
    await saveProviderLeads(campaignId, [
      { externalId: "lead-list-cat", email: "list@category.test", linkedin: null, lead: {}, leadStatus: "in_progress", category: "Interested", addedAt: T0 },
      { externalId: "lead-list-new", email: "new@category.test", linkedin: null, lead: {}, leadStatus: "in_progress", category: "Interested", addedAt: T0 },
    ]);
    assert.equal((await row(id)).category, null);
    assert.deepEqual(await sql("select category from crm.campaign_prospects where external_lead_id = 'lead-list-new'"), [{ category: "Interested" }], "a new prospect still starts with it");
  });

  it("keeps the unread reply note until a read succeeds, and files replies a later read saves", async () => {
    const campaign = { id: campaignId, workspaceId: owner.workspaceId, provider: "smartlead" as const, externalId: "801", name: "Agency outreach" };
    const contact = await person("Late", "late@reply.test");
    const id = await prospect({ email: "late@reply.test", contact, lead: "lead-late" });
    const event = (
      await sql<{ id: string }>(
        "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key) values ($1, $2, $3::uuid, 'replied', now(), 'test:late:replied') returning id",
        [owner.workspaceId, campaignId, id],
      )
    )[0].id;
    state.refuse = /lead-late\/message-history$/;
    await handleCampaignEvents(campaign, [{ eventId: event, prospectId: id, contactId: contact, kind: "replied", occurredAt: new Date().toISOString() }], owner, await context());
    state.refuse = null;
    const note = async () => (await sql<{ note: string | null }>("select private.campaign_unread_note($1) as note", [campaignId]))[0].note;
    assert.match((await note()) ?? "", /^Couldn't read Late Test's reply from Smartlead\./);
    await sql("update crm.campaigns set sync_error = null where id = $1", [campaignId]);
    assert.match((await note()) ?? "", /^Couldn't read Late Test's reply/, "the note survives the next sync until the thread is read");
    await saveThread(
      id,
      [
        {
          externalId: "m-late-1",
          direction: "inbound",
          step: 1,
          subject: "Re: Hello",
          body: "Yes, let's talk.",
          sentAt: new Date().toISOString(),
          conversationId: null,
          senderId: null,
          statsId: "stats-late",
          providerMessageId: "<late@x>",
          fromAddress: "late@reply.test",
          automatic: false,
          replyKey: null,
        },
      ],
      { replyEvents: false, handled: false, fileFor: owner },
    );
    const filed = await sql<{ title: string }>("select title from crm.activities where contact_id = $1 and metadata ? 'campaignMessageId'", [contact]);
    assert.deepEqual(filed, [{ title: "Reply to Agency outreach" }]);
    await threadFetched(id);
    assert.equal(await note(), null);

    const unread = (line: string, prospectId: string) => sql("select private.campaign_thread_unread($1, $2)", [prospectId, line]);
    const stopped = await prospect({ email: "stopped@note.test", lead: "lead-note-stopped" });
    await unread("Couldn't read Stopped's reply from Smartlead.", stopped);
    assert.match((await note()) ?? "", /Stopped/);
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'replied' where id = $1", [stopped]);
    await sql("select private.campaign_stop_confirmed($1, $2, 'stopped')", [owner.workspaceId, stopped]);
    assert.equal(await note(), null, "a stopped person's note goes");

    const removed = await prospect({ email: "removed@note.test", state: "queued" });
    await unread("Couldn't read Removed's reply from Smartlead.", removed);
    assert.match((await note()) ?? "", /Removed/);
    await removeProspect(owner, removed, { fetchImpl });
    assert.equal(await note(), null, "a removed person's note goes");

    const archived = await prospect({ campaign: otherCampaign, email: "archived@note.test" });
    await unread("Couldn't read Archived's reply from Smartlead.", archived);
    const otherNote = async () => (await sql<{ note: string | null }>("select private.campaign_unread_note($1) as note", [otherCampaign]))[0].note;
    assert.match((await otherNote()) ?? "", /Archived/);
    await sql("select private.campaign_sync_update($1, '{\"status\": \"archived\"}'::jsonb)", [otherCampaign]);
    assert.equal(await otherNote(), null, "an archived campaign's notes go");
    assert.deepEqual(await sql("select thread_error from crm.campaign_prospects where id = $1", [archived]), [{ thread_error: null }]);
    await sql("update crm.campaigns set status = 'active' where id = $1", [otherCampaign]);
  });

  it("keeps the Added to event for the next run when its note can't be filed", async () => {
    const contact = await person("Retry", "retry@added.test");
    const id = await prospect({ email: "retry@added.test", contact });
    const event = (
      await sql<{ id: string }>(
        "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key) values ($1, $2, $3::uuid, 'added', now(), 'orbit:added:' || $3::text) returning id",
        [owner.workspaceId, campaignId, id],
      )
    )[0].id;
    await sql(
      `create or replace function public.refuse_test_activity() returns trigger language plpgsql as $f$
       begin raise exception 'no activities in this test'; end; $f$`,
    );
    await sql("create trigger refuse_test_activity before insert on crm.activities for each row when (new.metadata->>'campaignAddedProspectId' is not null) execute function public.refuse_test_activity()");
    try {
      const campaign = { id: campaignId, workspaceId: owner.workspaceId, provider: "smartlead" as const, externalId: "801", name: "Agency outreach" };
      const outcome = await handleCampaignEvents(campaign, [{ eventId: event, prospectId: id, contactId: contact, kind: "added", occurredAt: new Date().toISOString() }], owner);
      assert.deepEqual(outcome.retry, [event]);
    } finally {
      await sql("drop trigger if exists refuse_test_activity on crm.activities");
      await sql("drop function if exists public.refuse_test_activity()");
    }
  });

  it("files Added to on the timeline from the event when the push stopped before it, and only once", async () => {
    const contact = await person("Add", "added@crash.test");
    const id = await prospect({ email: "added@crash.test", contact });
    const event = (
      await sql<{ id: string }>(
        "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key) values ($1, $2, $3::uuid, 'added', now(), 'orbit:added:' || $3::text) returning id",
        [owner.workspaceId, campaignId, id],
      )
    )[0].id;
    const campaign = { id: campaignId, workspaceId: owner.workspaceId, provider: "smartlead" as const, externalId: "801", name: "Agency outreach" };
    const events = [{ eventId: event, prospectId: id, contactId: contact, kind: "added", occurredAt: new Date().toISOString() }];
    await handleCampaignEvents(campaign, events, owner);
    await handleCampaignEvents(campaign, events, owner);
    const filed = await sql("select title from crm.activities where contact_id = $1 and metadata->>'campaignAddedProspectId' = $2", [contact, id]);
    assert.deepEqual(filed, [{ title: "Added to Agency outreach" }]);
  });

  it("writes each audit row with its change, so a retry never loses or repeats it", async () => {
    const id = await prospect({ email: "audit@retry.test", lead: "lead-audit" });
    await removeProspect(owner, id, { fetchImpl });
    await assert.rejects(removeProspect(owner, id, { fetchImpl }), refused("conflict"));
    assert.equal((await sql("select 1 from crm.audit_events where event_type = 'campaign.prospect_removed' and entity_id = $1", [id])).length, 1);
    const contact = await person("Aud", "aud@retry.test");
    const added = (await addProspects(owner, otherCampaign, [contact], { operation: "test" })).prospects[0];
    await addProspects(owner, otherCampaign, [contact], { operation: "test" });
    const audits = await sql<{ changes: Record<string, unknown> }>("select changes from crm.audit_events where event_type = 'campaign.prospect_added' and entity_id = $1", [added.prospectId]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].changes.contactId, contact);
    await sql("update crm.campaign_prospects set state = 'skipped', skip_reason = 'test', claimed_by = null where id = $1", [added.prospectId]);
  });

  it("handles a reply without its thread when Smartlead refuses the history or keeps failing, and says why", async () => {
    const campaign = { id: campaignId, workspaceId: owner.workspaceId, provider: "smartlead" as const, externalId: "801", name: "Agency outreach" };
    for (const [lead, status, attempts] of [
      ["lead-hist-a", 403, 0],
      ["lead-hist-b", 500, THREAD_TRIES - 1],
    ] as const) {
      const contact = await person("Hist", `${lead}@history.test`);
      const id = await prospect({ email: `${lead}@history.test`, contact, lead });
      const event = (
        await sql<{ id: string }>(
          "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, handle_attempts) values ($1, $2, $3, 'replied', now(), $4, $5) returning id",
          [owner.workspaceId, campaignId, id, `test:${lead}:replied`, attempts],
        )
      )[0].id;
      state.refuse = new RegExp(`${lead}/message-history$`);
      state.refuseStatus = status;
      const outcome = await handleCampaignEvents(campaign, [{ eventId: event, prospectId: id, contactId: contact, kind: "replied", occurredAt: new Date().toISOString() }], owner, await context());
      assert.deepEqual(outcome.retry, [], `${lead} isn't retried forever`);
      assert.match(outcome.syncError ?? "", /^Couldn't read Hist Test's reply from Smartlead\./);
      assert.ok((await sql<{ counted_at: Date | null }>("select counted_at from crm.campaign_events where id = $1", [event]))[0].counted_at);
    }
    state.refuse = null;
    state.refuseStatus = 403;
    const note = (await sql<{ sync_error: string | null }>("select sync_error from crm.campaigns where id = $1", [campaignId]))[0];
    assert.match(note.sync_error ?? "", /^Couldn't read Hist Test's reply from Smartlead\./);
  });

  it("throws on a reply shape Orbit can't read, so no cursor moves past it", async () => {
    const odd: typeof fetch = async () => json({ unexpected: true });
    await assert.rejects(listSmartleadLeads(SL_A, "801", 0, { fetchImpl: odd }), (error: unknown) => error instanceof SmartleadError && error.message === UNREADABLE);
    await assert.rejects(readSmartleadStatistics(SL_A, "801", null, 0, { fetchImpl: odd }), (error: unknown) => error instanceof SmartleadError && error.message === UNREADABLE);
    await assert.rejects(listHeyReachLeads("hr_key_odd_123", "1", 0, { fetchImpl: odd }), /HeyReach sent a reply Orbit couldn't read\./);
  });

  it("archives a campaign the provider no longer has, so its people stop counting as active", async () => {
    const gone = (
      await sql<{ id: string }>(
        "insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at) values ($1, 'smartlead', 'email', '899', 'Deleted', 'active', now(), now()) returning id",
        [owner.workspaceId],
      )
    )[0].id;
    const refusedProbe = (
      await sql<{ id: string }>(
        "insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at) values ($1, 'smartlead', 'email', '898', 'Hidden', 'active', now(), now()) returning id",
        [owner.workspaceId],
      )
    )[0].id;
    state.refuse = /^GET \/campaigns\/898$/;
    await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
    state.refuse = null;
    assert.deepEqual(await sql("select status from crm.campaigns where id = $1", [gone]), [{ status: "archived" }]);
    const probed = await sql<{ status: string; probed: string | null }>("select status, sync_state->>'probedAt' as probed from crm.campaigns where id = $1", [refusedProbe]);
    assert.equal(probed[0].status, "active");
    assert.ok(probed[0].probed, "a refused probe waits a day like any other");
  });

  it("brings back a skipped or failed row the provider lists as live", async () => {
    const id = await prospect({ email: "yan@live.test", state: "failed" });
    await sql("update crm.campaign_prospects set skip_reason = 'Smartlead didn''t take this lead' where id = $1", [id]);
    const removed = await prospect({ email: "rem@live.test", state: "skipped" });
    await sql("update crm.campaign_prospects set skip_reason = 'Removed' where id = $1", [removed]);
    await saveProviderLeads(campaignId, [
      { externalId: "lead-yan", email: "yan@live.test", linkedin: null, lead: {}, leadStatus: "in_progress", category: null, addedAt: T0 },
      { externalId: "lead-rem", email: "rem@live.test", linkedin: null, lead: {}, leadStatus: "in_progress", category: null, addedAt: T0 },
    ]);
    const after = await row(id);
    assert.deepEqual([after.state, after.external_lead_id, after.skip_reason, after.stop_requested_at], ["pushed", "lead-yan", "Smartlead didn't take this lead", null]);
    const back = await row(removed);
    assert.deepEqual([back.state, back.skip_reason, back.stop_reason, Boolean(back.stop_requested_at)], ["pushed", "Removed", "removed", true], "a removed person found live is stopped again");
  });

  it("names the LinkedIn senders on the add card", () => {
    assert.equal(sendsFromLine(["Mark Ridgeon"]), "Sends from Mark Ridgeon's account.");
    assert.equal(sendsFromLine(["Mark Ridgeon", "Jess Cole"]), "Sends from Mark Ridgeon's and Jess Cole's accounts.");
    assert.equal(sendsFromLine(["Ann", "Bob", "Chris"]), "Sends from Ann's, Bob's and Chris' accounts.");
  });
});
