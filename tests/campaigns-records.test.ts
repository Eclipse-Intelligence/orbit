import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { keyFingerprint, saveCampaignConnection } from "@/lib/campaigns/connections";
import { linkCampaignSender, listCampaignSenders } from "@/lib/campaigns/senders";
import { syncActor, syncCampaigns, type SyncedEvent } from "@/lib/campaigns/sync";
import { campaignSyncLine, prospectLine } from "@/lib/campaigns/format";
import { getCampaign, importCampaignProspects, lastingImportFailure, listCampaignProspects } from "@/lib/crm/campaigns";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { moveRecordsToWorkspace, previewMoveToWorkspace } from "@/lib/crm/move-workspace";
import { scopesForRole } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fakeHeyReach, fakeSmartlead, type FakeAccount, type FakeCampaign, type FakeHeyReachAccount, type FakeLead } from "./campaigns-fake";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const PROVENANCE = { operation: "campaign_records_test", source: "test" };

let eclipse: UserActor;
let ridgeon: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function contact(input: Record<string, unknown>) {
  return (await createContact(eclipse, input, { provenance: PROVENANCE })).body.contact;
}

async function company(name: string, domain: string) {
  return (await createCompany(eclipse, { name, domain }, { provenance: PROVENANCE })).body.company;
}

let campaignCount = 0;

async function campaign(name: string, status = "active") {
  campaignCount += 1;
  const rows = await sql<{ id: string }>(
    "insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status) values ($1, 'smartlead', 'email', $2, $3, $4) returning id",
    [eclipse.workspaceId, String(9000 + campaignCount), name, status],
  );
  return rows[0].id;
}

async function prospect(campaignId: string, values: { contactId?: string | null; companyId?: string | null; email?: string; lead?: string; state?: string; leadStatus?: string; stoppedAt?: string | null; repliedAt?: string | null }) {
  const rows = await sql<{ id: string }>(
    `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, company_id, email, external_lead_id, state, lead_status, stopped_at, replied_at, last_event_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id`,
    [
      eclipse.workspaceId,
      campaignId,
      values.contactId ?? null,
      values.companyId ?? null,
      values.email ?? null,
      values.lead ?? null,
      values.state ?? "pushed",
      values.leadStatus ?? "in_progress",
      values.stoppedAt ?? null,
      values.repliedAt ?? null,
    ],
  );
  return rows[0].id;
}

async function event(campaignId: string, prospectId: string, kind: string, key: string) {
  await sql(
    "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, step, occurred_at, dedupe_key) values ($1, $2, $3, $4, 1, now(), $5)",
    [eclipse.workspaceId, campaignId, prospectId, kind, key],
  );
}

function refused(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.match(error.message, pattern);
    return true;
  };
}

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("campaign prospects when records merge or move", () => {
  before(async () => {
    await resetDatabase();
    const mark = await createUser("mark@campaign-records.test", "Mark Ridgeon");
    await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    eclipse = { ...mark, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  });

  useServerlessPool();

  it("keeps one row per campaign when contacts merge, with the other row's events", async () => {
    const keep = await contact({ firstName: "Sarah", lastName: "Kent", email: "sarah@northfold.test" });
    const merge = await contact({ firstName: "Sarah", lastName: "Kent", email: "s.kent@northfold.test" });
    const shared = await campaign("Agency outreach");
    const only = await campaign("Founders");
    const kept = await prospect(shared, { contactId: keep.id, email: "sarah@northfold.test", lead: "lead-1" });
    const merged = await prospect(shared, { contactId: merge.id, email: "s.kent@northfold.test", lead: "lead-2", repliedAt: "2026-11-10T09:00:00Z" });
    const elsewhere = await prospect(only, { contactId: merge.id, email: "s.kent@northfold.test", lead: "lead-3" });
    await event(shared, kept, "sent", "k1");
    await event(shared, merged, "sent", "m1");
    await event(shared, merged, "replied", "m2");

    const result = await mergeContacts(eclipse, keep.id, merge.id, PROVENANCE);
    assert.equal(result.moved.campaign_prospects, 1);
    assert.equal(result.moved.campaign_prospects_combined, 1);

    const rows = await sql<{ id: string; contact_id: string; replied_at: Date | null }>(
      "select id, contact_id, replied_at from crm.campaign_prospects where workspace_id = $1 order by created_at",
      [eclipse.workspaceId],
    );
    assert.deepEqual(rows.map((row) => row.id), [kept, elsewhere]);
    assert.ok(rows.every((row) => row.contact_id === keep.id));
    assert.equal(rows[0].replied_at?.toISOString(), "2026-11-10T09:00:00.000Z");
    const events = await sql<{ prospect_id: string }>("select distinct prospect_id from crm.campaign_events where campaign_id = $1", [shared]);
    assert.deepEqual(events.map((row) => row.prospect_id), [kept]);
  });

  it("gives the kept row the merged row's lead id and email when it has none, so sync keeps matching it", async () => {
    const keep = await contact({ firstName: "Tom", lastName: "Avery", linkedinUrl: "https://www.linkedin.com/in/tom-avery-merge" });
    const merge = await contact({ firstName: "Tom", lastName: "Avery", email: "tom@brightlane-merge.test" });
    const id = await campaign("Merge lead ids");
    const kept = await prospect(id, { contactId: keep.id });
    await prospect(id, { contactId: merge.id, email: "tom@brightlane-merge.test", lead: "lead-tom" });
    await mergeContacts(eclipse, keep.id, merge.id, PROVENANCE);
    const rows = await sql<{ id: string; external_lead_id: string; email: string }>("select id, external_lead_id, email from crm.campaign_prospects where campaign_id = $1", [id]);
    assert.deepEqual(rows, [{ id: kept, external_lead_id: "lead-tom", email: "tom@brightlane-merge.test" }]);
  });

  it("gives the kept row the merged row's LinkedIn profile when it has none", async () => {
    const keep = await contact({ firstName: "Isla", lastName: "Moore", email: "isla@moorfield-merge.test" });
    const merge = await contact({ firstName: "Isla", lastName: "Moore", linkedinUrl: "https://www.linkedin.com/in/isla-moore-merge" });
    const id = await campaign("Merge profiles");
    const kept = await prospect(id, { contactId: keep.id, email: "isla@moorfield-merge.test", lead: "lead-isla" });
    const merged = await prospect(id, { contactId: merge.id, lead: "lead-isla-2" });
    await sql("update crm.campaign_prospects set linkedin = 'linkedin.com/in/isla-moore-merge' where id = $1", [merged]);
    await mergeContacts(eclipse, keep.id, merge.id, PROVENANCE);
    const rows = await sql<{ id: string; external_lead_id: string; email: string; linkedin: string }>("select id, external_lead_id, email, linkedin from crm.campaign_prospects where campaign_id = $1", [id]);
    assert.deepEqual(rows, [{ id: kept, external_lead_id: "lead-isla", email: "isla@moorfield-merge.test", linkedin: "linkedin.com/in/isla-moore-merge" }]);
  });

  it("points prospects at the kept company when companies merge", async () => {
    const keep = await company("Brightlane", "brightlane.test");
    const merge = await company("Brightlane Ltd", "brightlane-ltd.test");
    const id = await campaign("Company merge");
    const row = await prospect(id, { companyId: merge.id, email: "tom@brightlane.test" });
    const result = await mergeCompanies(eclipse, keep.id, merge.id, PROVENANCE);
    assert.equal(result.moved.campaign_prospects, 1);
    const after = await sql<{ company_id: string }>("select company_id from crm.campaign_prospects where id = $1", [row]);
    assert.equal(after[0].company_id, keep.id);
  });

  it("refuses to move someone who is active in a campaign, in the preview and the move", async () => {
    const priya = await contact({ firstName: "Priya", lastName: "Shah", email: "priya@halcyon.test" });
    const id = await campaign("Halcyon outreach");
    const row = await prospect(id, { contactId: priya.id, email: "priya@halcyon.test" });

    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, "Priya Shah is in Halcyon outreach. Remove them from campaigns first.");
    await assert.rejects(
      moveRecordsToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId }, PROVENANCE),
      refused(/^Priya Shah is in Halcyon outreach\. Remove them from campaigns first\.$/),
    );

    const copied = await moveRecordsToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
    assert.match(copied.message, /^Copied/);

    for (const state of ["queued", "filling", "pushing"]) {
      await sql("update crm.campaign_prospects set state = $2 where id = $1", [row, state]);
      const blocked = await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId });
      assert.ok(blocked.campaignConflict, state);
    }
    await sql("update crm.campaign_prospects set state = 'pushed', stop_requested_at = now() where id = $1", [row]);
    assert.ok((await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId })).campaignConflict);
  });

  it("refuses to move a company whose people are active in a campaign", async () => {
    const lumen = await company("Lumen", "lumen.test");
    const ben = await contact({ firstName: "Ben", lastName: "Hart", email: "ben@lumen.test", companyId: lumen.id });
    const id = await campaign("Lumen outreach");
    await prospect(id, { contactId: ben.id, companyId: lumen.id, email: "ben@lumen.test" });
    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [lumen.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, "Ben Hart is in Lumen outreach. Remove them from campaigns first.");
    await assert.rejects(moveRecordsToWorkspace(eclipse, { companyIds: [lumen.id], workspaceId: ridgeon.workspaceId }, PROVENANCE), refused(/Remove them from campaigns first\./));
  });

  it("moves people whose campaigns are over and clears the rows left behind", async () => {
    const fernway = await company("Fernway", "fernway.test");
    const joe = await contact({ firstName: "Joe", lastName: "Mills", email: "joe@fernway.test", companyId: fernway.id });
    const stopped = await campaign("Stopped outreach");
    const finished = await campaign("Finished outreach", "completed");
    const skipped = await campaign("Skipped outreach");
    const done = await campaign("Done outreach");
    const rows = [
      await prospect(stopped, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", stoppedAt: new Date().toISOString() }),
      await prospect(finished, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test" }),
      await prospect(skipped, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", state: "skipped" }),
      await prospect(done, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", leadStatus: "completed" }),
    ];
    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [fernway.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, null);
    await moveRecordsToWorkspace(eclipse, { companyIds: [fernway.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const left = await sql<{ workspace_id: string; contact_id: string | null; company_id: string | null; email: string }>(
      "select workspace_id, contact_id, company_id, email from crm.campaign_prospects where id = any($1::uuid[])",
      [rows],
    );
    assert.equal(left.length, 4);
    assert.ok(left.every((row) => row.workspace_id === eclipse.workspaceId && row.contact_id === null && row.company_id === null && row.email === "joe@fernway.test"));
    const crossed = await sql(
      `select p.id from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where c.workspace_id <> p.workspace_id
       union all select p.id from crm.campaign_prospects p join crm.companies c on c.id = p.company_id where c.workspace_id <> p.workspace_id`,
    );
    assert.deepEqual(crossed, []);
  });
});


const KEY_A = "sl_review_key_alpha_0001";
const KEY_B = "sl_review_key_bravo_0002";
const HR_A = "hr_review_key_alpha_0001";
const HR_B = "hr_review_key_bravo_0002";
const TABLES = ["campaigns", "campaign_prospects", "campaign_events", "campaign_senders", "campaign_connections"];
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE"];
const TEST = { provenance: { operation: "test" } };

async function gapSql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

function gapLeads(count: number, prefix: string): FakeLead[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}`, email: `p${index + 1}@${prefix}.test`, first: `P${index + 1}`, last: prefix }));
}

function gapCampaign(id: number, name: string, prefix: string, count: number): FakeCampaign {
  const people = gapLeads(count, prefix);
  return {
    id,
    name,
    status: "ACTIVE",
    leads: people,
    stats: people.map((lead, index) => ({ lead_id: lead.id, lead_email: lead.email, lead_name: lead.first, sequence_number: 1, sent_time: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString() })),
    sequences: [],
    analytics: { id, status: "ACTIVE", sent_count: count },
  };
}

async function tally(workspaceId: string) {
  const rows = await gapSql<{ prospects: number; events: number; workflow: number; notes: number; dupes: number }>(
    `select (select count(*)::int from crm.campaign_prospects where workspace_id = $1) as prospects,
            (select count(*)::int from crm.campaign_events where workspace_id = $1) as events,
            (select count(*)::int from crm.workflow_events where workspace_id = $1) as workflow,
            (select count(*)::int from crm.notifications where workspace_id = $1) as notes,
            (select count(*)::int from (select 1 from crm.campaign_prospects where workspace_id = $1 group by campaign_id, email having count(*) > 1) d) as dupes`,
    [workspaceId],
  );
  return rows[0];
}

async function contactTally(a: string, b: string) {
  const rows = await gapSql<{ a: number; b: number; audits: number; b_audits: number }>(
    `select (select count(*)::int from crm.contacts where workspace_id = $1) as a, (select count(*)::int from crm.contacts where workspace_id = $2) as b,
            (select count(*)::int from crm.audit_events where workspace_id = $1 and event_type = 'contact.created') as audits,
            (select count(*)::int from crm.audit_events where workspace_id = $2) as b_audits`,
    [a, b],
  );
  return rows[0];
}

async function commitAsUser(userId: string, text: string, values: unknown[]) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await client.query("set local role authenticated");
    await client.query(text, values);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}


describe("review 391 gaps", () => {
  let alice: UserActor;
  let amy: UserActor;
  let bob: UserActor;
  let both: UserActor;
  let bothInB: UserActor;
  let agentA: AgentActor;
  let agentANoWrite: AgentActor;
  const accountA: FakeAccount = { key: KEY_A, client: { id: 1, name: "Alpha" }, campaigns: [gapCampaign(101, "Alpha one", "alpha", 130)], calls: [] };
  const accountB: FakeAccount = { key: KEY_B, client: { id: 2, name: "Bravo" }, campaigns: [gapCampaign(201, "Bravo one", "bravo", 5)], calls: [] };
  const fetchImpl = fakeSmartlead([accountA, accountB]);
  const sender = (id: number) => ({ id, firstName: "Both", lastName: "Person", emailAddress: "both@gaps.test", profileUrl: "https://www.linkedin.com/in/both" });
  const hrA: FakeHeyReachAccount = { key: HR_A, accounts: [sender(1)], campaigns: [], calls: [] };
  const hrB: FakeHeyReachAccount = { key: HR_B, accounts: [sender(9)], campaigns: [], calls: [] };
  const hrFetch = fakeHeyReach([hrA, hrB]);
  const bothFetch: typeof fetch = (input, init) => (String(input instanceof Request ? input.url : input).includes("heyreach") ? hrFetch(input, init) : fetchImpl(input, init));
  const saved: Record<string, string | undefined> = {};
  const gapSync = (workspaceId: string, onEvents?: (campaign: unknown, events: SyncedEvent[]) => Promise<void>) =>
    syncCampaigns({ workspaceId, deadline: Date.now() + 60_000, fetchImpl: bothFetch, onEvents });

  before(async () => {
    await resetDatabase();
    for (const name of LIMITS) {
      saved[name] = process.env[name];
      process.env[name] = "100000";
    }
    alice = await createUser("alice@gaps.test", "Alice Alpha");
    bob = await createUser("bob@gaps.test", "Bob Bravo");
    const third = await createUser("amy@gaps.test", "Amy Member");
    const fourth = await createUser("both@gaps.test", "Both Person");
    await gapSql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($4, $3, 'member')", [
      alice.workspaceId,
      third.userId,
      fourth.userId,
      bob.workspaceId,
    ]);
    amy = { ...third, workspaceId: alice.workspaceId, role: "member", scopes: scopesForRole("member") };
    both = { ...fourth, workspaceId: alice.workspaceId, role: "member", scopes: scopesForRole("member") };
    bothInB = { ...fourth, workspaceId: bob.workspaceId, role: "member", scopes: scopesForRole("member") };
    agentA = (await createAgent(alice.workspaceId, ["crm:read", "contacts:write", "campaigns:write"], "A writer")).actor;
    agentANoWrite = (await createAgent(alice.workspaceId, ["crm:read", "contacts:write"], "A reader")).actor;
  });

  after(async () => {
    for (const name of LIMITS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeEach(async () => {
    await gapSql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:%'");
  });

  useServerlessPool();

  it("G1 resumes an interrupted lead backfill from sync_state without repeating a page, and backfill fires nothing", async () => {
    await saveCampaignConnection(alice, "smartlead", KEY_A, { fetchImpl });
    await saveCampaignConnection(bob, "smartlead", KEY_B, { fetchImpl });
    const seen: SyncedEvent[][] = [];
    const onEvents = async (_c: unknown, events: SyncedEvent[]) => {
      seen.push(events);
    };
    const before = await tally(alice.workspaceId);
    accountA.fail = (url) => (url.pathname.endsWith("/leads") && url.searchParams.get("offset") === "100" ? new Response("{}", { status: 500 }) : null);
    const first = await gapSync(alice.workspaceId, onEvents);
    accountA.fail = undefined;
    assert.equal(first.errors.length, 1);
    const state = await gapSql<{ sync_state: Record<string, unknown>; backfilled_at: Date | null }>("select sync_state, backfilled_at from crm.campaigns where workspace_id = $1", [alice.workspaceId]);
    assert.equal(state[0].sync_state.leadsOffset, 100);
    assert.equal(state[0].backfilled_at, null);
    assert.equal((await tally(alice.workspaceId)).prospects, 100);
    accountA.calls.length = 0;
    const second = await gapSync(alice.workspaceId, onEvents);
    assert.deepEqual(second.errors, []);
    assert.equal(second.backfilled, 1);
    assert.deepEqual(accountA.calls.filter((url) => url.pathname.endsWith("/leads")).map((url) => url.searchParams.get("offset")), ["100"]);
    const done = await tally(alice.workspaceId);
    assert.equal(done.prospects, 130);
    assert.equal(done.events, 130);
    assert.equal(done.dupes, 0);
    assert.equal(done.workflow, before.workflow);
    assert.equal(done.notes, before.notes);
    assert.equal(seen.length, 0);
    const error = await gapSql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1", [alice.workspaceId]);
    assert.equal(error[0].last_error, null);
  });

  it("G2 syncing twice, and three times at once, adds no duplicate prospects or events", async () => {
    const before = await tally(alice.workspaceId);
    await gapSync(alice.workspaceId);
    const reports = await Promise.all([gapSync(alice.workspaceId), gapSync(alice.workspaceId), gapSync(alice.workspaceId)]);
    for (const report of reports) assert.deepEqual(report.errors, []);
    assert.equal(reports.reduce((sum, report) => sum + report.connections, 0), 1);
    assert.deepEqual(await tally(alice.workspaceId), before);
  });

  it("G3 a live event reaches onEvents exactly once, even when onEvents fails the first time", async () => {
    accountA.campaigns[0].stats.push({ lead_id: "alpha-1", lead_email: "p1@alpha.test", lead_name: "P1", sequence_number: 1, sent_time: "2026-11-01T09:00:00.000Z", reply_time: new Date().toISOString() });
    const seen: string[] = [];
    let fail = true;
    const onEvents = async (_c: unknown, events: SyncedEvent[]) => {
      if (fail) {
        fail = false;
        throw new Error("handler down");
      }
      seen.push(...events.map((event) => event.kind));
    };
    await gapSync(alice.workspaceId, onEvents);
    await gapSync(alice.workspaceId, onEvents);
    await gapSync(alice.workspaceId, onEvents);
    assert.deepEqual(seen, ["replied"]);
  });

  it("G4 keeps the key out of last_error, the report and everything logged", async () => {
    const logged: string[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
    const capture = (...parts: unknown[]) => {
      logged.push(parts.map((part) => (part instanceof Error ? `${part.message} ${part.stack}` : typeof part === "string" ? part : JSON.stringify(part))).join(" "));
    };
    Object.assign(console, { error: capture, warn: capture, log: capture, info: capture });
    const reports = [];
    try {
      accountA.fail = (url) => new Response(`Bad request for ${url.href} key ${KEY_A}`, { status: 500 });
      reports.push(await gapSync(alice.workspaceId));
      accountA.fail = (url) => {
        throw new TypeError(`fetch failed for ${url.href}`);
      };
      reports.push(await gapSync(alice.workspaceId));
      accountA.fail = () => new Response(`<html>${KEY_A}</html>`, { status: 200 });
      reports.push(await gapSync(alice.workspaceId));
      accountA.fail = () => new Response(JSON.stringify({ message: `api_key ${KEY_A} not allowed` }), { status: 401 });
      reports.push(await gapSync(alice.workspaceId));
      await assert.rejects(saveCampaignConnection(alice, "smartlead", KEY_A, { fetchImpl }), (error: unknown) => {
        assert.ok(!String((error as Error).message).includes(KEY_A));
        assert.ok(!String((error as Error).stack).includes(KEY_A));
        return true;
      });
    } finally {
      accountA.fail = undefined;
      Object.assign(console, original);
    }
    assert.ok(logged.length >= 4, `logged ${logged.length}`);
    for (const line of logged) assert.ok(!line.includes(KEY_A), line);
    for (const report of reports) {
      assert.equal(report.errors.length, 1);
      assert.ok(!JSON.stringify(report).includes(KEY_A));
    }
    const stored = await gapSql<{ last_error: string | null; details: unknown }>("select last_error, details from crm.campaign_connections where workspace_id = $1", [alice.workspaceId]);
    assert.ok(stored[0].last_error && !JSON.stringify(stored[0]).includes(KEY_A));
    await gapSync(alice.workspaceId);
    const cleared = await gapSql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1", [alice.workspaceId]);
    assert.equal(cleared[0].last_error, null);
  });

  it("G5 a member and an agent of one workspace read nothing of another's, and never the secrets", async () => {
    await gapSync(bob.workspaceId);
    await saveCampaignConnection(bob, "heyreach", HR_B, { fetchImpl: hrFetch });
    await saveCampaignConnection(alice, "heyreach", HR_A, { fetchImpl: hrFetch });
    for (const table of TABLES) {
      const total = await gapSql<{ count: number }>(`select count(*)::int as count from crm.${table} where workspace_id = $1`, [bob.workspaceId]);
      assert.ok(total[0].count > 0, `${table} has rows to hide`);
      const seen = await queryAsUser<{ workspace_id: string }>(amy.userId, `select workspace_id from crm.${table}`);
      assert.ok(seen.length > 0, table);
      assert.ok(seen.every((row) => row.workspace_id === alice.workspaceId), `member ${table}`);
      for (const agent of [agentA, agentANoWrite]) {
        const rows = await withActor(agent, (db) => db.query<{ workspace_id: string }>(`select workspace_id from crm.${table}`));
        assert.ok(rows.rows.length > 0, table);
        assert.ok(rows.rows.every((row) => row.workspace_id === alice.workspaceId), `agent ${table}`);
      }
    }
    for (const column of ["key_encrypted", "key_fingerprint", "webhook_secret"]) {
      await assert.rejects(queryAsUser(amy.userId, `select ${column} from crm.campaign_connections`), /permission denied/);
      await assert.rejects(queryAsUser(alice.userId, `select ${column} from crm.campaign_connections`), /permission denied/);
      await assert.rejects(withActor(agentA, (db) => db.query(`select ${column} from crm.campaign_connections`)), /permission denied/);
    }
    const open = await gapSql(
      `select p.proname as name, r.rolname as role from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join (select rolname from pg_roles where rolname in ('authenticated', 'crm_agent', 'anon')) r
       where n.nspname = 'private' and p.proname like 'campaign%' and has_function_privilege(r.rolname, p.oid, 'execute')`,
    );
    assert.deepEqual(open, []);
  });

  it("G6 only owners and admins write connections, at the database too", async () => {
    const insert = "insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, $2, 'x', 'reviewfingerprint00000')";
    await assert.rejects(queryAsUser(amy.userId, insert, [bob.workspaceId, "smartlead"]), /row-level security/);
    await gapSql("delete from crm.campaign_connections where workspace_id = $1 and provider = 'heyreach'", [alice.workspaceId]);
    await assert.rejects(queryAsUser(amy.userId, insert, [alice.workspaceId, "heyreach"]), /row-level security/);
    await saveCampaignConnection(alice, "heyreach", HR_A, { fetchImpl: hrFetch });
    assert.deepEqual(await queryAsUser(amy.userId, "update crm.campaign_connections set last_error = 'x' returning id"), []);
    assert.deepEqual(await queryAsUser(amy.userId, "delete from crm.campaign_connections returning id"), []);
    assert.deepEqual(await queryAsUser(alice.userId, "update crm.campaign_connections set last_error = 'x' where workspace_id = $1 returning id", [bob.workspaceId]), []);
    for (const statement of [
      "insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, 'smartlead', 'x', 'agentfingerprint000000')",
      "update crm.campaign_connections set last_error = 'x' where workspace_id = $1",
      "delete from crm.campaign_connections where workspace_id = $1",
      "update crm.campaign_senders set user_id = null where workspace_id = $1",
      "update crm.campaigns set name = 'x' where workspace_id = $1",
      "delete from crm.campaign_prospects where workspace_id = $1",
      "delete from crm.campaign_events where workspace_id = $1",
    ]) {
      await assert.rejects(withActor(agentA, (db) => db.query(statement, [alice.workspaceId])), /permission denied/, statement);
    }
  });

  it("G7 the contact and company grant cannot point a prospect outside its workspace", async () => {
    const theirContact = (await createContact(bob, { firstName: "Zed", email: "zed@bravo-crm.test" }, TEST)).body.contact.id;
    const theirCompany = (await createCompany(bob, { name: "Bravo Co", domain: "bravo-co.test" }, TEST)).body.company.id;
    const mine = await gapSql<{ id: string }>("select id from crm.campaign_prospects where workspace_id = $1 order by id limit 1", [alice.workspaceId]);
    const theirs = await gapSql<{ id: string }>("select id from crm.campaign_prospects where workspace_id = $1 order by id limit 1", [bob.workspaceId]);
    const attempts: [string, string, unknown[]][] = [
      ["contact", "update crm.campaign_prospects set contact_id = $1 where id = $2", [theirContact, mine[0].id]],
      ["company", "update crm.campaign_prospects set company_id = $1 where id = $2", [theirCompany, mine[0].id]],
    ];
    for (const [label, statement, values] of attempts) {
      await assert.rejects(queryAsUser(amy.userId, statement, values), /row-level security/, `member ${label}`);
      await assert.rejects(queryAsUser(both.userId, statement, values), /row-level security/, `two-workspace member ${label}`);
      await assert.rejects(withActor(agentA, (db) => db.query(statement, values)), /row-level security/, `agent ${label}`);
    }
    assert.deepEqual(await queryAsUser(amy.userId, "update crm.campaign_prospects set contact_id = null where id = $1 returning id", [theirs[0].id]), []);
    const touched = await withActor(agentA, (db) => db.query("update crm.campaign_prospects set contact_id = null where id = $1 returning id", [theirs[0].id]));
    assert.equal(touched.rowCount, 0);
    await assert.rejects(queryAsUser(amy.userId, "update crm.campaign_prospects set workspace_id = $1", [bob.workspaceId]), /permission denied/);
    await assert.rejects(queryAsUser(amy.userId, "update crm.campaign_prospects set email = 'x@y.test'"), /permission denied/);
    const crossed = await gapSql(
      `select p.id from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where c.workspace_id <> p.workspace_id
       union all select p.id from crm.campaign_prospects p join crm.companies c on c.id = p.company_id where c.workspace_id <> p.workspace_id`,
    );
    assert.deepEqual(crossed, []);
  });

  it("G8 an agent without campaigns:write cannot use the prospect grant", async () => {
    const contact = (await createContact(alice, { firstName: "Own", email: "own@alpha-crm.test" }, TEST)).body.contact.id;
    const mine = await gapSql<{ id: string }>("select id from crm.campaign_prospects where workspace_id = $1 and contact_id is null order by id limit 1", [alice.workspaceId]);
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1", [alice.workspaceId]))[0].id;
    await assert.rejects(importCampaignProspects(agentANoWrite, campaignId), /campaigns:write/);
    const result = await withActor(agentANoWrite, (db) => db.query("update crm.campaign_prospects set contact_id = $1 where id = $2 returning id", [contact, mine[0].id])).then(
      (done) => `updated ${done.rowCount}`,
      (error) => `refused: ${(error as Error).message}`,
    );
    await gapSql("update crm.campaign_prospects set contact_id = null where id = $1", [mine[0].id]);
    assert.match(result, /^refused|^updated 0/, result);
  });

  it("G9 the prospect grant does nothing beyond Import: no unlinking or re-pointing a linked prospect", async () => {
    const first = (await createContact(alice, { firstName: "First", email: "first@alpha-crm.test" }, TEST)).body.contact.id;
    const second = (await createContact(alice, { firstName: "Second", email: "second@alpha-crm.test" }, TEST)).body.contact.id;
    const mine = await gapSql<{ id: string }>("select id from crm.campaign_prospects where workspace_id = $1 and contact_id is null order by id limit 1", [alice.workspaceId]);
    await gapSql("update crm.campaign_prospects set contact_id = $1 where id = $2", [first, mine[0].id]);
    const outcomes: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      await run().catch(() => undefined);
      const now = await gapSql<{ contact_id: string | null }>("select contact_id from crm.campaign_prospects where id = $1", [mine[0].id]);
      if (now[0].contact_id !== first) outcomes.push(label);
      await gapSql("update crm.campaign_prospects set contact_id = $1 where id = $2", [first, mine[0].id]);
    };
    await attempt("member re-pointed a linked prospect", () => commitAsUser(amy.userId, "update crm.campaign_prospects set contact_id = $1 where id = $2", [second, mine[0].id]));
    await attempt("member unlinked a prospect", () => commitAsUser(amy.userId, "update crm.campaign_prospects set contact_id = null where id = $1", [mine[0].id]));
    await attempt("agent unlinked a prospect", () => withActor(agentA, (db) => db.query("update crm.campaign_prospects set contact_id = null where id = $1", [mine[0].id])));
    await gapSql("update crm.campaign_prospects set contact_id = null where id = $1", [mine[0].id]);
    assert.deepEqual(outcomes, []);
  });

  it("G10 the same key cannot be connected twice per provider, and the same fingerprint under the other provider is allowed", async () => {
    const fingerprint = keyFingerprint("smartlead", KEY_A);
    const spare = await createUser("spare@gaps.test");
    const insert = "insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, $2, 'x', $3) returning id";
    await assert.rejects(gapSql(insert, [spare.workspaceId, "smartlead", fingerprint]), /campaign_connections_fingerprint_uidx/);
    const inserted = await gapSql<{ id: string }>(insert, [spare.workspaceId, "heyreach", fingerprint]);
    assert.equal(inserted.length, 1);
    await gapSql("delete from crm.campaign_connections where id = $1", [inserted[0].id]);
    await assert.rejects(saveCampaignConnection(spare, "heyreach", HR_A, { fetchImpl: hrFetch }), /already connected/);
    await assert.rejects(saveCampaignConnection(spare, "smartlead", KEY_B, { fetchImpl }), /already connected/);
  });

  it("G11 Import links existing contacts, creates the rest with audit rows, is safe twice and stays in its workspace", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1", [alice.workspaceId]))[0].id;
    await gapSql("update crm.campaign_prospects set contact_id = null, company_id = null where workspace_id = $1", [alice.workspaceId]);
    const elsewhere = (await createContact(bob, { firstName: "Same", email: "p5@alpha.test" }, TEST)).body.contact.id;
    const existing = (await createContact(alice, { firstName: "Late", email: "p6@alpha.test" }, TEST)).body.contact.id;
    const before = await contactTally(alice.workspaceId, bob.workspaceId);
    await gapSql(
      `update crm.campaign_prospects set lead = lead || jsonb_build_object('firstName', repeat('A', 100), 'lastName', repeat('B', 95), 'title', repeat('T', 150), 'linkedinUrl', 'linkedin.com/company/acme')
       where campaign_id = $1 and email = any($2::text[])`,
      [campaignId, ["p7@alpha.test", "p8@alpha.test"]],
    );
    const result = await importCampaignProspects(both, campaignId, { deadline: Date.now() + 60_000 });
    const trimmed = await gapSql<{ first_name: string; last_name: string; job_title: string; linkedin_url: string | null }>(
      "select c.first_name, c.last_name, c.job_title, c.linkedin_url from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where p.campaign_id = $1 and p.email = 'p7@alpha.test'",
      [campaignId],
    );
    assert.deepEqual(trimmed[0], { first_name: "A".repeat(80), last_name: "B".repeat(80), job_title: "T".repeat(120), linkedin_url: null });
    assert.equal(result.left, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.linked, 130);
    const afterwards = await contactTally(alice.workspaceId, bob.workspaceId);
    assert.equal(afterwards.a - before.a, result.imported);
    assert.equal(afterwards.audits - before.audits, result.imported);
    assert.equal(afterwards.b, before.b);
    assert.equal(afterwards.b_audits, before.b_audits);
    const six = await gapSql<{ contact_id: string }>("select contact_id from crm.campaign_prospects where campaign_id = $1 and email = 'p6@alpha.test'", [campaignId]);
    assert.equal(six[0].contact_id, existing);
    const five = await gapSql<{ contact_id: string; workspace_id: string }>(
      "select p.contact_id, c.workspace_id from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where p.campaign_id = $1 and p.email = 'p5@alpha.test'",
      [campaignId],
    );
    assert.notEqual(five[0].contact_id, elsewhere);
    assert.equal(five[0].workspace_id, alice.workspaceId);
    assert.deepEqual(await importCampaignProspects(both, campaignId, { deadline: Date.now() + 60_000 }), { imported: 0, linked: 0, failed: 0, left: 0, reasons: [] });
    const bobCampaign = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1", [bob.workspaceId]))[0].id;
    await assert.rejects(importCampaignProspects(amy, bobCampaign), /not found|Couldn't find|No /i);
    await assert.rejects(importCampaignProspects(agentA, bobCampaign), /not found|Couldn't find|No /i);
  });

  it("G12 two Imports at once create each contact once", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1", [bob.workspaceId]))[0].id;
    const before = await gapSql<{ count: number }>("select count(*)::int as count from crm.contacts where workspace_id = $1", [bob.workspaceId]);
    await gapSql(
      `update crm.campaign_prospects set lead = lead || jsonb_build_object('firstName', repeat('A', 100), 'lastName', repeat('B', 95), 'title', repeat('T', 150), 'linkedinUrl', 'linkedin.com/company/acme')
       where campaign_id = $1 and email = any($2::text[])`,
      [campaignId, ["p1@bravo.test", "p2@bravo.test"]],
    );
    const results = await Promise.all([importCampaignProspects(bob, campaignId), importCampaignProspects(bothInB, campaignId)]);
    assert.deepEqual(results.map((result) => result.failed), [0, 0]);
    const afterwards = await gapSql<{ count: number }>("select count(*)::int as count from crm.contacts where workspace_id = $1", [bob.workspaceId]);
    assert.equal(afterwards[0].count - before[0].count, 5);
    assert.equal((await gapSql("select 1 from crm.campaign_prospects where campaign_id = $1 and contact_id is null", [campaignId])).length, 0);
  });

  it("G13 removing a member clears their sender links in that workspace only", async () => {
    const inA = (await listCampaignSenders(alice)).senders[0];
    const inB = (await listCampaignSenders(bob)).senders[0];
    assert.equal(inA.userId, both.userId);
    assert.equal(inB.userId, both.userId);
    await removeMember(alice, both.userId);
    assert.equal((await listCampaignSenders(alice)).senders[0].userId, null);
    assert.equal((await listCampaignSenders(bob)).senders[0].userId, both.userId);
    const audits = await gapSql<{ workspace_id: string; changes: { unlinked: string | null } }>("select workspace_id, changes from crm.audit_events where event_type = 'campaign.sender_linked' and operation = 'remove_member'");
    assert.deepEqual(audits.map((row) => [row.workspace_id, row.changes.unlinked]), [[alice.workspaceId, both.userId]]);
    await assert.rejects(linkCampaignSender(alice, inA.id, both.userId), /Pick someone in this workspace/);
  });

  it("G14 sync runs as the person who connected while they are an admin, otherwise an owner", async () => {
    await gapSql("update crm.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2", [alice.workspaceId, amy.userId]);
    assert.equal((await syncActor(alice.workspaceId, amy.userId))?.userId, amy.userId);
    await gapSql("update crm.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [alice.workspaceId, amy.userId]);
    assert.equal((await syncActor(alice.workspaceId, amy.userId))?.userId, alice.userId);
    assert.equal((await syncActor(alice.workspaceId, bob.userId))?.userId, alice.userId);
    assert.equal((await syncActor(alice.workspaceId, null))?.userId, alice.userId);
  });

  it("hands every live event over once: backfilled rows are marked handled and nothing waits", async () => {
    const waiting = await gapSql<{ count: number }>("select count(*)::int as count from crm.campaign_events where workspace_id = $1 and handled_at is null", [alice.workspaceId]);
    assert.equal(waiting[0].count, 0);
  });

  it("links a prospect only while it is unlinked, and never to an archived contact", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]))[0].id;
    const row = (await gapSql<{ id: string }>("select id from crm.campaign_prospects where campaign_id = $1 order by id limit 1", [campaignId]))[0].id;
    const before = (await gapSql<{ contact_id: string }>("select contact_id from crm.campaign_prospects where id = $1", [row]))[0].contact_id;
    await gapSql("update crm.campaign_prospects set contact_id = null where id = $1", [row]);
    const archived = (await createContact(alice, { firstName: "Gone", email: "gone@alpha-crm.test" }, TEST)).body.contact.id;
    await gapSql("update crm.contacts set archived_at = now() where id = $1", [archived]);
    await assert.rejects(queryAsUser(amy.userId, "update crm.campaign_prospects set contact_id = $1 where id = $2", [archived, row]), /row-level security/);
    await assert.rejects(withActor(agentA, (db) => db.query("update crm.campaign_prospects set contact_id = $1 where id = $2", [archived, row])), /row-level security/);
    assert.equal((await withActor(agentANoWrite, (db) => db.query("update crm.campaign_prospects set contact_id = $1 where id = $2", [before, row]))).rowCount, 0);
    assert.equal((await withActor(agentA, (db) => db.query("update crm.campaign_prospects set contact_id = $1 where id = $2", [before, row]))).rowCount, 1);
    assert.equal((await withActor(agentA, (db) => db.query("update crm.campaign_prospects set contact_id = $1 where id = $2", [archived, row]))).rowCount, 0);
  });

  it("Import links an existing contact without changing it and fires no workflow events", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]))[0].id;
    await gapSql("update crm.campaign_prospects set contact_id = null where campaign_id = $1 and email in ('p20@alpha.test', 'p21@alpha.test')", [campaignId]);
    const kept = (await gapSql<{ id: string }>("select id from crm.contacts where workspace_id = $1 and normalized_email = 'p20@alpha.test'", [alice.workspaceId]))[0].id;
    await gapSql("update crm.contacts set first_name = 'Priya', job_title = 'Founder' where id = $1", [kept]);
    await gapSql("update crm.contacts set archived_at = now() where workspace_id = $1 and normalized_email = 'p21@alpha.test'", [alice.workspaceId]);
    const count = async () =>
      (
        await gapSql<{ workflow: number; created: number; updated: number }>(
          `select (select count(*)::int from crm.workflow_events where workspace_id = $1) as workflow,
                  (select count(*)::int from crm.audit_events where workspace_id = $1 and event_type = 'contact.created') as created,
                  (select count(*)::int from crm.audit_events where workspace_id = $1 and event_type = 'contact.updated') as updated`,
          [alice.workspaceId],
        )
      )[0];
    const before = await count();
    const result = await importCampaignProspects(alice, campaignId, { deadline: Date.now() + 30_000 });
    assert.deepEqual(result, { imported: 1, linked: 2, failed: 0, left: 0, reasons: [] });
    const after = await count();
    assert.equal(after.workflow, before.workflow);
    assert.equal(after.created, before.created + 1);
    assert.equal(after.updated, before.updated);
    const same = await gapSql<{ first_name: string; job_title: string }>("select first_name, job_title from crm.contacts where id = $1", [kept]);
    assert.deepEqual(same[0], { first_name: "Priya", job_title: "Founder" });
  });

  it("links by email before LinkedIn, one prospect per contact, and leaves out rows that can never import", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]))[0].id;
    const byEmail = (await createContact(alice, { firstName: "Mail", email: "mail@link-test.test" }, TEST)).body.contact.id;
    await createContact(alice, { firstName: "Profile", linkedinUrl: "https://www.linkedin.com/in/link-test-profile" }, TEST);
    const shared = (await createContact(alice, { firstName: "Shared", email: "shared@link-test.test" }, TEST)).body.contact.id;
    const insert = "insert into crm.campaign_prospects (workspace_id, campaign_id, email, linkedin, state) values ($1, $2, $3, $4, 'pushed') returning id";
    const first = (await gapSql<{ id: string }>(insert, [alice.workspaceId, campaignId, "mail@link-test.test", "linkedin.com/in/link-test-profile"]))[0].id;
    const second = (await gapSql<{ id: string }>(insert, [alice.workspaceId, campaignId, "shared@link-test.test", null]))[0].id;
    const third = (await gapSql<{ id: string }>(insert, [alice.workspaceId, campaignId, "shared@link-test.test", null]))[0].id;
    const linked = await gapSql<{ count: number }>("select private.campaign_link_contacts($1, null) as count", [campaignId]);
    assert.equal(linked[0].count, 2);
    const rows = await gapSql<{ id: string; contact_id: string | null }>("select id, contact_id from crm.campaign_prospects where id = any($1::uuid[])", [[first, second, third]]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.contact_id]));
    assert.equal(byId[first], byEmail);
    assert.equal(byId[second], shared);
    assert.equal(byId[third], null);
    assert.equal((await getCampaign(alice, campaignId)).unlinked, 0);
    await gapSql("delete from crm.campaign_prospects where id = any($1::uuid[])", [[first, second, third]]);
  });

  it("keeps syncing the other campaigns when one fails, marks one that is gone, and rotates", async () => {
    accountA.campaigns.push(gapCampaign(102, "Alpha broken", "broken", 2), gapCampaign(103, "Alpha gone", "gone", 2));
    accountA.fail = (url) =>
      url.pathname.includes("/campaigns/102/") ? new Response("{}", { status: 500 }) : url.pathname.includes("/campaigns/103/") ? new Response("{}", { status: 404 }) : null;
    try {
      const report = await gapSync(alice.workspaceId);
      assert.deepEqual(report.errors.sort(), ["Couldn't reach Smartlead. Try again.", "Smartlead can't find this campaign."]);
      const rows = await gapSql<{ external_id: string; sync_error: string | null; sync_state: Record<string, unknown> }>(
        "select external_id, sync_error, sync_state from crm.campaigns where workspace_id = $1 and provider = 'smartlead' order by external_id",
        [alice.workspaceId],
      );
      assert.equal(rows[0].sync_error, null);
      assert.equal(rows[1].sync_error, "Couldn't reach Smartlead. Try again.");
      assert.ok(rows[2].sync_state.missingAt);
      const connection = await gapSql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]);
      assert.equal(connection[0].last_error, null);
      const broken = await getCampaign(alice, (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and external_id = '102'", [alice.workspaceId]))[0].id);
      assert.equal(campaignSyncLine(broken, { provider: "smartlead", lastSyncedAt: new Date().toISOString(), lastError: null }), "Couldn't reach Smartlead. Try again.");
      const order = await gapSql<{ external_id: string }>("select external_id from private.campaign_sync_campaigns($1, 'smartlead', 'email', '[]'::jsonb)", [alice.workspaceId]);
      assert.equal(order[order.length - 1].external_id, "101");
      accountA.calls.length = 0;
      await gapSync(alice.workspaceId);
      assert.equal(accountA.calls.filter((url) => url.pathname.includes("/campaigns/103/")).length, 0);
      accountA.fail = (url) => (url.pathname.endsWith("/campaigns/101/analytics") ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : null);
      const before = await gapSql<{ last_synced_at: Date }>("select last_synced_at from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]);
      const busy = await gapSync(alice.workspaceId);
      assert.equal(busy.busy.length, 1);
      const after = await gapSql<{ last_synced_at: Date }>("select last_synced_at from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]);
      assert.ok(after[0].last_synced_at > before[0].last_synced_at);
    } finally {
      accountA.fail = undefined;
      accountA.campaigns.splice(1);
    }
  });

  it("reports a prospect that can't be imported once, with its reason, and stops counting it", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]))[0].id;
    const bad = (
      await gapSql<{ id: string }>("insert into crm.campaign_prospects (workspace_id, campaign_id, linkedin, state) values ($1, $2, 'linkedin.com/company/nope', 'pushed') returning id", [
        alice.workspaceId,
        campaignId,
      ])
    )[0].id;
    assert.equal((await getCampaign(alice, campaignId)).unlinked, 1);
    const first = await importCampaignProspects(alice, campaignId, { deadline: Date.now() + 30_000 });
    assert.equal(first.failed, 1);
    assert.equal(first.left, 0);
    assert.equal(first.reasons.length, 1);
    const stored = await gapSql<{ import_error: string }>("select import_error from crm.campaign_prospects where id = $1", [bad]);
    assert.equal(stored[0].import_error, first.reasons[0]);
    assert.equal((await getCampaign(alice, campaignId)).unlinked, 0);
    assert.deepEqual(await importCampaignProspects(alice, campaignId, { deadline: Date.now() + 30_000 }), { imported: 0, linked: 0, failed: 0, left: 0, reasons: [] });
    await gapSql("delete from crm.campaign_prospects where id = $1", [bad]);
  });

  it("keeps a passing failure out of import_error, so the row is tried again", () => {
    assert.equal(lastingImportFailure(new CrmError("invalid_input", "Enter a LinkedIn profile URL.", 400)), true);
    assert.equal(lastingImportFailure(Object.assign(new Error("value too long"), { code: "22001" })), true);
    assert.equal(lastingImportFailure(Object.assign(new Error("duplicate"), { code: "23505" })), true);
    assert.equal(lastingImportFailure(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })), false);
    assert.equal(lastingImportFailure(Object.assign(new Error("deadlock detected"), { code: "40P01" })), false);
    assert.equal(lastingImportFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), false);
    assert.equal(lastingImportFailure(new CrmError("rate_limited", "Busy.", 429)), false);
  });

  it("shows a stored import reason on the row, and clears it when the provider's lead changes", async () => {
    const campaignId = (await gapSql<{ id: string }>("select id from crm.campaigns where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]))[0].id;
    const bad = (
      await gapSql<{ id: string }>(
        "insert into crm.campaign_prospects (workspace_id, campaign_id, linkedin, external_lead_id, lead, state) values ($1, $2, 'linkedin.com/company/fixme', 'fixme-1', '{\"firstName\": \"Fix\"}'::jsonb, 'pushed') returning id",
        [alice.workspaceId, campaignId],
      )
    )[0].id;
    const result = await importCampaignProspects(alice, campaignId, { deadline: Date.now() + 30_000 });
    assert.equal(result.failed, 1);
    const listed = await listCampaignProspects(alice, campaignId, { search: "fixme" });
    assert.equal(listed.rows[0].importError, result.reasons[0]);
    assert.equal(prospectLine(listed.rows[0]), result.reasons[0]);
    const sync = (lead: Record<string, unknown>) =>
      gapSql("select private.campaign_sync_prospects($1, $2::jsonb)", [campaignId, JSON.stringify([{ external_id: "fixme-1", lead }])]);
    await sync({ firstName: "Fix" });
    assert.ok((await gapSql<{ import_error: string | null }>("select import_error from crm.campaign_prospects where id = $1", [bad]))[0].import_error);
    await sync({ firstName: "Fixed" });
    assert.equal((await gapSql<{ import_error: string | null }>("select import_error from crm.campaign_prospects where id = $1", [bad]))[0].import_error, null);
    await gapSql("delete from crm.campaign_prospects where id = $1", [bad]);
  });

  it("gives the same key's events to a second workspace after it moves there", async () => {
    await gapSql("delete from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [alice.workspaceId]);
    const carol = await createUser("carol@gaps.test", "Carol");
    await saveCampaignConnection(carol, "smartlead", KEY_A, { fetchImpl });
    const report = await gapSync(carol.workspaceId);
    assert.deepEqual(report.errors, []);
    const events = await gapSql<{ count: number }>("select count(*)::int as count from crm.campaign_events where workspace_id = $1", [carol.workspaceId]);
    assert.ok(events[0].count >= 129, String(events[0].count));
  });
});
