import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { campaignConnectionViews, removeCampaignConnection, saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { removeProspect, setCampaignPaused, setProspectCategory, setProspectPaused } from "@/lib/campaigns/manage";
import { replyToProspect } from "@/lib/campaigns/replies";
import { saveProviderEvents, syncCampaigns } from "@/lib/campaigns/sync";
import { saveThread } from "@/lib/campaigns/messages";
import { contactCampaignLines, contactCampaignTimeline, getProspectThread, refreshProspectThread } from "@/lib/campaigns/threads";
import { campaignWebhookUrl, ensureWebhookSecret } from "@/lib/campaigns/webhook-urls";
import { handleCampaignWebhook } from "@/lib/campaigns/webhooks";
import { getCampaign } from "@/lib/crm/campaigns";
import { createContact } from "@/lib/crm/contacts";
import { mergeContacts } from "@/lib/crm/merge";
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
      { id: "lead-ivy", email: "ivy@kiln.test", first: "Ivy", last: "Bell", company: "Kiln" },
      { id: "lead-uma", email: "uma@north.test", first: "Uma", last: "Reed", company: "North" },
      { id: "lead-vic", email: "vic@lane.test", first: "Vic", last: "Lane", company: "Lane" },
      { id: "lead-wes", email: "wes@gone.test", first: "Wes", last: "Gone", company: "Gone" },
      { id: "lead-xa", email: "xa@busy.test", first: "Xa", last: "Busy", company: "Busy" },
      { id: "lead-xb", email: "xb@busy.test", first: "Xb", last: "Busy", company: "Busy" },
    ],
    stats: [
      { lead_id: "lead-priya", lead_email: "priya@halcyon.test", lead_name: "Priya Shah", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-tom", lead_email: "tom@brightlane.test", lead_name: "Tom Avery", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-ivy", lead_email: "ivy@kiln.test", lead_name: "Ivy Bell", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-uma", lead_email: "uma@north.test", lead_name: "Uma Reed", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-vic", lead_email: "vic@lane.test", lead_name: "Vic Lane", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-wes", lead_email: "wes@gone.test", lead_name: "Wes Gone", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-xa", lead_email: "xa@busy.test", lead_name: "Xa Busy", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-xb", lead_email: "xb@busy.test", lead_name: "Xb Busy", sequence_number: 1, sent_time: T0 },
    ],
    sequences: sequenceOf([{ subject: "Quick question", body: "Hi {{first_name}}" }]),
    analytics: {},
    threads: {
      "lead-priya": [
        { type: "SENT", stats_id: "stats-priya", message_id: "<sent-priya@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Priya, saw the Shopify Plus news.</p>", email_seq_number: 1, from: "mark@getridgeon.test" },
      ],
      "lead-ben": [{ type: "SENT", stats_id: "stats-ben", message_id: "<sent-ben@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Ben</p>", email_seq_number: 1, from: "mark@getridgeon.test" }],
      "lead-uma": [],
      "lead-vic": [],
      "lead-wes": [],
      "lead-xa": [],
      "lead-xb": [],
      "lead-ivy": [{ type: "SENT", stats_id: "stats-ivy", message_id: "<sent-ivy@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Ivy</p>", email_seq_number: 1, from: "mark@getridgeon.test" }],
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
      { id: "lead-hr-kim", profileUrl: "https://www.linkedin.com/in/kimosei/", first: "Kim", last: "Osei", accountId: 1, connection: "ConnectionAccepted", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
    ],
    overall: {},
    byDay: {},
    conversations: [
      { id: "c-priya", accountId: 1, profileUrl: "https://www.linkedin.com/in/priyashah/", leadId: "lead-hr-priya", messages: [{ createdAt: "2026-11-12T10:00:00.000Z", body: "Hi Priya, I work with agencies on onboarding.", sender: "ME" }] },
      { id: "c-priya-private", accountId: 9, profileUrl: "https://www.linkedin.com/in/priyashah/", messages: [{ createdAt: "2026-11-13T10:00:00.000Z", body: "Dinner on Friday?", sender: "CORRESPONDENT" }] },
      { id: "c-dan", accountId: 2, profileUrl: "https://www.linkedin.com/in/danellis/", leadId: "lead-hr-dan", messages: [{ createdAt: "2026-11-12T10:00:00.000Z", body: "Thanks for connecting, Dan.", sender: "ME" }] },
      { id: "c-kim", accountId: 1, profileUrl: "https://www.linkedin.com/in/kimosei/", leadId: "lead-hr-kim", messages: [{ createdAt: "2026-11-13T10:00:00.000Z", body: "Interested, tell me more.", sender: "CORRESPONDENT" }] },
      { id: "c-stranger", accountId: 1, profileUrl: "https://www.linkedin.com/in/someone-else/", messages: [{ createdAt: "2026-11-13T11:00:00.000Z", body: "Who is this?", sender: "CORRESPONDENT" }] },
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
    assert.deepEqual(messages.map((row) => row.conversation_id), ["c-dan", "c-kim", "c-priya"]);
    assert.ok(!messages.some((row) => row.body.includes("Dinner") || row.body.includes("Who is this")));
    const priya = await sql<{ contact_id: string | null }>("select contact_id from crm.campaign_prospects where external_lead_id in ('lead-priya', 'lead-hr-priya')");
    assert.deepEqual(priya.map((row) => row.contact_id), [priyaContact, priyaContact]);
  });

  it("never fires a reply from before or during the backfill, even from an opened thread", async () => {
    const kim = await prospect("lead-hr-kim");
    assert.ok(kim.replied_at);
    const before = await sql<{ handled: boolean; counted: boolean }>("select handled_at is not null as handled, counted_at is not null as counted from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [kim.id]);
    assert.deepEqual(before, [{ handled: true, counted: false }]);
    await sql("update crm.campaigns set backfilled_at = null where external_id = '901'");
    try {
      heyreach.campaigns[0].conversations!.find((item) => item.id === "c-kim")!.messages.push({ createdAt: new Date().toISOString(), body: "Still keen.", sender: "CORRESPONDENT" });
      await refreshProspectThread(owner, kim.id, { fetchImpl, force: true });
    } finally {
      await sql("update crm.campaigns set backfilled_at = now() where external_id = '901'");
    }
    const after = await sql<{ handled: boolean }>("select handled_at is not null as handled from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [kim.id]);
    assert.deepEqual(after.map((row) => row.handled), [true, true]);
    await sync(owner.workspaceId);
    assert.equal((await notifications(owner.workspaceId)).length, 0);
    assert.equal((await sql("select 1 from crm.campaign_events where prospect_id = $1 and fired_at is not null", [kim.id])).length, 0);
    assert.equal((await sql("select 1 from crm.campaign_prospects where stop_requested_at is not null")).length, 0);
  });

  it("keeps counting conversations that aren't from the campaign's prospects", async () => {
    const founders = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '901'"))[0].id;
    assert.equal((await getCampaign(owner, founders)).strayConversations, 1);
    await sync(owner.workspaceId);
    assert.equal((await getCampaign(owner, founders)).strayConversations, 1);
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
      assert.equal((await sql("select 1 from crm.campaign_event_tombstones")).length, 1);
    });

    it("counts a real reply even when the stored category still says Out of office, and never re-reads the old one", async () => {
      const replyAt = new Date(Date.now() - 10_000).toISOString();
      const campaign = alpha.campaigns[0];
      campaign.stats.push({ lead_id: "lead-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0, reply_time: replyAt, lead_category: "Out Of Office" });
      campaign.threads!["lead-ben"].push({ type: "REPLY", stats_id: "stats-ben", message_id: "<real-ben@lumen.test>", time: replyAt, subject: "Re: Quick question", email_body: "Back now. Yes, let's talk.", from: "ben@lumen.test" });
      await sync(owner.workspaceId);
      await sync(owner.workspaceId);
      const ben = await prospect("lead-ben");
      assert.ok(ben.replied_at);
      assert.equal((await sql("select 1 from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [ben.id])).length, 1);
      assert.ok((await notifications(owner.workspaceId)).some((row) => row.title === "Ben Hart replied"));
    });

    it("doesn't count or act on a reply while its thread can't be read, then judges it once it can", async () => {
      const replyAt = new Date(Date.now() - 5_000).toISOString();
      const campaign = alpha.campaigns[0];
      campaign.stats.push({ lead_id: "lead-ivy", lead_email: "ivy@kiln.test", lead_name: "Ivy Bell", sequence_number: 1, sent_time: T0, reply_time: replyAt });
      campaign.threads!["lead-ivy"].push({ type: "REPLY", stats_id: "stats-ivy", message_id: "<ooo-ivy@kiln.test>", time: replyAt, subject: "Re: Quick question", email_body: "On leave.", is_auto_reply: true, from: "ivy@kiln.test" });
      alpha.fail = (url) => (url.pathname.endsWith("/leads/lead-ivy/message-history") ? new Response("{}", { status: 500 }) : null);
      try {
        await sync(owner.workspaceId);
      } finally {
        alpha.fail = undefined;
      }
      const ivy = await prospect("lead-ivy");
      const waiting = await sql<{ counted: boolean; fired: boolean; handled: boolean }>(
        "select counted_at is not null as counted, fired_at is not null as fired, handled_at is not null as handled from crm.campaign_events where prospect_id = $1 and kind = 'replied'",
        [ivy.id],
      );
      assert.deepEqual(waiting, [{ counted: false, fired: false, handled: false }]);
      assert.ok(!(await notifications(owner.workspaceId)).some((row) => row.title.startsWith("Ivy")));
      await sql("update crm.campaign_events set claimed_at = now() - interval '6 minutes' where prospect_id = $1 and claimed_at is not null and handled_at is null", [ivy.id]);
      await sync(owner.workspaceId);
      assert.equal((await prospect("lead-ivy")).replied_at, null);
      assert.equal((await sql("select 1 from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [ivy.id])).length, 0);
      assert.ok(!(await notifications(owner.workspaceId)).some((row) => row.title.startsWith("Ivy")));
    });

    it("keeps a counted reply counted", async () => {
      const priya = await prospect("lead-priya");
      const event = (await sql<{ id: string }>("select id from crm.campaign_events where prospect_id = $1 and kind = 'replied'", [priya.id]))[0];
      const result = await sql<{ done: boolean }>("select private.campaign_reply_uncount($1) as done", [event.id]);
      assert.equal(result[0].done, false);
      assert.ok((await prospect("lead-priya")).replied_at);
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

    it("shows a send that died mid-flight as May not have gone, and never sends it again", async () => {
      const priya = await prospectId("lead-priya");
      await sql(
        `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, send_state, client_key, sent_by_user_id, created_at)
         select p.workspace_id, p.campaign_id, p.id, 'email', 'outbound', 'A reply that never came back.', now() - interval '10 minutes', 'sending', 'stale-1', $2, now() - interval '10 minutes'
         from crm.campaign_prospects p where p.id = $1`,
        [priya, owner.userId],
      );
      const shown = (await getProspectThread(owner, priya)).items.find((item) => item.type === "message" && item.clientKey === "stale-1");
      assert.ok(shown && shown.type === "message");
      assert.deepEqual([shown.sendState, shown.sendError], ["unknown", "May not have gone."]);
      const writes = (alpha.writes ?? []).length;
      const again = await replyToProspect(owner, priya, { text: "A reply that never came back.", clientKey: "stale-1" }, { fetchImpl });
      assert.deepEqual([again.repeated, again.sendState], [true, "unknown"]);
      assert.equal((alpha.writes ?? []).length, writes);
      assert.equal((await sql<{ send_state: string }>("select send_state from crm.campaign_messages where client_key = 'stale-1'"))[0].send_state, "unknown");
    });

    it("treats a HeyReach success it can't read as maybe sent", async () => {
      heyreach.fail = (path) => (path === "/inbox/SendMessage" ? new Response("<html>ok", { status: 200 }) : null);
      try {
        const result = await replyToProspect(jess, await prospectId("lead-hr-dan"), { text: "Also free Thursday.", clientKey: "linkedin-2" }, { fetchImpl });
        assert.equal(result.sendState, "unknown");
      } finally {
        heyreach.fail = undefined;
      }
    });

    it("sends again after a clear refusal, stores it as outbound and files it on the timeline", async () => {
      const priya = await prospectId("lead-priya");
      alpha.fail = (url) => (url.pathname.endsWith("/reply-email-thread") ? new Response("{}", { status: 400 }) : null);
      await assert.rejects(replyToProspect(ann, priya, { text: "Following up on times.", clientKey: "email-2" }, { fetchImpl }), refused("upstream_failed"));
      alpha.fail = undefined;
      const state = await sql<{ send_state: string }>("select send_state from crm.campaign_messages where client_key = 'email-2'");
      assert.equal(state[0].send_state, "failed");
      const failedFor = async (viewer: UserActor) =>
        (await getProspectThread(viewer, priya)).items.find((item) => item.type === "message" && item.direction === "outbound" && item.sendState === "failed");
      const own = await failedFor(ann);
      assert.ok(own && own.type === "message");
      assert.equal(own.clientKey, "email-2");
      assert.ok(own.sendError);
      const theirs = await failedFor(owner);
      assert.ok(theirs && theirs.type === "message");
      assert.equal(theirs.clientKey, null);
      const sent = await replyToProspect(ann, priya, { text: "Following up on times.", clientKey: "email-2" }, { fetchImpl });
      assert.deepEqual([sent.sendState, sent.repeated], ["sent", false]);
      const writes = (alpha.writes ?? []).filter((write) => write.path === "/campaigns/801/reply-email-thread");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body?.email_stats_id, "stats-priya");
      assert.equal(writes[0].body?.reply_message_id, "<reply-priya@halcyon.test>");
      const filed = await sql<{ type: string; title: string }>("select type, title from crm.activities where metadata->>'campaignMessageId' = $1", [sent.messageId]);
      assert.deepEqual(filed.map((row) => [row.type, row.title]), [["email", "Reply sent in Agency outreach"]]);
      const replies = await audits(owner.workspaceId, "campaign.reply_sent");
      assert.deepEqual(replies.map((row) => row.changes.sendState), ["sent", "unknown", "unknown", "sent"]);
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
      const sends = heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length;
      await removeMember(owner, jess.userId);
      await assert.rejects(replyToProspect(jess, await prospectId("lead-hr-dan"), { text: "Still there?" }, { fetchImpl }), refused(["not_found", "forbidden"]));
      assert.equal(heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length, sends);
    });

    it("never puts a campaign reply in anyone's personal Mail", async () => {
      const mail = await sql<{ count: number }>(
        "select count(*)::int as count from crm.mail_messages where lower(coalesce(from_email, '')) in ('priya@halcyon.test', 'ben@lumen.test') or body_text ilike '%Happy to talk next week%' or body_text ilike '%Tuesday works%'",
      );
      assert.equal(mail[0].count, 0);
      const mine = await queryAsUser<{ count: number }>(owner.userId, "select count(*)::int as count from crm.mail_messages");
      assert.equal(mine[0].count, 0);
    });
  });

  describe("webhook registration, merging and disconnecting", () => {
    it("keeps the webhook secret out of the logs and shows the manual URL to admins only", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "smartlead"))!;
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = ORIGIN;
      const hook = campaignWebhookUrl(owner.workspaceId, "smartlead", secret)!;
      alpha.fail = (url) => (url.pathname.endsWith("/campaigns/801/webhooks") ? new Response(`Refused webhook_url ${encodeURIComponent(hook)} and ${hook.replace("&", "&amp;")}`, { status: 400 }) : null);
      const logged: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => {
        logged.push(parts.map((part) => (part instanceof Error ? `${part.message} ${part.stack}` : typeof part === "string" ? part : JSON.stringify(part))).join(" "));
      };
      try {
        await sync(owner.workspaceId);
      } finally {
        console.error = original;
        alpha.fail = undefined;
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
      assert.ok(logged.some((line) => line.includes("Smartlead request failed")));
      assert.ok(!logged.some((line) => line.includes(secret)));
      const state = await sql<{ external_id: string; failed: boolean; hooked: boolean }>(
        "select external_id, sync_state ? 'webhookFailedAt' as failed, sync_state ? 'webhookId' as hooked from crm.campaigns where workspace_id = $1 order by external_id",
        [owner.workspaceId],
      );
      assert.deepEqual(state.map((row) => [row.external_id, row.failed, row.hooked]), [["801", true, false], ["901", false, true]]);
      process.env.SITE_URL = ORIGIN;
      try {
        const views = await campaignConnectionViews(owner);
        assert.match(views.find((view) => view.provider === "smartlead")!.webhookUrl ?? "", /\/api\/webhooks\/smartlead\?w=.+&secret=/);
        assert.equal(views.find((view) => view.provider === "heyreach")!.webhookUrl, null);
        assert.equal((await campaignConnectionViews(ann)).find((view) => view.provider === "smartlead")!.webhookUrl, null);
      } finally {
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
    });

    it("keeps an unconfirmed stop and the messages when two prospects merge", async () => {
      const keep = (await createContact(owner, { firstName: "Sam", lastName: "One", email: "sam1@merge-replies.test" }, { provenance: { operation: "test" } })).body.contact.id;
      const merge = (await createContact(owner, { firstName: "Sam", lastName: "Two", email: "sam2@merge-replies.test" }, { provenance: { operation: "test" } })).body.contact.id;
      const founders = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '901'"))[0].id;
      const rows = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, external_lead_id, state, pushed_at, stop_requested_at, stop_reason)
         values ($1, $2, $3, 'lead-sam-1', 'pushed', now(), null, null), ($1, $2, $4, 'lead-sam-2', 'pushed', now(), now(), 'replied')
         returning id`,
        [owner.workspaceId, founders, keep, merge],
      );
      await sql(
        "insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, external_id) values ($1, $2, $3, 'linkedin', 'inbound', 'Hello', now(), 'sam-message')",
        [owner.workspaceId, founders, rows[1].id],
      );
      await mergeContacts(owner, keep, merge, { operation: "test" });
      const kept = await sql<{ stop: boolean; reason: string | null }>("select stop_requested_at is not null as stop, stop_reason as reason from crm.campaign_prospects where id = $1", [rows[0].id]);
      assert.deepEqual(kept, [{ stop: true, reason: "replied" }]);
      assert.deepEqual((await sql<{ prospect_id: string }>("select prospect_id from crm.campaign_messages where external_id = 'sam-message'")).map((row) => row.prospect_id), [rows[0].id]);
    });

    it("forgets a provider's webhooks when it is disconnected, so reconnecting adds them again", async () => {
      await removeCampaignConnection(owner, "heyreach");
      const state = await sql<{ hooked: boolean }>("select sync_state ? 'webhookId' as hooked from crm.campaigns where external_id = '901'");
      assert.deepEqual(state, [{ hooked: false }]);
      await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    });
  });

  describe("guards from the second review", () => {
    const smartleadOnly = (fetcher: typeof fetch, deadline = Date.now() + 60_000, onEvents = handleCampaignEvents) =>
      syncCampaigns({ workspaceId: owner.workspaceId, provider: "smartlead", deadline, fetchImpl: fetcher, onEvents });
    const heyreachOnly = (onEvents = handleCampaignEvents) => syncCampaigns({ workspaceId: owner.workspaceId, provider: "heyreach", deadline: Date.now() + 60_000, fetchImpl, onEvents });
    const replyFrom = (lead: string, email: string, name: string, body: string) => {
      const at = new Date(Date.now() - 15_000).toISOString();
      const campaign = alpha.campaigns[0];
      campaign.stats.push({ lead_id: lead, lead_email: email, lead_name: name, sequence_number: 1, sent_time: T0, reply_time: at });
      campaign.threads![lead].push({ type: "REPLY", stats_id: `stats-${lead}`, message_id: `<reply-${lead}@test>`, time: at, subject: "Re: Quick question", email_body: body, from: email });
    };
    const replyState = async (lead: string) =>
      (
        await sql<{ handled: boolean; claimed: boolean; counted: boolean }>(
          `select e.handled_at is not null as handled, e.claimed_at is not null as claimed, e.counted_at is not null as counted
           from crm.campaign_events e join crm.campaign_prospects p on p.id = e.prospect_id
           where p.external_lead_id = $1 and e.kind = 'replied'`,
          [lead],
        )
      )[0];
    const hangOn = (match: (url: string, init?: RequestInit) => boolean): typeof fetch => (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!match(url, init)) return fetchImpl(input, init);
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };

    it("hands over the rest of a batch when one reply's thread can't be read, keeping only that one for later", async () => {
      replyFrom("lead-uma", "uma@north.test", "Uma Reed", "Tell me more.");
      replyFrom("lead-vic", "vic@lane.test", "Vic Lane", "Yes please.");
      alpha.fail = (url) => (url.pathname.endsWith("/leads/lead-uma/message-history") ? new Response("{}", { status: 500 }) : null);
      try {
        await smartleadOnly(fetchImpl);
      } finally {
        alpha.fail = undefined;
      }
      assert.deepEqual(await replyState("lead-uma"), { handled: false, claimed: true, counted: false });
      assert.deepEqual(await replyState("lead-vic"), { handled: true, claimed: true, counted: true });
      assert.ok((await notifications(owner.workspaceId)).some((row) => row.title === "Vic Lane replied"));
      assert.equal((await sql<{ sync_error: string | null }>("select sync_error from crm.campaigns where external_id = '801'"))[0].sync_error, null);
    });

    it("reads a deleted lead's missing thread as empty without marking the campaign missing", async () => {
      replyFrom("lead-wes", "wes@gone.test", "Wes Gone", "Gone soon.");
      alpha.fail = (url) => (url.pathname.endsWith("/leads/lead-wes/message-history") ? new Response("{}", { status: 404 }) : null);
      try {
        await smartleadOnly(fetchImpl);
      } finally {
        alpha.fail = undefined;
      }
      assert.equal((await replyState("lead-wes")).handled, true);
      const campaign = await sql<{ missing: boolean; sync_error: string | null }>("select sync_state ? 'missingAt' as missing, sync_error from crm.campaigns where external_id = '801'");
      assert.deepEqual(campaign, [{ missing: false, sync_error: null }]);
    });

    it("skips a tombstoned reply when the poll brings it back", async () => {
      const tomb = (await sql<{ campaign_id: string; dedupe_key: string }>("select campaign_id, dedupe_key from crm.campaign_event_tombstones order by created_at limit 1"))[0];
      const inserted = await saveProviderEvents(tomb.campaign_id, [
        { externalLeadId: "lead-ben", email: "ben@lumen.test", linkedin: null, lead: {}, kind: "replied", step: 1, variant: null, occurredAt: new Date().toISOString(), dedupeKey: tomb.dedupe_key, category: null },
      ], false);
      assert.deepEqual(inserted, []);
      assert.equal((await sql("select 1 from crm.campaign_events where dedupe_key = $1", [tomb.dedupe_key])).length, 0);
    });

    it("confirms a reply only from a provider message sent after it", async () => {
      const priya = await prospectId("lead-priya");
      await sql(
        `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, send_state, client_key, sent_by_user_id)
         select p.workspace_id, p.campaign_id, p.id, 'email', 'outbound', 'Window check reply', now(), 'unknown', 'window-1', $2 from crm.campaign_prospects p where p.id = $1`,
        [priya, owner.userId],
      );
      await saveThread(priya, [
        { externalId: "<old-copy@test>", direction: "outbound", step: null, subject: null, body: "Window check reply", sentAt: new Date(Date.now() - 60 * 60_000).toISOString(), conversationId: null, senderId: null, statsId: null, providerMessageId: null, fromAddress: null, automatic: false, replyKey: null },
      ], { replyEvents: false, handled: true });
      const row = await sql<{ send_state: string; external_id: string | null }>("select send_state, external_id from crm.campaign_messages where client_key = 'window-1'");
      assert.deepEqual(row, [{ send_state: "unknown", external_id: null }]);
    });

    it("keeps a webhook's sync request when the request fails before its receipt", async () => {
      const secret = (await ensureWebhookSecret(owner.workspaceId, "smartlead"))!;
      const body = { event_type: "EMAIL_REPLY", campaign_id: 801, sl_email_lead_id: "lead-vic", sl_lead_email: "vic@lane.test" };
      await sql("revoke execute on function private.campaign_request_sync(uuid, text, text, text, text, text) from crm_app");
      try {
        await assert.rejects(webhook("smartlead", owner.workspaceId, secret, body, { "x-request-id": "req-15" }));
      } finally {
        await sql("grant execute on function private.campaign_request_sync(uuid, text, text, text, text, text) to crm_app");
      }
      const again = await webhook("smartlead", owner.workspaceId, secret, body, { "x-request-id": "req-15" });
      assert.deepEqual(await again.json(), { queued: 1 });
    });

    it("reads queued threads and sends stops before a slow poll can use up the run", async () => {
      await sql("update crm.campaign_prospects set sync_requested_at = now(), sync_claimed_at = null where external_lead_id = 'lead-tom'");
      await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'removed' where external_lead_id = 'lead-ivy'");
      await smartleadOnly(hangOn((url) => url.includes("/leads-statistics")), Date.now() + 9_000);
      assert.equal((await prospect("lead-tom")).sync_requested_at, null);
      assert.ok((await prospect("lead-ivy")).stopped_at);
    });

    it("carries on with the connection when the handover after queued threads fails", async () => {
      await sql("update crm.campaign_prospects set sync_requested_at = now(), sync_claimed_at = null where external_lead_id = 'lead-hr-dan'");
      heyreach.campaigns[0].conversations!.find((item) => item.id === "c-dan")!.messages.push({ createdAt: new Date().toISOString(), body: "One more thing.", sender: "CORRESPONDENT" });
      await heyreachOnly(async () => {
        throw new Error("handler down");
      });
      const connection = await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'heyreach'", [owner.workspaceId]);
      assert.equal(connection[0].last_error, null);
      await heyreachOnly();
    });

    it("doesn't mark the reply webhook failed when the run's own deadline cuts registration short", async () => {
      await sql("update crm.campaigns set sync_state = sync_state - 'webhookId' - 'webhookFailedAt' where external_id = '801'");
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = ORIGIN;
      try {
        await smartleadOnly(hangOn((url, init) => url.endsWith("/campaigns/801/webhooks") || (url.includes("/campaigns/801/webhooks?") && init?.method === "POST")), Date.now() + 9_000);
      } finally {
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
      const state = await sql<{ failed: boolean }>("select sync_state ? 'webhookFailedAt' as failed from crm.campaigns where external_id = '801'");
      assert.deepEqual(state, [{ failed: false }]);
    });

    it("audits a removal once, even when Remove is pressed twice", async () => {
      const campaign = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '801'"))[0].id;
      const zed = (
        await sql<{ id: string }>(
          "insert into crm.campaign_prospects (workspace_id, campaign_id, email, external_lead_id, state, pushed_at) values ($1, $2, 'zed@test.test', 'lead-zed', 'pushed', now()) returning id",
          [owner.workspaceId, campaign],
        )
      )[0].id;
      alpha.fail = (url) => (url.pathname.endsWith("/leads/lead-zed") ? new Response("{}", { status: 500 }) : null);
      try {
        assert.deepEqual(await removeProspect(owner, zed, { fetchImpl }), { state: "stopping" });
        await assert.rejects(removeProspect(owner, zed, { fetchImpl }), refused("conflict"));
      } finally {
        alpha.fail = undefined;
      }
      assert.equal((await audits(owner.workspaceId, "campaign.prospect_removed")).filter((row) => row.entity_id === zed).length, 1);
    });

    it("refreshes the rest of a thread when one campaign can't be read", async () => {
      const priya = await prospectId("lead-priya");
      const reads = heyreach.calls.filter((call) => call.path === "/inbox/GetConversationsV2").length;
      alpha.fail = (url) => (url.pathname.endsWith("/leads/lead-priya/message-history") ? new Response("{}", { status: 500 }) : null);
      try {
        const result = await refreshProspectThread(owner, priya, { fetchImpl, force: true });
        assert.equal(result.failed, true);
      } finally {
        alpha.fail = undefined;
      }
      assert.ok(heyreach.calls.filter((call) => call.path === "/inbox/GetConversationsV2").length > reads);
    });

    it("keeps at most 1,000 stray conversations", async () => {
      const ids = Array.from({ length: 1000 }, (_, index) => `stray-${index}`);
      await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('strayIds', $1::jsonb, 'strayConversations', 1000) where external_id = '901'", [JSON.stringify(ids)]);
      heyreach.campaigns[0].conversations!.push({ id: "c-stranger-2", accountId: 1, profileUrl: "https://www.linkedin.com/in/another-stranger/", messages: [{ createdAt: new Date().toISOString(), body: "Hello?", sender: "CORRESPONDENT" }] });
      await heyreachOnly();
      const founders = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '901'"))[0].id;
      assert.equal((await getCampaign(owner, founders)).strayConversations, 1000);
    });

    it("guards a counted reply with counted_at, not with fired_at", async () => {
      const zed = await prospectId("lead-zed");
      const campaign = (await sql<{ id: string }>("select id from crm.campaigns where external_id = '801'"))[0].id;
      const events = await sql<{ id: string }>(
        `insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key, fired_at, counted_at)
         values ($1, $2, $3, 'replied', now(), 'guard-fired', now(), null), ($1, $2, $3, 'replied', now(), 'guard-counted', null, now())
         returning id`,
        [owner.workspaceId, campaign, zed],
      );
      const done = async (id: string) => (await sql<{ done: boolean }>("select private.campaign_reply_uncount($1) as done", [id]))[0].done;
      assert.equal(await done(events[0].id), true);
      assert.equal(await done(events[1].id), false);
    });

    it("resumes a long conversation read where it stopped, so a big backfill finishes", async () => {
      const conversations = Array.from({ length: 2100 }, (_, index) => ({
        id: `c-many-${index}`,
        accountId: 1,
        profileUrl: `https://www.linkedin.com/in/many-${index}/`,
        messages: [{ createdAt: "2026-11-13T10:00:00.000Z", body: "Hi", sender: "CORRESPONDENT" as const }],
      }));
      heyreach.campaigns.push({ id: 903, name: "Founders three", status: "IN_PROGRESS", accountIds: [1], sequence: [], leads: [], overall: {}, byDay: {}, conversations });
      await heyreachOnly();
      const first = await sql<{ backfilled: boolean; offset: string | null }>("select backfilled_at is not null as backfilled, sync_state->>'repliesOffset' as offset from crm.campaigns where external_id = '903'");
      assert.deepEqual(first, [{ backfilled: false, offset: "2000" }]);
      await heyreachOnly();
      const second = await sql<{ backfilled: boolean; offset: string | null }>("select backfilled_at is not null as backfilled, sync_state->>'repliesOffset' as offset from crm.campaigns where external_id = '903'");
      assert.deepEqual(second, [{ backfilled: true, offset: null }]);
    });

    it("stores a reply that fails after it was saved as stored, and a retry never sends it again", async () => {
      const priya = await prospectId("lead-priya");
      const sends = () => (alpha.writes ?? []).filter((write) => write.path === "/campaigns/801/reply-email-thread").length;
      const before = sends();
      await sql("revoke execute on function private.campaign_reply_finish(uuid, uuid, text, text, text) from crm_app");
      try {
        await assert.rejects(replyToProspect(owner, priya, { text: "Sent but not recorded.", clientKey: "after-begin-1" }, { fetchImpl }), (error: unknown) => {
          assert.ok(error instanceof CrmError);
          assert.equal(typeof error.details?.messageId, "string");
          return true;
        });
      } finally {
        await sql("grant execute on function private.campaign_reply_finish(uuid, uuid, text, text, text) to crm_app");
      }
      assert.equal(sends(), before + 1);
      const again = await replyToProspect(owner, priya, { text: "Sent but not recorded.", clientKey: "after-begin-1" }, { fetchImpl });
      assert.equal(again.repeated, true);
      assert.equal(sends(), before + 1);
    });

    it("stops handing replies to a provider that says it's busy, keeping the rest for later", async () => {
      replyFrom("lead-xa", "xa@busy.test", "Xa Busy", "One.");
      replyFrom("lead-xb", "xb@busy.test", "Xb Busy", "Two.");
      const reads = () => alpha.calls.filter((url) => /\/leads\/lead-x[ab]\/message-history$/.test(url.pathname)).length;
      const before = reads();
      alpha.fail = (url) => (/\/leads\/lead-x[ab]\/message-history$/.test(url.pathname) ? new Response("{}", { status: 429, headers: { "retry-after": "60" } }) : null);
      let report;
      try {
        report = await smartleadOnly(fetchImpl);
      } finally {
        alpha.fail = undefined;
      }
      assert.equal(reads() - before, 1);
      assert.ok(report.busy.length > 0);
      assert.deepEqual([(await replyState("lead-xa")).handled, (await replyState("lead-xb")).handled], [false, false]);
    });

    it("keeps each page of a conversation read when a later page fails", async () => {
      const conversations = Array.from({ length: 250 }, (_, index) => ({
        id: `c-paged-${index}`,
        accountId: 1,
        profileUrl: `https://www.linkedin.com/in/paged-${index}/`,
        messages: [{ createdAt: "2026-11-13T10:00:00.000Z", body: "Hi", sender: "CORRESPONDENT" as const }],
      }));
      heyreach.campaigns.push({ id: 904, name: "Founders four", status: "IN_PROGRESS", accountIds: [1], sequence: [], leads: [], overall: {}, byDay: {}, conversations });
      let reads = 0;
      heyreach.fail = (path) => (path === "/inbox/GetConversationsV2" && ++reads === 2 ? new Response("{}", { status: 500 }) : null);
      try {
        await heyreachOnly();
      } finally {
        heyreach.fail = undefined;
      }
      const state = await sql<{ offset: string | null }>("select sync_state->>'repliesOffset' as offset from crm.campaigns where external_id = '904'");
      assert.deepEqual(state, [{ offset: "100" }]);
    });

    it("finishes a backfill even when its conversations can't be read", async () => {
      heyreach.campaigns.push({ id: 902, name: "Founders two", status: "IN_PROGRESS", accountIds: [1], sequence: [], leads: [], overall: {}, byDay: {} });
      heyreach.fail = (path) => (path === "/inbox/GetConversationsV2" ? new Response("{}", { status: 500 }) : null);
      try {
        await heyreachOnly();
      } finally {
        heyreach.fail = undefined;
      }
      const row = await sql<{ backfilled: boolean }>("select backfilled_at is not null as backfilled from crm.campaigns where external_id = '902'");
      assert.deepEqual(row, [{ backfilled: true }]);
    });
  });
});
