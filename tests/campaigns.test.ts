import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { campaignConnectionViews, keyFingerprint, KEY_TAKEN, removeCampaignConnection, saveCampaignConnection } from "@/lib/campaigns/connections";
import { syncCampaigns, type SyncedEvent } from "@/lib/campaigns/sync";
import { getCampaign, importCampaignProspects, listCampaignProspects, listCampaigns } from "@/lib/crm/campaigns";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fakeSmartlead, sequenceOf, type FakeAccount, type FakeCampaign, type FakeLead, type FakeStat } from "./campaigns-fake";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const KEY = "sl_client_key_eclipse_0001";
const OTHER_KEY = "sl_client_key_ridgeon_0002";
const LIMIT_ENV = [
  "WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE",
  "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR",
  "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE",
] as const;

let owner: UserActor;
let adminUser: UserActor;
let member: UserActor;
let outsider: UserActor;
const savedEnv: Record<string, string | undefined> = {};

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

function leads(count: number, prefix: string): FakeLead[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    email: `person${index + 1}@${prefix}.test`,
    first: `Person${index + 1}`,
    last: prefix,
    company: `${prefix} Ltd`,
    website: `https://${prefix}.test`,
  }));
}

function agencyCampaign(): FakeCampaign {
  const people: FakeLead[] = [
    { id: "lead-jane", email: "Jane@Acme.test", first: "Jane", last: "Doe", company: "Acme", website: "acme.test" },
    ...leads(129, "bulk"),
  ];
  const stats: FakeStat[] = [
    { lead_id: "lead-jane", lead_email: "jane@acme.test", lead_name: "Jane Doe", sequence_number: 1, sent_time: "2026-11-10T09:00:00.000Z", open_time: "2026-11-10T10:00:00.000Z", reply_time: "2026-11-11T08:30:00.000Z", lead_category: "Interested" },
    { lead_id: "bulk-1", lead_email: "person1@bulk.test", lead_name: "Person1 bulk", sequence_number: 1, sent_time: "2026-11-10T09:05:00.000Z", is_bounced: true },
    { lead_id: "bulk-2", lead_email: "person2@bulk.test", lead_name: "Person2 bulk", sequence_number: 1, sent_time: "2026-11-10T09:06:00.000Z" },
    { lead_id: "bulk-2", lead_email: "person2@bulk.test", lead_name: "Person2 bulk", sequence_number: 2, sent_time: "2026-11-13T09:06:00.000Z" },
  ];
  return {
    id: 501,
    name: "Agency outreach",
    status: "ACTIVE",
    leads: people,
    stats,
    sequences: sequenceOf([
      {
        subject: "",
        body: "",
        variants: [
          { label: "A", subject: "Quick question about {{news_hook}}", body: "Hi {{first_name}}, {{opener}}" },
          { label: "B", subject: "{{first_name}}, saw {{news_hook}}", body: "{{opener}}" },
        ],
      },
      { subject: "", body: "Re: previous, with {{proof_line}}", delay: 3 },
    ]),
    analytics: {
      id: 501,
      status: "ACTIVE",
      sent_count: "4",
      unique_sent_count: "3",
      open_count: "1",
      reply_count: "1",
      bounce_count: "1",
      unsubscribed_count: "0",
      campaign_lead_stats: { total: 130, interested: 1 },
    },
    mailboxes: [
      { id: 1, from_email: "mark@getacme.test", message_per_day: 20, is_smtp_success: true, is_imap_success: true, warmup_details: { warmup_reputation: "100%" } },
      { id: 2, from_email: "hello@tryacme.test", message_per_day: 20, is_smtp_success: false, is_imap_success: true, warmup_details: { warmup_reputation: "97%" } },
    ],
  };
}

function draftCampaign(): FakeCampaign {
  return { id: 502, name: "SaaS heads of marketing", status: "DRAFTED", leads: [], stats: [], sequences: [], analytics: { id: 502, status: "DRAFTED" } };
}

function account(key: string, name: string, campaigns: FakeCampaign[]): FakeAccount {
  return { key, client: { id: name === "Eclipse" ? 11 : 12, name }, campaigns, calls: [] };
}

async function counts(workspaceId: string) {
  const rows = await sql<{ events: number; notifications: number; contacts: number }>(
    `select (select count(*)::int from crm.workflow_events where workspace_id = $1) as events,
            (select count(*)::int from crm.notifications where workspace_id = $1) as notifications,
            (select count(*)::int from crm.contacts where workspace_id = $1) as contacts`,
    [workspaceId],
  );
  return rows[0];
}

describe("campaigns", () => {
  const eclipse = account(KEY, "Eclipse", [agencyCampaign(), draftCampaign()]);
  const ridgeon = account(OTHER_KEY, "Ridgeon", [
    {
      id: 777,
      name: "Ridgeon cold",
      status: "ACTIVE",
      leads: leads(3, "ridgeon"),
      stats: Array.from({ length: 150 }, (_, index) => ({
        lead_id: `ridgeon-${(index % 3) + 1}`,
        lead_email: `person${(index % 3) + 1}@ridgeon.test`,
        lead_name: "Ridgeon person",
        sequence_number: index + 1,
        sent_time: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString(),
      })),
      sequences: [],
      analytics: { id: 777, status: "ACTIVE", sent_count: 150 },
    },
  ]);
  const fetchImpl = fakeSmartlead([eclipse, ridgeon]);

  before(async () => {
    await resetDatabase();
    for (const name of LIMIT_ENV) savedEnv[name] = process.env[name];
    process.env.WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE = "100000";
    process.env.WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR = "100000";
    process.env.WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE = "100000";
    owner = await createUser("mark@campaigns.test", "Mark Ridgeon");
    const second = await createUser("ann@campaigns.test", "Ann Admin");
    const third = await createUser("mo@campaigns.test", "Mo Member");
    outsider = await createUser("oscar@elsewhere-campaigns.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')", [owner.workspaceId, second.userId, third.userId]);
    adminUser = { ...second, workspaceId: owner.workspaceId, role: "admin", scopes: scopesForRole("admin") };
    member = { ...third, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    for (const name of LIMIT_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await getPool().end();
    await getAdminPool().end();
  });

  beforeEach(async () => {
    await sql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:smartlead%'");
  });

  useServerlessPool();

  describe("the campaigns:write scope", () => {
    it("is a scope every member gets and agent tokens may hold", async () => {
      assert.ok(SCOPES.includes("campaigns:write"));
      assert.ok(scopesForRole("member").includes("campaigns:write"));
      const created = await sql<{ id: string }>("insert into crm.agents (workspace_id, name, scopes) values ($1, 'Campaign agent', $2) returning id", [owner.workspaceId, ["crm:read", "campaigns:write"]]);
      assert.equal(created.length, 1);
      await assert.rejects(
        sql("insert into crm.agents (workspace_id, name, scopes) values ($1, 'Wrong agent', $2)", [owner.workspaceId, ["campaigns:read"]]),
        /agents_scopes_valid/,
      );
      await sql("delete from crm.agents where id = $1", [created[0].id]);
    });
  });

  describe("connecting Smartlead", () => {
    it("refuses a key Smartlead rejects", async () => {
      await assert.rejects(saveCampaignConnection(owner, "smartlead", "sl_wrong_key_123", { fetchImpl }), refused("invalid_input", /^Smartlead rejected the key\.$/));
      assert.equal((await sql("select 1 from crm.campaign_connections")).length, 0);
    });

    it("lets only owners and admins save a key", async () => {
      await assert.rejects(saveCampaignConnection(member, "smartlead", KEY, { fetchImpl }), refused("forbidden", /owner or admin/));
      const agent = (await createAgent(owner.workspaceId, [...SCOPES], "Admin agent")).actor;
      await assert.rejects(saveCampaignConnection(agent, "smartlead", KEY, { fetchImpl }), refused("forbidden"));
    });

    it("checks the key, reads the client and stores the key encrypted", async () => {
      const saved = await saveCampaignConnection(adminUser, "smartlead", `  ${KEY}  `, { fetchImpl });
      assert.equal(saved.line, "Connected to client Eclipse. 2 campaigns.");
      const rows = await sql<{ key_encrypted: string; key_fingerprint: string; connected_by: string; details: Record<string, unknown> }>(
        "select key_encrypted, key_fingerprint, connected_by, details from crm.campaign_connections where workspace_id = $1",
        [owner.workspaceId],
      );
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].key_encrypted, KEY);
      assert.ok(!rows[0].key_encrypted.includes(KEY));
      assert.equal(decryptSecret(rows[0].key_encrypted), KEY);
      assert.equal(rows[0].key_fingerprint, keyFingerprint("smartlead", KEY));
      assert.equal(rows[0].connected_by, adminUser.userId);
      assert.equal(rows[0].details.clientName, "Eclipse");
      const audit = await sql<{ event_type: string; entity_type: string }>("select event_type, entity_type from crm.audit_events where workspace_id = $1 and event_type like 'campaign.%'", [owner.workspaceId]);
      assert.deepEqual(audit, [{ event_type: "campaign.connection_changed", entity_type: "campaign_connection" }]);
    });

    it("refuses a key already connected to another workspace", async () => {
      await assert.rejects(saveCampaignConnection(outsider, "smartlead", KEY, { fetchImpl }), refused("conflict", new RegExp(`^${KEY_TAKEN}$`)));
      await assert.rejects(
        sql("insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, 'smartlead', 'x', $2)", [
          outsider.workspaceId,
          keyFingerprint("smartlead", KEY),
        ]),
        /campaign_connections_fingerprint_uidx/,
      );
      const again = await saveCampaignConnection(owner, "smartlead", KEY, { fetchImpl });
      assert.match(again.line, /^Connected to client Eclipse\./);
    });

    it("never shows members the key, its fingerprint or the webhook secret", async () => {
      for (const column of ["key_encrypted", "key_fingerprint", "webhook_secret"]) {
        await assert.rejects(queryAsUser(member.userId, `select ${column} from crm.campaign_connections`), /permission denied/);
        await assert.rejects(queryAsUser(owner.userId, `select ${column} from crm.campaign_connections`), /permission denied/);
      }
      await assert.rejects(queryAsUser(member.userId, "select * from crm.campaign_connections"), /permission denied/);
      const visible = await queryAsUser<{ provider: string }>(member.userId, "select provider from crm.campaign_connections");
      assert.deepEqual(visible, [{ provider: "smartlead" }]);
      assert.deepEqual(await queryAsUser(member.userId, "update crm.campaign_connections set details = '{}'::jsonb returning id"), []);
      assert.deepEqual(await queryAsUser(member.userId, "delete from crm.campaign_connections returning id"), []);
      const agent = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).actor;
      await assert.rejects(withActor(agent, (db) => db.query("select key_encrypted from crm.campaign_connections")), /permission denied/);

      const [memberView] = await campaignConnectionViews(member);
      assert.equal(memberView.connected, true);
      assert.equal(memberView.keyHint, null);
      assert.equal(memberView.canAdmin, false);
      const [ownerView] = await campaignConnectionViews(owner);
      assert.equal(ownerView.keyHint, KEY.slice(-4));
    });
  });

  describe("sync and backfill", () => {
    let jane: string;
    let agencyId: string;
    const seen: SyncedEvent[][] = [];
    const onEvents = async (_campaign: unknown, events: SyncedEvent[]) => {
      seen.push(events);
    };

    it("backfills every campaign, matches people by email and creates nobody", async () => {
      jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" }, { provenance: { operation: "test" } })).body.contact.id;
      const before = await counts(owner.workspaceId);
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents });
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.busy, []);
      assert.equal(report.backfilled, 2);

      const campaigns = await sql<{ id: string; external_id: string; status: string; channel: string; variables: string[]; stats: Record<string, number>; backfilled_at: Date | null }>(
        "select id, external_id, status, channel, variables, stats, backfilled_at from crm.campaigns where workspace_id = $1 order by external_id",
        [owner.workspaceId],
      );
      assert.deepEqual(campaigns.map((row) => [row.external_id, row.status, row.channel]), [["501", "active", "email"], ["502", "drafted", "email"]]);
      assert.ok(campaigns.every((row) => row.backfilled_at));
      assert.deepEqual(campaigns[0].variables, ["first_name", "news_hook", "opener", "proof_line"]);
      assert.equal(campaigns[0].stats.sent, 4);
      assert.equal(campaigns[0].stats.positive, 1);
      agencyId = campaigns[0].id;

      const prospects = await sql<{ external_lead_id: string; contact_id: string | null; email: string; replied_at: Date | null; category: string | null; lead_status: string; state: string }>(
        "select external_lead_id, contact_id, email, replied_at, category, lead_status, state from crm.campaign_prospects where campaign_id = $1",
        [agencyId],
      );
      assert.equal(prospects.length, 130);
      const janeRow = prospects.find((row) => row.external_lead_id === "lead-jane")!;
      assert.equal(janeRow.contact_id, jane);
      assert.equal(janeRow.email, "jane@acme.test");
      assert.equal(janeRow.replied_at?.toISOString(), "2026-11-11T08:30:00.000Z");
      assert.equal(janeRow.category, "Interested");
      assert.equal(janeRow.state, "pushed");
      assert.equal(janeRow.lead_status, "in_progress");
      assert.equal(prospects.filter((row) => row.contact_id).length, 1);

      const events = await sql<{ kind: string; step: number }>("select kind, step from crm.campaign_events where campaign_id = $1 order by occurred_at, kind", [agencyId]);
      assert.deepEqual(events.map((row) => `${row.kind}:${row.step}`), ["sent:1", "bounced:1", "sent:1", "sent:1", "opened:1", "replied:1", "sent:2"]);

      const afterCounts = await counts(owner.workspaceId);
      assert.equal(afterCounts.events, before.events);
      assert.equal(afterCounts.notifications, before.notifications);
      assert.equal(afterCounts.contacts, before.contacts);
      assert.equal(seen.length, 0);
      const statCalls = eclipse.calls.filter((url) => url.pathname.endsWith("/leads-statistics"));
      assert.ok(statCalls.every((url) => !url.searchParams.has("event_time_gt")));
    });

    it("adds only new events on later syncs, and hands them on", async () => {
      const campaign = eclipse.campaigns[0];
      campaign.stats.push({ lead_id: "bulk-2", lead_email: "person2@bulk.test", lead_name: "Person2 bulk", sequence_number: 2, sent_time: "2026-11-13T09:06:00.000Z", reply_time: new Date().toISOString() });
      eclipse.calls.length = 0;
      const before = await counts(owner.workspaceId);
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents });
      assert.deepEqual(report.errors, []);
      assert.equal(report.events, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].map((event) => event.kind), ["replied"]);
      const statCalls = eclipse.calls.filter((url) => url.pathname.endsWith("/campaigns/501/leads-statistics"));
      assert.ok(statCalls.length > 0 && statCalls.every((url) => url.searchParams.has("event_time_gt")));
      assert.equal(eclipse.calls.filter((url) => url.pathname.endsWith("/campaigns/501/leads")).length, 0);
      assert.equal(eclipse.calls.filter((url) => url.pathname.endsWith("/campaigns/501/sequences")).length, 0);
      const afterCounts = await counts(owner.workspaceId);
      assert.equal(afterCounts.contacts, before.contacts);
      const replied = await sql<{ replied_at: Date | null }>("select replied_at from crm.campaign_prospects where campaign_id = $1 and external_lead_id = 'bulk-2'", [agencyId]);
      assert.ok(replied[0].replied_at);
    });

    it("shows campaigns, steps, prospects and mailboxes to every member", async () => {
      const list = await listCampaigns(member);
      assert.deepEqual(list.map((item) => [item.name, item.prospects]), [["Agency outreach", 130], ["SaaS heads of marketing", 0]]);
      const detail = await getCampaign(member, agencyId);
      assert.deepEqual(detail.sequence.map((step) => `${step.step}${step.variant ?? ""}`), ["1A", "1B", "2"]);
      assert.equal(detail.unlinked, 129);
      assert.equal(detail.days.length, 30);
      assert.match(detail.url ?? "", /app\.smartlead\.ai\/app\/email-campaign\/501/);
      const stepOne = detail.stepStats.find((row) => row.step === 1);
      assert.equal(stepOne?.sent, 3);
      const replied = await listCampaignProspects(member, agencyId, { filter: "replied" });
      assert.deepEqual(replied.rows.map((row) => row.name).sort(), ["Jane Doe", "Person2 bulk"]);
      const searched = await listCampaignProspects(member, agencyId, { search: "person12@" });
      assert.deepEqual(searched.rows.map((row) => row.email), ["person12@bulk.test"]);
      const page = await listCampaignProspects(member, agencyId, { page: 2 });
      assert.equal(page.total, 130);
      assert.equal(page.rows.length, 30);
    });

    it("imports the people who aren't in Orbit yet when asked", async () => {
      const before = await counts(owner.workspaceId);
      const result = await importCampaignProspects(member, agencyId, { deadline: Date.now() + 60_000 });
      assert.equal(result.linked, 129);
      assert.equal(result.imported, 129);
      assert.equal(result.left, 0);
      const afterCounts = await counts(owner.workspaceId);
      assert.equal(afterCounts.contacts, before.contacts + 129);
      const linked = await sql<{ email: string; contact_email: string }>(
        "select p.email, c.normalized_email as contact_email from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where p.campaign_id = $1 and p.external_lead_id = 'bulk-7'",
        [agencyId],
      );
      assert.deepEqual(linked, [{ email: "person7@bulk.test", contact_email: "person7@bulk.test" }]);
      const again = await importCampaignProspects(member, agencyId, { deadline: Date.now() + 60_000 });
      assert.deepEqual(again, { imported: 0, linked: 0, failed: 0, left: 0 });
    });
  });

  describe("limits", () => {
    it("waits when the statistics limit is used up and carries on from the same page", async () => {
      await saveCampaignConnection(outsider, "smartlead", OTHER_KEY, { fetchImpl });
      process.env.WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE = "1";
      try {
        const first = await syncCampaigns({ workspaceId: outsider.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.deepEqual(first.errors, []);
        assert.equal(first.busy.length, 1);
        assert.match(first.busy[0], /Smartlead/);
        const state = await sql<{ sync_state: Record<string, unknown>; backfilled_at: Date | null }>("select sync_state, backfilled_at from crm.campaigns where workspace_id = $1", [outsider.workspaceId]);
        assert.equal(state[0].sync_state.eventsOffset, 100);
        assert.equal(state[0].backfilled_at, null);
        const connection = await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1", [outsider.workspaceId]);
        assert.equal(connection[0].last_error, null);
      } finally {
        process.env.WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE = "100000";
      }
      await sql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:smartlead%'");
      ridgeon.calls.length = 0;
      const second = await syncCampaigns({ workspaceId: outsider.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.deepEqual(second.busy, []);
      assert.equal(second.backfilled, 1);
      const offsets = ridgeon.calls.filter((url) => url.pathname.endsWith("/leads-statistics")).map((url) => url.searchParams.get("offset"));
      assert.deepEqual(offsets, ["100"]);
      const events = await sql<{ count: number }>("select count(*)::int as count from crm.campaign_events where workspace_id = $1", [outsider.workspaceId]);
      assert.equal(events[0].count, 150);
    });

    it("waits for Retry-After when Smartlead answers 429", async () => {
      let refusedOnce = false;
      eclipse.fail = (url) => {
        if (refusedOnce || !url.pathname.endsWith("/analytics")) return null;
        refusedOnce = true;
        return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
      };
      try {
        const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.deepEqual(report.errors, []);
        assert.equal(report.busy.length, 1);
        const connection = await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1", [owner.workspaceId]);
        assert.equal(connection[0].last_error, null);
      } finally {
        eclipse.fail = undefined;
      }
    });

    it("records a rejected key without throwing", async () => {
      eclipse.fail = () => new Response("{}", { status: 401 });
      try {
        const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.deepEqual(report.errors, ["Smartlead rejected the key. Save a new one."]);
        const [view] = await campaignConnectionViews(member);
        assert.equal(view.lastError, "Smartlead rejected the key. Save a new one.");
      } finally {
        eclipse.fail = undefined;
      }
      await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      const [view] = await campaignConnectionViews(member);
      assert.equal(view.lastError, null);
    });
  });

  describe("privacy", () => {
    it("shows other workspaces nothing", async () => {
      const ours = (await listCampaigns(owner)).map((item) => item.id);
      const theirs = await listCampaigns(outsider);
      assert.deepEqual(theirs.map((item) => item.name), ["Ridgeon cold"]);
      for (const id of ours) await assert.rejects(getCampaign(outsider, id), refused("not_found"));
      await assert.rejects(listCampaignProspects(outsider, ours[0]), refused("not_found"));
      await assert.rejects(importCampaignProspects(outsider, ours[0]), refused("not_found"));
      for (const table of ["campaigns", "campaign_prospects", "campaign_events", "campaign_connections"]) {
        const rows = await queryAsUser<{ count: number }>(outsider.userId, `select count(*)::int as count from crm.${table} where workspace_id = $1`, [owner.workspaceId]);
        assert.equal(rows[0].count, 0, table);
      }
    });

    it("lets members read but not change campaigns or events", async () => {
      await assert.rejects(queryAsUser(member.userId, "update crm.campaigns set name = 'Changed'"), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key) select workspace_id, campaign_id, id, 'replied', now(), 'fake' from crm.campaign_prospects limit 1"), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "update crm.campaign_prospects set replied_at = now()"), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "select private.campaign_connection_key($1, 'smartlead')", [owner.workspaceId]), /permission denied/);
      const outsiderContact = (await createContact(outsider, { firstName: "Zed", email: "zed@elsewhere.test" }, { provenance: { operation: "test" } })).body.contact.id;
      assert.deepEqual(
        await queryAsUser(member.userId, "update crm.campaign_prospects set contact_id = $1 where id = (select id from crm.campaign_prospects where workspace_id = $2 and contact_id is not null limit 1) returning id", [outsiderContact, owner.workspaceId]),
        [],
      );
    });

    it("gives agent tokens reads with crm:read and Import only with campaigns:write", async () => {
      const agencyId = (await listCampaigns(owner)).find((item) => item.name === "Agency outreach")!.id;
      const reader = (await createAgent(owner.workspaceId, ["crm:read", "contacts:write"], "Reader agent")).actor;
      assert.equal((await listCampaigns(reader)).length, 2);
      assert.equal((await listCampaignProspects(reader, agencyId)).total, 130);
      await assert.rejects(importCampaignProspects(reader, agencyId), refused("forbidden", /campaigns:write/));
      const writer = (await createAgent(owner.workspaceId, ["crm:read", "contacts:write", "campaigns:write"], "Writer agent")).actor;
      const result = await importCampaignProspects(writer, agencyId, { deadline: Date.now() + 10_000 });
      assert.equal(result.left, 0);
      const elsewhere = (await createAgent(outsider.workspaceId, [...SCOPES], "Elsewhere agent")).actor;
      assert.deepEqual((await listCampaigns(elsewhere)).map((item) => item.name), ["Ridgeon cold"]);
      await assert.rejects(getCampaign(elsewhere, agencyId), refused("not_found"));
    });
  });

  describe("disconnecting", () => {
    it("keeps the history and stops sync", async () => {
      await assert.rejects(removeCampaignConnection(member, "smartlead"), refused("forbidden"));
      assert.equal(await removeCampaignConnection(owner, "smartlead"), true);
      eclipse.calls.length = 0;
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.equal(report.connections, 0);
      assert.equal(eclipse.calls.length, 0);
      assert.equal((await listCampaigns(member)).length, 2);
      const [view] = await campaignConnectionViews(owner);
      assert.equal(view.connected, false);
    });
  });
});
