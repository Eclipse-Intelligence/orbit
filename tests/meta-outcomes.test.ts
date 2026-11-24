import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { handleMetaLeadsWebhook, linkMetaPage } from "@/lib/crm/meta-leads";
import { getMetaOutcomesView, metaLeadTrails, runMetaOutcomes, saveMetaOutcomes } from "@/lib/crm/meta-outcomes";
import { createOpportunity, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { handleCronRequest } from "@/lib/crm/scheduler";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { graphFailure, graphOrigin, hashEmail, hashPhone, metaGraphVersion, MetaError, metaSignature } from "@/lib/meta";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const TOKEN = "dataset-token-test";
const DATASET = "1608701054328072";
const APP_SECRET = "outcomes-app-secret";
const ENV_NAMES = ["META_DATASET_TOKEN", "META_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_GRAPH_VERSION", "META_GRAPH_URL", "CRON_SECRET", "LLM_API_KEY"] as const;
const DAY = 24 * 60;

type SentEvent = {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  user_data: { lead_id: number; em?: string[]; ph?: string[] };
  custom_data: Record<string, unknown>;
};

type Behaviour = {
  datasets?: string[];
  reject?: (event: SentEvent) => { code: number; subcode?: number; message: string } | null;
  fail?: (events: SentEvent[]) => Response | null;
  delay?: number;
};

function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return getAdminPool().query<T>(text, values).then((result) => result.rows);
}

function metaFake(behaviour: Behaviour = {}) {
  const requests: { url: URL; dataset: string; raw: string; events: SentEvent[]; body: Record<string, unknown> }[] = [];
  const violations: string[] = [];
  let checks = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== graphOrigin()) violations.push(`origin ${url.origin}`);
    if (url.searchParams.has("access_token")) violations.push("token in the URL");
    if (init?.method === "POST") {
      const dataset = url.pathname.match(new RegExp(`^/${metaGraphVersion()}/(\\d+)/events$`))?.[1] ?? "";
      if (!(behaviour.datasets ?? [DATASET]).includes(dataset)) violations.push(`path ${url.pathname}`);
      const raw = String(init.body);
      const body = JSON.parse(raw.replace(/("lead_id":)(\d+)/g, '$1"$2"')) as { data: SentEvent[]; access_token: string };
      if (body.access_token !== TOKEN) violations.push("wrong token");
      const events = body.data.map((event) => ({ ...event, user_data: { ...event.user_data, lead_id: Number(event.user_data.lead_id) } }));
      requests.push({ url, dataset, raw, events, body });
      if (behaviour.delay) await new Promise((resolve) => setTimeout(resolve, behaviour.delay));
      const failure = behaviour.fail?.(events);
      if (failure) return failure;
      for (const event of events) {
        const rejected = behaviour.reject?.(event);
        if (rejected) {
          return Response.json(
            { error: { message: rejected.message, type: "OAuthException", code: rejected.code, error_subcode: rejected.subcode, fbtrace_id: "trace" } },
            { status: 400 },
          );
        }
      }
      return Response.json({ events_received: events.length, messages: [], fbtrace_id: "trace" });
    }
    if (url.pathname === `/v27.0/${DATASET}`) {
      checks += 1;
      return Response.json({ id: DATASET });
    }
    if (url.pathname.startsWith("/v27.0/")) return Response.json({ error: { message: "Unsupported get request", code: 100, error_subcode: 33 } }, { status: 400 });
    return new Response("Not found", { status: 404 });
  };
  return {
    fetchImpl,
    requests,
    violations,
    get checks() {
      return checks;
    },
    events: () => requests.flatMap((request) => request.events),
    names: () => requests.flatMap((request) => request.events.map((event) => event.event_name)),
  };
}

let owner: UserActor;
let admin: UserActor;
let member: UserActor;
let outsider: UserActor;
let stage: Record<string, string>;
let stageNames: Record<string, string> = {};
let salesPipeline = "";
let counter = 0;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>> = {};
const realFetch = globalThis.fetch;

type Scenario = { leadId: string; leadgen: string; contactId: string; companyId: string };

async function scenario(options: { filedMinutesAgo?: number; leadgen?: string; email?: string | null; phone?: string | null; companyOnly?: boolean; actor?: UserActor } = {}): Promise<Scenario> {
  counter += 1;
  const actor = options.actor ?? owner;
  const company = (await createCompany(actor, { name: `Lead Co ${counter}`, domain: `lead-co-${counter}.test` })).body.company;
  const contact = (await createContact(actor, { firstName: "Lead", lastName: `Person ${counter}`, email: `lead${counter}@lead-co-${counter}.test`, companyId: company.id })).body.contact;
  const leadgen = options.leadgen ?? String(2597163074137000 + counter);
  const email = options.email === undefined ? `lead${counter}@lead-co-${counter}.test` : options.email;
  const rows = await sql<{ id: string }>(
    `insert into crm.meta_leads (leadgen_id, page_id, workspace_id, contact_id, company_id, fetched_at, filed_at, email_hash, phone_hash)
     values ($1, '1111111111', $2, $3, $4, now(), now() - make_interval(mins => $5), $6, $7) returning id`,
    [leadgen, actor.workspaceId, options.companyOnly ? null : contact.id, company.id, options.filedMinutesAgo ?? 2 * DAY, hashEmail(email), hashPhone(options.phone ?? null)],
  );
  return { leadId: rows[0].id, leadgen, contactId: contact.id, companyId: company.id };
}

async function opportunity(input: { companyId: string; contactId?: string | null; stage?: string; value?: number; currency?: string; pipelineId?: string }) {
  counter += 1;
  const created = (
    await createOpportunity(owner, {
      companyId: input.companyId,
      primaryContactId: input.contactId ?? null,
      name: `Deal ${counter}`,
      stageId: input.stage ? stage[input.stage] : stage.New,
      ...(input.value === undefined ? {} : { value: input.value, currency: input.currency ?? "GBP" }),
      ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
    })
  ).body.opportunity;
  return created.id;
}

async function setEntryAge(opportunityId: string, stageName: string, minutesAgo: number) {
  await sql(
    `update crm.opportunity_stage_entries set entered_at = now() - make_interval(mins => $3)
     where id = (select id from crm.opportunity_stage_entries where opportunity_id = $1 and stage_id = $2 order by entered_at desc, id desc limit 1)`,
    [opportunityId, stage[stageName], minutesAgo],
  );
}

async function moveTo(opportunityId: string, stageName: string, minutesAgo: number) {
  await updateOpportunity(owner, opportunityId, { stageId: stage[stageName] });
  await setEntryAge(opportunityId, stageName, minutesAgo);
}

async function outcomes(leadId: string) {
  return sql<{ stage_name: string; position: number; status: string; attempts: number; occurred_at: Date; value: string | null; currency: string | null; error: string | null; sent_at: Date | null }>(
    'select stage_name, "position", status, attempts, occurred_at, value, currency, error, sent_at from crm.meta_lead_outcomes where lead_id = $1 order by "position"',
    [leadId],
  );
}

async function statuses(leadId: string) {
  return Object.fromEntries((await outcomes(leadId)).map((row) => [row.stage_name, row.status]));
}

function run(fake: ReturnType<typeof metaFake>, extra: { deadline?: number; contactId?: string; companyId?: string } = {}) {
  return runMetaOutcomes({ fetchImpl: fake.fetchImpl, deadline: Date.now() + 20_000, ...extra });
}

async function retryNow(leadId: string) {
  await sql("update crm.meta_lead_outcomes set next_attempt_at = null, claimed_until = null where lead_id = $1", [leadId]);
}

describe("Meta outcomes", () => {
  useServerlessPool();

  before(async () => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    process.env.META_DATASET_TOKEN = TOKEN;
    process.env.META_APP_SECRET = APP_SECRET;
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_GRAPH_VERSION;
    delete process.env.META_GRAPH_URL;
    delete process.env.LLM_API_KEY;
    globalThis.fetch = async () => {
      throw new Error("Tests never call real services.");
    };
    await resetDatabase();
    const base = await createUser("mark@outcomes.test", "Mark Ridgeon");
    const adminUser = await createUser("ada@outcomes.test", "Ada Admin");
    const memberUser = await createUser("sam@outcomes.test", "Sam Member");
    outsider = await createUser("olly@elsewhere-outcomes.test", "Olly Outside");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')", [base.workspaceId, adminUser.userId, memberUser.userId]);
    owner = base;
    admin = { ...adminUser, workspaceId: base.workspaceId, role: "admin", scopes: scopesForRole("admin") };
    member = { ...memberUser, workspaceId: base.workspaceId, role: "member", scopes: scopesForRole("member") };
    const pipeline = await listPipeline(owner);
    stage = Object.fromEntries(pipeline.stages.map((item) => [item.name, item.id]));
    stageNames = Object.fromEntries(pipeline.stages.map((item) => [item.id, item.name]));
    salesPipeline = pipeline.id;
    await sql("insert into crm.meta_outcome_settings (workspace_id, dataset_id, enabled) values ($1, $2, true)", [owner.workspaceId, DATASET]);
  });

  beforeEach(async () => {
    await sql("truncate crm.meta_leads cascade");
    await sql("delete from crm.opportunities");
    await sql("delete from crm.notifications");
    await sql("delete from crm.pipelines where workspace_id = $1 and id <> $2", [owner.workspaceId, salesPipeline]);
    for (const [id, name] of Object.entries(stageNames)) await sql("update crm.pipeline_stages set name = $2 where id = $1", [id, name]);
    await sql("update crm.meta_outcome_settings set enabled = true, dataset_id = $2, pipeline_id = null, last_error = null, last_error_at = null, alerted_at = null, last_sent_at = null where workspace_id = $1", [owner.workspaceId, DATASET]);
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await getPool().end();
    await getAdminPool().end();
  });

  describe("which stages are sent", () => {
    it("sends Lead for a filed lead with its hashes and the exact lead ID digits", async () => {
      const lead = await scenario({ leadgen: "12345678901234567", email: "  Jane.Doe@Example.COM ", phone: "07700 900123" });
      const fake = metaFake();
      const report = await run(fake);
      assert.equal(report.sent, 1);
      assert.deepEqual(fake.names(), ["Lead"]);
      const [event] = fake.events();
      assert.match(fake.requests[0].raw, /"lead_id":12345678901234567[,}]/);
      assert.doesNotMatch(fake.requests[0].raw, /"lead_id":"/);
      assert.deepEqual(event.user_data.em, [hashEmail("jane.doe@example.com")]);
      assert.deepEqual(event.user_data.ph, [hashPhone("+447700900123")]);
      assert.equal(event.action_source, "system_generated");
      assert.deepEqual(event.custom_data, { event_source: "crm", lead_event_source: "Orbit" });
      const row = (await outcomes(lead.leadId))[0];
      assert.equal(event.event_id, (await sql<{ id: string }>("select id from crm.meta_lead_outcomes where lead_id = $1", [lead.leadId]))[0].id);
      assert.equal(event.event_time, Math.floor(row.occurred_at.getTime() / 1000));
      assert.equal(row.status, "sent");
      assert.deepEqual(fake.violations, []);
      assert.doesNotMatch(fake.requests[0].raw, /jane\.doe|07700|Doe/i);
    });

    it("omits hashes a lead doesn't have", async () => {
      await scenario({ email: null });
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.events()[0].user_data.em, undefined);
      assert.deepEqual(fake.events()[0].user_data.ph, undefined);
    });

    it("sends a stage the first time it is reached, with the time it was reached", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working"]);
      const working = (await outcomes(lead.leadId)).find((row) => row.stage_name === "Working")!;
      assert.ok(Math.abs(working.occurred_at.getTime() - (Date.now() - 60 * 60_000)) < 5_000);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working"]);
    });

    it("sends a stage only once however often the opportunity passes through it", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 300);
      await moveTo(id, "Proposal", 200);
      await moveTo(id, "Working", 100);
      await moveTo(id, "Proposal", 50);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
      const proposal = (await outcomes(lead.leadId)).find((row) => row.stage_name === "Proposal")!;
      assert.ok(Math.abs(proposal.occurred_at.getTime() - (Date.now() - 200 * 60_000)) < 5_000);
      await moveTo(id, "Working", 20);
      await moveTo(id, "Proposal", 10);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
    });

    it("sends nothing for a stage reached under five minutes ago", async () => {
      const lead = await scenario();
      const quick = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(quick, "Proposal", 2);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      assert.deepEqual(Object.keys(await statuses(lead.leadId)), ["Lead"]);
    });

    it("sends nothing for a stage the opportunity was moved straight back out of", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Proposal", 12);
      await moveTo(id, "New", 9);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      await moveTo(id, "Proposal", 7);
      await moveTo(id, "Working", 6);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working"]);
    });

    it("sends a stage once it has settled for five minutes", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 6);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working"]);
    });

    it("keeps a stage that settled before the opportunity moved on, even if it has since moved back", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 120);
      await moveTo(id, "Proposal", 60);
      await moveTo(id, "Working", 30);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
    });

    it("fills the stages an opportunity skipped, in order, with the same time", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId, value: 8500 });
      await moveTo(id, "Won", 45);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal", "Won"]);
      assert.equal(fake.requests.length, 1);
      const times = fake.events().map((event) => event.event_time);
      assert.equal(times[1], times[3]);
      assert.equal(times[2], times[3]);
      assert.ok(times[0] <= times[1]);
    });

    it("never sends a stage before one that comes earlier in the pipeline", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Proposal", 120);
      await moveTo(id, "Working", 30);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
      const times = fake.events().map((event) => event.event_time);
      assert.ok(times[0] <= times[1] && times[1] <= times[2]);
    });

    it("sends Lost after the stages reached, without filling in stages the lead never reached", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 120);
      await moveTo(id, "Lost", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Lost"]);
      const lost = (await outcomes(lead.leadId)).find((row) => row.stage_name === "Lost")!;
      assert.ok(Math.abs(lost.occurred_at.getTime() - (Date.now() - 60 * 60_000)) < 5_000);
      assert.equal(lost.value, null);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Lost"]);
    });

    it("sends Lost straight from New with only Lead before it", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Lost", 30);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Lost"]);
    });

    it("waits five minutes before sending Lost, so a mistaken move sends nothing", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Lost", 1);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      await moveTo(id, "Working", 0);
      await setEntryAge(id, "Lost", 2);
      await run(fake);
      assert.equal((await statuses(lead.leadId)).Lost, undefined);
    });

    it("doesn't send Lost while the lead has another open opportunity at its company", async () => {
      const lead = await scenario();
      const lostOne = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await opportunity({ companyId: lead.companyId });
      await moveTo(lostOne, "Lost", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
    });

    it("still sends Won after Lost when a lost opportunity is reopened and won", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId, value: 4000, currency: "GBP" });
      await moveTo(id, "Lost", 120);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Lost"]);
      await moveTo(id, "Won", 30);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Lost", "Working", "Proposal", "Won"]);
      assert.equal((await statuses(lead.leadId)).Lost, "sent");
    });

    it("sends value and currency on Won only, and only when the opportunity has a value", async () => {
      const withValue = await scenario();
      const id = await opportunity({ companyId: withValue.companyId, contactId: withValue.contactId, value: 8500, currency: "GBP" });
      await moveTo(id, "Proposal", 120);
      await moveTo(id, "Won", 60);
      const without = await scenario();
      const other = await opportunity({ companyId: without.companyId, contactId: without.contactId });
      await moveTo(other, "Won", 60);
      const fake = metaFake();
      await run(fake);
      const won = fake.events().filter((event) => event.event_name === "Won");
      assert.equal(won.length, 2);
      const priced = won.find((event) => event.custom_data.value !== undefined)!;
      assert.deepEqual(priced.custom_data, { event_source: "crm", lead_event_source: "Orbit", value: 8500, currency: "GBP" });
      assert.deepEqual(won.find((event) => event.custom_data.value === undefined)!.custom_data, { event_source: "crm", lead_event_source: "Orbit" });
      for (const event of fake.events().filter((item) => item.event_name !== "Won")) assert.equal(event.custom_data.value, undefined);
    });

    it("counts an opportunity at the lead's company whoever its contact is, but not one created before the lead", async () => {
      const lead = await scenario({ filedMinutesAgo: 3 * DAY });
      const someoneElse = (await createContact(owner, { firstName: "Else", lastName: "Body", companyId: lead.companyId })).body.contact;
      const byCompany = await opportunity({ companyId: lead.companyId, contactId: someoneElse.id });
      await moveTo(byCompany, "Working", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working"]);

      const earlier = await scenario({ filedMinutesAgo: DAY });
      const old = await opportunity({ companyId: earlier.companyId, contactId: earlier.contactId });
      await sql("update crm.opportunities set created_at = now() - interval '2 days' where id = $1", [old]);
      await moveTo(old, "Proposal", 60);
      const noContact = await opportunity({ companyId: earlier.companyId });
      await sql("update crm.opportunities set created_at = now() - interval '2 days' where id = $1", [noContact]);
      await moveTo(noContact, "Won", 60);
      const second = metaFake();
      await run(second);
      assert.deepEqual(second.names(), ["Lead"]);
    });

    it("counts an opportunity whose contact is the lead even when it sits at another company, and a lead with no contact by its company", async () => {
      const lead = await scenario();
      const elsewhere = (await createCompany(owner, { name: "Elsewhere Ltd", domain: "elsewhere-ltd.test" })).body.company;
      const byContact = await opportunity({ companyId: elsewhere.id });
      await sql("update crm.opportunities set primary_contact_id = $2 where id = $1", [byContact, lead.contactId]);
      await moveTo(byContact, "Working", 60);
      const companyOnly = await scenario({ companyOnly: true });
      const viaCompany = await opportunity({ companyId: companyOnly.companyId });
      await moveTo(viaCompany, "Working", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual([...fake.names()].sort(), ["Lead", "Lead", "Working", "Working"]);
      assert.equal((await statuses(lead.leadId)).Working, "sent");
      assert.equal((await statuses(companyOnly.leadId)).Working, "sent");
    });

    it("ignores opportunities in another pipeline", async () => {
      const lead = await scenario();
      await sql("update crm.meta_outcome_settings set pipeline_id = $2 where workspace_id = $1", [owner.workspaceId, salesPipeline]);
      const boardId = (await sql<{ id: string }>("insert into crm.pipelines (workspace_id, name, kind) values ($1, 'Onboarding', 'board') returning id", [owner.workspaceId]))[0].id;
      const boardStage = (await sql<{ id: string }>("insert into crm.pipeline_stages (workspace_id, pipeline_id, name, position) values ($1, $2, 'Working', 0), ($1, $2, 'Live', 1) returning id", [owner.workspaceId, boardId]))[1].id;
      const card = (await createOpportunity(owner, { companyId: lead.companyId, name: "Card", pipelineId: boardId, stageId: boardStage })).body.opportunity.id;
      await sql("update crm.opportunity_stage_entries set entered_at = now() - interval '1 hour' where opportunity_id = $1", [card]);
      const second = (await sql<{ id: string }>("insert into crm.pipelines (workspace_id, name, kind) values ($1, 'Partners', 'sales') returning id", [owner.workspaceId]))[0].id;
      const partnerStages = await sql<{ id: string }>("insert into crm.pipeline_stages (workspace_id, pipeline_id, name, position) values ($1, $2, 'Intro', 0), ($1, $2, 'Signed', 1) returning id", [owner.workspaceId, second]);
      const partner = (await createOpportunity(owner, { companyId: lead.companyId, name: "Partner", pipelineId: second, stageId: partnerStages[1].id })).body.opportunity.id;
      await sql("update crm.opportunity_stage_entries set entered_at = now() - interval '1 hour' where opportunity_id = $1", [partner]);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      await sql("update crm.meta_outcome_settings set pipeline_id = $2 where workspace_id = $1", [owner.workspaceId, second]);
      await sql("truncate crm.meta_lead_outcomes");
      const other = metaFake();
      await run(other);
      assert.deepEqual(other.names(), ["Lead", "Signed"]);
    });

    it("never sends for opportunities that don't belong to a Meta lead", async () => {
      const company = (await createCompany(owner, { name: "Referral Ltd", domain: "referral-ltd.test" })).body.company;
      const id = await opportunity({ companyId: company.id });
      await moveTo(id, "Won", 60);
      const lead = await scenario();
      const unrelated = await opportunity({ companyId: company.id });
      await moveTo(unrelated, "Proposal", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where lead_id <> $1", [lead.leadId])).length, 0);
    });

    it("ignores archived opportunities and leads that aren't filed", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Proposal", 60);
      await sql("update crm.opportunities set archived_at = now() where id = $1", [id]);
      await sql("insert into crm.meta_leads (leadgen_id, page_id, workspace_id, fetched_at) values ('900000001', '1111111111', $1, now())", [owner.workspaceId]);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
    });

    it("records nothing while outcomes are off or have no dataset", async () => {
      await scenario();
      await sql("update crm.meta_outcome_settings set enabled = false where workspace_id = $1", [owner.workspaceId]);
      const fake = metaFake();
      const report = await run(fake);
      assert.equal(report.recorded, 0);
      assert.equal(fake.requests.length, 0);
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes")).length, 0);
      assert.equal((await sql<{ due: boolean }>("select private.meta_outcomes_work_due() as due"))[0].due, false);
    });

    it("does nothing without META_DATASET_TOKEN", async () => {
      await scenario();
      delete process.env.META_DATASET_TOKEN;
      try {
        const fake = metaFake();
        const report = await run(fake);
        assert.match(report.skipped ?? "", /isn't set up/);
        assert.equal(fake.requests.length, 0);
        assert.equal((await sql("select 1 from crm.meta_lead_outcomes")).length, 0);
      } finally {
        process.env.META_DATASET_TOKEN = TOKEN;
      }
    });

    it("scans only leads filed in the last 90 days, except when asked about a record", async () => {
      const old = await scenario({ filedMinutesAgo: 100 * DAY });
      const fake = metaFake();
      await run(fake);
      assert.equal(fake.requests.length, 0);
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where lead_id = $1", [old.leadId])).length, 0);
      await run(fake, { contactId: old.contactId });
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where lead_id = $1", [old.leadId])).length, 1);
    });

    it("looks at leads it has never checked first and stamps them", async () => {
      const first = await scenario();
      const second = await scenario();
      await sql("update crm.meta_leads set outcomes_checked_at = now() where id = $1", [first.leadId]);
      const due = await sql<{ lead_id: string }>("select lead_id from private.meta_lead_outcomes_due(1, null, null)");
      assert.deepEqual(due.map((row) => row.lead_id), [second.leadId]);
      assert.ok((await sql<{ outcomes_checked_at: Date | null }>("select outcomes_checked_at from crm.meta_leads where id = $1", [second.leadId]))[0].outcomes_checked_at);
    });

    it("fills the hashes of older leads from their answers", async () => {
      const lead = await scenario();
      await sql("update crm.meta_leads set email_hash = null, phone_hash = null, outcomes_checked_at = null, answers = $2::jsonb where id = $1", [
        lead.leadId,
        JSON.stringify([
          { name: "email", label: "Email", values: ["Old.Lead@Example.com"] },
          { name: "phone_number", label: "Phone", values: ["+44 7700 900456"] },
        ]),
      ]);
      const fake = metaFake();
      await run(fake);
      const row = (await sql<{ email_hash: string; phone_hash: string }>("select email_hash, phone_hash from crm.meta_leads where id = $1", [lead.leadId]))[0];
      assert.equal(row.email_hash, hashEmail("old.lead@example.com"));
      assert.equal(row.phone_hash, hashPhone("+447700900456"));
      assert.deepEqual(fake.events()[0].user_data.em, [row.email_hash]);
    });
  });

  describe("Meta's errors", () => {
    it("are classified as the lead client classifies them, with Meta's own words kept for events", () => {
      const event = graphFailure(400, { error: { code: 100, message: "Invalid  parameter:\nlead_id.", error_subcode: 2804 } }, TOKEN);
      assert.ok(event instanceof MetaError);
      assert.deepEqual([event.status, event.code, event.subcode, event.detail], [400, 100, 2804, "Invalid parameter: lead_id."]);
      const dataset = graphFailure(400, { error: { code: 100, message: "Unsupported post request.", error_subcode: 33 } }, TOKEN);
      assert.deepEqual([dataset.code, dataset.subcode], [100, 33]);
      assert.equal(graphFailure(400, { error: { code: 190, message: "Expired." } }, TOKEN).status, 401);
      assert.equal(graphFailure(400, { error: { code: 4, message: "Slow down." } }, TOKEN).status, 429);
      assert.equal(graphFailure(502, "<html>", TOKEN).status, 502);
      assert.equal(metaGraphVersion(), "v27.0");
    });
  });

  describe("old events", () => {
    it("never sends an event older than 6.5 days and re-times it to the earliest fresh later stage", async () => {
      const lead = await scenario({ filedMinutesAgo: 9 * DAY });
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await sql("update crm.opportunities set created_at = now() - interval '8 days' where id = $1", [id]);
      await moveTo(id, "Proposal", 3 * DAY);
      await sql("update crm.meta_leads set filed_at = now() - interval '9 days' where id = $1", [lead.leadId]);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
      const times = fake.events().map((event) => event.event_time);
      assert.equal(times[0], times[2]);
      for (const time of times) assert.ok(time > Date.now() / 1000 - 6.5 * 86_400);
    });

    it("skips stale stages when nothing fresh follows them", async () => {
      const lead = await scenario({ filedMinutesAgo: 9 * DAY });
      const fake = metaFake();
      await run(fake);
      assert.equal(fake.requests.length, 0);
      const [row] = await outcomes(lead.leadId);
      assert.equal(row.status, "skipped");
      await run(fake);
      assert.equal(fake.requests.length, 0);
    });

    it("never lets a stale event into a batch, so one old event can't make Meta reject the rest", async () => {
      const stale = await scenario({ filedMinutesAgo: 9 * DAY });
      const fresh = await scenario();
      const fake = metaFake({
        reject: (event) => (event.event_time < Date.now() / 1000 - 7 * 86_400 ? { code: 100, message: "Event too old." } : null),
      });
      await run(fake);
      assert.equal(fake.names().length, 1);
      assert.equal((await statuses(fresh.leadId)).Lead, "sent");
      assert.equal((await statuses(stale.leadId)).Lead, "skipped");
    });

    it("says nothing after the first failure, alerts the owner once after 24 hours, and again only after a new streak", async () => {
      await scenario();
      let working = false;
      const fake = metaFake({ fail: () => (working ? null : Response.json({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, { status: 401 })) });
      const alerts = () => sql<{ title: string; body: string }>("select title, body from crm.notifications where source = 'meta_outcomes'");
      await run(fake);
      assert.equal((await alerts()).length, 0);
      await sql("update crm.meta_lead_outcomes set next_attempt_at = null");
      await run(fake);
      assert.equal((await alerts()).length, 0);
      await sql("update crm.meta_outcome_settings set last_error_at = now() - interval '23 hours' where workspace_id = $1", [owner.workspaceId]);
      await sql("update crm.meta_lead_outcomes set next_attempt_at = null");
      await run(fake);
      assert.equal((await alerts()).length, 0);
      await sql("update crm.meta_outcome_settings set last_error_at = now() - interval '25 hours' where workspace_id = $1", [owner.workspaceId]);
      await sql("update crm.meta_lead_outcomes set next_attempt_at = null");
      await run(fake);
      await run(fake);
      const first = await alerts();
      assert.equal(first.length, 1);
      assert.equal(first[0].title, "Meta outcomes aren't sending");
      assert.match(first[0].body, /rejected the access token/);

      working = true;
      await sql("update crm.meta_lead_outcomes set next_attempt_at = null");
      await run(fake);
      assert.equal((await sql<{ last_error: string | null; alerted_at: Date | null }>("select last_error, alerted_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].alerted_at, null);

      working = false;
      await scenario();
      await run(fake);
      assert.equal((await alerts()).length, 1);
      await sql("update crm.meta_outcome_settings set last_error_at = now() - interval '25 hours' where workspace_id = $1", [owner.workspaceId]);
      await run(fake);
      await run(fake);
      assert.equal((await alerts()).length, 2);
    });

    it("fails a stage still unsent at 6.5 days, without a second alert", async () => {
      const lead = await scenario();
      const fake = metaFake({ fail: () => Response.json({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }, { status: 401 }) });
      await run(fake);
      assert.equal((await outcomes(lead.leadId))[0].status, "pending");
      await sql("update crm.meta_outcome_settings set last_error_at = now() - interval '25 hours' where workspace_id = $1", [owner.workspaceId]);
      await run(fake);
      await sql("update crm.meta_lead_outcomes set occurred_at = now() - interval '7 days', next_attempt_at = null where lead_id = $1", [lead.leadId]);
      await run(fake);
      const [row] = await outcomes(lead.leadId);
      assert.equal(row.status, "failed");
      assert.match(row.error ?? "", /6\.5 days/);
      await run(fake);
      assert.equal((await sql("select 1 from crm.notifications where source = 'meta_outcomes'")).length, 1);
      assert.equal(fake.events().length, 1);
    });
  });

  describe("sending", () => {
    it("keeps a lead's stages in one request, in position order", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId, value: 1000 });
      await moveTo(id, "Working", 300);
      await moveTo(id, "Proposal", 200);
      await moveTo(id, "Won", 100);
      const fake = metaFake();
      await run(fake);
      assert.equal(fake.requests.length, 1);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal", "Won"]);
    });

    it("sends at most 100 events in a request", async () => {
      for (let index = 0; index < 120; index += 1) await scenario();
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.requests.map((request) => request.events.length), [100, 20]);
    });

    it("sends two runners' work once between them", async () => {
      const leads = [];
      for (let index = 0; index < 6; index += 1) leads.push(await scenario());
      const fake = metaFake({ delay: 20 });
      await Promise.all([run(fake), run(fake), run(fake)]);
      const ids = fake.events().map((event) => event.event_id);
      assert.equal(ids.length, 6);
      assert.equal(new Set(ids).size, 6);
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where status = 'sent'")).length, 6);
    });

    it("splits a batch Meta rejects for one event, sends the rest and fails only the bad one", async () => {
      const good = await scenario();
      const bad = await scenario({ leadgen: "555000000000001" });
      const also = await scenario();
      const fake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000001 ? { code: 100, message: "Invalid parameter: lead_id." } : null) });
      const report = await run(fake);
      assert.equal(report.sent, 2);
      assert.equal(report.failed, 1);
      assert.equal((await statuses(good.leadId)).Lead, "sent");
      assert.equal((await statuses(also.leadId)).Lead, "sent");
      const [row] = await outcomes(bad.leadId);
      assert.equal(row.status, "failed");
      assert.equal(row.error, "Invalid parameter: lead_id.");
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);
      const requests = fake.requests.length;
      await run(fake);
      assert.equal(fake.requests.length, requests);
    });

    it("makes a lead's later stages wait behind a stage that failed", async () => {
      const lead = await scenario({ leadgen: "555000000000002" });
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Proposal", 60);
      const fake = metaFake({ reject: (event) => (event.event_name === "Working" ? { code: 100, message: "Bad stage." } : null) });
      await run(fake);
      assert.deepEqual(await statuses(lead.leadId), { Lead: "sent", Working: "failed", Proposal: "pending" });
      const again = metaFake();
      await run(again);
      assert.equal(again.requests.length, 0);
      assert.equal((await statuses(lead.leadId)).Proposal, "pending");
    });

    it("treats an unreachable dataset (100/33) as a workspace failure and keeps every row pending", async () => {
      const first = await scenario();
      const second = await scenario();
      const fake = metaFake({ reject: () => ({ code: 100, subcode: 33, message: "Unsupported post request." }) });
      const report = await run(fake);
      assert.equal(report.failed, 0);
      assert.equal(fake.requests.length, 1);
      assert.equal((await statuses(first.leadId)).Lead, "pending");
      assert.equal((await statuses(second.leadId)).Lead, "pending");
      const [settings] = await sql<{ last_error: string; last_error_at: Date }>("select last_error, last_error_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]);
      assert.match(settings.last_error, /can't reach the dataset/);
      assert.ok(settings.last_error_at);
    });

    it("treats a token error as a workspace failure: rows stay pending and back off", async () => {
      const lead = await scenario();
      const fake = metaFake({ fail: () => Response.json({ error: { message: "Error validating access token.", type: "OAuthException", code: 190 } }, { status: 400 }) });
      await run(fake);
      const [row] = await outcomes(lead.leadId);
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 1);
      const [next] = await sql<{ next_attempt_at: Date; claimed_until: Date | null }>("select next_attempt_at, claimed_until from crm.meta_lead_outcomes where lead_id = $1", [lead.leadId]);
      assert.ok(next.next_attempt_at.getTime() > Date.now() + 4 * 60_000);
      assert.equal(next.claimed_until, null);
      assert.match((await sql<{ last_error: string }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, /rejected the access token/);
      await run(fake);
      assert.equal(fake.requests.length, 1);
      await sql("update crm.meta_lead_outcomes set next_attempt_at = now() - interval '1 minute' where lead_id = $1", [lead.leadId]);
      await run(fake);
      assert.equal(fake.requests.length, 2);
      const [after] = await sql<{ attempts: number; next_attempt_at: Date }>("select attempts, next_attempt_at from crm.meta_lead_outcomes where lead_id = $1", [lead.leadId]);
      assert.equal(after.attempts, 2);
      assert.ok(after.next_attempt_at.getTime() > Date.now() + 9 * 60_000);
    });

    it("backs off through rate limits and server errors, and clears the error after a good send", async () => {
      const lead = await scenario();
      let phase: "limit" | "down" | "ok" = "limit";
      const fake = metaFake({
        fail: () => {
          if (phase === "limit") return Response.json({ error: { message: "Too many calls.", code: 4 } }, { status: 400 });
          if (phase === "down") return new Response("Bad gateway", { status: 502 });
          return null;
        },
      });
      await run(fake);
      assert.equal((await outcomes(lead.leadId))[0].attempts, 1);
      await retryNow(lead.leadId);
      phase = "down";
      await run(fake);
      assert.equal((await outcomes(lead.leadId))[0].attempts, 2);
      assert.ok((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error);
      await retryNow(lead.leadId);
      phase = "ok";
      await run(fake);
      assert.equal((await outcomes(lead.leadId))[0].status, "sent");
      assert.deepEqual(await sql("select last_error, last_error_at, alerted_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]), [{ last_error: null, last_error_at: null, alerted_at: null }]);
    });

    it("treats a split that rejects every single event as a workspace failure", async () => {
      const first = await scenario();
      const second = await scenario();
      const fake = metaFake({ reject: () => ({ code: 100, message: "Invalid parameter." }) });
      const report = await run(fake);
      assert.equal(report.failed, 0);
      assert.equal((await statuses(first.leadId)).Lead, "pending");
      assert.equal((await statuses(second.leadId)).Lead, "pending");
      assert.match((await sql<{ last_error: string }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, /nothing has been accepted lately/);
    });

    it("lets a stage that Meta rejects on its own stay failed rather than retrying it forever", async () => {
      const lead = await scenario({ leadgen: "555000000000003" });
      const good = await scenario();
      const fake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000003 ? { code: 100, message: "Nope." } : null) });
      await run(fake);
      const requests = fake.requests.length;
      await run(fake);
      assert.equal(fake.requests.length, requests);
      assert.equal((await outcomes(lead.leadId))[0].status, "failed");
      assert.equal((await statuses(good.leadId)).Lead, "sent");
    });

    it("stops starting new requests when time runs short and leaves the rest claimable", async () => {
      for (let index = 0; index < 4; index += 1) await scenario();
      const fake = metaFake();
      const report = await runMetaOutcomes({ fetchImpl: fake.fetchImpl, deadline: Date.now() + 400 });
      assert.equal(report.sent, 0);
      assert.equal(fake.requests.length, 0);
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where status = 'pending' and claimed_until is null")).length, 4);
    });

    it("leaves a lease on a claimed row so a second runner doesn't take it", async () => {
      const lead = await scenario();
      await sql("select * from private.meta_lead_outcomes_due(10, null, null)");
      await sql("select private.meta_lead_outcomes_record($1::jsonb)", [JSON.stringify([{ lead_id: lead.leadId, stage_name: "Lead", stage_id: null, position: 0, occurred_at: new Date().toISOString() }])]);
      const claimed = await sql("select * from private.meta_lead_outcomes_claim(10)");
      assert.equal(claimed.length, 1);
      assert.equal((await sql("select * from private.meta_lead_outcomes_claim(10)")).length, 0);
      await sql("update crm.meta_lead_outcomes set claimed_until = now() - interval '1 second' where lead_id = $1", [lead.leadId]);
      assert.equal((await sql("select * from private.meta_lead_outcomes_claim(10)")).length, 1);
    });

    it("won't blame one event for a rejection when nothing else has been accepted lately, even on a targeted pass", async () => {
      const lead = await scenario({ leadgen: "555000000000010" });
      const fake = metaFake({ reject: () => ({ code: 100, message: "Invalid parameter." }) });
      const report = await runMetaOutcomes({ fetchImpl: fake.fetchImpl, deadline: Date.now() + 20_000, leadIds: [lead.leadId] });
      assert.equal(report.failed, 0);
      assert.equal(report.sent, 0);
      const [row] = await outcomes(lead.leadId);
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 1);
      const [settings] = await sql<{ last_error: string; last_error_at: Date }>("select last_error, last_error_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]);
      assert.match(settings.last_error, /nothing has been accepted lately/);
      assert.ok(settings.last_error_at);

      const good = await scenario();
      await retryNow(lead.leadId);
      const second = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000010 ? { code: 100, message: "Invalid parameter: lead_id." } : null) });
      const again = await run(second);
      assert.equal(again.failed, 1);
      assert.equal((await statuses(good.leadId)).Lead, "sent");
      const [after] = await outcomes(lead.leadId);
      assert.equal(after.status, "failed");
      assert.equal(after.error, "Invalid parameter: lead_id.");
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);
    });

    it("blames a lone rejected event when the dataset accepted something in the last day, and not once the dataset changes", async () => {
      await scenario();
      await run(metaFake());
      const lead = await scenario({ leadgen: "555000000000011" });
      const fake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000011 ? { code: 100, message: "Bad lead." } : null) });
      const report = await run(fake);
      assert.equal(report.failed, 1);
      assert.equal((await outcomes(lead.leadId))[0].status, "failed");
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);

      await sql("update crm.meta_outcome_settings set last_sent_at = now() - interval '2 days' where workspace_id = $1", [owner.workspaceId]);
      const stale = await scenario({ leadgen: "555000000000012" });
      const staleFake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000012 ? { code: 100, message: "Bad lead." } : null) });
      await run(staleFake);
      assert.equal((await outcomes(stale.leadId))[0].status, "pending");

      await sql("update crm.meta_outcome_settings set last_sent_at = now() where workspace_id = $1", [owner.workspaceId]);
      await saveMetaOutcomes(owner, { datasetId: "222" }, { fetchImpl: async () => Response.json({ id: "222" }) });
      assert.equal((await sql<{ last_sent_at: Date | null }>("select last_sent_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_sent_at, null);
    });

    it("shows admins how many stages failed for good, and members nothing of it", async () => {
      await scenario();
      const bad = await scenario({ leadgen: "555000000000013" });
      const fake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000013 ? { code: 100, message: "Bad lead." } : null) });
      await run(fake);
      assert.equal((await outcomes(bad.leadId))[0].status, "failed");
      assert.equal((await getMetaOutcomesView(admin)).failed, 1);
      assert.equal((await getMetaOutcomesView(owner)).failed, 1);
      assert.equal((await getMetaOutcomesView(member)).failed, 0);
    });

    it("puts the rows of a rejected batch the deadline cut short on retry, then sends them one at a time", async () => {
      const bad = await scenario({ leadgen: "555000000000014" });
      const others = [await scenario(), await scenario(), await scenario()];
      const slow = metaFake({ delay: 2_800, reject: () => ({ code: 100, message: "Invalid parameter." }) });
      await runMetaOutcomes({ fetchImpl: slow.fetchImpl, deadline: Date.now() + 4_000 });
      assert.equal(slow.requests.length, 1);
      const rows = await sql<{ status: string; attempts: number; isolate: boolean; claimed_until: Date | null; next_attempt_at: Date | null }>(
        "select status, attempts, isolate, claimed_until, next_attempt_at from crm.meta_lead_outcomes",
      );
      assert.equal(rows.length, 4);
      for (const row of rows) {
        assert.equal(row.status, "pending");
        assert.equal(row.attempts, 1);
        assert.equal(row.isolate, true);
        assert.equal(row.claimed_until, null);
        assert.ok(row.next_attempt_at && row.next_attempt_at.getTime() > Date.now() + 4 * 60_000);
      }
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);

      await sql("update crm.meta_lead_outcomes set next_attempt_at = null");
      const fake = metaFake({ reject: (event) => (event.user_data.lead_id === 555000000000014 ? { code: 100, message: "Invalid parameter: lead_id." } : null) });
      const report = await run(fake);
      assert.ok(fake.requests.every((request) => request.events.length === 1));
      assert.equal(fake.requests.length, 4);
      assert.equal(report.sent, 3);
      assert.equal(report.failed, 1);
      assert.equal((await outcomes(bad.leadId))[0].status, "failed");
      for (const other of others) assert.equal((await statuses(other.leadId)).Lead, "sent");
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where isolate")).length, 0);
    });

    it("isn't blocked by leads stuck behind a failed earlier stage, however many there are", async () => {
      const stuck = [];
      for (let index = 0; index < 3; index += 1) stuck.push(await scenario({ filedMinutesAgo: 5 * DAY + index }));
      const open = await scenario({ filedMinutesAgo: DAY });
      const insert = (leadId: string, name: string, position: number, status: string) =>
        sql(
          `insert into crm.meta_lead_outcomes (workspace_id, lead_id, stage_name, "position", occurred_at, status)
           values ($1, $2, $3, $4, now() - interval '1 hour', $5)`,
          [owner.workspaceId, leadId, name, position, status],
        );
      for (const lead of stuck) {
        await insert(lead.leadId, "Lead", 0, "sent");
        await insert(lead.leadId, "Working", 1, "failed");
        await insert(lead.leadId, "Proposal", 2, "pending");
      }
      await insert(open.leadId, "Lead", 0, "pending");
      const claimed = await sql<{ leadgen_id: string; stage_name: string }>("select leadgen_id, stage_name from private.meta_lead_outcomes_claim(2)");
      assert.deepEqual(claimed.map((row) => [row.leadgen_id, row.stage_name]), [[open.leadgen, "Lead"]]);
      for (const lead of stuck) assert.equal((await statuses(lead.leadId)).Proposal, "pending");
      assert.equal((await sql("select 1 from crm.meta_lead_outcomes where claimed_until is not null and stage_name = 'Proposal'")).length, 0);
    });

    it("sends only a lead's own workspace's dataset, in a full run and a targeted pass, and nothing for a workspace with outcomes off", async () => {
      const second = "2222222222222222";
      const third = "3333333333333333";
      const ridgeon = await createWorkspace(owner, { name: "Dataset Two" });
      const quiet = await createWorkspace(owner, { name: "Dataset Three" });
      const actorFor = (id: string, name: string): UserActor => ({ ...owner, workspaceId: id, workspaceName: name, role: "owner", scopes: scopesForRole("owner") });
      const two = actorFor(ridgeon.id, "Dataset Two");
      const three = actorFor(quiet.id, "Dataset Three");
      try {
        await sql("insert into crm.meta_outcome_settings (workspace_id, dataset_id, enabled) values ($1, $2, true), ($3, $4, false)", [two.workspaceId, second, three.workspaceId, third]);
        const twoStages = Object.fromEntries((await listPipeline(two)).stages.map((item) => [item.name, item.id]));
        const inLaterStage = async (actor: UserActor, lead: Scenario, stages: Record<string, string>, name: string) => {
          const id = (await createOpportunity(actor, { companyId: lead.companyId, primaryContactId: lead.contactId, name: `Later ${counter}`, stageId: stages[name] })).body.opportunity.id;
          await sql("update crm.opportunity_stage_entries set entered_at = now() - interval '1 hour' where opportunity_id = $1", [id]);
        };
        const a1 = await scenario();
        const a2 = await scenario();
        await inLaterStage(owner, a1, stage, "Working");
        const b1 = await scenario({ actor: two });
        await inLaterStage(two, b1, twoStages, "Proposal");
        const c1 = await scenario({ actor: three });

        const fake = metaFake({ datasets: [DATASET, second] });
        await run(fake);
        const idsFor = (dataset: string) => fake.requests.filter((request) => request.dataset === dataset).flatMap((request) => request.events.map((event) => String(event.user_data.lead_id)));
        assert.deepEqual(new Set(idsFor(DATASET)), new Set([a1.leadgen, a2.leadgen]));
        assert.deepEqual(new Set(idsFor(second)), new Set([b1.leadgen]));
        assert.deepEqual(fake.requests.filter((request) => request.dataset === second).flatMap((request) => request.events.map((event) => event.event_name)), ["Lead", "Working", "Proposal"]);
        assert.deepEqual(fake.requests.filter((request) => request.dataset === DATASET).flatMap((request) => request.events.filter((event) => String(event.user_data.lead_id) === a1.leadgen).map((event) => event.event_name)), ["Lead", "Working"]);
        assert.equal((await outcomes(c1.leadId)).length, 0);
        assert.deepEqual(fake.violations, []);

        const a3 = await scenario();
        const b2 = await scenario({ actor: two });
        const before = fake.requests.length;
        await runMetaOutcomes({ fetchImpl: fake.fetchImpl, deadline: Date.now() + 20_000, leadIds: [b2.leadId, c1.leadId] });
        const targeted = fake.requests.slice(before);
        assert.deepEqual(targeted.map((request) => request.dataset), [second]);
        assert.deepEqual(targeted[0].events.map((event) => String(event.user_data.lead_id)), [b2.leadgen]);
        assert.equal((await outcomes(a3.leadId)).length, 0);
        assert.equal((await outcomes(c1.leadId)).length, 0);

        const rest = fake.requests.length;
        await run(fake);
        const later = fake.requests.slice(rest);
        assert.deepEqual(later.map((request) => [request.dataset, request.events.map((event) => String(event.user_data.lead_id))]), [[DATASET, [a3.leadgen]]]);
        assert.deepEqual(fake.violations, []);
      } finally {
        await sql("delete from crm.meta_outcome_settings where workspace_id = any($1)", [[two.workspaceId, three.workspaceId]]);
      }
    });

    it("sends Lead but nothing else while two sales pipelines are unchosen, says so, and alerts after 24 hours", async () => {
      const extra = (await sql<{ id: string }>("insert into crm.pipelines (workspace_id, name, kind) values ($1, 'Partners', 'sales') returning id", [owner.workspaceId]))[0].id;
      await sql("insert into crm.pipeline_stages (workspace_id, pipeline_id, name, position) values ($1, $2, 'Intro', 0), ($1, $2, 'Signed', 1)", [owner.workspaceId, extra]);
      const message = "Choose a pipeline in Settings › Tools.";
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 60);
      const fake = metaFake();
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead"]);
      assert.deepEqual(await statuses(lead.leadId), { Lead: "sent" });
      const [settings] = await sql<{ last_error: string; last_error_at: Date }>("select last_error, last_error_at from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]);
      assert.equal(settings.last_error, message);
      assert.ok(settings.last_error_at);
      assert.equal((await getMetaOutcomesView(admin)).lastError, message);
      assert.equal((await getMetaOutcomesView(member)).lastError, null);

      await scenario();
      await sql("update crm.meta_outcome_settings set last_error_at = now() - interval '25 hours' where workspace_id = $1", [owner.workspaceId]);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Lead"]);
      const alerts = await sql<{ body: string }>("select body from crm.notifications where source = 'meta_outcomes'");
      assert.deepEqual(alerts.map((row) => row.body), [message]);
      await run(fake);
      assert.equal((await sql("select 1 from crm.notifications where source = 'meta_outcomes'")).length, 1);

      await saveMetaOutcomes(owner, { pipelineId: salesPipeline }, { fetchImpl: metaFake().fetchImpl });
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Lead", "Working"]);
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);
    });

    it("clears the pipeline error when a second sales pipeline goes away", async () => {
      const extra = (await sql<{ id: string }>("insert into crm.pipelines (workspace_id, name, kind) values ($1, 'Partners', 'sales') returning id", [owner.workspaceId]))[0].id;
      await run(metaFake());
      assert.match((await sql<{ last_error: string }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, /Choose a pipeline/);
      await sql("delete from crm.pipelines where id = $1", [extra]);
      await run(metaFake());
      assert.equal((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error, null);
    });

    it("returns within its slice when Meta never answers", async () => {
      const lead = await scenario();
      const fetchImpl: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const keepAlive = setInterval(() => undefined, 60_000);
          init?.signal?.addEventListener("abort", () => {
            clearInterval(keepAlive);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      const started = Date.now();
      const report = await runMetaOutcomes({ fetchImpl, deadline: started + 3_500 });
      const took = Date.now() - started;
      assert.ok(took < 3_500 + 1_000, `took ${took}ms`);
      assert.equal(report.sent, 0);
      const [row] = await outcomes(lead.leadId);
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, 1);
      assert.equal((await sql<{ claimed_until: Date | null }>("select claimed_until from crm.meta_lead_outcomes where lead_id = $1", [lead.leadId]))[0].claimed_until, null);
      assert.ok((await sql<{ last_error: string | null }>("select last_error from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0].last_error);
    });
  });

  describe("filing", () => {
    it("hashes the lead's email and phone when it files, and sends Lead straight away", async () => {
      process.env.META_ACCESS_TOKEN = "page-system-token";
      try {
        await linkMetaPage(owner, "1111111111", { schedule: () => undefined });
        const leadgen = "444000000000001";
        const events = metaFake();
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === `/v27.0/${leadgen}`) {
            return Response.json({
              id: leadgen,
              created_time: new Date(Date.now() - 600_000).toISOString(),
              form_id: "6666",
              field_data: [
                { name: "full_name", values: ["Fran Filed"] },
                { name: "email", values: ["Fran.Filed@Filed-Co.test"] },
                { name: "phone_number", values: ["07700 900777"] },
                { name: "company_name", values: ["Filed Co"] },
              ],
            });
          }
          if (url.pathname === "/v27.0/6666") return Response.json({ id: "6666", name: "Form" });
          return events.fetchImpl(input, init);
        };
        const raw = JSON.stringify({ object: "page", entry: [{ id: "1111111111", time: 1, changes: [{ field: "leadgen", value: { leadgen_id: leadgen, page_id: "1111111111", form_id: "6666" } }] }] });
        const jobs: Promise<void>[] = [];
        const response = await handleMetaLeadsWebhook(
          new Request("https://orbit.test/api/webhooks/meta-leads", { method: "POST", body: raw, headers: { "x-hub-signature-256": metaSignature(raw, APP_SECRET) } }),
          { fetchImpl, rateLimit: false, schedule: (work) => jobs.push(work()), send: async () => ({ ok: true }) },
        );
        assert.equal(response.status, 200);
        await Promise.all(jobs);
        const [row] = await sql<{ email_hash: string; phone_hash: string; filed_at: Date | null }>("select email_hash, phone_hash, filed_at from crm.meta_leads where leadgen_id = $1", [leadgen]);
        assert.ok(row.filed_at, JSON.stringify(await sql("select error, fetched_at, workspace_id, attempts from crm.meta_leads where leadgen_id = $1", [leadgen])));
        assert.equal(row.email_hash, hashEmail("fran.filed@filed-co.test"));
        assert.equal(row.phone_hash, hashPhone("07700 900777"));
        assert.deepEqual(events.names(), ["Lead"]);
        assert.equal(events.events()[0].user_data.lead_id, Number(leadgen));
        assert.deepEqual(events.events()[0].user_data.em, [row.email_hash]);
      } finally {
        delete process.env.META_ACCESS_TOKEN;
        await sql("delete from crm.meta_lead_pages");
      }
    });

    it("sends one outcomes pass for everything a run filed, not one per lead", async () => {
      process.env.META_ACCESS_TOKEN = "page-system-token";
      try {
        await linkMetaPage(owner, "1111111111", { schedule: () => undefined });
        const leadgens = ["444000000000011", "444000000000012", "444000000000013"];
        const events = metaFake();
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          const index = leadgens.findIndex((id) => url.pathname === `/v27.0/${id}`);
          if (index >= 0) {
            return Response.json({
              id: leadgens[index],
              created_time: new Date(Date.now() - 600_000).toISOString(),
              form_id: "6666",
              field_data: [
                { name: "full_name", values: [`Batch Person ${index}`] },
                { name: "email", values: [`batch${index}@batch-co-${index}.test`] },
                { name: "company_name", values: [`Batch Co ${index}`] },
              ],
            });
          }
          if (url.pathname === "/v27.0/6666") return Response.json({ id: "6666", name: "Form" });
          return events.fetchImpl(input, init);
        };
        const raw = JSON.stringify({
          object: "page",
          entry: [{ id: "1111111111", time: 1, changes: leadgens.map((leadgen_id) => ({ field: "leadgen", value: { leadgen_id, page_id: "1111111111", form_id: "6666" } })) }],
        });
        const jobs: Promise<void>[] = [];
        const response = await handleMetaLeadsWebhook(
          new Request("https://orbit.test/api/webhooks/meta-leads", { method: "POST", body: raw, headers: { "x-hub-signature-256": metaSignature(raw, APP_SECRET) } }),
          { fetchImpl, rateLimit: false, schedule: (work) => jobs.push(work()), send: async () => ({ ok: true }) },
        );
        assert.equal(response.status, 200);
        await Promise.all(jobs);
        assert.equal((await sql("select 1 from crm.meta_leads where filed_at is not null")).length, 3);
        assert.equal(events.requests.length, 1);
        assert.deepEqual(events.requests[0].events.map((event) => String(event.user_data.lead_id)).sort(), leadgens);
        assert.deepEqual(events.names(), ["Lead", "Lead", "Lead"]);
      } finally {
        delete process.env.META_ACCESS_TOKEN;
        await sql("delete from crm.meta_lead_pages");
      }
    });
  });

  describe("the cron", () => {
    function cronRequest() {
      return new Request("https://orbit.test/api/cron/sync", { headers: { authorization: "Bearer cron-secret" } });
    }

    it("sends outcomes first for up to eight seconds, then gives the sync the rest of its budget", async () => {
      process.env.CRON_SECRET = "cron-secret";
      const order: string[] = [];
      let outcomesDeadline = 0;
      let budget = 0;
      const received = Date.now();
      await handleCronRequest(
        cronRequest(),
        async (ms) => {
          order.push("sync");
          budget = ms;
          return { startedAt: "", durationMs: 0, errors: 0, workspaces: [] };
        },
        async (deadline) => {
          order.push("outcomes");
          outcomesDeadline = deadline;
          await new Promise((resolve) => setTimeout(resolve, 250));
        },
      );
      assert.deepEqual(order, ["outcomes", "sync"]);
      assert.ok(outcomesDeadline <= received + 8_100 && outcomesDeadline > received + 7_000);
      assert.ok(budget < 50_000 - 200 && budget > 49_000, `budget ${budget}`);
    });

    it("leaves the sync its whole budget when there is nothing to send", async () => {
      process.env.CRON_SECRET = "cron-secret";
      let budget = 0;
      let calls = 0;
      const run = async (ms: number) => {
        budget = ms;
        return { startedAt: "", durationMs: 0, errors: 0, workspaces: [] };
      };
      await sql("update crm.meta_outcome_settings set enabled = false where workspace_id = $1", [owner.workspaceId]);
      await handleCronRequest(cronRequest(), run, async () => {
        calls += 1;
      });
      assert.equal(calls, 0);
      assert.equal(budget, 50_000);
      await sql("update crm.meta_outcome_settings set enabled = true where workspace_id = $1", [owner.workspaceId]);
      delete process.env.META_DATASET_TOKEN;
      try {
        await handleCronRequest(cronRequest(), run, async () => {
          calls += 1;
        });
        assert.equal(calls, 0);
        assert.equal(budget, 50_000);
      } finally {
        process.env.META_DATASET_TOKEN = TOKEN;
      }
    });

    it("keeps going when outcomes throw", async () => {
      process.env.CRON_SECRET = "cron-secret";
      let synced = false;
      const response = await handleCronRequest(
        cronRequest(),
        async () => {
          synced = true;
          return { startedAt: "", durationMs: 0, errors: 0, workspaces: [] };
        },
        async () => {
          throw new Error("boom");
        },
      );
      assert.equal(response.status, 200);
      assert.ok(synced);
    });
  });

  describe("settings", () => {
    it("lets owners and admins save and switch on, and checks the dataset with the token", async () => {
      await sql("delete from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]);
      const auditCount = async () => (await sql("select 1 from crm.audit_events where event_type = 'integration.updated' and workspace_id = $1", [owner.workspaceId])).length;
      const audited = await auditCount();
      const fake = metaFake();
      await saveMetaOutcomes(admin, { datasetId: ` ${DATASET} ` }, { fetchImpl: fake.fetchImpl });
      assert.equal(fake.checks, 1);
      let view = await getMetaOutcomesView(admin);
      assert.deepEqual([view.datasetId, view.enabled, view.tokenSet], [DATASET, false, true]);
      await saveMetaOutcomes(owner, { enabled: true }, { fetchImpl: fake.fetchImpl });
      assert.equal(fake.checks, 2);
      view = await getMetaOutcomesView(owner);
      assert.equal(view.enabled, true);
      assert.deepEqual(view.stages.map((item) => item.name), ["Lead", "Working", "Proposal", "Won", "Lost"]);
      assert.equal(view.stages.at(-1)?.note, "Opportunity marked lost");
      assert.deepEqual(view.pipelines, []);
      assert.equal((await auditCount()) - audited, 2);
    });

    it("refuses members any change to the settings and hides the errors from them, while they can see the dataset ID", async () => {
      await assert.rejects(saveMetaOutcomes(member, { datasetId: "123" }, { fetchImpl: metaFake().fetchImpl }), /Only owners and admins/);
      await assert.rejects(saveMetaOutcomes(member, { enabled: false }, { fetchImpl: metaFake().fetchImpl }), /Only owners and admins/);
      await sql("update crm.meta_outcome_settings set last_error = 'Token rejected.' where workspace_id = $1", [owner.workspaceId]);
      const seen = await getMetaOutcomesView(member);
      assert.equal(seen.datasetId, DATASET);
      assert.equal(seen.lastError, null);
      assert.equal((await getMetaOutcomesView(admin)).lastError, "Token rejected.");
      assert.deepEqual(
        await queryAsUser(member.userId, "update crm.meta_outcome_settings set enabled = false, dataset_id = '1' where workspace_id = $1 returning workspace_id", [owner.workspaceId]),
        [],
      );
      await assert.rejects(queryAsUser(member.userId, "insert into crm.meta_outcome_settings (workspace_id, dataset_id) values ($1, '1')", [outsider.workspaceId]));
      assert.deepEqual(await sql("select enabled, dataset_id from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]), [{ enabled: true, dataset_id: DATASET }]);
      assert.equal((await sql("select 1 from crm.meta_outcome_settings where enabled")).length, 1);
    });

    it("saves and switches on when the token can send events but Meta won't let it read the dataset", async () => {
      await sql("update crm.meta_outcome_settings set enabled = false, dataset_id = null where workspace_id = $1", [owner.workspaceId]);
      const sendOnly = async () =>
        Response.json({ error: { message: "(#100) Missing Permission", type: "OAuthException", code: 100, fbtrace_id: "trace" } }, { status: 400 });
      await saveMetaOutcomes(owner, { datasetId: DATASET }, { fetchImpl: sendOnly });
      await saveMetaOutcomes(owner, { enabled: true }, { fetchImpl: sendOnly });
      assert.equal((await sql("select 1 from crm.meta_outcome_settings where enabled and dataset_id = $1", [DATASET])).length, 1);
      const expired = async () => Response.json({ error: { message: "Error validating access token.", type: "OAuthException", code: 190 } }, { status: 400 });
      await sql("update crm.meta_outcome_settings set enabled = false, dataset_id = null where workspace_id = $1", [owner.workspaceId]);
      await assert.rejects(saveMetaOutcomes(owner, { datasetId: DATASET }, { fetchImpl: expired }), /access token/i);
    });

    it("won't switch on without a dataset ID or the token, or with a dataset Meta can't reach", async () => {
      await sql("update crm.meta_outcome_settings set enabled = false, dataset_id = null where workspace_id = $1", [owner.workspaceId]);
      await assert.rejects(saveMetaOutcomes(owner, { enabled: true }, { fetchImpl: metaFake().fetchImpl }), /Dataset ID first/);
      await assert.rejects(saveMetaOutcomes(owner, { datasetId: "not-a-number" }, { fetchImpl: metaFake().fetchImpl }), /digits only/);
      await assert.rejects(saveMetaOutcomes(owner, { datasetId: "999" }, { fetchImpl: metaFake().fetchImpl }), /can't reach the dataset/);
      delete process.env.META_DATASET_TOKEN;
      try {
        await assert.rejects(saveMetaOutcomes(owner, { datasetId: DATASET }, { fetchImpl: metaFake().fetchImpl }), /META_DATASET_TOKEN/);
        assert.equal((await getMetaOutcomesView(owner)).tokenSet, false);
      } finally {
        process.env.META_DATASET_TOKEN = TOKEN;
      }
      const row = (await sql<{ enabled: boolean; dataset_id: string | null }>("select enabled, dataset_id from crm.meta_outcome_settings where workspace_id = $1", [owner.workspaceId]))[0];
      assert.deepEqual(row, { enabled: false, dataset_id: null });
    });

    it("offers a pipeline choice only when there is more than one sales pipeline", async () => {
      const extra = (await sql<{ id: string }>("insert into crm.pipelines (workspace_id, name, kind) values ($1, 'Partners', 'sales') returning id", [owner.workspaceId]))[0].id;
      await sql("insert into crm.pipeline_stages (workspace_id, pipeline_id, name, position) values ($1, $2, 'Intro', 0), ($1, $2, 'Signed', 1)", [owner.workspaceId, extra]);
      let view = await getMetaOutcomesView(owner);
      assert.equal(view.pipelines.length, 2);
      assert.equal(view.pipelineId, null);
      assert.deepEqual(view.stages.map((item) => item.name), ["Lead"]);
      await saveMetaOutcomes(owner, { pipelineId: extra }, { fetchImpl: metaFake().fetchImpl });
      view = await getMetaOutcomesView(owner);
      assert.deepEqual(view.stages.map((item) => item.name), ["Lead", "Signed"]);
      await assert.rejects(saveMetaOutcomes(owner, { pipelineId: "00000000-0000-0000-0000-000000000000" }, { fetchImpl: metaFake().fetchImpl }), /Choose a sales pipeline/);
      await sql("update crm.meta_outcome_settings set pipeline_id = null where workspace_id = $1", [owner.workspaceId]);
      await sql("delete from crm.pipeline_stages where pipeline_id = $1", [extra]);
      await sql("delete from crm.pipelines where id = $1", [extra]);
    });

    it("keeps a renamed stage's old name on what was sent and uses the new name from then on", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 60);
      const fake = metaFake();
      await run(fake);
      await sql("update crm.pipeline_stages set name = 'Qualified' where id = $1", [stage.Working]);
      await moveTo(id, "Proposal", 30);
      await run(fake);
      assert.deepEqual(fake.names(), ["Lead", "Working", "Proposal"]);
      const second = await scenario();
      const other = await opportunity({ companyId: second.companyId, contactId: second.contactId });
      await moveTo(other, "Working", 60);
      await run(fake);
      assert.deepEqual(fake.names().slice(3), ["Lead", "Qualified"]);
      await sql("update crm.pipeline_stages set name = 'Working' where id = $1", [stage.Working]);
    });
  });

  describe("the trail on a contact", () => {
    it("shows a member the stages with dates, and the lead's outcomes only to people in its workspace", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 60);
      await run(metaFake());
      const trails = await metaLeadTrails(member, [lead.leadId]);
      assert.deepEqual(
        trails[lead.leadId].map((step) => [step.name, step.state, Boolean(step.at)]),
        [
          ["Lead", "sent", true],
          ["Working", "sent", true],
          ["Proposal", "waiting", false],
          ["Won", "waiting", false],
        ],
      );
      assert.deepEqual(await metaLeadTrails(outsider, [lead.leadId]), {});
      const visible = await queryAsUser<{ stage_name: string }>(member.userId, "select stage_name from crm.meta_lead_outcomes where lead_id = $1 order by \"position\"", [lead.leadId]);
      assert.deepEqual(visible.map((row) => row.stage_name), ["Lead", "Working"]);
      assert.deepEqual(await queryAsUser(outsider.userId, "select 1 from crm.meta_lead_outcomes where lead_id = $1", [lead.leadId]), []);
      await assert.rejects(queryAsUser(member.userId, "select error from crm.meta_lead_outcomes"), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "select opportunity_id from crm.meta_lead_outcomes"), /permission denied/);
      assert.deepEqual(await queryAsUser(member.userId, "select id from crm.meta_leads"), []);
    });

    it("marks a pending stage with attempts as retrying and leaves failed and skipped stages grey", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Won", 60);
      const fake = metaFake({ reject: (event) => (event.event_name === "Proposal" ? { code: 100, message: "Bad." } : null) });
      await run(fake);
      await sql("update crm.meta_lead_outcomes set status = 'pending', attempts = 2 where lead_id = $1 and stage_name = 'Won'", [lead.leadId]);
      const steps = (await metaLeadTrails(member, [lead.leadId]))[lead.leadId];
      assert.deepEqual(steps.map((step) => [step.name, step.state]), [["Lead", "sent"], ["Working", "sent"], ["Proposal", "waiting"], ["Won", "retrying"]]);
      await sql("update crm.meta_lead_outcomes set status = 'skipped', attempts = 0 where lead_id = $1 and stage_name = 'Won'", [lead.leadId]);
      assert.equal((await metaLeadTrails(member, [lead.leadId]))[lead.leadId][3].state, "waiting");
    });

    it("shows a lost lead's trail as the stages it reached, then Lost, without the grey ones", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 120);
      await moveTo(id, "Lost", 60);
      await run(metaFake());
      const steps = (await metaLeadTrails(member, [lead.leadId]))[lead.leadId];
      assert.deepEqual(steps.map((step) => [step.name, step.state]), [["Lead", "sent"], ["Working", "sent"], ["Lost", "sent"]]);
    });

    it("keeps a renamed stage's sent name in the trail", async () => {
      const lead = await scenario();
      const id = await opportunity({ companyId: lead.companyId, contactId: lead.contactId });
      await moveTo(id, "Working", 60);
      await run(metaFake());
      await sql("update crm.pipeline_stages set name = 'Qualified' where id = $1", [stage.Working]);
      try {
        const steps = (await metaLeadTrails(member, [lead.leadId]))[lead.leadId];
        assert.deepEqual(steps.map((step) => step.name), ["Lead", "Working", "Proposal", "Won"]);
      } finally {
        await sql("update crm.pipeline_stages set name = 'Working' where id = $1", [stage.Working]);
      }
    });

    it("shows no trail for a lead when outcomes were never on", async () => {
      const lead = await scenario();
      await sql("update crm.meta_outcome_settings set enabled = false where workspace_id = $1", [owner.workspaceId]);
      assert.deepEqual(await metaLeadTrails(member, [lead.leadId]), {});
    });
  });
});
