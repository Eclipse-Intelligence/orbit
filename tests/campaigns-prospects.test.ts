import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { judgeFill, type FillInput } from "@/lib/campaigns/fill";
import { addedLine, emailCapacityLine, linkedinCapacityLine, overflowLine } from "@/lib/campaigns/format";
import { addCompanyContacts, addProspects, contactOutreach, outreachOf, saveCampaignVariables } from "@/lib/campaigns/prospects";
import { smartleadProvider } from "@/lib/campaigns/providers";
import { claimFillBatch, fillActor, runFillBatch, transient } from "@/lib/campaigns/push";
import { findHeyReachLead } from "@/lib/heyreach";
import { SmartleadError } from "@/lib/smartlead";
import { getCampaign } from "@/lib/crm/campaigns";
import { createCompany, updateCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Contact, UserActor } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { definitionFromInput, type WorkflowDefinition } from "@/lib/workflows/definition";
import { removeProspect } from "@/lib/campaigns/manage";
import { runWorkflowTick } from "@/lib/workflows/engine";
import { withService } from "@/lib/workflows/limits";
import { createWorkflow, getRunSteps, saveWorkflow, setWorkflowStatus, startRun } from "@/lib/workflows/store";
import { STARTER_TEMPLATES } from "@/lib/workflows/templates";
import { fakeHeyReach, fakeSmartlead, type FakeAccount, type FakeHeyReachAccount } from "./campaigns-fake";
import { createAgent, createUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const SL_A = "sl_key_prospects_alpha_01";
const SL_B = "sl_key_prospects_bravo_02";
const HR_A = "hr_key_prospects_alpha_03";
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE", "WORKFLOW_LIMIT_LLM_PER_MINUTE"];
const EMAIL_SEQUENCE = [
  { step: 1, variant: null, subject: "Saw {{news_hook}}", body: "Hi {{first_name}}, saw {{news_hook}}.", delayDays: null },
  { step: 2, variant: null, subject: "", body: "Following up, {{first_name}}.", delayDays: 3 },
];
const LINKEDIN_SEQUENCE = [
  { step: 1, variant: null, subject: "Invite", body: "{connection_note}", delayDays: null },
  { step: 2, variant: null, subject: "Message", body: "Thanks for connecting, {first_name}.", delayDays: 1 },
];

type Push = { provider: "smartlead" | "heyreach"; body: Record<string, unknown> };

const state = {
  pushes: [] as Push[],
  llm: [] as string[],
  webSearch: [] as boolean[],
  smartleadFails: null as number | null,
  smartleadShort: false,
  found: new Set<string>(),
  foundElsewhere: new Set<string>(),
  badEmail: null as string | null,
  llmStatus: null as number | null,
  gate: null as null | { seenPush: boolean | null },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fillReply(user: string) {
  const prospect = user.match(/Prospect:\n(\{.*\})/)?.[1] ?? "{}";
  const first = (JSON.parse(prospect) as { firstName?: string }).firstName ?? "";
  if (/connection_note/.test(user)) {
    return { values: [{ name: "connection_note", value: `Hi ${first},\nliked your talk on {pricing}.`, sources: [{ fact: "Spoke at Brighton SEO" }] }] };
  }
  if (first === "Nina") return { values: [{ name: "news_hook", value: "", sources: [] }] };
  if (first === "Omar") return { values: [{ name: "news_hook", value: "growing 40% last year", sources: [{ fact: "They are growing" }] }] };
  return { values: [{ name: "news_hook", value: `the ${first} launch`, sources: [{ fact: `${first} launched a product`, url: "https://news.example/launch" }] }] };
}

const smartleadFake = (accounts: FakeAccount[]) => fakeSmartlead(accounts);

function router(accounts: FakeAccount[], heyreach: FakeHeyReachAccount[]): typeof fetch {
  const smartlead = smartleadFake(accounts);
  const hey = fakeHeyReach(heyreach);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.hostname === "api.llmapi.ai") {
      const user = String((body?.messages as { content: string }[] | undefined)?.[1]?.content ?? "");
      state.llm.push(user);
      state.webSearch.push(Boolean(body?.web_search_options));
      if (user.includes("FAIRNESS") && state.gate) {
        const pushesAtStart = state.pushes.length;
        for (let waited = 0; waited < 40 && state.pushes.length === pushesAtStart && state.gate.seenPush === null; waited += 1) {
          if (state.pushes.some((push) => JSON.stringify(push.body).includes("fair@fill.test"))) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        state.gate.seenPush = state.pushes.some((push) => JSON.stringify(push.body).includes("fair@fill.test"));
        return json({ model: "test", choices: [{ message: { content: JSON.stringify({ text: "ok" }) }, finish_reason: "stop" }] });
      }
      if (state.llmStatus) return json({ error: { message: "Down" } }, state.llmStatus);
      return json({ model: "test", choices: [{ message: { content: JSON.stringify(fillReply(user)) }, finish_reason: "stop" }] });
    }
    if (url.hostname === "server.smartlead.ai") {
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (method === "POST" && /^\/campaigns\/\d+\/leads$/.test(path)) {
        state.pushes.push({ provider: "smartlead", body: body ?? {} });
        if (state.smartleadFails) return json({ message: "Down" }, state.smartleadFails);
        const leads = (body?.lead_list as { email: string }[]) ?? [];
        if (state.badEmail && leads.some((lead) => lead.email === state.badEmail)) return json({ message: "Invalid lead" }, 400);
        return json({ ok: true, upload_count: state.smartleadShort ? 0 : leads.length, already_added_to_campaign: 0 });
      }
      if (method === "GET" && path === "/leads/") {
        const email = url.searchParams.get("email") ?? "";
        if (state.foundElsewhere.has(email)) return json({ id: `sl-${email}`, lead_campaign_data: [] });
        return state.found.has(email) ? json({ id: `sl-${email}`, lead_campaign_data: [{ campaign_id: 701 }] }) : json({ message: "Not found" }, 404);
      }
      return smartlead(input, init);
    }
    if (url.hostname === "api.heyreach.io") {
      const path = url.pathname.replace(/^\/api\/public/, "");
      if (path === "/campaign/AddLeadsToCampaignV2") {
        state.pushes.push({ provider: "heyreach", body: body ?? {} });
        return json({ addedLeadsCount: ((body?.accountLeadPairs as unknown[]) ?? []).length, updatedLeadsCount: 0, failedLeadsCount: 0 });
      }
      return hey(input, init);
    }
    throw new Error(`Unexpected request to ${url.href}`);
  };
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function row(prospectId: string) {
  const rows = await sql<{ state: string; skip_reason: string | null; values: Record<string, string>; sources: Record<string, unknown>; external_lead_id: string | null; sender_id: string | null; added_by_run_id: string | null; claimed_by: string | null }>(
    `select state, skip_reason, "values", sources, external_lead_id, sender_id, added_by_run_id, claimed_by from crm.campaign_prospects where id = $1`,
    [prospectId],
  );
  return rows[0];
}

function pushesFor(email: string) {
  return state.pushes.filter((push) => JSON.stringify(push.body).includes(email));
}

describe("adding prospects", () => {
  let owner: UserActor;
  let ann: UserActor;
  let outsider: UserActor;
  let sam: string;
  let emailCampaign: string;
  let otherCampaign: string;
  let linkedinCampaign: string;
  let pausedCampaign: string;
  let outsiderCampaign: string;
  const people: Record<string, Contact> = {};
  const saved: Record<string, string | undefined> = {};
  const alpha: FakeAccount = { key: SL_A, client: { id: 1, name: "Eclipse" }, campaigns: [], calls: [] };
  const bravo: FakeAccount = { key: SL_B, client: { id: 2, name: "Ridgeon" }, campaigns: [], calls: [] };
  const hr: FakeHeyReachAccount = {
    key: HR_A,
    accounts: [
      { id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@prospects.test", profileUrl: "https://www.linkedin.com/in/markridgeon", connectionRequestsDailyLimit: 20 },
      { id: 2, firstName: "Ann", lastName: "Member", emailAddress: "ann@prospects.test", profileUrl: "https://www.linkedin.com/in/annmember", connectionRequestsDailyLimit: 20 },
    ],
    campaigns: [],
    calls: [],
  };
  const fetchImpl = router([alpha, bravo], [hr]);

  async function contact(actor: UserActor, key: string, input: Record<string, unknown>, check: "valid" | "invalid" | null = "valid") {
    const made = (await createContact(actor, input, { provenance: { operation: "test" } })).body.contact;
    people[key] = made;
    if (check && made.email) {
      await sql(
        `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_by_user_id)
         values ($1, 'contact', $2, 'email_check', $3, 'enrow', $4, $5)`,
        [actor.workspaceId, made.id, check, made.email.toLowerCase(), actor.userId],
      );
    }
    return made;
  }

  async function campaign(workspaceId: string, provider: "smartlead" | "heyreach", externalId: string, name: string, status: string, sequence: unknown[], variables: string[], senders: string[] = []) {
    const rows = await sql<{ id: string }>(
      `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, sequence, variables, sender_ids, backfilled_at, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now(), now()) returning id`,
      [workspaceId, provider, provider === "smartlead" ? "email" : "linkedin", externalId, name, status, JSON.stringify(sequence), variables, senders],
    );
    return rows[0].id;
  }

  async function drainFills() {
    for (let round = 0; round < 5; round += 1) {
      const batch = await claimFillBatch();
      if (!batch) return;
      await runFillBatch(batch, { deadline: Date.now() + 300_000, fetchImpl });
    }
  }

  before(async () => {
    await resetDatabase();
    for (const name of LIMITS) {
      saved[name] = process.env[name];
      process.env[name] = "100000";
    }
    owner = await createUser("mark@prospects.test", "Mark Ridgeon");
    const second = await createUser("ann@prospects.test", "Ann Member");
    outsider = await createUser("oscar@elsewhere-prospects.test", "Oscar Outsider");
    const both = await createUser("sam@prospects.test", "Sam Both");
    sam = both.userId;
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [outsider.workspaceId, sam]);
    ann = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };

    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    await saveCampaignConnection(outsider, "smartlead", SL_B, { fetchImpl });

    emailCampaign = await campaign(owner.workspaceId, "smartlead", "701", "Agency outreach", "active", EMAIL_SEQUENCE, ["first_name", "news_hook"]);
    otherCampaign = await campaign(owner.workspaceId, "smartlead", "702", "Other outreach", "active", [], []);
    linkedinCampaign = await campaign(owner.workspaceId, "heyreach", "801", "Agency founders", "active", LINKEDIN_SEQUENCE, ["connection_note", "first_name"], ["1", "2"]);
    pausedCampaign = await campaign(owner.workspaceId, "heyreach", "802", "Paused founders", "paused", LINKEDIN_SEQUENCE, ["connection_note"], ["1"]);
    outsiderCampaign = await campaign(outsider.workspaceId, "smartlead", "711", "Ridgeon outreach", "active", [], []);
    await saveCampaignVariables(owner, emailCampaign, [{ name: "news_hook", brief: "Something specific they did, plainly.", maxLength: 80 }], { operation: "test" });

    const customer = (await createCompany(owner, { name: "Cara Co", domain: "cara.test" })).body.company;
    await updateCompany(owner, customer.id, { lifecycle: "customer" });
    const opportunityCompany = (await createCompany(owner, { name: "Dan Ltd", domain: "dan.test" })).body.company;
    await createOpportunity(owner, { companyId: opportunityCompany.id, name: "Dan pilot" });

    await contact(owner, "ben", { firstName: "Ben", lastName: "Hart", email: "ben@lumen.test" });
    await contact(owner, "cara", { firstName: "Cara", lastName: "Stone", email: "cara@cara.test", companyId: customer.id });
    await contact(owner, "dan", { firstName: "Dan", lastName: "Ellis", email: "dan@dan.test", companyId: opportunityCompany.id });
    await contact(owner, "eve", { firstName: "Eve", lastName: "Moss", email: "eve@moss.test" });
    await contact(owner, "fay", { firstName: "Fay", lastName: "Hill", email: "fay@hill.test" });
    await contact(owner, "gus", { firstName: "Gus", lastName: "Webb", linkedinUrl: "https://www.linkedin.com/in/guswebb" }, null);
    await contact(owner, "hal", { firstName: "Hal", lastName: "Ford", email: "hal@ford.test" });
    await contact(owner, "ida", { firstName: "Ida", lastName: "Shaw", email: "ida@shaw.test" });
    await contact(owner, "nina", { firstName: "Nina", lastName: "Park", email: "nina@park.test" });
    await contact(owner, "omar", { firstName: "Omar", lastName: "Fox", email: "omar@fox.test" });
    await contact(owner, "pat", { firstName: "Pat", lastName: "Kerr", email: "pat@kerr.test" });
    await contact(owner, "quin", { firstName: "Quin", lastName: "Lowe", email: "quin@lowe.test" });
    await contact(owner, "rob", { firstName: "Rob", lastName: "Dale", email: "rob@dale.test" });
    await contact(owner, "sue", { firstName: "Sue", lastName: "Hope", email: "sue@hope.test" });
    await contact(owner, "jon", { firstName: "Jon", lastName: "Reid", email: "jon@reid.test", linkedinUrl: "https://www.linkedin.com/in/jonreid", ownerId: second.userId });
    await contact(owner, "lou", { firstName: "Lou", email: "lou@lou.test", linkedinUrl: "https://www.linkedin.com/in/lou" });
    await contact(owner, "tia", { firstName: "Tia", lastName: "Ward", email: "tia@ward.test" });
    await contact(owner, "vic", { firstName: "Vic", lastName: "Lane", email: "vic@lane.test" });
    await contact(outsider, "zed", { firstName: "Zed", lastName: "Cole", email: "zed@cole.test" });
    await contact(outsider, "benB", { firstName: "Ben", lastName: "Hart", email: "ben@lumen.test" });

    await sql("insert into crm.mail_known_addresses (user_id, address, domain, sent_count) values ($1, 'eve@moss.test', 'moss.test', 2)", [second.userId]);
    await sql("insert into crm.mail_known_addresses (user_id, address, domain, met_first) values ($1, 'zed@cole.test', 'cole.test', now() - interval '1 day')", [sam]);
    await sql("insert into crm.suppressions (workspace_id, contact_id, kind, value, reason, source) values ($1, $2, 'email', 'fay@hill.test', 'manual', 'test')", [owner.workspaceId, people.fay.id]);
    await sql(
      `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, state, replied_at, pushed_at)
       values ($1, $2, $3, 'hal@ford.test', 'pushed', now(), now()), ($1, $2, $4, 'ida@shaw.test', 'pushed', null, now())`,
      [owner.workspaceId, otherCampaign, people.hal.id, people.ida.id],
    );
  });

  after(async () => {
    for (const name of LIMITS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    delete process.env.LLM_API_KEY;
    await getPool().end();
    await getAdminPool().end();
  });

  beforeEach(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    state.smartleadFails = null;
    state.smartleadShort = false;
    state.badEmail = null;
    state.llmStatus = null;
    await sql("delete from private.rate_limit_buckets where bucket_key like 'workflow-service:%'");
  });

  afterEach(() => {
    delete process.env.LLM_API_KEY;
  });

  useServerlessPool();

  it("runs its migration twice", async () => {
    await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270211100000_campaign_prospects.sql", "utf8"));
    await reapplyMigrationsFrom("20270211100000_campaign_prospects.sql");
  });

  it("skips everyone the rules say not to contact, and says why", async () => {
    const ids = ["ben", "cara", "dan", "eve", "fay", "gus", "hal", "ida"].map((key) => people[key].id);
    const result = await addProspects(owner, emailCampaign, ids, { operation: "test", source: "web" });
    const byContact = new Map(result.prospects.map((item) => [item.contactId, item]));
    const reason = (key: string) => byContact.get(people[key].id)?.skipReason ?? null;
    assert.equal(byContact.get(people.ben.id)?.state, "queued");
    assert.equal(reason("cara"), "Customer");
    assert.equal(reason("dan"), "Open opportunity");
    assert.equal(reason("eve"), "Written to or met");
    assert.equal(reason("fay"), "Do not contact");
    assert.equal(reason("gus"), "No email");
    assert.equal(reason("hal"), "Already replied");
    assert.equal(reason("ida"), "In another campaign");
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 7);
    assert.match(addedLine(result), /^1 added to Agency outreach\. 7 skipped: /);
    const audits = await sql("select 1 from crm.audit_events where workspace_id = $1 and event_type = 'campaign.prospect_added'", [owner.workspaceId]);
    assert.equal(audits.length, 1, "only the person who was added is audited");
  });

  it("counts mail from a member of both workspaces as written to or met in each", async () => {
    const result = await addProspects(outsider, outsiderCampaign, [people.zed.id], { operation: "test" });
    assert.equal(result.prospects[0].skipReason, "Written to or met");
    assert.equal((await sql("select 1 from crm.mail_known_addresses where address = 'zed@cole.test' and user_id = $1", [sam])).length, 1);
  });

  it("never lets anyone read or add to a campaign outside their workspace", async () => {
    await assert.rejects(addProspects(outsider, emailCampaign, [people.benB.id], { operation: "test" }), (error) => error instanceof CrmError && error.status === 404);
    await assert.rejects(getCampaign(outsider, emailCampaign), (error) => error instanceof CrmError && error.status === 404);
    const foreign = await addProspects(owner, otherCampaign, [people.zed.id], { operation: "test" });
    assert.equal(foreign.prospects.length, 0);
    assert.equal(foreign.missing, 1);
    assert.equal((await sql("select 1 from crm.campaign_prospects where contact_id = $1 and campaign_id = $2", [people.zed.id, otherCampaign])).length, 0);
    const { actor: reader } = await createAgent(owner.workspaceId, ["crm:read"]);
    await assert.rejects(addProspects(reader, emailCampaign, [people.tia.id], { operation: "test" }), (error) => error instanceof CrmError && error.status === 403);
    const { actor: elsewhere } = await createAgent(outsider.workspaceId, ["crm:read", "campaigns:write"]);
    await assert.rejects(addProspects(elsewhere, emailCampaign, [people.tia.id], { operation: "test" }), (error) => error instanceof CrmError && error.status === 404);
    const { actor: writer } = await createAgent(owner.workspaceId, ["crm:read", "campaigns:write"]);
    const added = await addProspects(writer, emailCampaign, [people.tia.id], { operation: "test" });
    assert.equal(added.added, 1);
    const tia = await sql<{ added_by_agent_id: string | null }>("select added_by_agent_id from crm.campaign_prospects where contact_id = $1", [people.tia.id]);
    assert.equal(tia[0].added_by_agent_id, writer.agentId);
    await assert.rejects(saveCampaignVariables(writer, emailCampaign, [], { operation: "test" }), (error) => error instanceof CrmError && error.status === 403);
    await assert.rejects(saveCampaignVariables(outsider, emailCampaign, [], { operation: "test" }), (error) => error instanceof CrmError && error.status === 404);
  });

  it("fills and pushes queued prospects once, with their variables and sources", async () => {
    state.pushes.length = 0;
    await drainFills();
    const ben = (await addProspects(owner, emailCampaign, [people.ben.id], { operation: "test" })).prospects[0];
    assert.equal(ben.outcome, "already");
    const saved = await row(ben.prospectId);
    assert.equal(saved.state, "pushed");
    assert.equal(saved.values.news_hook, "the Ben launch");
    assert.equal(saved.sources.news_hook, undefined, "a link the AI didn't read is dropped");
    const pushes = pushesFor("ben@lumen.test");
    assert.equal(pushes.length, 1);
    const lead = (pushes[0].body.lead_list as Record<string, unknown>[]).find((item) => item.email === "ben@lumen.test")!;
    assert.deepEqual(lead.custom_fields, { news_hook: "the Ben launch" });
    assert.deepEqual(pushes[0].body.settings, { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false });
    const fired = await sql<{ data: Record<string, unknown> }>("select data from crm.workflow_events where data->>'prospectId' = $1 and data->>'kind' = 'added'", [ben.prospectId]);
    assert.equal(fired.length, 1);
    const activity = await sql<{ title: string }>("select title from crm.activities where contact_id = $1 and metadata->>'campaignAddedProspectId' = $2", [people.ben.id, ben.prospectId]);
    assert.deepEqual(activity.map((item) => item.title), ["Added to Agency outreach"]);
    assert.equal((await row(ben.prospectId)).claimed_by, null);
    assert.ok(state.webSearch.length > 0 && state.webSearch.every(Boolean), "every fill can search the web");
    assert.match(String(state.llm[0]), /Prospect:/);
    const tia = await sql<{ state: string; added_by_agent_id: string | null }>("select state, added_by_agent_id from crm.campaign_prospects where contact_id = $1", [people.tia.id]);
    assert.deepEqual(tia.map((item) => item.state), ["pushed"], "a prospect an agent token added is filled as the sync's member");
    await drainFills();
    assert.equal(pushesFor("ben@lumen.test").length, 1, "nothing pushes twice");
  });

  it("never pushes a prospect missing a required variable or using an unsourced figure", async () => {
    const result = await addProspects(owner, emailCampaign, [people.nina.id, people.omar.id], { operation: "test" });
    await drainFills();
    const [nina, omar] = result.prospects;
    assert.deepEqual([(await row(nina.prospectId)).state, (await row(nina.prospectId)).skip_reason], ["skipped", "Nothing found for news_hook"]);
    assert.deepEqual([(await row(omar.prospectId)).state, (await row(omar.prospectId)).skip_reason], ["skipped", "Nothing found for news_hook"]);
    assert.equal(pushesFor("nina@park.test").length + pushesFor("omar@fox.test").length, 0);
  });

  it("checks Do not contact and replies again just before pushing", async () => {
    const result = await addProspects(owner, emailCampaign, [people.pat.id, people.quin.id], { operation: "test" });
    await sql("insert into crm.suppressions (workspace_id, kind, value, reason, source) values ($1, 'email', 'pat@kerr.test', 'unsubscribed', 'test')", [owner.workspaceId]);
    await sql(
      "insert into crm.campaign_prospects (workspace_id, campaign_id, email, state, replied_at, pushed_at) values ($1, $2, 'quin@lowe.test', 'pushed', now(), now())",
      [owner.workspaceId, otherCampaign],
    );
    await drainFills();
    const [pat, quin] = result.prospects;
    assert.equal((await row(pat.prospectId)).skip_reason, "Do not contact");
    assert.equal((await row(quin.prospectId)).skip_reason, "Already replied");
    assert.equal(pushesFor("pat@kerr.test").length + pushesFor("quin@lowe.test").length, 0);
  });

  it("looks a lead up after an unclear push instead of pushing it twice", async () => {
    state.pushes.length = 0;
    const rob = (await addProspects(owner, emailCampaign, [people.rob.id], { operation: "test" })).prospects[0];
    state.smartleadFails = 502;
    await drainFills();
    assert.equal((await row(rob.prospectId)).state, "pushing");
    assert.equal(pushesFor("rob@dale.test").length, 1);
    state.smartleadFails = null;
    state.found.add("rob@dale.test");
    await drainFills();
    assert.equal((await row(rob.prospectId)).state, "pushing", "an unclear push waits a minute before Orbit looks again");
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [rob.prospectId]);
    await drainFills();
    const after = await row(rob.prospectId);
    assert.equal(after.state, "pushed");
    assert.equal(after.external_lead_id, "sl-rob@dale.test");
    assert.equal(pushesFor("rob@dale.test").length, 1, "the retry found the lead and didn't push again");
  });

  it("fails a lead the provider didn't take, then re-queues it and checks again when added again", async () => {
    state.smartleadShort = true;
    const sue = (await addProspects(owner, emailCampaign, [people.sue.id], { operation: "test" })).prospects[0];
    await drainFills();
    assert.deepEqual([(await row(sue.prospectId)).state, (await row(sue.prospectId)).skip_reason], ["failed", "Smartlead didn't take this lead"]);
    state.smartleadShort = false;
    await sql("update crm.campaign_prospects set stop_requested_at = now(), stop_reason = 'removed' where id = $1", [sue.prospectId]);
    const again = (await addProspects(owner, emailCampaign, [people.sue.id, people.fay.id], { operation: "test" })).prospects;
    assert.equal(again[0].outcome, "requeued");
    assert.deepEqual(await sql("select stop_requested_at, stop_reason from crm.campaign_prospects where id = $1", [sue.prospectId]), [{ stop_requested_at: null, stop_reason: null }]);
    assert.equal(again[0].prospectId, sue.prospectId);
    assert.equal(again[1].outcome, "skipped", "Do not contact is checked again");
    await drainFills();
    assert.equal((await row(sue.prospectId)).state, "pushed");
  });

  it("adds a company's people", async () => {
    const company = (await createCompany(owner, { name: "Ward Group", domain: "ward.test" })).body.company;
    await contact(owner, "uri", { firstName: "Uri", lastName: "Ward", email: "uri@ward.test", companyId: company.id });
    const result = await addCompanyContacts(owner, otherCampaign, [company.id], { operation: "test" });
    assert.equal(result.added, 1);
  });

  it("LinkedIn: refuses a campaign that isn't running, needs a full name and sends from the owner's account", async () => {
    await assert.rejects(addProspects(owner, pausedCampaign, [people.jon.id], { operation: "test" }), /Start this campaign in HeyReach first\./);
    const result = await addProspects(owner, linkedinCampaign, [people.jon.id, people.lou.id], { operation: "test" });
    assert.equal(result.prospects[1].skipReason, "No first or last name");
    await drainFills();
    const jon = await row(result.prospects[0].prospectId);
    assert.equal(jon.state, "pushed");
    assert.equal(jon.sender_id, "2");
    assert.equal(jon.values.connection_note, "Hi Jon, liked your talk on pricing.", "a connection note is one line with no braces");
    assert.deepEqual(jon.sources.connection_note, [{ label: "Spoke at Brighton SEO" }]);
    const push = state.pushes.find((item) => item.provider === "heyreach")!;
    const pair = (push.body.accountLeadPairs as Record<string, unknown>[])[0];
    assert.equal(pair.linkedInAccountId, 2);
    assert.deepEqual((pair.lead as Record<string, unknown>).customUserFields, [{ name: "connection_note", value: "Hi Jon, liked your talk on pricing." }]);
    assert.equal((pair.lead as Record<string, unknown>).profileUrl, "https://www.linkedin.com/in/jonreid");
  });

  it("reads contact.outreach from the newest row on each channel", async () => {
    const jonRow = (await sql<{ id: string }>("select id from crm.campaign_prospects where contact_id = $1 and campaign_id = $2", [people.jon.id, linkedinCampaign]))[0];
    assert.deepEqual(await contactOutreach(owner, people.jon.id), { email: "none", linkedin: "queued", replied: false });
    await sql(
      "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, occurred_at, dedupe_key) values ($1, $2, $3, 'invite_accepted', now(), 'test:jon:accepted')",
      [owner.workspaceId, linkedinCampaign, jonRow.id],
    );
    assert.equal((await contactOutreach(owner, people.jon.id)).linkedin, "accepted");
    const benRow = (await sql<{ id: string }>("select id from crm.campaign_prospects where contact_id = $1 and campaign_id = $2", [people.ben.id, emailCampaign]))[0];
    await sql(
      "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, step, occurred_at, dedupe_key) values ($1, $2, $3, 'sent', 1, now(), 'test:ben:sent')",
      [owner.workspaceId, emailCampaign, benRow.id],
    );
    assert.deepEqual(await contactOutreach(owner, people.ben.id), { email: "sent", linkedin: "none", replied: false });
    assert.deepEqual(await contactOutreach(outsider, people.ben.id), { email: "none", linkedin: "none", replied: false }, "another workspace sees nothing");
    assert.deepEqual(
      outreachOf([
        { channel: "email", state: "pushed", replied_at: null, stopped_at: null, lead_status: null, campaign_status: "active", kinds: ["sent", "opened"], created_at: "2026-11-01T00:00:00Z" },
        { channel: "email", state: "skipped", replied_at: null, stopped_at: null, lead_status: null, campaign_status: "active", kinds: [], created_at: "2026-11-10T00:00:00Z" },
        { channel: "linkedin", state: "pushed", replied_at: null, stopped_at: null, lead_status: null, campaign_status: "active", kinds: ["invite_sent", "invite_accepted"], created_at: "2026-11-02T00:00:00Z" },
        { channel: "linkedin", state: "failed", replied_at: null, stopped_at: null, lead_status: null, campaign_status: "active", kinds: [], created_at: "2026-11-12T00:00:00Z" },
      ]),
      { email: "opened", linkedin: "accepted", replied: false },
      "a row that never went out isn't outreach",
    );
    await sql(
      "insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, linkedin, state, skip_reason, created_at) values ($1, $2, $3, 'linkedin.com/in/jonreid', 'skipped', 'In another campaign', now() + interval '1 minute')",
      [owner.workspaceId, pausedCampaign, people.jon.id],
    );
    assert.equal((await contactOutreach(owner, people.jon.id)).linkedin, "accepted", "a later skip in another campaign doesn't hide the acceptance");
  });

  async function workflow(definition: WorkflowDefinition) {
    const created = await createWorkflow(owner, { name: `Prospects ${Math.random()}` });
    await saveWorkflow(owner, created.id, { definition });
    await setWorkflowStatus(owner, created.id, "active");
    return created.id;
  }

  function stepFlow(): WorkflowDefinition {
    const parsed = definitionFromInput({
      trigger: { type: "manual", object: "contact" },
      nodes: [
        { id: "filter_1", type: "filter", config: { match: "all", conditions: [{ left: "{{contact.outreach.email}}", op: "is", right: "none" }] } },
        { id: "add_to_campaign_1", type: "add_to_campaign", config: { campaignId: emailCampaign, campaignName: "Agency outreach", channel: "email" } },
        { id: "add_note_1", type: "add_note", config: { title: "Now {{contact.outreach.email}}", body: "{{steps.add_to_campaign_1.state}}" } },
      ],
      edges: [
        { source: "trigger", handle: "out", target: "filter_1" },
        { source: "filter_1", handle: "out", target: "add_to_campaign_1" },
        { source: "add_to_campaign_1", handle: "out", target: "add_note_1" },
      ],
    });
    assert.ok("definition" in parsed, JSON.stringify(parsed));
    return parsed.definition;
  }

  it("Add to campaign fills and pushes inside a run, a test run only describes it, and outreach reloads", async () => {
    const id = await workflow(stepFlow());
    const before = state.pushes.length;
    const test = await startRun(owner, id, { test: true, record: { type: "contact", id: people.vic.id }, fetchImpl });
    const testSteps = (await getRunSteps(owner, test.runId)).steps;
    assert.ok(testSteps.some((step) => step.stepId === "add_to_campaign_1" && JSON.stringify(step.output).includes("testRun")));
    assert.equal(state.pushes.length, before, "a test run pushes nothing");
    assert.equal((await sql("select 1 from crm.campaign_prospects where contact_id = $1", [people.vic.id])).length, 0);

    const run = await startRun(owner, id, { test: false, record: { type: "contact", id: people.vic.id }, fetchImpl });
    for (let round = 0; round < 3; round += 1) await runWorkflowTick({ fetchImpl, budgetMs: 200_000, long: true, limit: 5 });
    const added = (await sql<{ id: string; state: string; added_by_run_id: string }>("select id, state, added_by_run_id from crm.campaign_prospects where contact_id = $1 and campaign_id = $2", [people.vic.id, emailCampaign]))[0];
    assert.equal(added.state, "pushed");
    assert.equal(added.added_by_run_id, run.runId);
    const event = await sql<{ payload: { sourceWorkflowId?: string; depth?: number }; fired_at: Date | null }>("select payload, fired_at from crm.campaign_events where prospect_id = $1 and kind = 'added'", [added.id]);
    assert.equal(event[0].payload.sourceWorkflowId, id, "the added event carries the workflow that pushed it, for the loop guard");
    assert.equal(event[0].payload.depth, 1);
    assert.ok(event[0].fired_at);
    const note = await sql<{ title: string; body: string }>("select title, body from crm.activities where contact_id = $1 and type = 'note' and title like 'Now %'", [people.vic.id]);
    assert.deepEqual(note.map((item) => [item.title, item.body]), [["Now queued", "pushed"]]);
    assert.equal(pushesFor("vic@lane.test").length, 1);

    const second = await startRun(owner, id, { test: false, record: { type: "contact", id: people.vic.id }, fetchImpl });
    for (let round = 0; round < 2; round += 1) await runWorkflowTick({ fetchImpl, budgetMs: 200_000, long: true, limit: 5 });
    const steps = (await getRunSteps(owner, second.runId)).steps;
    assert.deepEqual(steps.map((step) => step.stepId), ["filter_1"], "the filter read the new outreach and stopped the path");
    assert.equal(pushesFor("vic@lane.test").length, 1, "a second run never pushes the same person again");
    const uri = await sql<{ state: string }>("select state from crm.campaign_prospects where contact_id = $1", [people.uri.id]);
    assert.deepEqual(uri.map((item) => item.state), ["pushed"], "the workers' long tick takes queued adds as fill jobs");
  });

  it("saves variable briefs and shows capacity", async () => {
    const briefs = await saveCampaignVariables(ann, emailCampaign, [{ name: "news_hook", brief: "A recent launch.", maxLength: 60 }], { operation: "test" });
    assert.deepEqual(briefs, [{ name: "news_hook", brief: "A recent launch.", required: true, maxLength: 60 }]);
    await assert.rejects(saveCampaignVariables(ann, emailCampaign, [{ name: "first_name", brief: "x" }], { operation: "test" }), /isn't in this campaign's steps/);
    const detail = await getCampaign(owner, emailCampaign);
    assert.deepEqual(detail.briefs.map((item) => item.name), ["news_hook"]);
    const linkedin = await getCampaign(owner, linkedinCampaign);
    assert.equal(linkedin.capacity?.invites, 40);
    assert.equal(emailCapacityLine(10, 200, 4), "10 mailboxes send 200 a day. At 4 steps, about 50 new prospects a day fit.");
    assert.equal(overflowLine(71, 50), "Today's workflow added 71. The extra 21 wait for tomorrow.");
    assert.equal(overflowLine(40, 50), null);
    assert.equal(linkedinCapacityLine({ senders: 2, invites: 40, messages: 70 }, 2), "2 senders send 40 invites a day. About 35 new prospects a day fit.");
    assert.equal(
      addedLine({ campaign: { name: "Agency outreach" }, added: 9, already: 0, skipped: 3, missing: 0, reasons: [{ reason: "Open opportunity", count: 2 }, { reason: "Already replied", count: 1 }] }),
      "9 added to Agency outreach. 3 skipped: 2 open opportunity, 1 already replied.",
    );
  });

  it("fills an agent's prospects as the member who connected that campaign's tool while they're an owner or admin, else an owner", async () => {
    const dee = await createUser("dee@prospects.test", "Dee Admin");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')", [owner.workspaceId, dee.userId]);
    await sql("update crm.campaign_connections set connected_by = $2 where workspace_id = $1 and provider = 'heyreach'", [owner.workspaceId, dee.userId]);
    await sql("update crm.campaign_connections set connected_by = $2 where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId, ann.userId]);
    assert.equal((await fillActor(owner.workspaceId, "heyreach", null))?.userId, dee.userId, "the campaign's own connection decides");
    assert.equal((await fillActor(owner.workspaceId, "smartlead", null))?.userId, owner.userId, "a member who isn't an owner or admin is passed over");
    await sql("update crm.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [owner.workspaceId, dee.userId]);
    assert.equal((await fillActor(owner.workspaceId, "heyreach", null))?.userId, owner.userId, "a demoted member falls back to an owner");
    assert.equal((await fillActor(owner.workspaceId, "heyreach", ann.userId))?.userId, ann.userId, "a person's own adds run as them");
    await sql("update crm.campaign_connections set connected_by = $2 where workspace_id = $1", [owner.workspaceId, owner.userId]);
  });

  it("only counts figures that Orbit holds or a page the AI read", () => {
    const proof = [{ id: "proof-1", client: "Acme", description: "a logistics firm", product: "SEO", usedFor: "organic growth", result: "cut acquisition costs by 30%", measured: "2025", permission: "named" }];
    const input = {
      variables: [{ name: "hook", brief: "", required: true, maxLength: null }],
      valueLimit: 2000,
      token: (name: string) => `{{${name}}}`,
      campaign: { name: "x", channel: "email", provider: "smartlead", sequence: [] },
      contact: { name: "A", firstName: "A", notes: "Their revenue grew 12% last year." },
      company: null,
      proof,
    } as unknown as FillInput;
    const judge = (value: string, sources: { fact: string; url?: string; proofId?: string }[]) => judgeFill(input, { values: [{ name: "hook", value, sources }] }, []).problem;
    assert.equal(judge("Your revenue grew 45%", [{ fact: "revenue grew 45%" }]), "Nothing found for hook", "the AI can't vouch for its own figure");
    assert.equal(judge("Your revenue grew 12%", [{ fact: "revenue grew 12%" }]), null, "a figure in Orbit's own records passes");
    assert.equal(judge("Acme cut costs by 70%", [{ fact: "cut costs by 70%", proofId: "proof-1" }]), "Nothing found for hook", "a proof entry's own wording decides");
    assert.equal(judge("Acme cut acquisition costs by 30%", [{ fact: "cut costs by 70%", proofId: "proof-1" }]), null);
    assert.equal(judge("Beta cut costs by 30%", [{ fact: "cut costs by 30%", proofId: "proof-unknown" }]), "Nothing found for hook");
  });

  it("never counts a model's own fact for a page it didn't read, even one Orbit knows", () => {
    const input = {
      variables: [{ name: "hook", brief: "", required: true, maxLength: null }],
      valueLimit: 2000,
      token: (name: string) => `{{${name}}}`,
      campaign: { name: "x", channel: "email", provider: "smartlead", sequence: [] },
      contact: { name: "A", firstName: "A" },
      company: { name: "Acme", website: "https://acme.test" },
      proof: [],
    } as unknown as FillInput;
    const text = "Acme raised £45m and grew 300%";
    assert.equal(judgeFill(input, { values: [{ name: "hook", value: text, sources: [{ fact: text, url: "https://acme.test" }] }] }, []).problem, "Nothing found for hook");
    assert.equal(judgeFill(input, { values: [{ name: "hook", value: text, sources: [{ fact: text, url: "https://acme.test" }] }] }, ["https://acme.test"]).problem, null, "a page it read counts");
  });

  it("puts a row back to filling when nothing was sent, and trusts a lookup only for this campaign", async () => {
    await contact(owner, "abe", { firstName: "Abe", lastName: "Ross", email: "abe@ross.test" });
    const abe = (await addProspects(owner, emailCampaign, [people.abe.id], { operation: "test" })).prospects[0];
    state.smartleadFails = 429;
    await drainFills();
    const waiting = await row(abe.prospectId);
    assert.equal(waiting.state, "filling", "a busy push sent nothing, so the row isn't pushing");
    assert.equal(waiting.values.news_hook, "the Abe launch", "the filled values are kept");
    assert.equal((await sql("select 1 from crm.campaign_events where prospect_id = $1", [abe.prospectId])).length, 0);
    state.smartleadFails = null;
    const asked = state.llm.filter((text) => text.includes('"firstName":"Abe"')).length;
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [abe.prospectId]);
    await drainFills();
    assert.equal((await row(abe.prospectId)).state, "pushed");
    assert.equal(state.llm.filter((text) => text.includes('"firstName":"Abe"')).length, asked, "it isn't filled again");

    await contact(owner, "bea", { firstName: "Bea", lastName: "Lyle", email: "bea@lyle.test" });
    const bea = (await addProspects(owner, emailCampaign, [people.bea.id], { operation: "test" })).prospects[0];
    state.smartleadFails = 502;
    await drainFills();
    assert.equal((await row(bea.prospectId)).state, "pushing");
    state.smartleadFails = null;
    state.foundElsewhere.add("bea@lyle.test");
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [bea.prospectId]);
    await drainFills();
    assert.equal(pushesFor("bea@lyle.test").length, 2, "a lead found in another campaign doesn't count, so it's pushed again");
    assert.equal((await row(bea.prospectId)).state, "pushed");

    const other = await findHeyReachLead("key", "801", "https://www.linkedin.com/in/x", { fetchImpl: async () => json({ id: "lead-1", campaignId: 999 }) });
    assert.equal(other, null, "a HeyReach lead in another campaign isn't this one");
    const here = await findHeyReachLead("key", "801", "https://www.linkedin.com/in/x", { fetchImpl: async () => json({ id: "lead-1", campaignId: 801 }) });
    assert.deepEqual(here, { id: "lead-1" });
    const unsure = await findHeyReachLead("key", "801", "https://www.linkedin.com/in/x", { fetchImpl: async () => json({ id: "lead-1" }) });
    assert.equal(unsure, null, "a reply that doesn't name the campaign doesn't count");
  });

  it("never adds two contacts with the same email to one campaign", async () => {
    await contact(owner, "wes", { firstName: "Wes", lastName: "Long", email: "wes@long.test" });
    const wes = (await addProspects(owner, otherCampaign, [people.wes.id], { operation: "test" })).prospects[0];
    await sql("update crm.contacts set email = 'wes@new.test', normalized_email = 'wes@new.test' where id = $1", [people.wes.id]);
    await contact(owner, "xan", { firstName: "Xan", lastName: "Long", email: "wes@long.test" });
    const twin = (await addProspects(owner, otherCampaign, [people.xan.id], { operation: "test" })).prospects[0];
    assert.equal(twin.outcome, "already");
    assert.equal(twin.prospectId, wes.prospectId);
    await sql("update crm.campaign_prospects set state = 'failed', skip_reason = 'x' where id = $1", [wes.prospectId]);
    const moved = (await addProspects(owner, otherCampaign, [people.xan.id], { operation: "test" })).prospects[0];
    assert.deepEqual([moved.outcome, moved.prospectId], ["requeued", wes.prospectId], "a failed twin moves to the new contact and is checked again");
    assert.deepEqual(await sql("select contact_id, state from crm.campaign_prospects where id = $1", [wes.prospectId]), [{ contact_id: people.xan.id, state: "queued" }]);
    await sql("update crm.campaign_prospects set state = 'skipped', skip_reason = 'x' where id = $1", [wes.prospectId]);
    await sql("insert into crm.suppressions (workspace_id, kind, value, reason, source) values ($1, 'email', 'wes@long.test', 'manual', 'test')", [owner.workspaceId]);
    await sql("update crm.contacts set email = 'xan@other.test', normalized_email = 'xan@other.test' where id = $1", [people.xan.id]);
    await sql("update crm.contacts set email = 'wes@long.test', normalized_email = 'wes@long.test' where id = $1", [people.wes.id]);
    const back = (await addProspects(owner, otherCampaign, [people.wes.id], { operation: "test" })).prospects[0];
    assert.deepEqual([back.outcome, back.prospectId, back.skipReason], ["skipped", wes.prospectId, "Do not contact"], "the do-not-contact check runs again on the moved row");
  });

  it("an outage releases prospects instead of failing them", async () => {
    await contact(owner, "cal", { firstName: "Cal", lastName: "Dunn", email: "cal@dunn.test" });
    const cal = (await addProspects(owner, emailCampaign, [people.cal.id], { operation: "test" })).prospects[0];
    state.llmStatus = 503;
    await drainFills();
    assert.equal((await row(cal.prospectId)).state, "filling");
    const provider = smartleadProvider;
    assert.equal(transient(provider, new Error("timeout exceeded when trying to connect")), true, "an unknown error waits");
    assert.equal(transient(provider, new CrmError("upstream_error", "Couldn't check.", 502)), true);
    assert.equal(transient(provider, new CrmError("invalid_input", "Bad.", 400)), false);
    assert.equal(transient(provider, new SmartleadError("Rejected", 401)), true, "a rejected key waits for a new key");
    state.llmStatus = null;
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [cal.prospectId]);
    await drainFills();
    assert.equal((await row(cal.prospectId)).state, "pushed");
  });

  it("one bad lead fails alone, and a rejected key fails nobody", async () => {
    await contact(owner, "dee2", { firstName: "Dot", lastName: "Hale", email: "dot@hale.test" });
    await contact(owner, "eli", { firstName: "Eli", lastName: "Hale", email: "eli@hale.test" });
    const added = (await addProspects(owner, emailCampaign, [people.dee2.id, people.eli.id], { operation: "test" })).prospects;
    state.badEmail = "dot@hale.test";
    await drainFills();
    assert.equal((await row(added[0].prospectId)).state, "failed");
    assert.equal((await row(added[1].prospectId)).state, "pushed");

    await contact(owner, "fin", { firstName: "Fin", lastName: "Gray", email: "fin@gray.test" });
    const fin = (await addProspects(owner, emailCampaign, [people.fin.id], { operation: "test" })).prospects[0];
    state.badEmail = null;
    state.smartleadFails = 401;
    await drainFills();
    assert.equal((await row(fin.prospectId)).state, "filling", "rows wait for the key to be replaced");
    assert.equal((await sql<{ fill_attempts: number }>("select fill_attempts from crm.campaign_prospects where id = $1", [fin.prospectId]))[0].fill_attempts, 1, "a push the key was rejected for counts");
    const marked = await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId]);
    assert.equal(marked[0].last_error, null, "a refused push never marks the key, only the key check and campaign list do");
    await sql("update crm.campaign_connections set last_error = 'Smartlead rejected the key. Save a new one.' where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId]);

    await contact(owner, "joy", { firstName: "Joy", lastName: "Bird", email: "joy@bird.test" });
    const joy = (await addProspects(owner, emailCampaign, [people.joy.id], { operation: "test" })).prospects[0];
    const pushesBefore = state.pushes.length;
    for (let round = 0; round < 7; round += 1) {
      await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = any($1::uuid[])", [[fin.prospectId, joy.prospectId]]);
      await drainFills();
    }
    assert.equal(state.llm.filter((text) => text.includes('"firstName":"Joy"')).length, 0, "nothing is filled while the key is rejected");
    assert.equal(state.pushes.length, pushesBefore, "and nothing is sent");
    const waiting = await sql<{ state: string; fill_attempts: number }>("select state, fill_attempts from crm.campaign_prospects where id = any($1::uuid[]) order by created_at", [[fin.prospectId, joy.prospectId]]);
    assert.deepEqual(waiting.map((item) => [item.state, item.fill_attempts]), [["filling", 1], ["filling", 0]], "waiting for a key uses up no more attempts");

    await sql("select private.campaign_key_rejected($1, 'smartlead', 'not-this-key-fingerprint', 'x')", [owner.workspaceId]);
    assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.campaign_connections where workspace_id = $1 and provider = 'smartlead'", [owner.workspaceId]))[0].last_error, "Smartlead rejected the key. Save a new one.", "an old key's rejection can't mark another key");

    state.smartleadFails = null;
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = any($1::uuid[])", [[fin.prospectId, joy.prospectId]]);
    await drainFills();
    assert.equal((await row(fin.prospectId)).state, "pushed");
    assert.equal((await row(joy.prospectId)).state, "pushed");
  });

  it("a key that keeps being rejected at push gives up after five tries", async () => {
    await contact(owner, "kit", { firstName: "Kit", lastName: "Shaw", email: "kit@shaw.test" });
    const kit = (await addProspects(owner, emailCampaign, [people.kit.id], { operation: "test" })).prospects[0];
    state.smartleadFails = 403;
    for (let round = 0; round < 7; round += 1) {
      await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
      await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1 and state <> 'failed'", [kit.prospectId]);
      await drainFills();
    }
    const done = await sql<{ state: string; fill_attempts: number }>("select state, fill_attempts from crm.campaign_prospects where id = $1", [kit.prospectId]);
    assert.deepEqual([done[0].state, done[0].fill_attempts], ["failed", 5]);
    state.smartleadFails = null;
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
  });

  it("waits without counting while the AI isn't set up, and counts a bad request", async () => {
    await contact(owner, "lia", { firstName: "Lia", lastName: "Moss", email: "lia@moss.test" });
    const lia = (await addProspects(owner, emailCampaign, [people.lia.id], { operation: "test" })).prospects[0];
    state.llmStatus = 401;
    await drainFills();
    assert.deepEqual(await sql("select state, fill_attempts from crm.campaign_prospects where id = $1", [lia.prospectId]), [{ state: "filling", fill_attempts: 0 }]);
    process.env.LLM_API_KEY = "";
    state.llmStatus = null;
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [lia.prospectId]);
    await drainFills();
    assert.deepEqual(await sql("select state, fill_attempts from crm.campaign_prospects where id = $1", [lia.prospectId]), [{ state: "filling", fill_attempts: 0 }], "a missing key is a setup problem");
    process.env.LLM_API_KEY = "test-llm-key";
    state.llmStatus = 400;
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [lia.prospectId]);
    await drainFills();
    assert.deepEqual(await sql("select state, fill_attempts from crm.campaign_prospects where id = $1", [lia.prospectId]), [{ state: "filling", fill_attempts: 1 }], "a bad request counts");
    state.llmStatus = null;
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [lia.prospectId]);
    await drainFills();
    assert.equal((await row(lia.prospectId)).state, "pushed");
  });

  it("holds queued LinkedIn prospects while their campaign is paused", async () => {
    await contact(owner, "kai", { firstName: "Kai", lastName: "Webb", email: "kai@webb.test", linkedinUrl: "https://www.linkedin.com/in/kaiwebb" });
    const kai = (await addProspects(owner, linkedinCampaign, [people.kai.id], { operation: "test" })).prospects[0];
    await sql("update crm.campaigns set status = 'paused' where id = $1", [linkedinCampaign]);
    await drainFills();
    assert.deepEqual(await sql("select state, fill_attempts from crm.campaign_prospects where id = $1", [kai.prospectId]), [{ state: "filling", fill_attempts: 0 }]);
    await sql("update crm.campaigns set status = 'active' where id = $1", [linkedinCampaign]);
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [kai.prospectId]);
    await drainFills();
    assert.equal((await row(kai.prospectId)).state, "pushed");
  });

  it("keeps a counted row's backoff when the same job later releases everything", async () => {
    await contact(owner, "max", { firstName: "Max", lastName: "Hart", email: "max@hart.test" });
    const max = (await addProspects(owner, emailCampaign, [people.max.id], { operation: "test" })).prospects[0];
    const holder = "fill:backoff-test";
    await sql("update crm.campaign_prospects set state = 'filling', claimed_at = now(), claimed_by = $2 where id = $1", [max.prospectId, holder]);
    await sql("select private.campaign_fill_retry($1, $2, $3, 'Down', 5)", [owner.workspaceId, max.prospectId, holder]);
    const before = await sql<{ claimed_at: Date; claimed_by: string | null }>("select claimed_at, claimed_by from crm.campaign_prospects where id = $1", [max.prospectId]);
    assert.equal(before[0].claimed_by, null, "a counted row belongs to no job while it waits");
    await sql("select private.campaign_fill_end($1, $2, $3, null, null)", [owner.workspaceId, max.prospectId, holder]);
    await sql("select private.campaign_push_undo($1, $2::uuid[], $3)", [owner.workspaceId, [max.prospectId], holder]);
    const after = await sql<{ claimed_at: Date; fill_attempts: number }>("select claimed_at, fill_attempts from crm.campaign_prospects where id = $1", [max.prospectId]);
    assert.equal(after[0].claimed_at.getTime(), before[0].claimed_at.getTime(), "the blanket release leaves the backoff alone");
    assert.equal(after[0].fill_attempts, 1);
    const claimable = await sql<{ ok: boolean }>("select private.campaign_fill_claimable(p) as ok from crm.campaign_prospects p where p.id = $1", [max.prospectId]);
    assert.equal(claimable[0].ok, false, "nobody takes it before the backoff ends");
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [max.prospectId]);
    await drainFills();
    assert.equal((await row(max.prospectId)).state, "pushed");
  });

  it("gives up after five failed attempts, and a re-add starts the count again", async () => {
    await contact(owner, "ivo", { firstName: "Ivo", lastName: "Kent", email: "ivo@kent.test" });
    const ivo = (await addProspects(owner, emailCampaign, [people.ivo.id], { operation: "test" })).prospects[0];
    state.llmStatus = 503;
    await drainFills();
    const held = await sql<{ wait: number }>("select extract(epoch from (claimed_at + interval '10 minutes' - now()))::int as wait from crm.campaign_prospects where id = $1", [ivo.prospectId]);
    assert.ok(held[0].wait > 240 && held[0].wait <= 300, `the first retry waits five minutes (${held[0].wait}s)`);
    await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1", [ivo.prospectId]);
    await drainFills();
    const longer = await sql<{ wait: number }>("select extract(epoch from (claimed_at + interval '10 minutes' - now()))::int as wait from crm.campaign_prospects where id = $1", [ivo.prospectId]);
    assert.ok(longer[0].wait > 1700 && longer[0].wait <= 1800, `the second waits half an hour (${longer[0].wait}s)`);
    await drainFills();
    assert.equal(state.llm.filter((text) => text.includes('"firstName":"Ivo"')).length, 2, "nothing retries before the hold ends");
    for (let round = 0; round < 6; round += 1) {
      await sql("update crm.campaign_prospects set claimed_at = now() - interval '11 minutes' where id = $1 and state <> 'failed'", [ivo.prospectId]);
      await drainFills();
    }
    const failed = await sql<{ state: string; skip_reason: string | null; fill_attempts: number }>("select state, skip_reason, fill_attempts from crm.campaign_prospects where id = $1", [ivo.prospectId]);
    assert.equal(failed[0].state, "failed");
    assert.equal(failed[0].fill_attempts, 5);
    assert.ok(failed[0].skip_reason && failed[0].skip_reason.length > 0);
    assert.equal(state.llm.filter((text) => text.includes('"firstName":"Ivo"')).length, 5, "the AI is asked five times, never more");
    state.llmStatus = null;
    const again = (await addProspects(owner, emailCampaign, [people.ivo.id], { operation: "test" })).prospects[0];
    assert.equal(again.outcome, "requeued");
    assert.equal((await sql<{ fill_attempts: number }>("select fill_attempts from crm.campaign_prospects where id = $1", [ivo.prospectId]))[0].fill_attempts, 0);
    await drainFills();
    assert.equal((await row(ivo.prospectId)).state, "pushed");
  });

  it("re-checks the campaign is still running when it pushes", async () => {
    await contact(owner, "gil", { firstName: "Gil", lastName: "Moor", email: "gil@moor.test" });
    const gil = (await addProspects(owner, otherCampaign, [people.gil.id], { operation: "test" })).prospects[0];
    await sql("update crm.campaigns set status = 'completed' where id = $1", [otherCampaign]);
    await drainFills();
    assert.deepEqual([(await row(gil.prospectId)).state, (await row(gil.prospectId)).skip_reason], ["failed", "This campaign has ended."]);
    await sql("update crm.campaigns set status = 'active' where id = $1", [otherCampaign]);
    assert.equal((await addProspects(owner, otherCampaign, [people.gil.id], { operation: "test" })).prospects[0].outcome, "requeued");
  });

  it("keeps a value only when its figures come from a source", () => {
    const input = {
      variables: [
        { name: "hook", brief: "", required: true, maxLength: 40 },
        { name: "extra", brief: "", required: false, maxLength: null },
      ],
      valueLimit: 2000,
      token: (name: string) => `{{${name}}}`,
      campaign: { name: "x", channel: "email", provider: "smartlead", sequence: [] },
      contact: { name: "A", firstName: "A" },
      company: null,
      proof: [],
    } as unknown as FillInput;
    const sourced = judgeFill(input, { values: [{ name: "hook", value: "up 40% this year", sources: [{ fact: "Revenue up 40% this year", url: "https://a.test/x" }] }] }, ["https://a.test/x"]);
    assert.deepEqual(sourced.values, { hook: "up 40% this year" });
    assert.equal(sourced.problem, null, "an optional value can be empty");
    const invented = judgeFill(input, { values: [{ name: "hook", value: "up 40% this year", sources: [{ fact: "Revenue up 40% this year", url: "https://made.up/x" }] }] }, []);
    assert.equal(invented.problem, "Nothing found for hook");
    const long = judgeFill(input, { values: [{ name: "hook", value: "x".repeat(41), sources: [] }] }, []);
    assert.equal(long.problem, "hook was too long");
  });

  it("waits for a workflow add's backoff, and ends the item with the row's reason when the person is removed while it waits", async () => {
    await contact(owner, "wren", { firstName: "Wren", lastName: "Wait", email: "wren@wait.test" });
    const id = await workflow(stepFlow());
    state.smartleadFails = 503;
    const run = await startRun(owner, id, { test: false, record: { type: "contact", id: people.wren.id }, fetchImpl });
    for (let round = 0; round < 2; round += 1) await runWorkflowTick({ fetchImpl, budgetMs: 230_000, long: true, limit: 5 });
    const waiting = await sql<{ status: string; resume_at: Date | null }>("select status, resume_at from crm.workflow_runs where id = $1", [run.runId]);
    assert.equal(waiting[0].status, "waiting");
    const wait = (waiting[0].resume_at?.getTime() ?? 0) - Date.now();
    assert.ok(wait > 4 * 60_000 && wait < 6 * 60_000, `the run waits for the row's five minute backoff, not a minute (${wait} ms)`);
    const prospect = (await sql<{ id: string; fill_attempts: number }>("select id, fill_attempts from crm.campaign_prospects where contact_id = $1", [people.wren.id]))[0];
    assert.equal(prospect.fill_attempts, 1);

    state.smartleadFails = null;
    await removeProspect(owner, prospect.id, { fetchImpl });
    const pushesBefore = pushesFor("wren@wait.test").length;
    await sql("update crm.workflow_runs set resume_at = now() - interval '1 second' where id = $1", [run.runId]);
    for (let round = 0; round < 2; round += 1) await runWorkflowTick({ fetchImpl, budgetMs: 230_000, long: true, limit: 5 });
    const ended = await sql<{ status: string; skip_reason: string | null }>("select status, skip_reason from crm.workflow_runs where id = $1", [run.runId]);
    assert.deepEqual(ended, [{ status: "succeeded", skip_reason: "Add to campaign: Removed" }]);
    const rows = await sql<{ state: string; skip_reason: string | null }>("select state, skip_reason from crm.campaign_prospects where contact_id = $1", [people.wren.id]);
    assert.deepEqual(rows, [{ state: "skipped", skip_reason: "Removed" }], "the step never adds the person again when it resumes");
    assert.equal(pushesFor("wren@wait.test").length, pushesBefore, "and never pushes them");
  });

  it("keeps a share of the Smartlead budget for sync when pushes use theirs up", async () => {
    const savedLimit = process.env.WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_HOUR;
    process.env.WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_HOUR = "1";
    try {
      await withService("smartlead_push", async () => undefined, { scope: owner.workspaceId });
      await contact(owner, "bud", { firstName: "Bud", lastName: "Get", email: "bud@budget.test" });
      const bud = (await addProspects(owner, emailCampaign, [people.bud.id], { operation: "test" })).prospects[0];
      const pushesBefore = state.pushes.length;
      await runWorkflowTick({ fetchImpl, budgetMs: 230_000, long: true, limit: 5 });
      assert.equal(state.pushes.length, pushesBefore, "no push goes over the push budget");
      const waiting = await sql<{ state: string; fill_attempts: number }>("select state, fill_attempts from crm.campaign_prospects where id = $1", [bud.prospectId]);
      assert.deepEqual(waiting, [{ state: "filling", fill_attempts: 0 }], "a busy budget costs no attempt");
      await assert.doesNotReject(smartleadProvider.listCampaigns({ key: SL_A, workspaceId: owner.workspaceId, fetchImpl }), "sync still has its share");
    } finally {
      if (savedLimit === undefined) delete process.env.WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_HOUR;
      else process.env.WORKFLOW_LIMIT_SMARTLEAD_PUSH_PER_HOUR = savedLimit;
    }
    await sql("update crm.campaign_prospects set state = 'skipped', skip_reason = 'test', claimed_by = null where contact_id = $1", [people.bud.id]);
  });

  it("starts a fill batch in every long tick before taking runs, so bulk adds aren't starved", async () => {
    await contact(owner, "fair", { firstName: "Fair", lastName: "Fill", email: "fair@fill.test" });
    const parsed = definitionFromInput({
      trigger: { type: "manual", object: "contact" },
      nodes: [{ id: "ai_1", type: "ai", config: { prompt: "FAIRNESS check.", outputs: [{ key: "text", type: "text" }] } }],
      edges: [{ source: "trigger", handle: "out", target: "ai_1" }],
    });
    assert.ok("definition" in parsed, JSON.stringify(parsed));
    const id = await workflow(parsed.definition);
    state.gate = { seenPush: false };
    const first = await startRun(owner, id, { test: false, record: { type: "contact", id: people.fair.id }, fetchImpl });
    await sql("update crm.campaign_prospects set state = 'skipped', skip_reason = 'test', claimed_by = null where state in ('queued', 'filling', 'pushing')");
    await addProspects(owner, emailCampaign, [people.fair.id], { operation: "test" });
    await sql(
      "insert into crm.workflow_runs (workspace_id, workflow_id, owner_id, status, test, definition, event) select workspace_id, workflow_id, owner_id, 'queued', false, definition, event from crm.workflow_runs where id = $1",
      [first.runId],
    );
    state.gate = { seenPush: null };
    try {
      await runWorkflowTick({ fetchImpl, budgetMs: 230_000, long: true, limit: 1 });
      assert.equal(state.gate.seenPush, true, "the fill ran before the run that would have held the only slot");
    } finally {
      state.gate = null;
    }
  });

  it("ships templates that save", () => {
    for (const key of ["daily-prospecting", "linkedin-then-email", "email-then-linkedin", "positive-reply"]) {
      const template = STARTER_TEMPLATES.find((item) => item.key === key);
      assert.ok(template, key);
      const parsed = definitionFromInput(template.definition);
      assert.ok("definition" in parsed, `${key}: ${JSON.stringify(parsed)}`);
    }
  });
});
