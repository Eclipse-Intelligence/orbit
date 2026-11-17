import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { removeProspect, setCampaignPaused, setProspectCategory, setProspectPaused } from "@/lib/campaigns/manage";
import { replyToProspect } from "@/lib/campaigns/replies";
import { syncCampaigns } from "@/lib/campaigns/sync";
import { contactCampaignLines, contactCampaignTimeline, getProspectThread, refreshProspectThread } from "@/lib/campaigns/threads";
import { ensureWebhookSecret } from "@/lib/campaigns/webhook-urls";
import { handleCampaignWebhook } from "@/lib/campaigns/webhooks";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { safeDefinition } from "@/lib/workflows/definition";
import { fakeHeyReach, fakeSmartlead, sequenceOf, type FakeAccount, type FakeHeyReachAccount, type FakeHeyReachCampaign } from "./campaigns-fake";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const SL_A = "sl_key_replies_alpha_01";
const SL_B = "sl_key_replies_bravo_02";
const HR_A = "hr_key_replies_alpha_03";
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE"];
const T0 = "2026-11-10T09:00:00.000Z";
const ORIGIN = "https://orbit.test";

let owner: UserActor;
let ann: UserActor;
let jess: UserActor;
let outsider: UserActor;
let priyaContact: string;
const saved: Record<string, string | undefined> = {};

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

function refused(code: string | string[], pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.ok((Array.isArray(code) ? code : [code]).includes(error.code), `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

async function prospectId(lead: string) {
  const rows = await sql<{ id: string }>("select id from crm.campaign_prospects where external_lead_id = $1", [lead]);
  assert.equal(rows.length, 1, `one prospect for ${lead}`);
  return rows[0].id;
}

async function prospect(lead: string) {
  const rows = await sql<{
    id: string;
    replied_at: Date | null;
    stop_requested_at: Date | null;
    stopped_at: Date | null;
    stop_reason: string | null;
    lead_status: string | null;
    category: string | null;
    sync_requested_at: Date | null;
  }>("select id, replied_at, stop_requested_at, stopped_at, stop_reason, lead_status, category, sync_requested_at from crm.campaign_prospects where external_lead_id = $1", [lead]);
  return rows[0];
}

async function firedEvents(workspaceId: string, kind: string) {
  return sql<{ entity_type: string; entity_id: string; data: Record<string, unknown>; source_workflow_id: string | null; depth: number }>(
    "select entity_type, entity_id, data, source_workflow_id, depth from crm.workflow_events where workspace_id = $1 and 'campaign_event' = any(trigger_types) and data->>'kind' = $2",
    [workspaceId, kind],
  );
}

async function notifications(workspaceId: string) {
  return sql<{ user_id: string; title: string; href: string | null }>(
    "select user_id, title, href from crm.notifications where workspace_id = $1 and source = 'campaign' order by created_at",
    [workspaceId],
  );
}

async function audits(workspaceId: string, type: string) {
  return sql<{ entity_id: string; actor_user_id: string | null; changes: Record<string, unknown> }>(
    "select entity_id, actor_user_id, changes from crm.audit_events where workspace_id = $1 and event_type = $2 order by created_at",
    [workspaceId, type],
  );
}

function agencyOutreach() {
  return {
    id: 801,
    name: "Agency outreach",
    status: "ACTIVE",
    leads: [
      { id: "lead-priya", email: "priya@halcyon.test", first: "Priya", last: "Shah", company: "Halcyon Digital" },
      { id: "lead-ben", email: "ben@lumen.test", first: "Ben", last: "Hart", company: "Lumen & Co" },
      { id: "lead-tom", email: "tom@brightlane.test", first: "Tom", last: "Avery", company: "Brightlane" },
    ],
    stats: [
      { lead_id: "lead-priya", lead_email: "priya@halcyon.test", lead_name: "Priya Shah", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-tom", lead_email: "tom@brightlane.test", lead_name: "Tom Avery", sequence_number: 1, sent_time: T0 },
    ],
    sequences: sequenceOf([{ subject: "Quick question", body: "Hi {{first_name}}" }]),
    analytics: {},
    threads: {
      "lead-priya": [
        { type: "SENT", stats_id: "stats-priya", message_id: "<sent-priya@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Priya, saw the Shopify Plus news.</p>", email_seq_number: 1, from: "mark@getridgeon.test" },
      ],
      "lead-ben": [{ type: "SENT", stats_id: "stats-ben", message_id: "<sent-ben@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Ben</p>", email_seq_number: 1, from: "mark@getridgeon.test" }],
    } as Record<string, unknown[]>,
  };
}

function agencyFounders(): FakeHeyReachCampaign {
  return {
    id: 901,
    name: "Agency founders",
    status: "IN_PROGRESS",
    accountIds: [1, 2],
    sequence: [{ actionType: "ConnectionRequest", message: "{connection_note}" }],
    leads: [
      { id: "lead-hr-priya", profileUrl: "https://www.linkedin.com/in/priyashah/", first: "Priya", last: "Shah", accountId: 1, connection: "ConnectionAccepted", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
      { id: "lead-hr-dan", profileUrl: "https://www.linkedin.com/in/danellis/", first: "Dan", last: "Ellis", accountId: 2, connection: "ConnectionAccepted", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
    ],
    overall: {},
    byDay: {},
    conversations: [
      { id: "c-priya", accountId: 1, profileUrl: "https://www.linkedin.com/in/priyashah/", leadId: "lead-hr-priya", messages: [{ createdAt: "2026-11-12T10:00:00.000Z", body: "Hi Priya, I work with agencies on onboarding.", sender: "ME" }] },
      { id: "c-priya-private", accountId: 9, profileUrl: "https://www.linkedin.com/in/priyashah/", messages: [{ createdAt: "2026-11-13T10:00:00.000Z", body: "Dinner on Friday?", sender: "CORRESPONDENT" }] },
      { id: "c-dan", accountId: 2, profileUrl: "https://www.linkedin.com/in/danellis/", leadId: "lead-hr-dan", messages: [{ createdAt: "2026-11-12T10:00:00.000Z", body: "Thanks for connecting, Dan.", sender: "ME" }] },
    ],
  };
}

describe("campaign events and replies", () => {
  const alpha: FakeAccount = { key: SL_A, client: { id: 1, name: "Eclipse" }, campaigns: [agencyOutreach()], calls: [] };
  const bravo: FakeAccount = {
    key: SL_B,
    client: { id: 2, name: "Ridgeon" },
    campaigns: [
      {
        id: 811,
        name: "Ridgeon outreach",
        status: "ACTIVE",
        leads: [{ id: "lead-b-priya", email: "priya@halcyon.test", first: "Priya", last: "Shah" }],
        stats: [{ lead_id: "lead-b-priya", lead_email: "priya@halcyon.test", lead_name: "Priya Shah", sequence_number: 1, sent_time: T0 }],
        sequences: [],
        analytics: {},
      },
    ],
    calls: [],
  };
  const heyreach: FakeHeyReachAccount = {
    key: HR_A,
    accounts: [
      { id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@replies.test", profileUrl: "https://www.linkedin.com/in/markridgeon" },
      { id: 2, firstName: "Jess", lastName: "Cole", emailAddress: "jess@replies.test", profileUrl: "https://www.linkedin.com/in/jesscole" },
    ],
    campaigns: [agencyFounders()],
    calls: [],
  };
  const smartleadFetch = fakeSmartlead([alpha, bravo]);
  const heyreachFetch = fakeHeyReach([heyreach]);
  const fetchImpl: typeof fetch = (input, init) => (String(input instanceof Request ? input.url : input).includes("heyreach") ? heyreachFetch(input, init) : smartleadFetch(input, init));
  const sync = (workspaceId: string, fetcher: typeof fetch = fetchImpl) => syncCampaigns({ workspaceId, deadline: Date.now() + 60_000, fetchImpl: fetcher, onEvents: handleCampaignEvents });
  const webhook = (provider: "smartlead" | "heyreach", workspaceId: string, secret: string, body: unknown, headers: Record<string, string> = {}) =>
    handleCampaignWebhook(new Request(`${ORIGIN}/api/webhooks/${provider}?w=${workspaceId}&secret=${encodeURIComponent(secret)}`, { method: "POST", body: JSON.stringify(body), headers }), provider, { syncAfter: false });

  before(async () => {
    await resetDatabase();
    for (const name of LIMITS) {
      saved[name] = process.env[name];
      process.env[name] = "100000";
    }
    owner = await createUser("mark@replies.test", "Mark Ridgeon");
    const second = await createUser("ann@replies.test", "Ann Member");
    const third = await createUser("jess@replies.test", "Jess Cole");
    outsider = await createUser("oscar@elsewhere-replies.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [owner.workspaceId, second.userId, third.userId]);
    ann = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    jess = { ...third, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    priyaContact = (
      await createContact(owner, { firstName: "Priya", lastName: "Shah", email: "priya@halcyon.test", linkedinUrl: "https://www.linkedin.com/in/priyashah" }, { provenance: { operation: "test" } })
    ).body.contact.id;
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    await saveCampaignConnection(outsider, "smartlead", SL_B, { fetchImpl });
    await sql(
      `insert into crm.workflows (workspace_id, owner_id, name, status, trigger_type, definition)
       values ($1, $2, 'On replies', 'active', 'campaign_event', $3::jsonb)`,
      [owner.workspaceId, owner.userId, JSON.stringify({ version: 2, trigger: { type: "campaign_event", event: "replied" }, triggerPosition: { x: 0, y: 0 }, nodes: [], edges: [] })],
    );
  });

  after(async () => {
    for (const name of LIMITS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await getPool().end();
    await getAdminPool().end();
  });

  beforeEach(async () => {
    await sql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:%'");
  });

  useServerlessPool();

  it("runs its migration twice", async () => {
    await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270209100000_campaign_replies.sql", "utf8"));
  });

  it("backfills without firing anything and keeps conversations from other accounts out", async () => {
    const first = await sync(owner.workspaceId);
    assert.deepEqual(first.errors, []);
    assert.equal(first.backfilled, 2);
    await sync(outsider.workspaceId);
    assert.equal((await sql("select 1 from crm.workflow_events where 'campaign_event' = any(trigger_types)")).length, 0);
    assert.equal((await notifications(owner.workspaceId)).length, 0);
    const messages = await sql<{ conversation_id: string; body: string }>("select conversation_id, body from crm.campaign_messages where channel = 'linkedin' order by conversation_id");
    assert.deepEqual(messages.map((row) => row.conversation_id), ["c-dan", "c-priya"]);
    assert.ok(!messages.some((row) => row.body.includes("Dinner")));
    const priya = await sql<{ contact_id: string | null }>("select contact_id from crm.campaign_prospects where external_lead_id in ('lead-priya', 'lead-hr-priya')");
    assert.deepEqual(priya.map((row) => row.contact_id), [priyaContact, priyaContact]);
  });

  describe("webhooks", () => {
    let secret: string;

    before(async () => {
      secret = (await ensureWebhookSecret(owner.workspaceId, "smartlead"))!;
      assert.ok(secret);
      assert.equal(await ensureWebhookSecret(owner.workspaceId, "smartlead"), secret);
      await ensureWebhookSecret(outsider.workspaceId, "smartlead");
    });

    const reply = { event_type: "EMAIL_REPLY", campaign_id: 801, sl_email_lead_id: "lead-priya", sl_lead_email: "priya@halcyon.test", event_timestamp: "2026-11-14T09:41:00Z" };

    it("refuses a wrong secret and a wrong workspace", async () => {
      assert.equal((await webhook("smartlead", owner.workspaceId, "wrong-secret", reply)).status, 401);
      assert.equal((await webhook("smartlead", outsider.workspaceId, secret, reply)).status, 401);
      assert.equal((await webhook("smartlead", "not-a-workspace", secret, reply)).status, 401);
      assert.equal((await webhook("heyreach", outsider.workspaceId, secret, reply)).status, 401);
      assert.equal((await prospect("lead-priya")).sync_requested_at, null);
      assert.equal((await sql("select 1 from crm.webhook_receipts")).length, 0);
    });

    it("queues a sync of a known lead, once per delivery, and changes nothing else", async () => {
      const before = await sql<{ events: number; messages: number }>("select (select count(*)::int from crm.campaign_events) as events, (select count(*)::int from crm.campaign_messages) as messages");
      const first = await webhook("smartlead", owner.workspaceId, secret, reply, { "x-request-id": "req-1" });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { queued: 1 });
      assert.ok((await prospect("lead-priya")).sync_requested_at);
      const again = await webhook("smartlead", owner.workspaceId, secret, reply, { "x-request-id": "req-1" });
      assert.deepEqual(await again.json(), { duplicate: true });
      const receipts = await sql<{ source: string; message_id: string }>("select source, message_id from crm.webhook_receipts");
      assert.deepEqual(receipts.map((row) => row.source), ["smartlead"]);
      assert.equal(receipts[0].message_id.length, 64);
      const after = await sql<{ events: number; messages: number }>("select (select count(*)::int from crm.campaign_events) as events, (select count(*)::int from crm.campaign_messages) as messages");
      assert.deepEqual(after, before);
    });

    it("sets nothing for a lead Orbit doesn't have, which waits for the poll", async () => {
      const response = await webhook("smartlead", owner.workspaceId, secret, { ...reply, sl_email_lead_id: "lead-nobody", sl_lead_email: "nobody@nowhere.test" }, { "x-request-id": "req-2" });
      assert.deepEqual(await response.json(), { queued: 0 });
      assert.equal((await sql("select 1 from crm.campaign_prospects where sync_requested_at is not null")).length, 1);
    });

    it("never flags a lead in another workspace", async () => {
      const bravoSecret = (await ensureWebhookSecret(outsider.workspaceId, "smartlead"))!;
      const response = await webhook("smartlead", outsider.workspaceId, bravoSecret, { ...reply, campaign_id: 801 }, { "x-request-id": "req-3" });
      assert.deepEqual(await response.json(), { queued: 0 });
      assert.equal((await sql("select 1 from crm.campaign_prospects where sync_requested_at is not null and workspace_id = $1", [outsider.workspaceId])).length, 0);
    });

    it("takes HeyReach reply webhooks too", async () => {
      const heySecret = (await ensureWebhookSecret(owner.workspaceId, "heyreach"))!;
      const response = await webhook("heyreach", owner.workspaceId, heySecret, {
        event_type: "EVERY_MESSAGE_REPLY_RECEIVED",
        campaign: { id: 901 },
        lead: { id: "lead-hr-dan", profile_url: "https://www.linkedin.com/in/danellis" },
        conversation_id: "c-dan",
        recent_messages: [{ creation_time: "2026-11-14T09:00:00Z", message: "Old news" }],
      });
      assert.deepEqual(await response.json(), { queued: 1 });
    });
  });

  describe("a reply found by sync", () => {
    it("stores it, marks the prospect replied, stops them elsewhere, tells the owner and fires once", async () => {
      const replyAt = new Date(Date.now() - 60_000).toISOString();
      const campaign = alpha.campaigns[0];
      campaign.stats.push({ lead_id: "lead-priya", lead_email: "priya@halcyon.test", lead_name: "Priya Shah", sequence_number: 1, sent_time: T0, reply_time: replyAt });
      campaign.threads!["lead-priya"].push({ type: "REPLY", stats_id: "stats-priya", message_id: "<reply-priya@halcyon.test>", time: replyAt, subject: "Re: Quick question", email_body: "<p>Thanks Mark. Happy to talk next week.</p>", from: "priya@halcyon.test" });
      const report = await sync(owner.workspaceId);
      assert.deepEqual(report.errors, []);
      const priya = await prospect("lead-priya");
      assert.ok(priya.replied_at);
      assert.equal(priya.sync_requested_at, null);
      const inbound = await sql<{ id: string; body: string }>("select id, body from crm.campaign_messages where prospect_id = $1 and direction = 'inbound'", [priya.id]);
      assert.equal(inbound.length, 1);
      assert.match(inbound[0].body, /Happy to talk next week/);
      await sync(owner.workspaceId);
      const linkedin = await prospect("lead-hr-priya");
      assert.ok(linkedin.stop_requested_at);
      assert.equal(linkedin.stop_reason, "replied");
      assert.ok(linkedin.stopped_at);
      assert.equal(heyreach.calls.filter((call) => call.path === "/campaign/StopLeadInCampaign").length, 1);
      assert.equal(bravo.writes?.length ?? 0, 0);
      assert.equal((await prospect("lead-b-priya")).stop_requested_at, null);

      const told = await notifications(owner.workspaceId);
      assert.deepEqual(told.map((row) => [row.user_id, row.title]), [[owner.userId, "Priya Shah replied"]]);
      assert.equal(told[0].href, `/campaigns/threads/${priya.id}`);
      const fired = await firedEvents(owner.workspaceId, "replied");
      assert.equal(fired.length, 1);
      assert.equal(fired[0].entity_type, "contact");
      assert.equal(fired[0].entity_id, priyaContact);
      assert.equal(fired[0].data.channel, "email");
      const activities = await sql<{ type: string; contact_id: string; metadata: Record<string, unknown> }>(
        "select type, contact_id, metadata from crm.activities where workspace_id = $1 and metadata ? 'campaignMessageId'",
        [owner.workspaceId],
      );
      assert.deepEqual(activities.map((row) => [row.type, row.contact_id, row.metadata.campaignMessageId]), [["email", priyaContact, inbound[0].id]]);

      await sync(owner.workspaceId);
      assert.equal((await firedEvents(owner.workspaceId, "replied")).length, 1);
      assert.equal((await notifications(owner.workspaceId)).length, 1);
      const dispatched = await sql<{ dispatched: number }>("select private.dispatch_workflow_events(500) as dispatched");
      assert.ok(dispatched[0].dispatched >= 1);
      const runs = await sql<{ contact_id: string | null }>("select contact_id from crm.workflow_runs where event->>'type' = 'campaign.event' and event->'data'->>'kind' = 'replied'");
      assert.deepEqual(runs.map((row) => row.contact_id), [priyaContact]);
    });

    it("doesn't count an Out of office reply", async () => {
      const replyAt = new Date(Date.now() - 30_000).toISOString();
      const campaign = alpha.campaigns[0];
      campaign.stats.push({ lead_id: "lead-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0, reply_time: replyAt, lead_category: "Out Of Office" });
      campaign.threads!["lead-ben"].push({ type: "REPLY", stats_id: "stats-ben", message_id: "<ooo-ben@lumen.test>", time: replyAt, subject: "Automatic reply: Quick question", email_body: "I'm away until Monday.", from: "ben@lumen.test" });
      await sync(owner.workspaceId);
      const ben = await prospect("lead-ben");
      assert.equal(ben.replied_at, null);
      assert.equal((await sql("select 1 from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [ben.id])).length, 0);
      assert.equal((await sql("select 1 from crm.campaign_messages where prospect_id = $1 and direction = 'inbound'", [ben.id])).length, 1);
      assert.ok(!(await notifications(owner.workspaceId)).some((row) => row.title.startsWith("Ben")));
      assert.equal((await sql("select 1 from crm.campaign_events where kind = 'replied' and fired_at is not null")).length, 1);
    });

    it("tells the LinkedIn sender's member about a LinkedIn reply", async () => {
      const at = new Date().toISOString();
      heyreach.campaigns[0].conversations!.find((item) => item.id === "c-dan")!.messages.push({ createdAt: at, body: "Sounds good, call me Tuesday.", sender: "CORRESPONDENT" });
      await sync(owner.workspaceId);
      const dan = await prospect("lead-hr-dan");
      assert.ok(dan.replied_at);
      const told = await notifications(owner.workspaceId);
      assert.deepEqual(told.filter((row) => row.title.startsWith("Dan")).map((row) => row.user_id).sort(), [owner.userId, jess.userId].sort());
      const fired = (await firedEvents(owner.workspaceId, "replied")).filter((row) => row.data.channel === "linkedin");
      assert.equal(fired.length, 1);
      assert.equal(fired[0].entity_type, "campaign_prospect");
    });
  });

  describe("replying from Orbit", () => {
    it("refuses agent tokens", async () => {
      const agent = (await createAgent(owner.workspaceId, [...SCOPES], "Admin agent")).actor;
      await assert.rejects(replyToProspect(agent, await prospectId("lead-hr-dan"), { text: "Hello" }, { fetchImpl }), refused("forbidden", /^Only a person can reply\.$/));
    });

    it("lets only the LinkedIn sender's member reply", async () => {
      const dan = await prospectId("lead-hr-dan");
      await assert.rejects(replyToProspect(owner, dan, { text: "Tuesday works." }, { fetchImpl }), refused("forbidden", /^Only Jess Cole can reply from this LinkedIn account\.$/));
      const ownerView = await getProspectThread(owner, dan);
      assert.deepEqual(ownerView.replyOptions.map((option) => [option.channel, option.canReply, option.reason]), [["linkedin", false, "Only Jess Cole can reply from this LinkedIn account."]]);
      const jessView = await getProspectThread(jess, dan);
      assert.equal(jessView.replyOptions[0].canReply, true);
      const sent = await replyToProspect(jess, dan, { text: "Tuesday works. 2pm?", clientKey: "linkedin-1" }, { fetchImpl });
      assert.equal(sent.sendState, "sent");
      const sends = heyreach.calls.filter((call) => call.path === "/inbox/SendMessage");
      assert.equal(sends.length, 1);
      assert.equal(sends[0].body?.conversationId, "c-dan");
      assert.equal(sends[0].body?.linkedInAccountId, 2);
      assert.equal(sends[0].body?.message, "Tuesday works. 2pm?");
      const again = await replyToProspect(jess, dan, { text: "Tuesday works. 2pm?", clientKey: "linkedin-1" }, { fetchImpl });
      assert.equal(again.repeated, true);
      assert.equal(heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length, 1);
    });

    it("never sends an email reply twice when a retry follows an unclear failure", async () => {
      const priya = await prospectId("lead-priya");
      let attempts = 0;
      const flaky: typeof fetch = async (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("reply-email-thread")) {
          attempts += 1;
          throw new Error("socket hang up");
        }
        return fetchImpl(input, init);
      };
      const text = "Great. Does Tuesday or Wednesday afternoon work?";
      const first = await replyToProspect(owner, priya, { text, clientKey: "email-1" }, { fetchImpl: flaky });
      assert.equal(first.sendState, "unknown");
      const retry = await replyToProspect(owner, priya, { text, clientKey: "email-1" }, { fetchImpl });
      assert.deepEqual([retry.repeated, retry.sendState], [true, "unknown"]);
      assert.equal(attempts, 1);
      assert.equal((alpha.writes ?? []).filter((write) => write.path.endsWith("/reply-email-thread")).length, 0);

      alpha.campaigns[0].threads!["lead-priya"].push({ type: "SENT", stats_id: "stats-priya", message_id: "<orbit-reply@getridgeon.test>", time: new Date().toISOString(), subject: "Re: Quick question", email_body: `<p>${text}</p><p>Mark</p>`, from: "mark@getridgeon.test" });
      await refreshProspectThread(owner, priya, { fetchImpl, force: true });
      const outbound = await sql<{ send_state: string | null; confirmed_at: Date | null; client_key: string | null }>(
        "select send_state, confirmed_at, client_key from crm.campaign_messages where prospect_id = $1 and direction = 'outbound' order by sent_at",
        [priya],
      );
      assert.equal(outbound.length, 2);
      assert.equal(outbound[1].client_key, "email-1");
      assert.equal(outbound[1].send_state, "sent");
      assert.ok(outbound[1].confirmed_at);
    });

    it("sends again after a clear refusal, stores it as outbound and files it on the timeline", async () => {
      const priya = await prospectId("lead-priya");
      alpha.fail = (url) => (url.pathname.endsWith("/reply-email-thread") ? new Response("{}", { status: 400 }) : null);
      await assert.rejects(replyToProspect(ann, priya, { text: "Following up on times.", clientKey: "email-2" }, { fetchImpl }), refused("upstream_failed"));
      alpha.fail = undefined;
      const state = await sql<{ send_state: string }>("select send_state from crm.campaign_messages where client_key = 'email-2'");
      assert.equal(state[0].send_state, "failed");
      const sent = await replyToProspect(ann, priya, { text: "Following up on times.", clientKey: "email-2" }, { fetchImpl });
      assert.deepEqual([sent.sendState, sent.repeated], ["sent", false]);
      const writes = (alpha.writes ?? []).filter((write) => write.path === "/campaigns/801/reply-email-thread");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body?.email_stats_id, "stats-priya");
      assert.equal(writes[0].body?.reply_message_id, "<reply-priya@halcyon.test>");
      const filed = await sql<{ type: string; title: string }>("select type, title from crm.activities where metadata->>'campaignMessageId' = $1", [sent.messageId]);
      assert.deepEqual(filed.map((row) => [row.type, row.title]), [["email", "Reply sent in Agency outreach"]]);
      const replies = await audits(owner.workspaceId, "campaign.reply_sent");
      assert.deepEqual(replies.map((row) => row.changes.sendState), ["sent", "unknown", "sent"]);
    });
  });

  describe("actions on campaigns and prospects", () => {
    it("pauses and resumes a campaign, audited", async () => {
      const campaign = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '801'"))[0].id;
      assert.deepEqual(await setCampaignPaused(ann, campaign, true, { fetchImpl }), { status: "paused" });
      assert.equal((await sql<{ status: string }>("select status from crm.campaigns where id = $1", [campaign]))[0].status, "paused");
      assert.deepEqual(await setCampaignPaused(ann, campaign, false, { fetchImpl }), { status: "active" });
      assert.deepEqual(
        (alpha.writes ?? []).filter((write) => write.path === "/campaigns/801/status").map((write) => write.body?.status),
        ["PAUSED", "START"],
      );
      assert.equal((await audits(owner.workspaceId, "campaign.paused")).length, 1);
      assert.equal((await audits(owner.workspaceId, "campaign.resumed")).length, 1);
      const founders = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '901'"))[0].id;
      await setCampaignPaused(ann, founders, true, { fetchImpl });
      assert.equal(heyreach.calls.filter((call) => call.path === "/campaign/Pause").length, 1);
      await setCampaignPaused(ann, founders, false, { fetchImpl });
    });

    it("pauses, resumes and removes an email prospect, each audited", async () => {
      const tom = await prospectId("lead-tom");
      await setProspectPaused(ann, tom, true, { fetchImpl });
      assert.equal((await prospect("lead-tom")).lead_status, "paused");
      await setProspectPaused(ann, tom, false, { fetchImpl });
      assert.equal((await prospect("lead-tom")).lead_status, "in_progress");
      assert.deepEqual(await removeProspect(ann, tom, { fetchImpl }), { state: "stopped" });
      const row = await prospect("lead-tom");
      assert.equal(row.stop_reason, "removed");
      assert.ok(row.stopped_at);
      assert.deepEqual(
        (alpha.writes ?? []).filter((write) => write.path.startsWith("/campaigns/801/leads/lead-tom")).map((write) => `${write.method} ${write.path}`),
        ["POST /campaigns/801/leads/lead-tom/pause", "POST /campaigns/801/leads/lead-tom/resume", "DELETE /campaigns/801/leads/lead-tom"],
      );
      for (const type of ["campaign.prospect_paused", "campaign.prospect_resumed", "campaign.prospect_removed"]) {
        const rows = await audits(owner.workspaceId, type);
        assert.deepEqual(rows.map((item) => [item.entity_id, item.actor_user_id]), [[tom, ann.userId]], type);
      }
      await assert.rejects(removeProspect(ann, tom, { fetchImpl }), refused("conflict"));
      await assert.rejects(setProspectPaused(ann, await prospectId("lead-hr-dan"), true, { fetchImpl }), refused("invalid_input", /can't be paused one by one/));
    });

    it("fires the trigger when a category is set in Orbit", async () => {
      const priya = await prospectId("lead-priya");
      const before = (await firedEvents(owner.workspaceId, "category")).length;
      const result = await setProspectCategory(ann, priya, "Meeting booked", { fetchImpl });
      assert.deepEqual(result, { category: "Meeting booked", fired: true });
      const fired = await firedEvents(owner.workspaceId, "category");
      assert.equal(fired.length, before + 1);
      const latest = fired.find((row) => row.data.category === "Meeting booked")!;
      assert.deepEqual([latest.entity_type, latest.entity_id, latest.data.channel], ["contact", priyaContact, "email"]);
      assert.deepEqual((alpha.writes ?? []).filter((write) => write.path === "/campaigns/801/leads/lead-priya/category").map((write) => write.body?.category_id), [4]);
      assert.equal((await audits(owner.workspaceId, "campaign.category_changed")).length, 1);
      assert.deepEqual(await setProspectCategory(ann, priya, "Meeting booked", { fetchImpl }), { category: "Meeting booked", fired: false });
      const definition = safeDefinition({ version: 2, trigger: { type: "campaign_event", event: "positive", channel: "email" }, triggerPosition: { x: 0, y: 0 }, nodes: [], edges: [] });
      assert.equal(definition?.trigger.type, "campaign_event");
    });
  });

  describe("the thread and the contact page", () => {
    it("shows one thread per person across channels", async () => {
      const thread = await getProspectThread(ann, await prospectId("lead-hr-priya"));
      assert.equal(thread.person.name, "Priya Shah");
      assert.equal(thread.person.contactId, priyaContact);
      const channels = new Set(thread.items.filter((item) => item.type === "message").map((item) => item.channel));
      assert.deepEqual([...channels].sort(), ["email", "linkedin"]);
      assert.ok(thread.items.some((item) => item.type === "note" && item.text === "Stopped in Agency founders"));
      assert.ok(thread.items.some((item) => item.type === "note" && item.kind === "accepted"));
      assert.deepEqual(thread.campaigns.map((item) => [item.name, item.state]).sort(), [["Agency founders", "stopped"], ["Agency outreach", "replied"]]);
      assert.equal(thread.defaultChannel, "email");
      const lines = await contactCampaignLines(ann, priyaContact);
      assert.deepEqual(lines.map((line) => [line.campaignName, line.label]), [["Agency outreach", "Replied"]]);
      const timeline = await contactCampaignTimeline(ann, priyaContact);
      assert.ok(timeline.some((row) => row.title === "Step 1 sent" && row.campaignName === "Agency outreach" && row.detail === "mark@getridgeon.test"));
      assert.ok(timeline.some((row) => row.title === "Invite accepted" && row.detail === "Mark Ridgeon"));
    });
  });

  describe("workspace boundaries", () => {
    it("lets nobody outside the workspace read or act on its campaigns", async () => {
      const priya = await prospectId("lead-priya");
      const campaign = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '801'"))[0].id;
      await assert.rejects(getProspectThread(outsider, priya), refused("not_found"));
      await assert.rejects(replyToProspect(outsider, priya, { text: "Hi" }, { fetchImpl }), refused("not_found"));
      await assert.rejects(setCampaignPaused(outsider, campaign, true, { fetchImpl }), refused("not_found"));
      await assert.rejects(setProspectCategory(outsider, priya, "Interested", { fetchImpl }), refused("not_found"));
      await assert.rejects(removeProspect(outsider, priya, { fetchImpl }), refused("not_found"));
      await assert.rejects(refreshProspectThread(outsider, priya, { fetchImpl }), refused("not_found"));
      assert.deepEqual(await contactCampaignLines(outsider, priyaContact), []);
      assert.deepEqual(await contactCampaignTimeline(outsider, priyaContact), []);
      const seen = await queryAsUser<{ count: number }>(outsider.userId, "select count(*)::int as count from crm.campaign_messages");
      assert.equal(seen[0].count, 0);
      assert.equal((await notifications(outsider.workspaceId)).length, 0);
      assert.equal((await sql("select 1 from crm.workflow_events where workspace_id = $1", [outsider.workspaceId])).length, 0);
      await assert.rejects(queryAsUser(ann.userId, "insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, sent_at) select workspace_id, campaign_id, id, 'email', 'inbound', now() from crm.campaign_prospects limit 1"), /permission denied/);
      await assert.rejects(queryAsUser(ann.userId, "update crm.campaign_messages set body = 'x'"), /permission denied/);
      await assert.rejects(queryAsUser(ann.userId, "update crm.campaign_prospects set stop_requested_at = now()"), /permission denied/);
    });

    it("refuses a LinkedIn reply from someone removed from the workspace", async () => {
      await removeMember(owner, jess.userId);
      await assert.rejects(replyToProspect(jess, await prospectId("lead-hr-dan"), { text: "Still there?" }, { fetchImpl }), refused(["not_found", "forbidden"]));
      assert.equal(heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length, 1);
    });
  });
});
