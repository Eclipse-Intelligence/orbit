import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { setCampaignAutoAdd } from "@/lib/campaigns/manage";
import { addProspects } from "@/lib/campaigns/prospects";
import { smartleadEvents } from "@/lib/campaigns/providers";
import { saveProviderEvents, syncCampaigns, type SyncedEvent } from "@/lib/campaigns/sync";
import { ensureWebhookSecret } from "@/lib/campaigns/webhook-urls";
import { handleCampaignWebhook } from "@/lib/campaigns/webhooks";
import { getCampaign, importCampaignProspect, listCampaignProspects } from "@/lib/crm/campaigns";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { HEYREACH_SINCE_FILTER, heyReachSteps } from "@/lib/heyreach";
import { readSmartleadStats } from "@/lib/smartlead";
import { providerReason } from "@/lib/upstream";
import { definitionFromInput, type Trigger } from "@/lib/workflows/definition";
import { campaignTriggerMatches } from "@/lib/workflows/engine";
import { STARTER_TEMPLATES } from "@/lib/workflows/templates";
import { fakeHeyReach, type FakeHeyReachAccount, type FakeHeyReachCampaign } from "./campaigns-fake";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

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
});
