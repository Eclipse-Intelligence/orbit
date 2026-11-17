import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { contactSuppression, doNotContactFor, liftDoNotContact, ONLY_A_PERSON_LIFTS, setDoNotContact } from "@/lib/campaigns/suppression";
import { syncCampaigns } from "@/lib/campaigns/sync";
import { getProspectThread } from "@/lib/campaigns/threads";
import { withActor } from "@/lib/crm/context";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox, sendContactEmail } from "@/lib/crm/inbox";
import { mergeContacts } from "@/lib/crm/merge";
import { scopesForRole } from "@/lib/crm/scopes";
import { checkSuppressed, suppressedAddresses } from "@/lib/crm/suppressions";
import type { UserActor } from "@/lib/crm/types";
import { WEBHOOK_EVENTS } from "@/lib/crm/webhooks";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { latestEmailCheck } from "@/lib/enrichment/email-check";
import { readDraftInput, scheduleMailDraft, sendForAgent, sendMailDraft, sendMailOnce } from "@/lib/mail/compose";
import { processDueMail } from "@/lib/mail/due";
import { syncMail } from "@/lib/mail/sync";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { fakeHeyReach, fakeSmartlead, sequenceOf, type FakeAccount, type FakeHeyReachAccount } from "./campaigns-fake";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const SL_A = "sl_key_suppress_alpha_01";
const SL_B = "sl_key_suppress_bravo_02";
const HR_A = "hr_key_suppress_alpha_03";
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE"];
const T0 = "2026-11-10T09:00:00.000Z";
const ORIGIN = "https://orbit.test";
const GRAPH = "https://graph.microsoft.com/v1.0";
const REFUSED = /^Couldn't send\. Ben Hart is on the do not contact list\.$/;

type Call = { method: string; url: string; body: Record<string, unknown> | null };

let drafts = 0;

function outlook() {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(GRAPH)) throw new Error(`Unexpected request to ${url}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, url: url.replace(GRAPH, ""), body });
    if (method === "POST" && url === `${GRAPH}/me/messages`) {
      drafts += 1;
      return Response.json({ id: `draft-${drafts}`, conversationId: `conv-new-${drafts}`, subject: "" }, { status: 201 });
    }
    if (url.endsWith("/send") || url.endsWith("/sendMail")) return new Response(null, { status: 202 });
    if (url.endsWith("/me/mailFolders/sentitems/messages")) return Response.json({ id: "sent-copy" }, { status: 201 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method !== "GET") return Response.json({ id: "patched" }, { status: url.endsWith("/attachments") ? 201 : 200 });
    const asked = url.match(/\/me\/messages\/([^/?]+)\?\$select=internetMessageId$/)?.[1];
    if (asked) return Response.json({ internetMessageId: `<${decodeURIComponent(asked)}@eclipse.test>` });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}` });
  };
  const sends = () => calls.filter((call) => call.method === "POST" && (call.url.endsWith("/send") || call.url.endsWith("/sendMail")));
  return { fetchImpl, calls, sends };
}

let owner: UserActor;
let ann: UserActor;
let outsider: UserActor;
let ben: string;
let tom: string;
let uma: string;
let vic: string;
let ivy: string;
let source: string;
const saved: Record<string, string | undefined> = {};

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

function refused(pattern: RegExp, code = "suppressed") {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    return true;
  };
}

async function prospect(lead: string) {
  const rows = await sql<{ id: string; state: string; skip_reason: string | null; stop_requested_at: Date | null; stopped_at: Date | null; stop_reason: string | null }>(
    "select id, state, skip_reason, stop_requested_at, stopped_at, stop_reason from crm.campaign_prospects where external_lead_id = $1",
    [lead],
  );
  assert.equal(rows.length, 1, `one prospect for ${lead}`);
  return rows[0];
}

async function suppressions(workspaceId: string) {
  return sql<{ kind: string; value: string; reason: string; contact_id: string | null; source: string; blocked_at: Date | null }>(
    "select kind, value, reason, contact_id, source, blocked_at from crm.suppressions where workspace_id = $1 order by kind, value",
    [workspaceId],
  );
}

async function audits(workspaceId: string, type: string) {
  return sql<{ entity_type: string; entity_id: string; actor_user_id: string | null; changes: Record<string, unknown> }>(
    "select entity_type, entity_id, actor_user_id, changes from crm.audit_events where workspace_id = $1 and event_type = $2 order by created_at",
    [workspaceId, type],
  );
}

function agencyOutreach() {
  return {
    id: 501,
    name: "Agency outreach",
    status: "ACTIVE",
    leads: [
      { id: "lead-ben", email: "ben@lumen.test", first: "Ben", last: "Hart" },
      { id: "lead-uma", email: "uma@north.test", first: "Uma", last: "Reed" },
      { id: "lead-vic", email: "vic@lane.test", first: "Vic", last: "Lane" },
      { id: "lead-ivy", email: "ivy@kiln.test", first: "Ivy", last: "Bell" },
    ],
    stats: [
      { lead_id: "lead-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-uma", lead_email: "uma@north.test", lead_name: "Uma Reed", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-vic", lead_email: "vic@lane.test", lead_name: "Vic Lane", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-ivy", lead_email: "ivy@kiln.test", lead_name: "Ivy Bell", sequence_number: 1, sent_time: T0, is_unsubscribed: true },
    ] as FakeAccount["campaigns"][number]["stats"],
    sequences: sequenceOf([{ subject: "Quick question", body: "Hi {{first_name}}" }]),
    analytics: {},
  };
}

function founderOutreach() {
  return {
    id: 502,
    name: "Founder outreach",
    status: "ACTIVE",
    leads: [
      { id: "lead-ben-2", email: "ben@lumen.test", first: "Ben", last: "Hart" },
      { id: "lead-vic-2", email: "vic@lane.test", first: "Vic", last: "Lane" },
    ],
    stats: [
      { lead_id: "lead-ben-2", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0 },
      { lead_id: "lead-vic-2", lead_email: "vic@lane.test", lead_name: "Vic Lane", sequence_number: 1, sent_time: T0 },
    ],
    sequences: sequenceOf([{ subject: "Founders", body: "Hi {{first_name}}" }]),
    analytics: {},
  };
}

describe("suppression and Do not contact", () => {
  const alpha: FakeAccount = { key: SL_A, client: { id: 1, name: "Eclipse" }, campaigns: [agencyOutreach(), founderOutreach()], calls: [] };
  const bravo: FakeAccount = {
    key: SL_B,
    client: { id: 2, name: "Ridgeon" },
    campaigns: [
      {
        id: 511,
        name: "Ridgeon outreach",
        status: "ACTIVE",
        leads: [{ id: "lead-b-ben", email: "ben@lumen.test", first: "Ben", last: "Hart" }],
        stats: [{ lead_id: "lead-b-ben", lead_email: "ben@lumen.test", lead_name: "Ben Hart", sequence_number: 1, sent_time: T0 }],
        sequences: [],
        analytics: {},
      },
    ],
    calls: [],
  };
  const heyreach: FakeHeyReachAccount = {
    key: HR_A,
    accounts: [{ id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@suppress.test", profileUrl: "https://www.linkedin.com/in/markridgeon" }],
    campaigns: [
      {
        id: 601,
        name: "Agency founders",
        status: "IN_PROGRESS",
        accountIds: [1],
        sequence: [{ actionType: "ConnectionRequest", message: "{connection_note}" }],
        leads: [
          { id: "lead-hr-ben", profileUrl: "https://www.linkedin.com/in/benhart/", first: "Ben", last: "Hart", accountId: 1, connection: "ConnectionSent", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
          { id: "lead-hr-vic", profileUrl: "https://www.linkedin.com/in/viclane/", first: "Vic", last: "Lane", accountId: 1, connection: "ConnectionSent", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
        ],
        overall: {},
        byDay: {},
        conversations: [],
      },
    ],
    calls: [],
  };
  const smartleadFetch = fakeSmartlead([alpha, bravo]);
  const heyreachFetch = fakeHeyReach([heyreach]);
  const fetchImpl: typeof fetch = (input, init) => (String(input instanceof Request ? input.url : input).includes("heyreach") ? heyreachFetch(input, init) : smartleadFetch(input, init));
  const sync = (workspaceId: string) => syncCampaigns({ workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents: handleCampaignEvents });

  before(async () => {
    await resetDatabase();
    for (const name of LIMITS) {
      saved[name] = process.env[name];
      process.env[name] = "100000";
    }
    owner = await createUser("mark@suppress.test", "Mark Ridgeon");
    const second = await createUser("ann@suppress.test", "Ann Member");
    outsider = await createUser("oscar@elsewhere-suppress.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    ann = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    const contact = async (actor: UserActor, firstName: string, lastName: string, email: string, linkedinUrl?: string) =>
      (await createContact(actor, { firstName, lastName, email, ...(linkedinUrl ? { linkedinUrl } : {}) }, { provenance: { operation: "test" } })).body.contact.id;
    ben = await contact(owner, "Ben", "Hart", "ben@lumen.test", "https://www.linkedin.com/in/benhart");
    tom = await contact(owner, "Tom", "Avery", "tom@brightlane.test");
    uma = await contact(owner, "Uma", "Reed", "uma@north.test", "https://www.linkedin.com/in/umareed");
    vic = await contact(owner, "Vic", "Lane", "vic@lane.test", "https://www.linkedin.com/in/viclane");
    ivy = await contact(owner, "Ivy", "Bell", "ivy@kiln.test");
    await contact(outsider, "Ben", "Hart", "ben@lumen.test");
    for (const actor of [owner, outsider]) {
      await saveMailbox(actor, { email: actor === owner ? "mark@eclipse.test" : "oscar@other.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    source = (await sql<{ id: string }>("select id from crm.mail_sources where user_id = $1 order by created_at limit 1", [owner.userId]))[0].id;
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    await saveCampaignConnection(outsider, "smartlead", SL_B, { fetchImpl });
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
    await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270210100000_campaign_suppression.sql", "utf8"));
    await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270210100000_campaign_suppression.sql", "utf8"));
  });

  it("keeps an unsubscribe found while backfilling, across channels", async () => {
    const first = await sync(owner.workspaceId);
    assert.deepEqual(first.errors, []);
    await sync(outsider.workspaceId);
    const rows = await suppressions(owner.workspaceId);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.value, row.reason, row.contact_id, row.source]),
      [["email", "ivy@kiln.test", "unsubscribed", ivy, "smartlead"]],
    );
    assert.equal((await audits(owner.workspaceId, "campaign.unsubscribed")).length, 0, "backfill audits nothing");
    assert.equal((await suppressions(outsider.workspaceId)).length, 0);
  });

  it("suppresses only the bounced address and records an invalid email check", async () => {
    alpha.campaigns[0].stats.push({ lead_id: "lead-uma", lead_email: "uma@north.test", lead_name: "Uma Reed", sequence_number: 2, sent_time: new Date().toISOString(), is_bounced: true });
    const report = await sync(owner.workspaceId);
    assert.deepEqual(report.errors, []);
    const rows = (await suppressions(owner.workspaceId)).filter((row) => row.value.includes("uma") || row.value.includes("umareed"));
    assert.deepEqual(rows.map((row) => [row.kind, row.value, row.reason, row.contact_id]), [["email", "uma@north.test", "bounced", uma]]);
    const check = await latestEmailCheck(owner, "uma@north.test");
    assert.equal(check?.verdict, "invalid");
    assert.equal(check?.providerName, "Smartlead");
    assert.equal((await sql("select 1 from crm.enrichment_lookups where record_id = $1 and field = 'email_check' and provider = 'smartlead'", [uma])).length, 1);
    assert.equal((await audits(owner.workspaceId, "campaign.bounced")).length, 1);
    assert.equal(await doNotContactFor(owner, { contactId: uma }), null, "a bounce is not Do not contact");
    assert.equal((await prospect("lead-uma")).stop_requested_at, null);
    await withActor(owner, async (db) => {
      assert.deepEqual(await suppressedAddresses(db, owner.workspaceId, ["Uma@North.test"]), [{ address: "uma@north.test", reason: "bounced", name: "Uma Reed" }]);
    });
  });

  it("suppresses an unsubscribed person on every channel and stops them everywhere", async () => {
    alpha.campaigns[0].stats.push({ lead_id: "lead-vic", lead_email: "vic@lane.test", lead_name: "Vic Lane", sequence_number: 2, sent_time: new Date().toISOString(), is_unsubscribed: true });
    assert.deepEqual((await sync(owner.workspaceId)).errors, []);
    assert.deepEqual((await sync(owner.workspaceId)).errors, []);
    const rows = (await suppressions(owner.workspaceId)).filter((row) => row.contact_id === vic);
    assert.deepEqual(rows.map((row) => [row.kind, row.value, row.reason]), [
      ["email", "vic@lane.test", "unsubscribed"],
      ["linkedin", "linkedin.com/in/viclane", "unsubscribed"],
    ]);
    assert.equal((await prospect("lead-vic")).stop_requested_at, null, "Smartlead already stopped the lead that unsubscribed");
    for (const lead of ["lead-vic-2", "lead-hr-vic"]) {
      const row = await prospect(lead);
      assert.equal(row.stop_reason, "suppressed", lead);
      assert.ok(row.stopped_at, `${lead} is stopped at the provider`);
    }
    assert.ok(heyreach.calls.some((call) => call.path === "/campaign/StopLeadInCampaign"));
    assert.ok((alpha.writes ?? []).some((write) => write.path === "/campaigns/502/leads/lead-vic-2/pause"));
    const audit = await audits(owner.workspaceId, "campaign.unsubscribed");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_type, "campaign_prospect");
    assert.equal((await doNotContactFor(owner, { contactId: vic }))?.reason, "unsubscribed");
    assert.match((await doNotContactFor(owner, { contactId: vic }))!.line, /^Unsubscribed \d{1,2} [A-Z][a-z]{2}\.$/);
  });

  describe("Do not contact", () => {
    let thread: Awaited<ReturnType<typeof getProspectThread>>;

    it("stops the person in every campaign, blocks the address in Smartlead and audits it", async () => {
      const queued = await sql<{ id: string }>(
        `insert into crm.campaign_prospects (workspace_id, campaign_id, email, state)
         select k.workspace_id, k.id, 'ben@lumen.test', 'queued' from crm.campaigns k where k.workspace_id = $1 and k.external_id = '601'
         returning id`,
        [owner.workspaceId],
      );
      const before = (alpha.writes ?? []).length;
      const result = await setDoNotContact(ann, { contactId: ben }, { fetchImpl });
      assert.equal(result.changed, true);
      assert.equal(result.stopping, 3);
      assert.equal(result.skipped, 1);
      for (const lead of ["lead-ben", "lead-ben-2", "lead-hr-ben"]) {
        const row = await prospect(lead);
        assert.equal(row.stop_reason, "suppressed", lead);
        assert.ok(row.stopped_at, lead);
      }
      const skipped = await sql<{ state: string; skip_reason: string }>("select state, skip_reason from crm.campaign_prospects where id = $1", [queued[0].id]);
      assert.deepEqual(skipped, [{ state: "skipped", skip_reason: "Do not contact" }]);
      const writes = (alpha.writes ?? []).slice(before);
      assert.ok(writes.some((write) => write.path === "/campaigns/501/leads/lead-ben/pause"));
      const block = writes.find((write) => write.path === "/leads/add-domain-block-list");
      assert.deepEqual(block?.body, { domain_block_list: ["ben@lumen.test"] });
      const rows = (await suppressions(owner.workspaceId)).filter((row) => row.contact_id === ben);
      assert.deepEqual(rows.map((row) => [row.kind, row.value, row.reason, row.source, Boolean(row.blocked_at)]), [
        ["email", "ben@lumen.test", "manual", "web", true],
        ["linkedin", "linkedin.com/in/benhart", "manual", "web", false],
      ]);
      const audit = await audits(owner.workspaceId, "campaign.do_not_contact_set");
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_user_id, ann.userId);
      assert.equal(audit[0].entity_id, ben);
      assert.ok(WEBHOOK_EVENTS.includes("campaign.do_not_contact_set"));

      const again = await setDoNotContact(owner, { contactId: ben }, { fetchImpl });
      assert.equal(again.changed, false);
      assert.equal((await audits(owner.workspaceId, "campaign.do_not_contact_set")).length, 1);

      const status = await doNotContactFor(owner, { contactId: ben });
      assert.equal(status?.reason, "manual");
      assert.match(status!.line, /^Set by Ann Member, \d{1,2} [A-Z][a-z]{2}\.$/);
      thread = await getProspectThread(owner, (await prospect("lead-hr-ben")).id);
      assert.equal(thread.doNotContact?.line, status!.line);
      assert.ok(thread.items.some((item) => item.type === "note" && item.text === "Stopped in Agency founders"));
    });

    it("lets a workspace agent token with campaigns:write set it, and records the agent", async () => {
      const agent = await createAgent(owner.workspaceId, ["crm:read", "campaigns:write"], "Prospector");
      const result = await setDoNotContact(agent.actor, { contactId: ivy }, { fetchImpl });
      assert.equal(result.changed, false, "Ivy already unsubscribed");
      const reader = await createAgent(owner.workspaceId, ["crm:read"], "Reader");
      await assert.rejects(setDoNotContact(reader.actor, { contactId: tom }, { fetchImpl }), (error: unknown) => error instanceof CrmError && error.status === 403);
    });

    describe("routes that refuse", () => {
      it("refuses bulk email", async () => {
        const box = outlook();
        await assert.rejects(sendContactEmail(owner, ben, { subject: "Hello", body: "Hi Ben", suppression: "refuse" }, box.fetchImpl), refused(REFUSED));
        assert.equal(box.sends().length, 0);
      });

      it("skips workflow Send email with the reason", async () => {
        const box = outlook();
        const workflow = await createWorkflow(owner, { name: "Email Ben" });
        await saveWorkflow(owner, workflow.id, {
          definition: {
            version: 2,
            trigger: { type: "manual", object: "contact" },
            triggerPosition: { x: 0, y: 0 },
            nodes: [{ id: "send_email_1", type: "send_email", config: { subject: "Hi", body: "Hello {{contact.firstName}}" }, position: { x: 300, y: 0 } }],
            edges: [{ source: "trigger", handle: "out", target: "send_email_1" }],
          },
        });
        await setWorkflowStatus(owner, workflow.id, "active");
        const started = await startRun(owner, workflow.id, { test: false, record: { type: "contact", id: ben }, fetchImpl: box.fetchImpl });
        assert.equal(box.sends().length, 0);
        const steps = await getRunSteps(owner, started.runId);
        const step = steps.steps.find((item) => item.stepId === "send_email_1");
        assert.equal(step?.status, "skipped");
        assert.match(step?.error ?? "", REFUSED);
      });

      it("refuses the assistant's send_email, sent now or later", async () => {
        const box = outlook();
        await assert.rejects(sendForAgent(owner, { to: ["ben@lumen.test"], subject: "Hello", body: "Hi Ben" }, { origin: ORIGIN, fetchImpl: box.fetchImpl }), refused(REFUSED));
        const later = new Date(Date.now() + 86_400_000).toISOString();
        await assert.rejects(sendForAgent(owner, { to: ["ben@lumen.test"], subject: "Hello", body: "Hi Ben", sendAt: later }, { origin: ORIGIN, fetchImpl: box.fetchImpl }), refused(REFUSED));
        assert.equal(box.sends().length, 0);
        assert.equal((await sql("select 1 from crm.mail_drafts where user_id = $1 and send_at is not null", [owner.userId])).length, 0);
      });

      it("refuses MCP mail_send, sent now or later", async () => {
        const box = outlook();
        await assert.rejects(sendMailOnce(owner, { to: ["ben@lumen.test", "tom@brightlane.test"], subject: "Hello", body: "Hi" }, { origin: ORIGIN, fetchImpl: box.fetchImpl }), refused(REFUSED));
        await assert.rejects(
          sendMailOnce(owner, { to: [{ address: "ben@lumen.test", name: "Ben Hart" }], subject: "Hello", body: "Hi", sendAt: new Date(Date.now() + 86_400_000).toISOString() }, { origin: ORIGIN, fetchImpl: box.fetchImpl }),
          refused(REFUSED),
        );
        assert.equal(box.sends().length, 0);
      });

      it("names every refused recipient", async () => {
        await withActor(owner, async (db) => {
          await assert.rejects(
            checkSuppressed(db, owner.workspaceId, [{ address: "ben@lumen.test", name: "Ben Hart" }, { address: "VIC@lane.test", name: "Vic Lane" }, { address: "tom@brightlane.test" }], "refuse"),
            refused(/^Couldn't send\. Ben Hart and Vic Lane are on the do not contact list\.$/),
          );
        });
      });
    });

    describe("routes that warn", () => {
      it("sends from the contact page's composer and proposal emails with a warning", async () => {
        const box = outlook();
        const result = await sendContactEmail(owner, ben, { subject: "Following up", body: "Hi Ben", suppression: "warn", origin: null }, box.fetchImpl);
        assert.equal(box.sends().length, 1);
        assert.equal(result.warning, "Sent. Ben Hart is on the do not contact list.");
        const plain = await sendContactEmail(owner, tom, { subject: "Hello", body: "Hi Tom", origin: null }, box.fetchImpl);
        assert.equal(plain.warning, null);
        const page = await contactSuppression(owner, ben);
        assert.equal(page.caution, "Ben Hart is on the do not contact list.");
        assert.equal((await contactSuppression(owner, tom)).caution, null);
        assert.equal((await contactSuppression(owner, uma)).caution, "Uma Reed is on the do not contact list.");
      });

      it("sends from the Mail composer, which shows the line before sending", async () => {
        const box = outlook();
        await withActor(owner, async (db) => {
          assert.deepEqual(await checkSuppressed(db, owner.workspaceId, [{ address: "ben@lumen.test", name: "Ben Hart" }], "warn"), ["Ben Hart"]);
        });
        const result = await sendMailDraft(owner, readDraftInput({ mode: "new", sourceId: source, to: [{ address: "ben@lumen.test", name: "Ben Hart" }], subject: "One to one", body: "Hi Ben" }), {
          origin: ORIGIN,
          fetchImpl: box.fetchImpl,
          storedFiles: "replace",
        });
        assert.equal(result.warning, null);
        assert.equal(box.sends().length, 1);
      });
    });

    describe("scheduled sends", () => {
      async function due(id: string) {
        await sql("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [id]);
      }

      it("checks a send scheduled earlier again when it goes", async () => {
        const later = new Date(Date.now() + 86_400_000).toISOString();
        const toTom = await scheduleMailDraft(owner, { ...readDraftInput({ mode: "new", sourceId: source, to: [{ address: "tom@brightlane.test", name: "Tom Avery" }], subject: "Later", body: "Hi Tom" }), sendAt: later }, { origin: ORIGIN, fetchImpl: outlook().fetchImpl, storedFiles: "replace" });
        const toBen = await scheduleMailDraft(owner, { ...readDraftInput({ mode: "new", sourceId: source, to: [{ address: "ben@lumen.test", name: "Ben Hart" }], subject: "Seen the warning", body: "Hi Ben" }), sendAt: later }, { origin: ORIGIN, fetchImpl: outlook().fetchImpl, storedFiles: "replace" });
        await setDoNotContact(owner, { contactId: tom }, { fetchImpl });
        await due(toTom.id);
        await due(toBen.id);
        const box = outlook();
        const report = await processDueMail(owner, { fetchImpl: box.fetchImpl, origin: ORIGIN });
        assert.equal(report.failed, 1);
        assert.equal(report.sent, 1);
        assert.equal(box.sends().length, 1);
        const failed = await sql<{ send_error: string | null }>("select send_error from crm.mail_drafts where id = $1", [toTom.id]);
        assert.equal(failed[0].send_error, "Couldn't send. Tom Avery is on the do not contact list.");
        assert.equal((await sql("select 1 from crm.mail_drafts where id = $1", [toBen.id])).length, 0, "the send Mark scheduled after seeing the warning went");
        await liftDoNotContact(owner, { contactId: tom });
      });
    });

    describe("lifting", () => {
      it("is refused for an agent token", async () => {
        const agent = await createAgent(owner.workspaceId, ["crm:read", "campaigns:write", "admin"], "Lifter");
        await assert.rejects(liftDoNotContact(agent.actor, { contactId: ben }), (error: unknown) => error instanceof CrmError && error.status === 403 && error.message === ONLY_A_PERSON_LIFTS);
        assert.ok(await doNotContactFor(owner, { contactId: ben }));
      });

      it("isn't offered by the assistant, MCP, REST or a workflow step", () => {
        const files = ["lib/assistant/tools.ts", "server/mcp/server.ts", "server/mcp/mail.ts", "lib/workflows/engine.ts", "lib/workflows/definition.ts"];
        for (const file of files) {
          const text = readFileSync(file, "utf8");
          assert.ok(!text.includes("liftDoNotContact") && !text.includes("suppression_lift"), file);
        }
        const v1 = readFileSync("lib/api/agent.ts", "utf8");
        assert.ok(!v1.includes("liftDoNotContact"));
        const routes = readFileSync("app/(crm)/campaigns/actions.ts", "utf8");
        assert.ok(routes.includes("liftDoNotContact("), "the web app is the one place that lifts");
      });

      it("works for a person in the app, from the thread or the contact page", async () => {
        const lifted = await liftDoNotContact(owner, { prospectId: thread.prospectId });
        assert.equal(lifted.lifted, 2);
        assert.equal(await doNotContactFor(owner, { contactId: ben }), null);
        const audit = await audits(owner.workspaceId, "campaign.do_not_contact_lifted");
        assert.equal(audit.length, 2, "Tom's lift and Ben's");
        assert.equal(audit[1].actor_user_id, owner.userId);
        const box = outlook();
        await sendContactEmail(owner, ben, { subject: "Back on", body: "Hi Ben", suppression: "refuse", origin: null }, box.fetchImpl);
        assert.equal(box.sends().length, 1);
        assert.equal((await suppressions(owner.workspaceId)).filter((row) => row.value === "uma@north.test").length, 1, "bounces stay");
        assert.deepEqual(await liftDoNotContact(owner, { contactId: ben }), { lifted: 0 });
      });
    });
  });

  describe("merging and moving", () => {
    it("re-points a merged contact's suppressions to the kept contact", async () => {
      const dup = (await createContact(owner, { firstName: "Benjamin", lastName: "Hart", email: "benjamin@lumen.test" }, { provenance: { operation: "test" } })).body.contact.id;
      await setDoNotContact(owner, { contactId: dup }, { fetchImpl });
      await mergeContacts(owner, ben, dup, { operation: "test" });
      const rows = await sql<{ contact_id: string }>("select contact_id from crm.suppressions where value = 'benjamin@lumen.test'");
      assert.deepEqual(rows.map((row) => row.contact_id), [ben]);
      assert.equal((await doNotContactFor(owner, { contactId: ben }))?.reason, "manual");
      await liftDoNotContact(owner, { contactId: ben });
      assert.equal((await sql("select 1 from crm.suppressions where value = 'benjamin@lumen.test'")).length, 0);
    });

    it("clears the contact on rows left behind when a contact moves workspace, and still matches by address", async () => {
      const leaving = (await createContact(owner, { firstName: "Lou", lastName: "Moved", email: "lou@moved.test" }, { provenance: { operation: "test" } })).body.contact.id;
      await setDoNotContact(owner, { contactId: leaving }, { fetchImpl });
      await sql("update crm.contacts set workspace_id = $2 where id = $1", [leaving, outsider.workspaceId]);
      const rows = await sql<{ contact_id: string | null; workspace_id: string }>("select contact_id, workspace_id from crm.suppressions where value = 'lou@moved.test'");
      assert.deepEqual(rows, [{ contact_id: null, workspace_id: owner.workspaceId }]);
      await withActor(owner, async (db) => {
        assert.equal((await suppressedAddresses(db, owner.workspaceId, ["lou@moved.test"])).length, 1);
      });
    });
  });

  describe("workspaces", () => {
    it("never reads, refuses or changes across workspaces", async () => {
      await setDoNotContact(owner, { contactId: ben }, { fetchImpl });
      const seen = await queryAsUser<{ value: string }>(outsider.userId, "select value from crm.suppressions");
      assert.equal(seen.length, 0);
      const mine = await queryAsUser<{ value: string }>(ann.userId, "select value from crm.suppressions where value = 'ben@lumen.test'");
      assert.equal(mine.length, 1);
      const box = outlook();
      const outsiderBen = (await sql<{ id: string }>("select id from crm.contacts where workspace_id = $1 and email = 'ben@lumen.test'", [outsider.workspaceId]))[0].id;
      await sendContactEmail(outsider, outsiderBen, { subject: "Hello", body: "Hi Ben", suppression: "refuse", origin: null }, box.fetchImpl);
      assert.equal(box.sends().length, 1);
      assert.equal(await doNotContactFor(outsider, { contactId: outsiderBen }), null);
      await assert.rejects(setDoNotContact(outsider, { contactId: ben }, { fetchImpl }), (error: unknown) => error instanceof CrmError && error.code === "not_found");
      await assert.rejects(liftDoNotContact(outsider, { contactId: ben }), (error: unknown) => error instanceof CrmError && error.code === "not_found");
      assert.equal((await prospect("lead-b-ben")).stop_requested_at, null);
      assert.ok(!(bravo.writes ?? []).some((write) => write.path.includes("block")));
    });
  });
});
