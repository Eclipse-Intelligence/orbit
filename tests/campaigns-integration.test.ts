import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { setCampaignAutoAdd } from "@/lib/campaigns/manage";
import { addProspects } from "@/lib/campaigns/prospects";
import { smartleadEvents } from "@/lib/campaigns/providers";
import { finishedReady, saveProviderEvents, syncCampaigns, type SyncedEvent } from "@/lib/campaigns/sync";
import { ensureWebhookSecret } from "@/lib/campaigns/webhook-urls";
import { handleCampaignWebhook } from "@/lib/campaigns/webhooks";
import { campaignOptions, getCampaign, importCampaignProspect, listCampaignProspects } from "@/lib/crm/campaigns";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { HEYREACH_SINCE_FILTER, heyReachSteps } from "@/lib/heyreach";
import { readSmartleadStats } from "@/lib/smartlead";
import { providerReason } from "@/lib/upstream";
import { withCampaignChannel, withCampaignEvent, type CampaignTrigger } from "@/lib/workflows/campaign-trigger";
import { definitionFromInput, triggerProblem, type Trigger } from "@/lib/workflows/definition";
import { campaignTriggerMatches, LONG_TICK_MS, runWorkflowTick } from "@/lib/workflows/engine";
import { upsertRecord } from "@/lib/workflows/records";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus } from "@/lib/workflows/store";
import { STARTER_TEMPLATES } from "@/lib/workflows/templates";
import { fakeHeyReach, type FakeHeyReachAccount, type FakeHeyReachCampaign } from "./campaigns-fake";
import { createAgent, createUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const KEY = "hr_key_integration_0001";
const OUTSIDER_KEY = "hr_key_integration_0002";
const LIMIT_ENV = "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE";
const ORIGIN = "https://orbit.test";

let owner: UserActor;
let member: UserActor;
let outsider: UserActor;
let savedLimit: string | undefined;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

function refused(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function linkedinCampaign(): FakeHeyReachCampaign {
  return {
    id: 9101,
    name: "Founders LinkedIn",
    status: "IN_PROGRESS",
    accountIds: [1],
    sequence: [
      { actionType: "ConnectionRequest", message: "Hi {FIRST_NAME}" },
      { actionType: "Message", message: "Thanks, {FIRST_NAME}. {opener}", delayInDays: 2 },
    ],
    listId: 77,
    progress: {
      totalUsers: 1815,
      totalUsersInProgress: 35,
      totalUsersPending: 1780,
      totalUsersFinished: 0,
      totalUsersFailed: 0,
      totalUsersManuallyStopped: 0,
      totalUsersExcluded: 0,
    },
    leads: [
      { id: "lead-amy", profileUrl: "https://www.linkedin.com/in/amy-able/", first: "Amy", last: "Able", company: "Able Ltd", accountId: 1, connection: "ConnectionSent", lastActionTime: minutesAgo(600) },
      { id: "lead-old", profileUrl: "https://www.linkedin.com/in/old-oscar/", first: "Old", last: "Oscar", company: "Oscar Ltd", accountId: 1, status: "Finished", connection: "ConnectionAccepted", lastActionTime: minutesAgo(600) },
    ],
    listLeads: [
      { profileUrl: "https://www.linkedin.com/in/amy-able", firstName: "Amy", lastName: "Able", companyName: "Able Ltd" },
      { profileUrl: "https://www.linkedin.com/in/old-oscar", firstName: "Old", lastName: "Oscar", companyName: "Oscar Ltd" },
      { profileUrl: "https://www.linkedin.com/in/cara-cole", firstName: "Cara", lastName: "Cole", companyName: "Cole Ltd", position: "Founder" },
    ],
    overall: { connectionsSent: 2, connectionsAccepted: 1, messagesSent: 0, totalMessageReplies: 0 },
    byDay: {},
  };
}

describe("campaign integration upgrade", () => {
  const eclipse: FakeHeyReachAccount = { key: KEY, accounts: [{ id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@integration.test", profileUrl: "https://www.linkedin.com/in/markr" }], campaigns: [linkedinCampaign()], calls: [] };
  const other: FakeHeyReachAccount = {
    key: OUTSIDER_KEY,
    accounts: [],
    campaigns: [{ ...linkedinCampaign(), id: 9201, name: "Outsider LinkedIn", leads: [], listLeads: [], listId: 78 }],
    calls: [],
  };
  const fetchImpl = fakeHeyReach([eclipse, other]);
  const campaignRow = () => eclipse.campaigns[0];
  let linkedinId: string;
  let emailId: string;

  async function sync(workspaceId = owner.workspaceId) {
    return syncCampaigns({ workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents: handleCampaignEvents });
  }

  async function prospect(campaignId: string, linkedin: string) {
    const rows = await sql<{ id: string; contact_id: string | null; lead_status: string | null; external_lead_id: string | null }>(
      "select id, contact_id, lead_status, external_lead_id from crm.campaign_prospects where campaign_id = $1 and linkedin = $2",
      [campaignId, linkedin],
    );
    return rows;
  }

  async function workflowEvents(kind: string) {
    return sql<{ data: { prospectId: string; step?: number; kind: string } }>(
      "select data from crm.workflow_events where workspace_id = $1 and data->>'kind' = $2 order by created_at",
      [owner.workspaceId, kind],
    );
  }

  before(async () => {
    await resetDatabase();
    savedLimit = process.env[LIMIT_ENV];
    process.env[LIMIT_ENV] = "100000";
    owner = await createUser("mark@integration.test", "Mark Ridgeon");
    const second = await createUser("mo@integration.test", "Mo Member");
    outsider = await createUser("oscar@elsewhere-integration.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    member = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    if (savedLimit === undefined) delete process.env[LIMIT_ENV];
    else process.env[LIMIT_ENV] = savedLimit;
    await getPool().end();
    await getAdminPool().end();
  });

  beforeEach(async () => {
    await sql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:heyreach%'");
  });

  useServerlessPool();

  describe("provider shapes", () => {
    it("reads HeyReach's sequence tree and keeps provider reasons free of keys and personal data", () => {
      const steps = heyReachSteps({
        nodeType: "CONNECTION_REQUEST",
        payload: { messages: ["Hi {FIRST_NAME}"] },
        conditionalNode: { nodeType: "MESSAGE", actionDelay: 2, actionDelayUnit: "DAY", payload: { messages: ["Thanks"] }, unconditionalNode: { nodeType: "END" } },
        unconditionalNode: { nodeType: "END" },
      });
      assert.deepEqual(
        steps.map((step) => [step.step, step.subject, step.body, step.delayDays]),
        [
          [1, "Invite", "Hi {FIRST_NAME}", null],
          [2, "Message", "Thanks", 2],
        ],
      );
      const ab = heyReachSteps({
        nodeType: "VIEW_PROFILE",
        actionDelay: 0,
        actionDelayUnit: "DAY",
        unconditionalNode: {
          nodeType: "CONNECTION_REQUEST",
          actionDelay: 1,
          actionDelayUnit: "DAY",
          payload: { fallbackMessage: "Hi there", messages: ["Hi {FIRST_NAME}, version A", "Hi {FIRST_NAME}, version B"] },
          conditionalNode: { nodeType: "MESSAGE", actionDelay: 1, actionDelayUnit: "DAY", payload: { fallbackMessage: "Thanks", messages: ["Thanks {FIRST_NAME}"] }, unconditionalNode: { nodeType: "END" } },
          unconditionalNode: { nodeType: "END" },
        },
      });
      assert.deepEqual(
        ab.map((step) => [step.step, step.variant, step.subject, step.body]),
        [
          [1, null, "View profile", ""],
          [2, "A", "Invite", "Hi {FIRST_NAME}, version A"],
          [2, "B", "Invite", "Hi {FIRST_NAME}, version B"],
          [3, null, "Message", "Thanks {FIRST_NAME}"],
        ],
      );
      const reason = providerReason(JSON.stringify({ errorMessage: `Lead jane@acme.test (https://www.linkedin.com/in/jane) rejected for api_key=${KEY}` }), [KEY]);
      assert.ok(reason);
      assert.doesNotMatch(reason!, /jane@acme|linkedin\.com\/in\/jane|hr_key/);
      assert.match(reason!, /\[email\]/);
      assert.equal(providerReason("<html>Bad gateway</html>"), null);
    });

    it("maps Smartlead's lead and activity counts under its own names", async () => {
      const stats = await readSmartleadStats("sl_key", "55", {
        fetchImpl: async () =>
          Response.json({
            sent_count: 40,
            unique_sent_count: 30,
            unique_open_count: 12,
            unique_click_count: 3,
            reply_count: 4,
            bounce_count: 1,
            unsubscribed_count: 2,
            campaign_lead_stats: { total: 100, notStarted: 70, inprogress: 25, completed: 3, blocked: 1, paused: 1, stopped: 0, interested: 2 },
          }),
      });
      assert.deepEqual(
        { leads: stats.leads, notStarted: stats.notStarted, inProgress: stats.inProgress, finished: stats.finished, blocked: stats.blocked, pausedLeads: stats.pausedLeads, stopped: stats.stopped },
        { leads: 100, notStarted: 70, inProgress: 25, finished: 3, blocked: 1, pausedLeads: 1, stopped: 0 },
      );
      assert.equal(stats.contacted, 30);
      assert.equal(stats.positive, 2);
    });
  });

  describe("HeyReach counts and the whole lead list", () => {
    it("backfills HeyReach's own counts, lists not enrolled leads once, and fires nothing", async () => {
      await saveCampaignConnection(owner, "heyreach", KEY, { fetchImpl });
      await saveCampaignConnection(outsider, "heyreach", OUTSIDER_KEY, { fetchImpl });
      await sync();
      await sync();
      const rows = await sql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and external_id = '9101'", [owner.workspaceId]);
      linkedinId = rows[0].id;
      const campaign = await getCampaign(member, linkedinId);
      assert.equal(campaign.stats.leads, 1815);
      assert.equal(campaign.stats.enrolled, 35);
      assert.equal(campaign.stats.notEnrolled, 1780);
      assert.equal(campaign.stats.finished, 0);
      assert.equal(campaign.stats.excluded, 0);
      assert.equal(campaign.stats.accepted, 1);
      assert.equal(campaign.sequence.length, 2);
      assert.deepEqual(campaign.variables, ["FIRST_NAME", "opener"]);
      assert.deepEqual(campaign.briefs.map((item) => item.name), ["opener"]);
      const page = await listCampaignProspects(member, linkedinId);
      assert.deepEqual(page.rows.map((row) => row.name).sort(), ["Amy Able", "Cara Cole", "Old Oscar"]);
      assert.equal(page.rows.find((row) => row.name === "Cara Cole")?.notEnrolled, true);
      assert.equal(page.rows.find((row) => row.name === "Amy Able")?.notEnrolled, false);
      assert.equal((await prospect(linkedinId, "linkedin.com/in/amy-able")).length, 1, "a lead in both lists is one prospect");
      assert.equal((await workflowEvents("finished")).length, 0, "backfill fires nothing");
      const finished = await sql("select 1 from crm.campaign_events where campaign_id = $1 and kind = 'finished' and handled_at is not null", [linkedinId]);
      assert.equal(finished.length, 1, "the lead that finished before backfill is recorded as handled");
      const since = eclipse.calls.filter((call) => call.path === "/campaign/GetLeadsFromCampaign" && call.body?.timeFilter !== undefined);
      assert.ok(since.length > 0, "the second sync asks for leads since the last one");
      assert.ok(since.every((call) => call.body?.timeFilter === HEYREACH_SINCE_FILTER));
      assert.equal(campaign.syncError, null);
    });

    it("shows the endpoint and HeyReach's own reason for a 400, and logs no key or personal data", async () => {
      eclipse.fail = (path) =>
        path === "/stats/GetOverallStats" ? Response.json({ errorMessage: `Invalid campaignIds for lead jane@acme.test with key ${KEY}` }, { status: 400 }) : null;
      const logged = mock.method(console, "error", () => undefined);
      try {
        await sync();
      } finally {
        logged.mock.restore();
        eclipse.fail = undefined;
      }
      const rows = await sql<{ sync_error: string }>("select sync_error from crm.campaigns where id = $1", [linkedinId]);
      assert.match(rows[0].sync_error, /^HeyReach returned an error \(400\) on GetOverallStats: Invalid campaignIds for lead \[email\] with key \[redacted\]\.$/);
      const lines = logged.mock.calls.map((call) => call.arguments.map(String).join(" "));
      const line = lines.find((text) => text.includes("/stats/GetOverallStats"));
      assert.ok(line, lines.join("\n"));
      assert.match(line!, /400/);
      assert.doesNotMatch(lines.join("\n"), /jane@acme|hr_key_integration/);
      await sync();
      assert.equal((await sql<{ sync_error: string | null }>("select sync_error from crm.campaigns where id = $1", [linkedinId]))[0].sync_error, null);
    });
  });

  describe("importing and adding to Orbit", () => {
    it("imports one prospect, and importing again changes nothing", async () => {
      const [cara] = await prospect(linkedinId, "linkedin.com/in/cara-cole");
      const first = await importCampaignProspect(member, cara.id);
      assert.equal(first.created, true);
      const again = await importCampaignProspect(member, cara.id);
      assert.equal(again.contactId, first.contactId);
      const contacts = await sql("select 1 from crm.contacts where workspace_id = $1 and normalized_linkedin = 'linkedin.com/in/cara-cole'", [owner.workspaceId]);
      assert.equal(contacts.length, 1);
      await assert.rejects(importCampaignProspect(outsider, cara.id), refused("not_found"));
    });

    it("lets only people in the workspace change Add to Orbit, and audits it", async () => {
      const agent = (await createAgent(owner.workspaceId, scopesForRole("owner"), "Bot")).actor;
      await assert.rejects(setCampaignAutoAdd(agent, linkedinId, "accepted"), refused("forbidden", /Only people/));
      await assert.rejects(setCampaignAutoAdd(outsider, linkedinId, "accepted"), refused("not_found"));
      await assert.rejects(setCampaignAutoAdd(member, linkedinId, "sometimes"), refused("invalid_input"));
      assert.equal(await setCampaignAutoAdd(member, linkedinId, "accepted"), "accepted");
      assert.equal((await getCampaign(owner, linkedinId)).autoAdd, "accepted");
      const audits = await sql<{ changes: { before: { autoAdd: string }; after: { autoAdd: string } }; actor_user_id: string }>(
        "select changes, actor_user_id from crm.audit_events where workspace_id = $1 and event_type = 'campaign.auto_add_changed'",
        [owner.workspaceId],
      );
      assert.equal(audits.length, 1);
      assert.deepEqual([audits[0].changes.before.autoAdd, audits[0].changes.after.autoAdd, audits[0].actor_user_id], ["off", "accepted", member.userId]);
    });

    it("adds people who accept, links an existing contact instead of duplicating, and never adds backfilled leads", async () => {
      const existing = (
        await createContact(owner, { firstName: "Amy", lastName: "Able", linkedinUrl: "https://www.linkedin.com/in/amy-able" }, { provenance: { operation: "test" } })
      ).body.contact;
      const now = new Date().toISOString();
      const amy = campaignRow().leads.find((lead) => lead.id === "lead-amy")!;
      amy.connection = "ConnectionAccepted";
      amy.lastActionTime = now;
      campaignRow().leads.push({ id: "lead-dan", profileUrl: "https://www.linkedin.com/in/dan-dee/", first: "Dan", last: "Dee", company: "Dee Ltd", accountId: 1, connection: "ConnectionAccepted", lastActionTime: now });
      await sync();
      await sync();
      const contacts = await sql<{ id: string; normalized_linkedin: string; tags: string[] }>(
        "select id, normalized_linkedin, tags from crm.contacts where workspace_id = $1 and normalized_linkedin in ('linkedin.com/in/amy-able', 'linkedin.com/in/dan-dee', 'linkedin.com/in/old-oscar') order by normalized_linkedin",
        [owner.workspaceId],
      );
      assert.deepEqual(
        contacts.map((row) => [row.normalized_linkedin, row.tags]),
        [
          ["linkedin.com/in/amy-able", ["linkedin", "founders linkedin"]],
          ["linkedin.com/in/dan-dee", ["linkedin", "founders linkedin"]],
        ],
      );
      assert.equal((await prospect(linkedinId, "linkedin.com/in/amy-able"))[0].contact_id, existing.id, "matched by LinkedIn profile");
      assert.equal((await prospect(linkedinId, "linkedin.com/in/old-oscar"))[0].contact_id, null, "backfilled acceptances never add anyone");
      const outsiderContacts = await sql("select 1 from crm.contacts where workspace_id = $1", [outsider.workspaceId]);
      assert.equal(outsiderContacts.length, 0);
    });
  });

  describe("Finished", () => {
    it("fires once per prospect, and never for someone who replied", async () => {
      const now = new Date().toISOString();
      const dan = campaignRow().leads.find((lead) => lead.id === "lead-dan")!;
      dan.status = "Finished";
      dan.lastActionTime = now;
      campaignRow().leads.push({ id: "lead-eve", profileUrl: "https://www.linkedin.com/in/eve-ess/", first: "Eve", last: "Ess", accountId: 1, connection: "ConnectionAccepted", status: "InSequence", lastActionTime: now });
      await sync();
      const [eve] = await prospect(linkedinId, "linkedin.com/in/eve-ess");
      await sql("update crm.campaign_prospects set replied_at = now() where id = $1", [eve.id]);
      const lead = campaignRow().leads.find((item) => item.id === "lead-eve")!;
      lead.status = "Finished";
      lead.lastActionTime = new Date().toISOString();
      await sync();
      await sync();
      const fired = await workflowEvents("finished");
      const [danRow] = await prospect(linkedinId, "linkedin.com/in/dan-dee");
      assert.deepEqual(
        fired.map((row) => row.data.prospectId),
        [danRow.id],
      );
    });

    it("fires once for a Smartlead lead that completed", async () => {
      await sql("insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, 'smartlead', 'x', 'integrationfingerprint00')", [owner.workspaceId]);
      const rows = await sql<{ id: string }>(
        `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at)
         values ($1, 'smartlead', 'email', '5501', 'Agency email', 'active', now(), now()) returning id`,
        [owner.workspaceId],
      );
      emailId = rows[0].id;
      const lead = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, email, state, external_lead_id, lead_status, pushed_at)
         values ($1, $2, 'fin@agency.test', 'pushed', 'sl-1', 'completed', now()) returning id`,
        [owner.workspaceId, emailId],
      );
      for (let pass = 0; pass < 2; pass += 1) {
        await sql("select private.campaign_mark_finished($1, false)", [emailId]);
        const waiting = await sql<{ id: string }>("select id from crm.campaign_events where campaign_id = $1 and kind = 'finished' and fired_at is null", [emailId]);
        await sql("select private.campaign_fire_events($1::uuid[])", [waiting.map((row) => row.id)]);
      }
      const fired = (await workflowEvents("finished")).filter((row) => row.data.prospectId === lead[0].id);
      assert.equal(fired.length, 1);
    });
  });

  describe("Reached a step", () => {
    it("records each Smartlead step once per prospect, however often it is read", async () => {
      const sent = { leadId: "sl-1", email: "fin@agency.test", name: "Fin", category: null, variant: null, openedAt: null, clickedAt: null, repliedAt: null, bounced: false, unsubscribed: false };
      const first = smartleadEvents("5501", [{ ...sent, step: 1, sentAt: minutesAgo(60) }]);
      const second = smartleadEvents("5501", [
        { ...sent, step: 1, sentAt: minutesAgo(60) },
        { ...sent, step: 2, sentAt: minutesAgo(5) },
      ]);
      const saved = [...(await saveProviderEvents(emailId, first, false)), ...(await saveProviderEvents(emailId, second, false))];
      assert.deepEqual(saved.map((event) => event.kind), ["sent", "sent"]);
      await sql("select private.campaign_fire_events($1::uuid[])", [saved.map((event) => event.eventId)]);
      await sql("select private.campaign_fire_events($1::uuid[])", [saved.map((event) => event.eventId)]);
      const fired = await workflowEvents("sent");
      assert.deepEqual(fired.map((row) => row.data.step).sort(), [1, 2]);
    });

    it("counts HeyReach messages from webhooks once each, and ignores retries and other workspaces", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const outsiderSecret = (await ensureWebhookSecret(outsider.workspaceId, "heyreach"))!;
      const post = (body: unknown, workspaceId = owner.workspaceId, key = secret) =>
        handleCampaignWebhook(
          new Request(`${ORIGIN}/api/webhooks/heyreach?w=${workspaceId}&secret=${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify(body) }),
          "heyreach",
          { syncAfter: false },
        );
      const message = (at: string) => ({ event_type: "MESSAGE_SENT", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox", first_name: "Fay", last_name: "Fox" }, timestamp: at });
      const shapes = mock.method(console, "info", () => undefined);
      try {
        const firstAt = minutesAgo(120);
        assert.deepEqual(await (await post(message(firstAt))).json(), { saved: 1 });
        assert.deepEqual(await (await post(message(firstAt))).json(), { duplicate: true });
        assert.deepEqual(await (await post(message(minutesAgo(118)))).json(), { saved: 0 }, "a second report of the same send is not a new message");
        assert.deepEqual(await (await post(message(minutesAgo(10)))).json(), { saved: 1 });
        assert.deepEqual(await (await post({ event_type: "CONNECTION_REQUEST_SENT", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: minutesAgo(200) })).json(), { saved: 1 });
        assert.deepEqual(await (await post({ event_type: "CONNECTION_REQUEST_SENT", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: minutesAgo(199) })).json(), { saved: 0 });
        assert.deepEqual(await (await post(message(minutesAgo(1)), outsider.workspaceId, outsiderSecret)).json(), { ignored: true }, "another workspace's campaign id finds nothing");
      } finally {
        shapes.mock.restore();
      }
      const logged = shapes.mock.calls.map((call) => call.arguments.map(String).join(" ")).join("\n");
      assert.match(logged, /event_type=MESSAGE_SENT/);
      assert.doesNotMatch(logged, /fay-fox/);
      const [fay] = await prospect(linkedinId, "linkedin.com/in/fay-fox");
      const events = await sql<{ kind: string; step: number | null }>("select kind, step from crm.campaign_events where prospect_id = $1 order by occurred_at", [fay.id]);
      assert.deepEqual(events.map((event) => [event.kind, event.step]), [
        ["invite_sent", null],
        ["message_sent", 1],
        ["message_sent", 2],
      ]);
      await sync();
      await sync();
      const fired = (await workflowEvents("message_sent")).filter((row) => row.data.prospectId === fay.id);
      assert.deepEqual(fired.map((row) => row.data.step).sort(), [1, 2]);
    });

    it("routes HeyReach webhooks by campaign id, stores one event for two deliveries, and ignores campaigns Orbit doesn't have", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const post = (body: unknown) =>
        handleCampaignWebhook(new Request(`${ORIGIN}/api/webhooks/heyreach?w=${owner.workspaceId}&secret=${encodeURIComponent(secret)}`, { method: "POST", body: JSON.stringify(body) }), "heyreach", { syncAfter: false });
      const viewedAt = minutesAgo(30);
      const viewed = (extra: Record<string, unknown>) => ({ event_type: "VIEWED_PROFILE", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: viewedAt, ...extra });
      const shapes = mock.method(console, "info", () => undefined);
      try {
        assert.deepEqual(await (await post(viewed({ webhook_name: "Orbit viewed profile, all campaigns" }))).json(), { saved: 1 });
        assert.deepEqual(await (await post(viewed({ webhook_name: "Orbit viewed profile 9101" }))).json(), { saved: 0 }, "the same view from a campaign's own webhook isn't stored again");
        assert.deepEqual(await (await post({ ...viewed({}), campaign: undefined, campaignId: "9101", timestamp: minutesAgo(29) })).json(), { saved: 0 }, "campaignId at the top level routes the same way");
        assert.deepEqual(await (await post({ event_type: "VIEWED_PROFILE", campaign: { id: 777777 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: viewedAt })).json(), { ignored: true });
        assert.deepEqual(await (await post({ event_type: "VIEWED_PROFILE", lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: viewedAt })).json(), { ignored: true });
        assert.deepEqual(await (await post({ event_type: "EVERY_MESSAGE_REPLY_RECEIVED", campaign_id: 777777, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, recent_messages: [{ creation_time: viewedAt, message: "Hi" }] })).json(), { ignored: true });
      } finally {
        shapes.mock.restore();
      }
      const logged = shapes.mock.calls.map((call) => call.arguments.map(String).join(" ")).join("\n");
      assert.match(logged, /Campaign webhook ignored: a campaign Orbit doesn't have/);
      assert.match(logged, /Campaign webhook ignored: no campaign id/);
      assert.doesNotMatch(logged.split("\n").filter((line) => line.startsWith("Campaign webhook ignored")).join("\n"), /fay-fox|777777|Hi\b/);
      const [fay] = await prospect(linkedinId, "linkedin.com/in/fay-fox");
      const views = await sql<{ count: number }>("select count(*)::int as count from crm.campaign_events where prospect_id = $1 and kind = 'profile_viewed'", [fay.id]);
      assert.equal(views[0].count, 1);
      assert.equal((await sql("select 1 from crm.campaigns where workspace_id = $1 and external_id = '777777'", [owner.workspaceId])).length, 0);
    });

    it("counts a HeyReach positive auto-tag towards Interested once, sets the category, and stores other tags", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const post = (body: unknown) =>
        handleCampaignWebhook(new Request(`${ORIGIN}/api/webhooks/heyreach?w=${owner.workspaceId}&secret=${encodeURIComponent(secret)}`, { method: "POST", body: JSON.stringify(body) }), "heyreach", { syncAfter: false });
      const tag = (event: string, profile: string, extra: Record<string, unknown> = {}) => ({ event_type: event, campaign: { id: 9101 }, lead: { profile_url: `https://www.linkedin.com/in/${profile}` }, timestamp: minutesAgo(5), ...extra });
      const [fay] = await prospect(linkedinId, "linkedin.com/in/fay-fox");
      await sql("update crm.campaign_prospects set category = null where id = $1", [fay.id]);
      await sql("update crm.campaigns set sync_state = sync_state || '{\"leadStateAt\": \"2026-11-18T00:00:00Z\"}'::jsonb where id = $1", [linkedinId]);
      await sql("update crm.campaign_connections set details = details - 'webhooks' where workspace_id = $1 and provider = 'heyreach'", [owner.workspaceId]);
      assert.equal((await getCampaign(owner, linkedinId)).leadFunnel?.interested, undefined, "Interested stays hidden until the positive auto-tag webhook is registered");
      const shapes = mock.method(console, "info", () => undefined);
      try {
        assert.deepEqual(await (await post(tag("LEAD_AUTO_TAGGED_INTERESTED", "fay-fox"))).json(), { saved: 1 });
        assert.deepEqual(await (await post(tag("LEAD_AUTO_TAGGED_INTERESTED", "fay-fox", { timestamp: minutesAgo(1) }))).json(), { saved: 0 });
        await post(tag("LEAD_TAG_UPDATED", "fay-fox", { tags: [{ name: "Hot" }, "Founder"] }));
        await post(tag("LEAD_AUTO_TAGGED_GENERIC", "fay-fox", { tags: ["Question"] }));
      } finally {
        shapes.mock.restore();
      }
      const row = (await sql<{ category: string | null; state: Record<string, unknown> }>("select category, provider_state as state from crm.campaign_prospects where id = $1", [fay.id]))[0];
      assert.equal(row.category, "Interested");
      assert.ok(row.state.positiveAt);
      assert.deepEqual(row.state.tags, ["Question"]);
      assert.equal(row.state.autoTag, "generic");
      const categories = await sql<{ count: number }>("select count(*)::int as count from crm.campaign_events where prospect_id = $1 and kind = 'category'", [fay.id]);
      assert.equal(categories[0].count, 1);
      await sql(
        "update crm.campaign_connections set details = jsonb_set(details, '{webhooks}', '{\"events\": {\"LEAD_AUTO_TAGGED_INTERESTED\": \"1\"}}'::jsonb) where workspace_id = $1 and provider = 'heyreach'",
        [owner.workspaceId],
      );
      assert.equal((await getCampaign(owner, linkedinId)).leadFunnel?.interested, 1);

      const waiting = await sql<{ id: string }>("select id from crm.campaign_events where prospect_id = $1 and kind = 'category' and fired_at is null", [fay.id]);
      if (waiting.length > 0) await sql("select private.campaign_fire_events($1::uuid[])", [waiting.map((item) => item.id)]);
      const fired = (await workflowEvents("category")).filter((item) => item.data.prospectId === fay.id);
      assert.equal(fired.length, 1);
      assert.equal((fired[0].data as Record<string, unknown>).category, "Interested");
      assert.equal(campaignTriggerMatches({ type: "campaign_event", event: "positive", channel: "linkedin" }, fired[0].data as Record<string, unknown>), true);
    });

    it("saves a HeyReach auto-tag for someone Orbit hasn't seen in the campaign yet", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const shapes = mock.method(console, "info", () => undefined);
      try {
        const response = await handleCampaignWebhook(
          new Request(`${ORIGIN}/api/webhooks/heyreach?w=${owner.workspaceId}&secret=${encodeURIComponent(secret)}`, {
            method: "POST",
            body: JSON.stringify({ event_type: "LEAD_AUTO_TAGGED_INTERESTED", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/gus-new" }, tags: ["Warm"], timestamp: minutesAgo(2) }),
          }),
          "heyreach",
          { syncAfter: false },
        );
        assert.deepEqual(await response.json(), { saved: 1 });
      } finally {
        shapes.mock.restore();
      }
      const [gus] = await prospect(linkedinId, "linkedin.com/in/gus-new");
      const row = (await sql<{ category: string | null; state: Record<string, unknown> }>("select category, provider_state as state from crm.campaign_prospects where id = $1", [gus.id]))[0];
      assert.equal(row.category, "Interested");
      assert.ok(row.state.positiveAt, "the tag lands on the person the event just added");
      assert.deepEqual(row.state.tags, ["Warm"]);
    });

    it("matches the trigger on step, action, count, channel and campaign", () => {
      const email = { kind: "sent", step: 2, channel: "email", campaignId: "c1" };
      const step = (trigger: Partial<Extract<Trigger, { type: "campaign_event" }>>) => ({ type: "campaign_event" as const, event: "step" as const, ...trigger });
      assert.equal(campaignTriggerMatches(step({ channel: "email", step: 2 }), email), true);
      assert.equal(campaignTriggerMatches(step({ channel: "email", step: 1 }), email), false);
      assert.equal(campaignTriggerMatches(step({ channel: "email", step: 2, campaignId: "c2" }), email), false);
      assert.equal(campaignTriggerMatches(step({ channel: "linkedin", action: "message_sent" }), email), false);
      const message = (n: number) => ({ kind: "message_sent", step: n, channel: "linkedin", campaignId: "c1" });
      assert.equal(campaignTriggerMatches(step({ channel: "linkedin", action: "message_sent" }), message(1)), true);
      assert.equal(campaignTriggerMatches(step({ channel: "linkedin", action: "message_sent" }), message(2)), false);
      assert.equal(campaignTriggerMatches(step({ channel: "linkedin", action: "message_sent", nth: 2 }), message(2)), true);
      assert.equal(campaignTriggerMatches(step({ channel: "linkedin", action: "profile_viewed" }), { kind: "profile_viewed", channel: "linkedin" }), true);
      assert.equal(campaignTriggerMatches({ type: "campaign_event", event: "finished", channel: "linkedin" }, { kind: "finished", channel: "linkedin" }), true);
      assert.equal(campaignTriggerMatches({ type: "campaign_event", event: "finished", channel: "email" }, { kind: "finished", channel: "linkedin" }), false);
      const missing = definitionFromInput({ trigger: { type: "campaign_event", event: "step", channel: "email" }, steps: [] });
      assert.deepEqual(missing, { error: "Reached a step needs a step number." });
      for (const key of ["linkedin-finished-then-email", "email-finished-then-linkedin", "linkedin-step-then-email", "email-step-then-linkedin"]) {
        const template = STARTER_TEMPLATES.find((item) => item.key === key);
        assert.ok(template, key);
        assert.ok("definition" in definitionFromInput(template.definition), key);
      }
      assert.equal(STARTER_TEMPLATES.some((item) => item.key === "linkedin-then-email"), false, "the 7-day template is replaced");
    });
  });

  describe("mixing channels", () => {
    it("adds a LinkedIn prospect to an email campaign while LinkedIn keeps running, and a reply stops both", async () => {
      const [fay] = await prospect(linkedinId, "linkedin.com/in/fay-fox");
      const contact = (
        await createContact(owner, { firstName: "Fay", lastName: "Fox", email: "fay@foxco.test", linkedinUrl: "https://www.linkedin.com/in/fay-fox" }, { provenance: { operation: "test" } })
      ).body.contact;
      await sql(
        `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_by_user_id)
         values ($1, 'contact', $2, 'email_check', 'valid', 'enrow', 'fay@foxco.test', $3)`,
        [owner.workspaceId, contact.id, owner.userId],
      );
      await sql("update crm.campaign_prospects set contact_id = $2 where id = $1", [fay.id, contact.id]);
      const added = await addProspects(owner, emailId, [contact.id], { operation: "test", source: "workflow" }, { kick: false });
      assert.equal(added.added, 1, JSON.stringify(added.reasons));
      const linkedinRow = await sql<{ stop_requested_at: Date | null }>("select stop_requested_at from crm.campaign_prospects where id = $1", [fay.id]);
      assert.equal(linkedinRow[0].stop_requested_at, null, "the LinkedIn campaign keeps running");
      const emailProspect = added.prospects[0].prospectId;
      await sql("update crm.campaign_prospects set state = 'pushed', external_lead_id = 'sl-fay', pushed_at = now() where id = $1", [emailProspect]);
      const events = await saveProviderEvents(emailId, smartleadEvents("5501", [{ leadId: "sl-fay", email: "fay@foxco.test", name: "Fay Fox", category: null, step: 1, variant: null, sentAt: minutesAgo(30), openedAt: null, clickedAt: null, repliedAt: minutesAgo(2), bounced: false, unsubscribed: false }]), false);
      const replied: SyncedEvent[] = events.filter((event) => event.kind === "replied");
      assert.equal(replied.length, 1);
      await handleCampaignEvents({ id: emailId, workspaceId: owner.workspaceId, provider: "smartlead", externalId: "5501", name: "Agency email" }, replied, owner);
      const stopped = await sql<{ stop_requested_at: Date | null; stop_reason: string | null }>("select stop_requested_at, stop_reason from crm.campaign_prospects where id = $1", [fay.id]);
      assert.ok(stopped[0].stop_requested_at, "a reply on email stops the LinkedIn campaign");
      assert.equal(stopped[0].stop_reason, "replied");
    });
  });

  describe("round 1 review rules", () => {
    let wfEmailCampaign: string;

    it("never marks Finished after a failed or skipped reply read, and does once the reads succeed", async () => {
      const now = new Date().toISOString();
      campaignRow().leads.push(
        { id: "lead-gus", profileUrl: "https://www.linkedin.com/in/gus-gray/", first: "Gus", last: "Gray", accountId: 1, connection: "ConnectionAccepted", status: "Finished", lastActionTime: now },
        { id: "lead-hal", profileUrl: "https://www.linkedin.com/in/hal-hart/", first: "Hal", last: "Hart", accountId: 1, connection: "ConnectionAccepted", status: "Finished", lastActionTime: now },
      );
      campaignRow().conversations = [
        { id: "conv-gus", accountId: 1, profileUrl: "https://www.linkedin.com/in/gus-gray", leadId: "lead-gus", messages: [{ createdAt: now, body: "Sounds good, call me", sender: "CORRESPONDENT" }] },
      ];
      eclipse.fail = (path) => (path === "/inbox/GetConversationsV2" ? Response.json({ errorMessage: "Inbox unavailable" }, { status: 400 }) : null);
      const logged = mock.method(console, "error", () => undefined);
      try {
        await sync();
      } finally {
        logged.mock.restore();
        eclipse.fail = undefined;
      }
      const [gus] = await prospect(linkedinId, "linkedin.com/in/gus-gray");
      const [hal] = await prospect(linkedinId, "linkedin.com/in/hal-hart");
      assert.equal(gus.lead_status, "completed");
      const finishedFor = async (id: string) => (await sql("select 1 from crm.campaign_events where prospect_id = $1 and kind = 'finished'", [id])).length;
      assert.equal(await finishedFor(gus.id), 0, "a failed reply read never lets Finished through");
      assert.equal(await finishedFor(hal.id), 0, "nothing is marked until both reads complete");
      await sync();
      await sync();
      assert.equal(await finishedFor(gus.id), 0, "someone who replied never finishes");
      assert.equal(await finishedFor(hal.id), 1);
      assert.equal(finishedReady({ handled: false, eventsReadNow: true, repliesReadNow: false }), false);
      assert.equal(finishedReady({ handled: false, eventsReadNow: false, repliesReadNow: true }), false);
      assert.equal(finishedReady({ handled: false, eventsReadNow: true, repliesReadNow: true }), true);
      assert.equal(finishedReady({ handled: true, eventsReadNow: false, repliesReadNow: false }), true, "handled rows never fire, so backfill may mark them");
    });

    it("never marks Finished for someone stopped, removed, or who replied on another row", async () => {
      const contact = (await createContact(owner, { firstName: "Ivy", lastName: "Ink", email: "ivy@inkco.test" }, { provenance: { operation: "test" } })).body.contact;
      const rows = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, state, external_lead_id, lead_status, pushed_at, stop_requested_at, stopped_at)
         values ($1, $2, $3, 'ivy@inkco.test', 'pushed', 'sl-ivy', 'completed', now(), null, null),
                ($1, $2, null, 'stop@inkco.test', 'pushed', 'sl-stop', 'completed', now(), now(), null),
                ($1, $2, null, 'gone@inkco.test', 'pushed', 'sl-gone', 'completed', now(), now(), now())
         returning id`,
        [owner.workspaceId, emailId, contact.id],
      );
      await sql(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, linkedin, state, external_lead_id, pushed_at, replied_at)
         values ($1, $2, $3, 'linkedin.com/in/ivy-ink', 'pushed', 'lead-ivy', now(), now())`,
        [owner.workspaceId, linkedinId, contact.id],
      );
      await sql("select private.campaign_mark_finished($1, false)", [emailId]);
      const finished = await sql("select 1 from crm.campaign_events where prospect_id = any($1::uuid[]) and kind = 'finished'", [rows.map((row) => row.id)]);
      assert.equal(finished.length, 0);
    });

    it("seeds Finished as handled on upgrade for campaigns already backfilled", async () => {
      const lead = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, email, state, external_lead_id, lead_status, pushed_at)
         values ($1, $2, 'early@agency.test', 'pushed', 'sl-early', 'completed', now()) returning id`,
        [owner.workspaceId, emailId],
      );
      const before = (await workflowEvents("finished")).length;
      await reapplyMigrationsFrom("20270216100000_campaign_integration.sql");
      const seeded = await sql<{ handled_at: Date | null; fired_at: Date | null }>("select handled_at, fired_at from crm.campaign_events where prospect_id = $1 and kind = 'finished'", [lead[0].id]);
      assert.equal(seeded.length, 1);
      assert.ok(seeded[0].handled_at && seeded[0].fired_at);
      await sql("select private.campaign_mark_finished($1, false)", [emailId]);
      assert.equal((await workflowEvents("finished")).length, before, "upgrading fires nothing");
    });

    it("stores one prospect and one event when a webhook and a poll for the same person overlap", async () => {
      const client = await getAdminPool().connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`campaign-person:${linkedinId}:linkedin.com/in/kit-kay`]);
        const event = (dedupeKey: string, externalLeadId: string | null) => ({
          externalLeadId,
          email: null,
          linkedin: "linkedin.com/in/kit-kay",
          lead: { firstName: "Kit", lastName: "Kay" },
          kind: "invite_sent" as const,
          step: null,
          variant: null,
          occurredAt: minutesAgo(3),
          dedupeKey,
          category: null,
        });
        const both = Promise.all([
          saveProviderEvents(linkedinId, [event("heyreach:9101:linkedin.com/in/kit-kay:invite_sent", null)], false),
          saveProviderEvents(linkedinId, [event("heyreach:9101:linkedin.com/in/kit-kay:invite_sent:other", null)], false),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await client.query("commit");
        const saved = await both;
        assert.equal(saved.flat().length, 1);
      } finally {
        client.release();
      }
      const rows = await prospect(linkedinId, "linkedin.com/in/kit-kay");
      assert.equal(rows.length, 1, "one prospect");
      const events = await sql("select 1 from crm.campaign_events where prospect_id = $1 and kind = 'invite_sent'", [rows[0].id]);
      assert.equal(events.length, 1, "one event");
    });

    it("keeps a webhook that failed to save open for HeyReach's retry", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const body = JSON.stringify({ event_type: "VIEWED_PROFILE", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/lou-lane" }, timestamp: minutesAgo(4) });
      const post = () =>
        handleCampaignWebhook(new Request(`${ORIGIN}/api/webhooks/heyreach?w=${owner.workspaceId}&secret=${encodeURIComponent(secret)}`, { method: "POST", body }), "heyreach", { syncAfter: false });
      await sql(`create or replace function public.integration_refuse() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end; $$`);
      await sql("create trigger integration_refuse before insert on crm.campaign_events for each row execute function public.integration_refuse()");
      const shapes = mock.method(console, "info", () => undefined);
      try {
        await assert.rejects(post());
      } finally {
        await sql("drop trigger integration_refuse on crm.campaign_events");
      }
      try {
        assert.deepEqual(await (await post()).json(), { saved: 1 });
        assert.deepEqual(await (await post()).json(), { duplicate: true });
      } finally {
        shapes.mock.restore();
      }
    });

    it("drops a late message webhook instead of counting a phantom next step", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const post = (at: string) =>
        handleCampaignWebhook(
          new Request(`${ORIGIN}/api/webhooks/heyreach?w=${owner.workspaceId}&secret=${encodeURIComponent(secret)}`, {
            method: "POST",
            body: JSON.stringify({ event_type: "MESSAGE_SENT", campaign: { id: 9101 }, lead: { profile_url: "https://www.linkedin.com/in/fay-fox" }, timestamp: at }),
          }),
          "heyreach",
          { syncAfter: false },
        );
      const shapes = mock.method(console, "info", () => undefined);
      try {
        assert.deepEqual(await (await post(minutesAgo(60))).json(), { saved: 0 });
      } finally {
        shapes.mock.restore();
      }
      const [fay] = await prospect(linkedinId, "linkedin.com/in/fay-fox");
      const steps = await sql<{ step: number }>("select step from crm.campaign_events where prospect_id = $1 and kind = 'message_sent' order by step", [fay.id]);
      assert.deepEqual(steps.map((row) => row.step), [1, 2]);
    });

    it("retries an auto-add that failed for a passing reason, without duplicating", async () => {
      await sql(`create or replace function public.integration_busy() returns trigger language plpgsql as $$ begin raise exception 'busy' using errcode = '40001'; end; $$`);
      await sql("create trigger integration_busy before insert on crm.contacts for each row execute function public.integration_busy()");
      campaignRow().leads.push({ id: "lead-max", profileUrl: "https://www.linkedin.com/in/max-moss/", first: "Max", last: "Moss", accountId: 1, connection: "ConnectionAccepted", lastActionTime: new Date().toISOString() });
      const logged = mock.method(console, "error", () => undefined);
      try {
        await sync();
      } finally {
        logged.mock.restore();
        await sql("drop trigger integration_busy on crm.contacts");
      }
      const [max] = await prospect(linkedinId, "linkedin.com/in/max-moss");
      assert.equal(max.contact_id, null);
      const waiting = await sql<{ handled_at: Date | null; handle_attempts: number }>(
        "select handled_at, handle_attempts from crm.campaign_events where prospect_id = $1 and kind = 'invite_accepted'",
        [max.id],
      );
      assert.equal(waiting[0].handled_at, null, "the event waits for another try");
      assert.equal(waiting[0].handle_attempts, 1);
      await sql("update crm.campaign_events set claimed_at = null where prospect_id = $1", [max.id]);
      await sync();
      await sql("update crm.campaign_events set claimed_at = null where prospect_id = $1", [max.id]);
      await sync();
      const contacts = await sql("select 1 from crm.contacts where workspace_id = $1 and normalized_linkedin = 'linkedin.com/in/max-moss'", [owner.workspaceId]);
      assert.equal(contacts.length, 1);
      assert.ok((await prospect(linkedinId, "linkedin.com/in/max-moss"))[0].contact_id);
    });

    it("resolves a LinkedIn profile only to that profile, never by name", async () => {
      const company = (await createCompany(owner, { name: "Smith Works", domain: "smithworks.test" })).body.company;
      const named = (await createContact(owner, { firstName: "John", lastName: "Smith", companyId: company.id }, { provenance: { operation: "test" } })).body.contact;
      const other = (
        await createContact(owner, { firstName: "Jon", lastName: "Other", email: "shared@smithworks.test", linkedinUrl: "https://www.linkedin.com/in/jon-other" }, { provenance: { operation: "test" } })
      ).body.contact;
      const input = (linkedinUrl: string, email = "") => ({
        object: "contact" as const,
        name: "",
        domain: "",
        website: "",
        email,
        firstName: "John",
        lastName: "Smith",
        jobTitle: "",
        companyId: company.id,
        linkedinUrl,
        create: true,
      });
      const first = await upsertRecord(owner, input("https://www.linkedin.com/in/john-smith-1"), { operation: "test" });
      const second = await upsertRecord(owner, input("https://www.linkedin.com/in/john-smith-2"), { operation: "test" });
      const again = await upsertRecord(owner, input("https://www.linkedin.com/in/john-smith-1"), { operation: "test" });
      assert.equal(first.created, true);
      assert.equal(second.created, true);
      assert.notEqual(first.id, second.id, "two John Smiths with different profiles are two contacts");
      assert.notEqual(first.id, named.id, "a profile never falls back to the name");
      assert.equal(again.id, first.id);
      const clash = await upsertRecord(owner, input("https://www.linkedin.com/in/john-smith-3", "shared@smithworks.test"), { operation: "test" });
      assert.notEqual(clash.id, other.id, "an email held by a contact with another profile isn't that person");
      assert.equal((clash as { note?: string }).note, "Email belongs to Jon Other, left off.");
      const profiles = await sql<{ id: string; normalized_linkedin: string | null }>(
        "select id, normalized_linkedin from crm.contacts where id = any($1::uuid[])",
        [[first.id, second.id, clash.id]],
      );
      assert.deepEqual(profiles.map((row) => row.normalized_linkedin).sort(), ["linkedin.com/in/john-smith-1", "linkedin.com/in/john-smith-2", "linkedin.com/in/john-smith-3"]);
    });

    it("offers every campaign to the trigger, and switching to Reached a step keeps it valid", async () => {
      await sql("update crm.campaigns set status = 'completed' where id = $1", [emailId]);
      const forSteps = await campaignOptions(owner);
      const forTrigger = await campaignOptions(owner, { all: true });
      assert.equal(forSteps.some((item) => item.id === emailId), false);
      assert.equal(forTrigger.some((item) => item.id === emailId), true);
      await sql("update crm.campaigns set status = 'active' where id = $1", [emailId]);
      const choices = forTrigger.map((item) => ({ id: item.id, channel: item.channel }));
      const base: CampaignTrigger = { type: "campaign_event", event: "replied", channel: null, campaignId: linkedinId, campaignName: "Founders LinkedIn" };
      const stepped = withCampaignEvent(base, "step", choices);
      assert.equal(stepped.channel, "linkedin");
      assert.equal(triggerProblem(stepped), null);
      const toEmail = withCampaignChannel(stepped, "email", choices);
      assert.equal(toEmail.campaignId, null, "a campaign on the other channel is cleared");
      assert.equal(triggerProblem(toEmail), null);
      for (const event of ["added", "finished", "step"] as const) {
        for (const channel of [null, "email", "linkedin"] as const) {
          const made = withCampaignChannel(withCampaignEvent({ ...base, channel }, event, choices), event === "step" && !channel ? "email" : channel, choices);
          assert.equal(triggerProblem(made), null, `${event} ${channel}`);
        }
      }
    });

    it("hides Import on a prospect with no email or profile", async () => {
      await sql("insert into crm.campaign_prospects (workspace_id, campaign_id, state, external_lead_id, pushed_at) values ($1, $2, 'pushed', 'sl-blank', now())", [owner.workspaceId, emailId]);
      const page = await listCampaignProspects(owner, emailId);
      const blank = page.rows.find((row) => row.name === "Unnamed");
      assert.ok(blank);
      assert.equal(blank.importable, false);
      assert.equal(page.rows.find((row) => row.email === "early@agency.test")?.importable, true);
    });

    it("runs the LinkedIn-to-email templates to Find email with a company", async () => {
      const rows = await sql<{ id: string }>(
        `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, backfilled_at, synced_at)
         values ($1, 'smartlead', 'email', '5502', 'Follow-up email', 'active', now(), now()) returning id`,
        [owner.workspaceId],
      );
      wfEmailCampaign = rows[0].id;
      for (const key of ["linkedin-finished-then-email", "linkedin-step-then-email"]) {
        const template = STARTER_TEMPLATES.find((item) => item.key === key)!;
        const definition = {
          ...template.definition,
          trigger: { ...template.definition.trigger, campaignId: linkedinId },
          nodes: template.definition.nodes.map((node) =>
            node.type === "add_to_campaign" ? { ...node, config: { campaignId: wfEmailCampaign, campaignName: "Follow-up email", channel: "email" } } : node,
          ),
        };
        const created = await createWorkflow(owner, { name: key });
        await saveWorkflow(owner, created.id, { definition });
        await setWorkflowStatus(owner, created.id, "active");
      }
      const prospects = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, linkedin, lead, state, external_lead_id, lead_status, pushed_at)
         values ($1, $2, 'linkedin.com/in/nia-north', '{"firstName": "Nia", "lastName": "North", "companyName": "North Studio"}'::jsonb, 'pushed', 'lead-nia', 'completed', now())
         returning id`,
        [owner.workspaceId, linkedinId],
      );
      const nia = prospects[0].id;
      await sql(
        `insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, step, occurred_at, dedupe_key)
         values ($1, $2, $3, 'message_sent', 1, now(), 'test:nia:message_sent:1')`,
        [owner.workspaceId, linkedinId, nia],
      );
      await sql("select private.campaign_mark_finished($1, false)", [linkedinId]);
      const waiting = await sql<{ id: string }>("select id from crm.campaign_events where prospect_id = $1 and fired_at is null", [nia]);
      await sql("select private.campaign_fire_events($1::uuid[])", [waiting.map((row) => row.id)]);
      for (let round = 0; round < 6; round += 1) {
        const tick = await runWorkflowTick({ fetchImpl, budgetMs: LONG_TICK_MS, long: true, limit: 25 });
        if (tick.processed === 0) break;
      }
      const runs = await sql<{ id: string; name: string }>(
        `select r.id, w.name from crm.workflow_runs r join crm.workflows w on w.id = r.workflow_id
         where w.workspace_id = $1 and w.name in ('linkedin-finished-then-email', 'linkedin-step-then-email')
           and r.event->'data'->>'prospectId' = $2 and r.parent_run_id is null
         order by w.name`,
        [owner.workspaceId, nia],
      );
      assert.deepEqual(runs.map((run) => run.name), ["linkedin-finished-then-email", "linkedin-step-then-email"]);
      for (const run of runs) {
        const { steps } = await getRunSteps(owner, run.id);
        assert.ok(steps.some((step) => step.stepId === "find_email_1"), `${run.name} reached Find email: ${JSON.stringify(steps.map((step) => [step.stepId, step.status, step.error]))}`);
      }
      const contacts = await sql<{ company: string | null }>(
        "select co.name as company from crm.contacts c left join crm.companies co on co.id = c.company_id where c.workspace_id = $1 and c.normalized_linkedin = 'linkedin.com/in/nia-north'",
        [owner.workspaceId],
      );
      assert.deepEqual(contacts, [{ company: "North Studio" }], "one contact, with the prospect's company");
    });
  });

  describe("round 2 review rules", () => {
    it("re-runs a retried reply in full: the person is stopped, with one activity and one notification", async () => {
      const contact = (await createContact(owner, { firstName: "Pat", lastName: "Pike", email: "pat@pikeco.test", linkedinUrl: "https://www.linkedin.com/in/pat-pike" }, { provenance: { operation: "test" } })).body.contact;
      const emailRow = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, state, external_lead_id, pushed_at)
         values ($1, $2, $3, 'pat@pikeco.test', 'pushed', 'sl-pat', now() - interval '2 days') returning id`,
        [owner.workspaceId, emailId, contact.id],
      );
      const linkedinRow = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, linkedin, state, external_lead_id, lead_status, pushed_at)
         values ($1, $2, $3, 'linkedin.com/in/pat-pike', 'pushed', 'lead-pat', 'in_progress', now() - interval '2 days') returning id`,
        [owner.workspaceId, linkedinId, contact.id],
      );
      const repliedAt = minutesAgo(3);
      await sql(
        `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, external_id)
         values ($1, $2, $3, 'email', 'inbound', 'Yes, send me more', $4, 'msg-pat-1')`,
        [owner.workspaceId, emailId, emailRow[0].id, repliedAt],
      );
      const saved = await saveProviderEvents(
        emailId,
        smartleadEvents("5501", [{ leadId: "sl-pat", email: "pat@pikeco.test", name: "Pat Pike", category: null, step: 1, variant: null, sentAt: minutesAgo(60), openedAt: null, clickedAt: null, repliedAt, bounced: false, unsubscribed: false }]),
        false,
      );
      const replied = saved.filter((event) => event.kind === "replied");
      assert.equal(replied.length, 1);
      const campaign = { id: emailId, workspaceId: owner.workspaceId, provider: "smartlead" as const, externalId: "5501", name: "Agency email" };
      await sql(`create or replace function public.integration_no_stop() returns trigger language plpgsql as $$ begin raise exception 'stop failed for the test'; end; $$`);
      await sql(
        "create trigger integration_no_stop before update on crm.campaign_prospects for each row when (new.stop_requested_at is distinct from old.stop_requested_at) execute function public.integration_no_stop()",
      );
      const logged = mock.method(console, "error", () => undefined);
      let first;
      try {
        first = await handleCampaignEvents(campaign, replied, owner);
      } finally {
        logged.mock.restore();
        await sql("drop trigger integration_no_stop on crm.campaign_prospects");
      }
      assert.deepEqual(first.retry, [replied[0].eventId], "the reply is tried again");
      const counted = await sql<{ counted_at: Date | null }>("select counted_at from crm.campaign_events where id = $1", [replied[0].eventId]);
      assert.ok(counted[0].counted_at, "it was counted before the stop failed");
      await handleCampaignEvents(campaign, replied, owner);
      await handleCampaignEvents(campaign, replied, owner);
      const stopped = await sql<{ stop_requested_at: Date | null }>("select stop_requested_at from crm.campaign_prospects where id = $1", [linkedinRow[0].id]);
      assert.ok(stopped[0].stop_requested_at, "the retry still stops them everywhere");
      const activities = await sql("select 1 from crm.activities where workspace_id = $1 and contact_id = $2 and metadata->>'prospectId' = $3", [
        owner.workspaceId,
        contact.id,
        emailRow[0].id,
      ]);
      assert.equal(activities.length, 1, "one activity");
      const alerts = await sql("select 1 from crm.push_log where key = $1", [`campaign-reply:${replied[0].eventId}`]);
      assert.equal(alerts.length, 1, "one notification");
    });

    it("keeps marking Finished on a campaign that isn't live after a failed reply read", async () => {
      eclipse.campaigns.push({
        ...linkedinCampaign(),
        id: 9102,
        name: "Ended LinkedIn",
        status: "FINISHED",
        listId: undefined,
        listLeads: [],
        progress: undefined,
        leads: [{ id: "lead-quin", profileUrl: "https://www.linkedin.com/in/quin-quay/", first: "Quin", last: "Quay", accountId: 1, connection: "ConnectionAccepted", status: "InSequence", lastActionTime: minutesAgo(600) }],
        conversations: [],
      });
      await sync();
      await sync();
      const rows = await sql<{ id: string; backfilled_at: Date | null }>("select id, backfilled_at from crm.campaigns where workspace_id = $1 and external_id = '9102'", [owner.workspaceId]);
      const ended = rows[0].id;
      assert.ok(rows[0].backfilled_at);
      const quin = eclipse.campaigns.find((item) => item.id === 9102)!.leads[0];
      const dayLater = async (patch: Record<string, string>) => {
        quin.lastActionTime = new Date().toISOString();
        await sql("update crm.campaigns set sync_state = sync_state || $2::jsonb where id = $1", [ended, JSON.stringify(patch)]);
      };
      const finishedCount = async () => (await sql("select 1 from crm.campaign_events where campaign_id = $1 and kind = 'finished'", [ended])).length;
      quin.status = "Finished";
      await dayLater({ eventsAt: minutesAgo(25 * 60), repliesAt: minutesAgo(25 * 60) });
      eclipse.fail = (path) => (path === "/inbox/GetConversationsV2" ? Response.json({ errorMessage: "Inbox unavailable" }, { status: 400 }) : null);
      const logged = mock.method(console, "error", () => undefined);
      try {
        await sync();
      } finally {
        logged.mock.restore();
        eclipse.fail = undefined;
      }
      assert.equal(await finishedCount(), 0, "day 1: the reply read failed");
      await dayLater({ eventsAt: minutesAgo(25 * 60), repliesAt: minutesAgo(30) });
      await sync();
      assert.equal(await finishedCount(), 1, "a later pass reads replies with the events and marks Finished");
    });
  });
});
