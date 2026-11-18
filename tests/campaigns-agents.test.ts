import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GET as listCampaignsRoute } from "@/app/api/v1/campaigns/route";
import { GET as listProspectsRoute, POST as addProspectsRoute } from "@/app/api/v1/campaigns/[id]/prospects/route";
import { ALL_TOOLS_LOADED, companionTools } from "@/lib/assistant/chat";
import { coldEmailGuide } from "@/lib/assistant/guides";
import {
  ORBIT_TOOL_LIMIT,
  REQUEST_TOOL_LIMIT,
  TOOL_DOMAIN_NAMES,
  assistantTools,
  describeAction,
  domainTools,
  fittingDomains,
  toolDomainNames,
  type ToolDomain,
  recordNames,
  runTool,
  toolDefinitions,
} from "@/lib/assistant/tools";
import { NO_LIFT, replyInCampaign, runCampaignAction } from "@/lib/campaigns/agent";
import { saveCampaignConnection } from "@/lib/campaigns/connections";
import { KEY_ELSEWHERE, KEY_REUSED, repeatedNote, replyToProspect } from "@/lib/campaigns/replies";
import { handleCampaignEvents } from "@/lib/campaigns/events";
import { setDoNotContact } from "@/lib/campaigns/suppression";
import { syncCampaigns } from "@/lib/campaigns/sync";
import { SEVERAL_CAMPAIGNS } from "@/lib/crm/campaigns";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, UserActor } from "@/lib/crm/types";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { registerCampaignTools } from "@/server/mcp/campaigns";
import { createCrmMcpServer } from "@/server/mcp/server";
import { fakeHeyReach, fakeSmartlead, sequenceOf, type FakeAccount, type FakeHeyReachAccount } from "./campaigns-fake";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

const SL_A = "sl_key_agents_alpha_01";
const SL_B = "sl_key_agents_bravo_02";
const HR_A = "hr_key_agents_alpha_03";
const LIMITS = ["WORKFLOW_LIMIT_SMARTLEAD_PER_MINUTE", "WORKFLOW_LIMIT_SMARTLEAD_PER_HOUR", "WORKFLOW_LIMIT_SMARTLEAD_STATS_PER_MINUTE", "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE"];
const T0 = "2026-11-10T09:00:00.000Z";
const ORIGIN = "https://orbit.test";

let owner: UserActor;
let jess: UserActor;
let outsider: UserActor;
const people: Record<string, string> = {};
const saved: Record<string, string | undefined> = {};

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function campaignId(externalId: string) {
  return (await sql<{ id: string }>("select id from crm.campaigns where external_id = $1", [externalId]))[0].id;
}

async function prospectId(lead: string) {
  return (await sql<{ id: string }>("select id from crm.campaign_prospects where external_lead_id = $1", [lead]))[0].id;
}

function refused(code: string | string[], pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.ok((Array.isArray(code) ? code : [code]).includes(error.code), `${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

function toolError(result: unknown) {
  return result && typeof result === "object" && "error" in result ? String((result as { error: unknown }).error) : null;
}

async function mcpClient(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "campaigns-test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    async tools() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    async instructions() {
      return client.getInstructions() ?? "";
    },
    async call(name: string, args: Record<string, unknown>) {
      const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      const text = result.content.map((part) => part.text).join("");
      return { error: result.isError === true, text, json: result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function campaignMcp(actor: Actor, options: { canReply?: boolean; fetchImpl?: typeof fetch } = {}) {
  const server = new McpServer({ name: "crm", version: "1.0.0" });
  registerCampaignTools(server, actor, options);
  return mcpClient(server);
}

function api(token: string, url: string, init: RequestInit = {}) {
  return new Request(`${ORIGIN}/api/v1${url}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("campaigns for the assistant, MCP and the API", () => {
  const alpha: FakeAccount = {
    key: SL_A,
    client: { id: 1, name: "Eclipse" },
    campaigns: [
      {
        id: 801,
        name: "Agency outreach",
        status: "ACTIVE",
        leads: [{ id: "lead-nina", email: "nina@halcyon.test", first: "Nina", last: "Shah", company: "Halcyon Digital" }],
        stats: [{ lead_id: "lead-nina", lead_email: "nina@halcyon.test", lead_name: "Nina Shah", sequence_number: 1, sent_time: T0 }],
        sequences: sequenceOf([{ subject: "Quick question", body: "Hi {{first_name}}" }]),
        analytics: {},
        threads: {
          "lead-nina": [{ type: "SENT", stats_id: "stats-nina", message_id: "<sent-nina@getridgeon.test>", time: T0, subject: "Quick question", email_body: "<p>Hi Nina</p>", email_seq_number: 1, from: "mark@getridgeon.test" }],
        },
      },
    ],
    calls: [],
  };
  const bravo: FakeAccount = {
    key: SL_B,
    client: { id: 2, name: "Ridgeon" },
    campaigns: [
      {
        id: 811,
        name: "Elsewhere outreach",
        status: "ACTIVE",
        leads: [{ id: "lead-b-olu", email: "olu@elsewhere.test", first: "Olu", last: "Bray" }],
        stats: [{ lead_id: "lead-b-olu", lead_email: "olu@elsewhere.test", lead_name: "Olu Bray", sequence_number: 1, sent_time: T0 }],
        sequences: [],
        analytics: {},
      },
    ],
    calls: [],
  };
  const heyreach: FakeHeyReachAccount = {
    key: HR_A,
    accounts: [
      { id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "mark@agents.test", profileUrl: "https://www.linkedin.com/in/markridgeon" },
      { id: 2, firstName: "Jess", lastName: "Cole", emailAddress: "jess@agents.test", profileUrl: "https://www.linkedin.com/in/jesscole" },
    ],
    campaigns: [
      {
        id: 901,
        name: "Agency founders",
        status: "IN_PROGRESS",
        accountIds: [1, 2],
        sequence: [{ actionType: "ConnectionRequest", message: "{connection_note}" }],
        leads: [
          { id: "lead-hr-dan", profileUrl: "https://www.linkedin.com/in/danellis/", first: "Dan", last: "Ellis", accountId: 2, connection: "ConnectionAccepted", lastActionTime: "2026-11-11T16:40:00.000Z", created: "2026-11-01T09:00:00.000Z" },
        ],
        overall: {},
        byDay: {},
        conversations: [
          { id: "c-dan", accountId: 2, profileUrl: "https://www.linkedin.com/in/danellis/", leadId: "lead-hr-dan", messages: [{ createdAt: "2026-11-12T10:00:00.000Z", body: "Thanks for connecting, Dan.", sender: "ME" }] },
        ],
      },
    ],
    calls: [],
  };
  const smartleadFetch = fakeSmartlead([alpha, bravo]);
  const heyreachFetch = fakeHeyReach([heyreach]);
  const fetchImpl: typeof fetch = (input, init) => (String(input instanceof Request ? input.url : input).includes("heyreach") ? heyreachFetch(input, init) : smartleadFetch(input, init));
  const sync = (workspaceId: string) => syncCampaigns({ workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents: handleCampaignEvents });

  let email: string;
  let linkedin: string;
  let elsewhere: string;
  let dan: string;
  let nina: string;
  let agentToken: string;
  let readerToken: string;
  let outsiderToken: string;

  before(async () => {
    await resetDatabase();
    for (const name of LIMITS) {
      saved[name] = process.env[name];
      process.env[name] = "100000";
    }
    owner = await createUser("mark@agents.test", "Mark Ridgeon");
    const second = await createUser("jess@agents.test", "Jess Cole");
    outsider = await createUser("oscar@elsewhere-agents.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    jess = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    const make = async (actor: UserActor, key: string, input: Record<string, unknown>) => {
      people[key] = (await createContact(actor, input, { provenance: { operation: "test" } })).body.contact.id;
    };
    await make(owner, "dan", { firstName: "Dan", lastName: "Ellis", email: "dan@ellis.test", linkedinUrl: "https://www.linkedin.com/in/danellis" });
    await make(owner, "nina", { firstName: "Nina", lastName: "Shah", email: "nina@halcyon.test" });
    await make(owner, "rae", { firstName: "Rae", lastName: "Moss", email: "rae@moss.test", linkedinUrl: "https://www.linkedin.com/in/raemoss" });
    await make(owner, "tom", { firstName: "Tom", lastName: "Avery", email: "tom@avery.test", linkedinUrl: "https://www.linkedin.com/in/tomavery" });
    await make(owner, "una", { firstName: "Una", lastName: "Reed", email: "una@reed.test", linkedinUrl: "https://www.linkedin.com/in/unareed" });
    await make(outsider, "olu", { firstName: "Olu", lastName: "Bray", email: "olu@elsewhere.test" });
    await saveCampaignConnection(owner, "smartlead", SL_A, { fetchImpl });
    await saveCampaignConnection(owner, "heyreach", HR_A, { fetchImpl });
    await saveCampaignConnection(outsider, "smartlead", SL_B, { fetchImpl });
    await sync(owner.workspaceId);
    await sync(outsider.workspaceId);
    heyreach.campaigns[0].conversations![0].messages.push({ createdAt: "2026-11-13T10:00:00.000Z", body: "Interested. Can we talk Tuesday?", sender: "CORRESPONDENT" });
    await sync(owner.workspaceId);
    email = await campaignId("801");
    linkedin = await campaignId("901");
    elsewhere = await campaignId("811");
    dan = await prospectId("lead-hr-dan");
    nina = await prospectId("lead-nina");
    agentToken = (await createAgent(owner.workspaceId, ["crm:read", "campaigns:write"], "Prospector")).token;
    readerToken = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).token;
    outsiderToken = (await createAgent(outsider.workspaceId, ["crm:read", "campaigns:write", "admin"], "Elsewhere")).token;
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

  const pool = useServerlessPool();

  it("starts from synced campaigns with the LinkedIn accounts linked to their members", async () => {
    const senders = await sql<{ external_id: string; user_id: string | null }>("select external_id, user_id from crm.campaign_senders where workspace_id = $1 order by external_id", [owner.workspaceId]);
    assert.deepEqual(senders, [
      { external_id: "1", user_id: owner.userId },
      { external_id: "2", user_id: jess.userId },
    ]);
    assert.equal((await sql<{ contact_id: string }>("select contact_id from crm.campaign_prospects where id = $1", [dan]))[0].contact_id, people.dan);
  });

  describe("reads", () => {
    it("lists campaigns with a channel filter through the assistant, MCP and REST alike", async () => {
      const all = (await runTool(owner, "campaigns", { view: "list" })) as { campaigns: { name: string; channel: string }[] };
      assert.deepEqual(all.campaigns.map((item) => item.channel).sort(), ["email", "linkedin"]);
      const onlyLinkedin = (await runTool(owner, "campaigns", { view: "list", channel: "linkedin" })) as { campaigns: { id: string }[] };
      assert.deepEqual(onlyLinkedin.campaigns.map((item) => item.id), [linkedin]);

      const client = await campaignMcp(owner);
      try {
        const listed = await client.call("read_campaigns", { view: "list", channel: "email" });
        assert.deepEqual((listed.json!.campaigns as { id: string }[]).map((item) => item.id), [email]);
      } finally {
        await client.close();
      }

      const rest = await listCampaignsRoute(api(readerToken, "/campaigns?channel=linkedin"));
      assert.equal(rest.status, 200);
      assert.deepEqual(((await rest.json()) as { campaigns: { id: string }[] }).campaigns.map((item) => item.id), [linkedin]);
      const bad = await listCampaignsRoute(api(readerToken, "/campaigns?channel=fax"));
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { error: { code: string } }).error.code, "invalid_input");
    });

    it("reads one campaign, its prospects, a thread by contact and channel, and who accepted", async () => {
      const detail = (await runTool(owner, "campaigns", { view: "campaign", campaignId: linkedin })) as { campaign: { name: string; channel: string } };
      assert.equal(detail.campaign.name, "Agency founders");
      const page = (await runTool(owner, "campaigns", { view: "prospects", campaignId: email })) as { prospects: { rows: { name: string }[] } };
      assert.deepEqual(page.prospects.rows.map((row) => row.name), ["Nina Shah"]);
      const thread = (await runTool(owner, "campaigns", { view: "thread", contactId: people.dan, channel: "linkedin" })) as { thread: { prospectId: string; replyOptions: { channel: string; canReply: boolean; reason: string | null }[] } };
      assert.equal(thread.thread.prospectId, dan);
      assert.deepEqual(thread.thread.replyOptions.map((option) => [option.channel, option.canReply, option.reason]), [["linkedin", false, "Only Jess Cole can reply from this LinkedIn account."]]);
      const accepted = (await runTool(owner, "campaigns", { view: "activity", kinds: ["invite_accepted"], since: "2026-11-01" })) as { events: { name: string; kind: string }[] };
      assert.ok(accepted.events.length > 0);
      assert.ok(accepted.events.every((event) => event.kind === "invite_accepted" && event.name === "Dan Ellis"));
      const wrongKind = (await runTool(owner, "campaigns", { view: "activity", kinds: ["accepted"] })) as { error: string };
      assert.match(wrongKind.error, /Unknown event: accepted/);

      const rest = await listProspectsRoute(api(readerToken, `/campaigns/${email}/prospects?filter=all`), params(email));
      assert.equal(rest.status, 200);
      assert.deepEqual(((await rest.json()) as { rows: { name: string }[] }).rows.map((row) => row.name), ["Nina Shah"]);
    });
  });

  describe("nobody reads or acts on a campaign outside their workspace", () => {
    it("through the assistant", async () => {
      const listed = (await runTool(outsider, "campaigns", { view: "list" })) as { campaigns: { id: string }[] };
      assert.deepEqual(listed.campaigns.map((item) => item.id), [elsewhere]);
      for (const args of [
        { view: "campaign", campaignId: email },
        { view: "prospects", campaignId: linkedin },
        { view: "thread", prospectId: dan },
        { view: "thread", contactId: people.dan },
        { view: "activity", campaignId: linkedin },
      ]) {
        assert.match(toolError(await runTool(outsider, "campaigns", args)) ?? "", /not found|isn't in a campaign/i, JSON.stringify(args));
      }
      for (const args of [
        { action: "add", campaignId: email, contactIds: [people.olu] },
        { action: "pause", campaignId: email },
        { action: "remove", prospectId: nina },
        { action: "set_category", prospectId: nina, category: "Interested" },
        { action: "reply", prospectId: dan, text: "Hello" },
      ]) {
        assert.match(toolError(await runTool(outsider, "campaign_action", args)) ?? "", /not found/i, JSON.stringify(args));
      }
      const audits = await sql("select 1 from crm.audit_events where workspace_id = $1 and actor_user_id = $2", [owner.workspaceId, outsider.userId]);
      assert.equal(audits.length, 0);
      assert.equal((await sql("select 1 from crm.campaign_prospects where contact_id = $1 and workspace_id = $2", [people.olu, owner.workspaceId])).length, 0);
    });

    it("through MCP, for personal and workspace agent tokens", async () => {
      const agent = (await createAgent(outsider.workspaceId, ["crm:read", "campaigns:write"], "Elsewhere MCP")).actor;
      for (const actor of [outsider, agent] as Actor[]) {
        const client = await campaignMcp(actor, { canReply: actor.type === "user", fetchImpl });
        try {
          const listed = await client.call("read_campaigns", { view: "list" });
          assert.deepEqual((listed.json!.campaigns as { id: string }[]).map((item) => item.id), [elsewhere]);
          for (const args of [
            { view: "campaign", campaign_id: email },
            { view: "prospects", campaign_id: linkedin },
            { view: "thread", prospect_id: dan },
            { view: "activity", campaign_id: email },
          ]) {
            const read = await client.call("read_campaigns", args);
            assert.ok(read.error && /^not_found/.test(read.text), `${actor.type} ${JSON.stringify(args)}: ${read.text}`);
          }
          for (const args of [
            { action: "add", campaign_id: email, contact_ids: [people.olu] },
            { action: "resume", campaign_id: linkedin },
            { action: "remove", prospect_id: nina },
            { action: "set_category", prospect_id: nina, category: null },
          ]) {
            const acted = await client.call("campaign_action", args);
            assert.ok(acted.error && /^not_found/.test(acted.text), `${actor.type} ${JSON.stringify(args)}: ${acted.text}`);
          }
          if (actor.type === "user") {
            const reply = await client.call("campaign_reply", { prospect_id: nina, text: "Hello" });
            assert.ok(reply.error && /^not_found/.test(reply.text), reply.text);
          }
        } finally {
          await client.close();
        }
      }
    });

    it("through REST", async () => {
      const listed = await listCampaignsRoute(api(outsiderToken, "/campaigns"));
      assert.deepEqual(((await listed.json()) as { campaigns: { id: string }[] }).campaigns.map((item) => item.id), [elsewhere]);
      const read = await listProspectsRoute(api(outsiderToken, `/campaigns/${email}/prospects`), params(email));
      assert.equal(read.status, 404);
      const added = await addProspectsRoute(api(outsiderToken, `/campaigns/${linkedin}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.olu] }) }), params(linkedin));
      assert.equal(added.status, 404);
      const theirs = await addProspectsRoute(api(outsiderToken, `/campaigns/${elsewhere}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.dan] }) }), params(elsewhere));
      assert.equal(theirs.status, 200);
      const body = (await theirs.json()) as { added: number; missing: number };
      assert.deepEqual([body.added, body.missing], [0, 1]);
      assert.equal((await sql("select 1 from crm.campaign_prospects where contact_id = $1 and campaign_id = $2", [people.dan, elsewhere])).length, 0);
    });
  });

  describe("adding people", () => {
    it("adds through the assistant, MCP and REST with each route's provenance, and needs campaigns:write", async () => {
      const viaAssistant = (await runTool(owner, "campaign_action", { action: "add", campaignId: linkedin, contactIds: [people.rae] })) as { added: number; line: string };
      assert.equal(viaAssistant.added, 1);
      const client = await campaignMcp((await createAgent(owner.workspaceId, ["crm:read", "campaigns:write"], "MCP prospector")).actor);
      try {
        const viaMcp = await client.call("campaign_action", { action: "add", campaign_id: linkedin, contact_ids: [people.tom], provenanceSource: "research run" });
        assert.equal(viaMcp.json!.added, 1, viaMcp.text);
      } finally {
        await client.close();
      }
      const viaRest = await addProspectsRoute(
        api(agentToken, `/campaigns/${linkedin}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.una], provenance: { source: "daily run" } }) }),
        params(linkedin),
      );
      assert.equal(viaRest.status, 200);
      assert.equal(((await viaRest.json()) as { added: number }).added, 1);
      const audits = await sql<{ operation: string; source: string | null; actor_type: string; contact: string }>(
        `select operation, source, actor_type, changes->>'contactId' as contact from crm.audit_events
         where workspace_id = $1 and event_type = 'campaign.prospect_added' order by created_at`,
        [owner.workspaceId],
      );
      assert.deepEqual(
        audits.map((row) => [row.contact, row.operation, row.actor_type]),
        [
          [people.rae, "campaign_add", "user"],
          [people.tom, "campaign_add", "agent"],
          [people.una, "add_campaign_prospects", "agent"],
        ],
      );
      assert.equal(audits[1].source, "research run");
      assert.equal(audits[2].source, "daily run");

      const forbidden = await addProspectsRoute(api(readerToken, `/campaigns/${linkedin}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.nina] }) }), params(linkedin));
      assert.equal(forbidden.status, 403);
      const both = await addProspectsRoute(api(agentToken, `/campaigns/${linkedin}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.nina], companyIds: [people.nina] }) }), params(linkedin));
      assert.equal(both.status, 400);
    });

    it("replays an Idempotency-Key and refuses it for a different body", async () => {
      const send = (body: unknown) =>
        addProspectsRoute(api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": "add-once" } }), params(email));
      const first = await send({ contactIds: [people.tom] });
      const firstBody = await first.json();
      const again = await send({ contactIds: [people.tom] });
      assert.deepEqual(await again.json(), firstBody);
      assert.equal((firstBody as { added: number }).added, 1);
      const audits = await sql("select 1 from crm.audit_events where event_type = 'campaign.prospect_added' and changes->>'campaignId' = $1", [email]);
      assert.equal(audits.length, 1);
      const other = await send({ contactIds: [people.una] });
      assert.equal(other.status, 409);
      assert.equal(((await other.json()) as { error: { code: string } }).error.code, "idempotency_conflict");
    });

    it("shows the card for an add with the campaign and the people", async () => {
      const args = { action: "add", campaignId: email, contactIds: [people.rae, people.una] };
      const card = describeAction("campaign_action", args, await recordNames(owner, [args], ["campaign_action"]));
      assert.deepEqual(card, { title: "Add 2 people to Agency outreach", lines: ["Rae Moss", "Una Reed"] });
    });
  });

  describe("idempotency claims", () => {
    it("runs its migration twice", async () => {
      await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270212100000_idempotency_claims.sql", "utf8"));
      await applyMigrationSql(getAdminPool(), readFileSync("supabase/migrations/20270212100000_idempotency_claims.sql", "utf8"));
    });

    it("runs two concurrent identical requests once, and every replay gets the first run's answer", async () => {
      const send = () =>
        addProspectsRoute(
          api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [people.rae] }), headers: { "idempotency-key": "together" } }),
          params(email),
        );
      pool.allowNestedConnections();
      const [first, second] = await Promise.all([send(), send()]);
      const answers = [
        { status: first.status, body: (await first.json()) as Record<string, unknown> },
        { status: second.status, body: (await second.json()) as Record<string, unknown> },
      ];
      const done = answers.filter((answer) => answer.status === 200);
      assert.ok(done.length >= 1);
      assert.equal(done[0].body.added, 1);
      for (const answer of answers) {
        if (answer.status === 409) assert.equal((answer.body.error as { code: string }).code, "idempotency_in_progress");
        else assert.deepEqual(answer.body, done[0].body);
      }
      const later = await send();
      assert.equal(later.status, 200);
      assert.deepEqual(await later.json(), done[0].body);
      const audits = await sql("select 1 from crm.audit_events where event_type = 'campaign.prospect_added' and changes->>'campaignId' = $1 and changes->>'contactId' = $2", [email, people.rae]);
      assert.equal(audits.length, 1);
    });

    const claimSend = (key: string, contactId: string) =>
      addProspectsRoute(
        api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [contactId] }), headers: { "idempotency-key": key } }),
        params(email),
      );

    it("runs a failed request again at once with the same key and body", async () => {
      const vera = (await createContact(owner, { firstName: "Vera", lastName: "Lowe", email: "vera@lowe.test" }, { provenance: { operation: "test" } })).body.contact.id;
      await sql("update crm.campaigns set status = 'completed' where id = $1", [email]);
      try {
        const failedRun = await claimSend("fails-first", vera);
        assert.equal(failedRun.status, 409);
        assert.match(((await failedRun.json()) as { error: { message: string } }).error.message, /ended/);
      } finally {
        await sql("update crm.campaigns set status = 'active' where id = $1", [email]);
      }
      const retried = await claimSend("fails-first", vera);
      assert.equal(retried.status, 200);
      assert.equal(((await retried.json()) as { added: number }).added, 1);
    });

    it("lets exactly one of two simultaneous retries take over a claim left by a process that died", async () => {
      const wim = (await createContact(owner, { firstName: "Wim", lastName: "Holt", email: "wim@holt.test" }, { provenance: { operation: "test" } })).body.contact.id;
      await sql("update crm.campaigns set status = 'completed' where id = $1", [email]);
      try {
        assert.equal((await claimSend("died", wim)).status, 409);
      } finally {
        await sql("update crm.campaigns set status = 'active' where id = $1", [email]);
      }
      const stale = await sql<{ status_code: number }>("update crm.idempotency_keys set created_at = now() - interval '6 minutes' where idempotency_key = 'died' returning status_code");
      assert.deepEqual(stale.map((row) => row.status_code), [0]);
      pool.allowNestedConnections();
      const answers = await Promise.all([claimSend("died", wim), claimSend("died", wim)]);
      const bodies = await Promise.all(answers.map(async (answer) => ({ status: answer.status, body: (await answer.json()) as Record<string, unknown> })));
      const ran = bodies.filter((answer) => answer.status === 200);
      assert.ok(ran.length >= 1);
      for (const answer of bodies) {
        if (answer.status !== 200) assert.equal((answer.body.error as { code: string }).code, "idempotency_in_progress");
        else assert.deepEqual(answer.body, ran[0].body);
      }
      const audits = await sql("select 1 from crm.audit_events where event_type = 'campaign.prospect_added' and changes->>'contactId' = $1", [wim]);
      assert.equal(audits.length, 1);
      const stored = await sql<{ status_code: number }>("select status_code from crm.idempotency_keys where idempotency_key = 'died'");
      assert.deepEqual(stored.map((row) => row.status_code), [200]);
    });
  });

  describe("acting on a contact in several campaigns", () => {
    it("refuses pause, resume, remove and set_category by contactId alone, and names the campaign it acted on", async () => {
      const live = await sql<{ campaign_id: string }>("select campaign_id from crm.campaign_prospects where contact_id = $1 and stopped_at is null and state not in ('skipped', 'failed')", [people.tom]);
      assert.ok(live.length >= 2, "Tom is in both campaigns");
      const client = await campaignMcp(owner, { fetchImpl });
      try {
        for (const action of ["pause", "resume", "remove", "set_category"]) {
          const args = { action, contactId: people.tom, ...(action === "set_category" ? { category: "Interested" } : {}) };
          assert.equal(toolError(await runTool(owner, "campaign_action", args)), SEVERAL_CAMPAIGNS, action);
          const viaMcp = await client.call("campaign_action", { action, contact_id: people.tom, ...(action === "set_category" ? { category: "Interested" } : {}) });
          assert.equal(viaMcp.text, `conflict: ${SEVERAL_CAMPAIGNS}`, action);
        }
      } finally {
        await client.close();
      }
      for (const action of ["pause", "resume", "remove", "set_category"]) {
        const args = { action, contactId: people.tom, ...(action === "set_category" ? { category: "Interested" } : {}) };
        const card = describeAction("campaign_action", args, await recordNames(owner, [args], ["campaign_action"]));
        assert.ok(card.title.includes("Tom Avery"), card.title);
        assert.ok(!card.title.includes("can't find"), card.title);
        assert.ok(card.lines.includes(SEVERAL_CAMPAIGNS), `${action}: ${JSON.stringify(card)}`);
      }
      const act = (input: Record<string, unknown>) => runCampaignAction(owner, input, { provenance: { operation: "test" }, allowReply: false, fetchImpl }) as Promise<{ campaign: { id: string; name: string } }>;
      const chosen = await act({ action: "set_category", contactId: people.tom, campaignId: linkedin, category: "Interested" });
      assert.deepEqual(chosen.campaign, { id: linkedin, name: "Agency founders", channel: "linkedin" });
      const removed = await act({ action: "remove", contactId: people.tom, campaignId: email });
      assert.deepEqual([removed.campaign.id, removed.campaign.name], [email, "Agency outreach"]);
      const paused = await act({ action: "pause", campaignId: email });
      assert.deepEqual([paused.campaign.id, paused.campaign.name], [email, "Agency outreach"]);
      const resumed = await act({ action: "resume", campaignId: email });
      assert.equal(resumed.campaign.id, email);
      const thread = (await runTool(owner, "campaigns", { view: "thread", contactId: people.tom })) as { thread: { prospectId: string } };
      assert.ok(thread.thread.prospectId);
    });
  });

  describe("rules every route keeps", () => {
    it("refuses every change without campaigns:write", async () => {
      const reader = (await createAgent(owner.workspaceId, ["crm:read"], "Read only")).actor;
      const client = await campaignMcp(reader, { fetchImpl });
      try {
        for (const action of ["pause", "resume", "remove", "set_category"]) {
          const args = { action, prospectId: nina, ...(action === "set_category" ? { category: "Interested" } : {}) };
          await assert.rejects(runCampaignAction(reader, args, { provenance: { operation: "test" }, allowReply: false, fetchImpl }), refused("forbidden", /campaigns:write/), action);
          const viaMcp = await client.call("campaign_action", { action, prospect_id: nina, ...(action === "set_category" ? { category: "Interested" } : {}) });
          assert.match(viaMcp.text, /^forbidden: .*campaigns:write/, action);
        }
        const paused = await client.call("campaign_action", { action: "pause", campaign_id: email });
        assert.match(paused.text, /^forbidden: .*campaigns:write/);
      } finally {
        await client.close();
      }
      assert.equal((await sql("select 1 from crm.audit_events where actor_agent_id = $1", [reader.agentId])).length, 0);
    });

    it("never calls a provider to reply for a token without Can send messages", async () => {
      const sends = () => heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length + alpha.calls.filter((call) => /reply/i.test(call.pathname)).length;
      const before = sends();
      const client = await mcpClient(createCrmMcpServer(jess, { personal: { tokenId: "00000000-0000-4000-8000-000000000004", canSend: false } }));
      try {
        assert.ok(!(await client.tools()).includes("campaign_reply"));
        const direct = await client.call("campaign_reply", { prospect_id: dan, text: "Hello" });
        assert.ok(direct.error, direct.text);
        const viaAction = await client.call("campaign_action", { action: "reply", prospect_id: dan, text: "Hello" });
        assert.ok(viaAction.error, viaAction.text);
      } finally {
        await client.close();
      }
      assert.equal(sends(), before);
    });

    it("refuses more than 1,000 people on every route, by contact and by company", async () => {
      const many = Array.from({ length: 1001 }, () => crypto.randomUUID());
      assert.match(toolError(await runTool(owner, "campaign_action", { action: "add", campaignId: email, contactIds: many })) ?? "", /Add up to 1,000 people at a time/);
      const rest = await addProspectsRoute(api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: many }) }), params(email));
      assert.equal(rest.status, 400);
      const client = await campaignMcp(owner, { fetchImpl });
      try {
        const viaMcp = await client.call("campaign_action", { action: "add", campaign_id: email, contact_ids: many });
        assert.ok(viaMcp.error);
        const company = (await sql<{ id: string }>("insert into crm.companies (workspace_id, name, normalized_name) values ($1, 'Crowded Ltd', 'crowded ltd') returning id", [owner.workspaceId]))[0].id;
        await sql(
          `insert into crm.contacts (workspace_id, company_id, first_name, last_name, email)
           select $1, $2, 'Person', 'Number ' || n, 'person' || n || '@crowded.test' from generate_series(1, 1001) n`,
          [owner.workspaceId, company],
        );
        assert.match(toolError(await runTool(owner, "campaign_action", { action: "add", campaignId: email, companyIds: [company] })) ?? "", /Add up to 1,000 people at a time/);
        const byCompany = await client.call("campaign_action", { action: "add", campaign_id: email, company_ids: [company] });
        assert.equal(byCompany.text, "invalid_input: Add up to 1,000 people at a time.");
        const restCompany = await addProspectsRoute(api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify({ companyIds: [company] }) }), params(email));
        assert.equal(restCompany.status, 400);
        assert.equal((await sql("select 1 from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where c.company_id = $1", [company])).length, 0);
      } finally {
        await client.close();
      }
    });

    it("shows a card for every change", async () => {
      const card = async (args: Record<string, unknown>) => describeAction("campaign_action", args, await recordNames(owner, [args], ["campaign_action"]));
      assert.deepEqual(await card({ action: "pause", campaignId: email }), { title: "Pause Agency outreach", lines: [] });
      assert.deepEqual(await card({ action: "resume", campaignId: linkedin }), { title: "Resume Agency founders", lines: [] });
      assert.deepEqual(await card({ action: "pause", prospectId: nina }), { title: "Pause Nina Shah in Agency outreach", lines: [] });
      assert.deepEqual(await card({ action: "resume", contactId: people.nina, campaignId: email }), { title: "Resume Nina Shah in Agency outreach", lines: [] });
      assert.deepEqual(await card({ action: "remove", prospectId: dan }), { title: "Remove Dan Ellis from Agency founders", lines: [] });
      assert.deepEqual(await card({ action: "set_category", prospectId: nina, category: "Meeting booked" }), { title: "Set Nina Shah to Meeting booked", lines: ["In Agency outreach"] });
      assert.deepEqual(await card({ action: "set_category", prospectId: nina, category: null }), { title: "Clear Nina Shah's category", lines: ["In Agency outreach"] });
      assert.deepEqual(await card({ action: "reply", contactId: people.nina, channel: "email", text: "Thanks, Nina." }), { title: "Reply to Nina Shah", lines: ["In Agency outreach", "Thanks, Nina."] });
    });
  });

  describe("a workspace agent token never replies", () => {
    it("is never offered a reply tool, and the shared action and reply refuse it", async () => {
      const agent = await createAgent(owner.workspaceId, ["crm:read", "campaigns:write", "admin"], "Replier");
      const full = await mcpClient(createCrmMcpServer(agent.actor, { personal: { tokenId: "00000000-0000-4000-8000-000000000001", canSend: true } }));
      try {
        const names = await full.tools();
        assert.ok(names.includes("read_campaigns") && names.includes("campaign_action"));
        assert.ok(!names.includes("campaign_reply"));
        assert.match(await full.instructions(), /It never replies in campaigns/);
        const viaAction = await full.call("campaign_action", { action: "reply", prospect_id: dan });
        assert.ok(viaAction.error, viaAction.text);
      } finally {
        await full.close();
      }
      const direct = await campaignMcp(agent.actor, { canReply: true, fetchImpl });
      try {
        assert.ok(!(await direct.tools()).includes("campaign_reply"));
      } finally {
        await direct.close();
      }
      await assert.rejects(runCampaignAction(agent.actor, { action: "reply", prospectId: nina, text: "Hi" }, { provenance: { operation: "test" }, allowReply: true, fetchImpl }), refused("forbidden", /^Only a person can reply\.$/));
      await assert.rejects(replyInCampaign(agent.actor, { prospectId: dan, text: "Hi" }, { provenance: { operation: "test" }, fetchImpl }), refused("forbidden", /^Only a person can reply\.$/));
      const routes = sourceFiles(path.join(process.cwd(), "app", "api", "v1"));
      assert.ok(routes.length > 10);
      for (const file of routes) assert.doesNotMatch(readFileSync(file, "utf8"), /replyToProspect|replyInCampaign|campaign_reply/, file);
    });

    it("offers campaign_reply only to a personal token with Can send messages", async () => {
      const plain = await mcpClient(createCrmMcpServer(owner, { personal: { tokenId: "00000000-0000-4000-8000-000000000002", canSend: false } }));
      const sending = await mcpClient(createCrmMcpServer(owner, { personal: { tokenId: "00000000-0000-4000-8000-000000000003", canSend: true } }));
      const stdio = await mcpClient(createCrmMcpServer(owner));
      try {
        assert.ok(!(await plain.tools()).includes("campaign_reply"));
        assert.match(await plain.instructions(), /Can send messages in Settings › API tokens/);
        assert.ok((await sending.tools()).includes("campaign_reply"));
        assert.ok(!(await stdio.tools()).includes("campaign_reply"));
        assert.match(await sending.instructions(), /campaigns:write to add people to campaigns and change them/);
      } finally {
        await plain.close();
        await sending.close();
        await stdio.close();
      }
    });
  });

  describe("a LinkedIn reply from anyone but the sender's member is refused", () => {
    it("refuses the owner in the assistant and over MCP, and the card says why", async () => {
      const refusal = toolError(await runTool(owner, "campaign_action", { action: "reply", contactId: people.dan, channel: "linkedin", text: "Tuesday works." }));
      assert.equal(refusal, "Only Jess Cole can reply from this LinkedIn account.");
      const args = { action: "reply", contactId: people.dan, channel: "linkedin", text: "Tuesday works." };
      const card = describeAction("campaign_action", args, await recordNames(owner, [args], ["campaign_action"]));
      assert.deepEqual(card, { title: "Send on LinkedIn as Jess Cole", lines: ["To Dan Ellis", "Tuesday works.", "Only Jess Cole can reply from this LinkedIn account."] });
      const client = await campaignMcp(owner, { canReply: true, fetchImpl });
      try {
        const reply = await client.call("campaign_reply", { prospect_id: dan, text: "Tuesday works." });
        assert.ok(reply.error);
        assert.equal(reply.text, "forbidden: Only Jess Cole can reply from this LinkedIn account.");
      } finally {
        await client.close();
      }
      assert.equal((await sql("select 1 from crm.campaign_messages where prospect_id = $1 and direction = 'outbound' and sent_by_user_id is not null", [dan])).length, 0);
      assert.ok(!heyreach.calls.some((call) => call.path === "/inbox/SendMessage"));
    });

    it("sends for the member, as them, over MCP with their token", async () => {
      const client = await campaignMcp(jess, { canReply: true, fetchImpl });
      try {
        const reply = await client.call("campaign_reply", { contact_id: people.dan, channel: "linkedin", text: "Tuesday at 2pm works.", client_key: "mcp-jess-1" });
        assert.equal(reply.error, false, reply.text);
        assert.equal(reply.json!.channel, "linkedin");
        assert.equal(reply.json!.prospectId, dan);
        const again = await client.call("campaign_reply", { contact_id: people.dan, channel: "linkedin", text: "Tuesday at 2pm works.", client_key: "mcp-jess-1" });
        assert.equal(again.json!.repeated, true);
      } finally {
        await client.close();
      }
      assert.equal(heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length, 1);
      const audit = await sql<{ actor_user_id: string; operation: string }>("select actor_user_id, operation from crm.audit_events where event_type = 'campaign.reply_sent' and entity_id = $1", [dan]);
      assert.deepEqual(audit, [{ actor_user_id: jess.userId, operation: "campaign_reply" }]);
    });

    it("refuses a reused client_key with other text or on another thread, and never sends a keyless retry twice", async () => {
      const sent = () => heyreach.calls.filter((call) => call.path === "/inbox/SendMessage").length;
      const before = sent();
      const client = await campaignMcp(jess, { canReply: true, fetchImpl });
      try {
        const changed = await client.call("campaign_reply", { contact_id: people.dan, channel: "linkedin", text: "Wednesday instead.", client_key: "mcp-jess-1" });
        assert.equal(changed.text, `conflict: ${KEY_REUSED}`);
        const elsewhere = await client.call("campaign_reply", { prospect_id: nina, text: "Tuesday at 2pm works.", client_key: "mcp-jess-1" });
        assert.equal(elsewhere.text, `conflict: ${KEY_ELSEWHERE}`);
        assert.equal(sent(), before);
        const first = await client.call("campaign_reply", { prospect_id: dan, text: "See you then." });
        const retry = await client.call("campaign_reply", { prospect_id: dan, text: "See you then." });
        assert.equal(first.json!.repeated, false, first.text);
        assert.equal(retry.json!.repeated, true, retry.text);
        assert.match(String(retry.json!.note), /^Already sent (just now|\d+ minutes? ago), not sent again\.$/);
        assert.equal(first.json!.note, undefined);
        assert.equal(repeatedNote(new Date(Date.now() - 4 * 60_000)), "Already sent 4 minutes ago, not sent again.");
        assert.match(repeatedNote(new Date(), "unknown"), /may not have gone/);
        assert.equal(retry.json!.messageId, first.json!.messageId);
        assert.deepEqual(first.json!.campaign, { id: linkedin, name: "Agency founders", channel: "linkedin" });
        assert.equal(sent(), before + 1);
      } finally {
        await client.close();
      }
      await assert.rejects(replyToProspect(jess, dan, { text: "Another reply.", clientKey: "mcp-jess-1" }, { fetchImpl }), refused("conflict", /different reply/));
    });
  });

  describe("no route but the web app lifts Do not contact", () => {
    it("keeps Do not contact through every agent route, and no action lifts it", async () => {
      const kim = (await createContact(owner, { firstName: "Kim", lastName: "Osei", email: "kim@osei.test", linkedinUrl: "https://www.linkedin.com/in/kimosei" }, { provenance: { operation: "test" } })).body.contact.id;
      await setDoNotContact(owner, { contactId: kim }, { fetchImpl });
      const viaAssistant = (await runTool(owner, "campaign_action", { action: "add", campaignId: linkedin, contactIds: [kim] })) as { skipped: number; reasons: { reason: string }[] };
      assert.equal(viaAssistant.skipped, 1);
      assert.match(viaAssistant.reasons[0].reason, /Do not contact/);
      const viaRest = await addProspectsRoute(api(agentToken, `/campaigns/${email}/prospects`, { method: "POST", body: JSON.stringify({ contactIds: [kim] }) }), params(email));
      assert.match(JSON.stringify(await viaRest.json()), /Do not contact/);

      for (const action of ["lift_do_not_contact", "lift", "unsuppress"]) {
        assert.equal(toolError(await runTool(owner, "campaign_action", { action, contactId: kim })), NO_LIFT);
        await assert.rejects(runCampaignAction(owner, { action, contactId: kim }, { provenance: { operation: "test" }, allowReply: true }), refused("forbidden"));
      }
      const client = await campaignMcp(owner, { canReply: true, fetchImpl });
      try {
        const lifted = await client.call("campaign_action", { action: "lift_do_not_contact", contact_id: kim });
        assert.ok(lifted.error);
        assert.ok(!(await client.tools()).some((name) => /lift|suppress|contact/i.test(name)));
      } finally {
        await client.close();
      }
      const kept = await sql<{ kind: string }>("select kind from crm.suppressions where workspace_id = $1 and contact_id = $2 order by kind", [owner.workspaceId, kim]);
      assert.deepEqual(kept.map((row) => row.kind), ["email", "linkedin"]);
      assert.equal((await sql("select 1 from crm.audit_events where event_type = 'campaign.do_not_contact_lifted'")).length, 0);
    });

    it("calls liftDoNotContact only from the web app's server action", () => {
      const root = process.cwd();
      const files = ["app", "lib", "server", "components", "scripts", "companion"].flatMap((dir) => sourceFiles(path.join(root, dir)));
      const callers = files.filter((file) => /\bliftDoNotContact\s*\(/.test(readFileSync(file, "utf8"))).map((file) => path.relative(root, file)).sort();
      assert.deepEqual(callers, ["app/(crm)/campaigns/actions.ts", "lib/campaigns/suppression.ts"]);
      for (const dir of ["lib/assistant", "lib/campaigns/agent.ts", "server/mcp", "app/api", "lib/workflows"]) {
        const scoped = files.filter((file) => path.relative(root, file).startsWith(dir));
        assert.ok(scoped.length > 0, dir);
        for (const file of scoped) assert.doesNotMatch(readFileSync(file, "utf8"), /liftDoNotContact|suppression_lift|do_not_contact_lifted/, file);
      }
    });
  });

  describe("no request sends more than 128 tools", () => {
    const switches = [true, false].flatMap((multiWorkspace) => [true, false].flatMap((eclipse) => [true, false].map((linear) => ({ multiWorkspace, eclipse, linear }))));

    it("keeps every request within the limit, whatever a chat loads and in whatever order", () => {
      for (const options of switches) {
        const forward = toolDefinitions({ ...options, domains: TOOL_DOMAIN_NAMES });
        const backward = toolDefinitions({ ...options, domains: [...TOOL_DOMAIN_NAMES].reverse() });
        for (const sent of [forward, backward, toolDefinitions(options)]) {
          assert.ok(sent.length <= ORBIT_TOOL_LIMIT, `${JSON.stringify(options)}: ${sent.length}`);
          assert.ok(sent.length + 2 <= REQUEST_TOOL_LIMIT);
          assert.equal(new Set(sent.map((tool) => tool.function.name)).size, sent.length);
        }
        for (const webSearch of [true, false]) {
          const agent = companionTools(options, [], webSearch).tools;
          assert.ok(agent.length + (webSearch ? 1 : 0) <= REQUEST_TOOL_LIMIT, `Orbit Agent sends ${agent.length} and WebSearch`);
        }
      }
      assert.ok(toolDefinitions().length + 2 <= REQUEST_TOOL_LIMIT, "the probe adds its own tool and web_search");
    });

    const loadCalls = (domains: readonly string[]) => [
      { tool_calls: domains.map((domain, index) => ({ id: `load-${index}`, type: "function" as const, function: { name: "find_tools", arguments: JSON.stringify({ domains: [domain] }) } })) },
    ];

    it("sends or lets the model load every area offered, on every path", () => {
      const histories = [[], TOOL_DOMAIN_NAMES, [...TOOL_DOMAIN_NAMES].reverse(), ["chat"], ["workspace", "chat"]] as (readonly ToolDomain[])[];
      for (const options of switches) {
        const offered = toolDomainNames(options);
        const loadable = (names: string[], enumOf: string[]) => (domain: ToolDomain) =>
          domainTools(domain, options).every((name) => names.includes(name)) || (names.includes("find_tools") && enumOf.includes(domain));
        const findEnum = (tools: { name: string; parameters: unknown }[]) =>
          ((tools.find((tool) => tool.name === "find_tools")?.parameters as { properties?: { domains?: { items?: { enum?: string[] } } } } | undefined)?.properties?.domains?.items?.enum ?? []);
        for (const history of histories) {
          const chat = assistantTools({ ...options, domains: history, used: history });
          const chatNames = chat.map((tool) => tool.name);
          for (const domain of offered) assert.ok(loadable(chatNames, findEnum(chat))(domain), `chat ${JSON.stringify(options)} ${domain}`);
          for (const webSearch of [true, false]) {
            const agent = companionTools(options, loadCalls(history) as never, webSearch);
            const names = agent.tools.map((tool) => tool.name);
            assert.ok(names.length + (webSearch ? 1 : 0) <= REQUEST_TOOL_LIMIT, `${names.length} tools`);
            for (const domain of offered) {
              const sent = domainTools(domain, options).every((name) => names.includes(name));
              assert.ok(sent || (names.includes("find_tools") && findEnum(agent.tools as never).includes(domain) && agent.line.includes(domain)), `Orbit Agent ${JSON.stringify(options)} web ${webSearch}: ${domain}`);
            }
            if (agent.left.length === 0) {
              assert.ok(!names.includes("find_tools"));
              assert.equal(agent.line, ALL_TOOLS_LOADED);
            } else assert.match(agent.line, /call find_tools with it/);
          }
        }
      }
      const full = { multiWorkspace: true, eclipse: true, linear: true };
      assert.deepEqual(companionTools(full, [], false).left, []);
      assert.deepEqual(companionTools(full, [], true).left, ["chat", "workspace"]);
    });

    it("keeps check_web, social_lookup and remember when everything is loaded, in a chat and on Orbit Agent", () => {
      for (const options of switches) {
        for (const order of [TOOL_DOMAIN_NAMES, [...TOOL_DOMAIN_NAMES].reverse()]) {
          const chat = toolDefinitions({ ...options, domains: order, used: order }).map((tool) => tool.function.name);
          for (const webSearch of [true, false]) {
            const agent = companionTools(options, loadCalls(order) as never, webSearch).tools.map((tool) => tool.name);
            const untouched = companionTools(options, [], webSearch).tools.map((tool) => tool.name);
            for (const names of [chat, agent, untouched]) {
              assert.ok(names.includes("check_web") && names.includes("social_lookup"), JSON.stringify(options));
              assert.ok(names.includes("remember"), `remember: ${JSON.stringify(options)}`);
            }
          }
          assert.ok(chat.length <= ORBIT_TOOL_LIMIT);
        }
        const plain = toolDefinitions(options).map((tool) => tool.function.name);
        assert.ok(plain.includes("check_web") && plain.includes("remember"));
      }
    });

    it("drops the least recently used area in a chat, and the last unused one on Orbit Agent, never web or an area in use", async () => {
      const full = { multiWorkspace: true, eclipse: true, linear: true };
      assert.deepEqual(TOOL_DOMAIN_NAMES.slice(-3), ["web", "settings", "workspace"]);
      const untouched = fittingDomains(TOOL_DOMAIN_NAMES, full, []);
      assert.deepEqual(TOOL_DOMAIN_NAMES.filter((domain) => !untouched.includes(domain)), ["chat", "workspace"]);
      const oneWorkspace = fittingDomains(TOOL_DOMAIN_NAMES, { ...full, multiWorkspace: false }, []);
      assert.deepEqual(TOOL_DOMAIN_NAMES.filter((domain) => domain !== "workspace" && !oneWorkspace.includes(domain)), ["chat"]);
      const usedSettings = fittingDomains(TOOL_DOMAIN_NAMES, full, ["settings"]);
      assert.ok(usedSettings.includes("settings") && usedSettings.includes("web"));
      assert.deepEqual(TOOL_DOMAIN_NAMES.filter((domain) => !usedSettings.includes(domain)), ["chat", "workspace"]);
      const agentNames = companionTools(full, loadCalls(["settings"]) as never).tools.map((tool) => tool.name);
      assert.ok(agentNames.includes("remember") && agentNames.includes("check_web"));

      const webFirst = ["web", ...TOOL_DOMAIN_NAMES.filter((domain) => domain !== "web")] as typeof TOOL_DOMAIN_NAMES;
      const allUsed = fittingDomains(webFirst, full, webFirst);
      assert.deepEqual(webFirst.filter((domain) => !allUsed.includes(domain)), ["records"]);
      assert.ok(allUsed.includes("web") && allUsed.includes("settings"));
      const settingsOldest = ["settings", "web", ...TOOL_DOMAIN_NAMES.filter((domain) => domain !== "web" && domain !== "settings")] as typeof TOOL_DOMAIN_NAMES;
      const kept = fittingDomains(settingsOldest, full, settingsOldest);
      assert.ok(kept.includes("settings") && kept.includes("web"));
      assert.deepEqual(settingsOldest.filter((domain) => !kept.includes(domain)), ["records"]);

      const beforeCampaigns = TOOL_DOMAIN_NAMES.filter((domain) => domain !== "campaigns");
      const loaded = (await runTool(owner, "find_tools", { domains: ["campaigns"] }, { ...full, loaded: beforeCampaigns })) as {
        loaded: { domain: string }[];
        unloaded: string[];
        unloadedReason: string;
      };
      assert.deepEqual(loaded.loaded.map((item) => item.domain), ["campaigns"]);
      assert.deepEqual(loaded.unloaded, ["records"]);
      assert.match(loaded.unloadedReason, /used least recently/);
      const fresh = (await runTool(owner, "find_tools", { domains: ["campaigns", "web"] }, full)) as { loaded: { domain: string }[]; notLoaded?: string[]; unloaded?: string[] };
      assert.deepEqual(fresh.loaded.map((item) => item.domain), ["campaigns", "web"]);
      assert.equal(fresh.notLoaded, undefined);
      assert.equal(fresh.unloaded, undefined);
    });
  });

  describe("the cold_email guide", () => {
    it("routes a first email to a campaign only when Smartlead is connected, and offers LinkedIn without an email", async () => {
      assert.doesNotMatch(coldEmailGuide("Eclipse"), /campaign_action/);
      assert.match(coldEmailGuide("Eclipse", { email: true, linkedin: false }), /goes into an email campaign, never send_email/);
      assert.doesNotMatch(coldEmailGuide("Eclipse", { email: true, linkedin: false }), /LinkedIn campaign/);
      assert.match(coldEmailGuide("Eclipse", { email: false, linkedin: true }), /no email address, offer a LinkedIn campaign/);
      const live = (await runTool(owner, "guide", { topic: "cold_email" })) as { guide: string };
      assert.match(live.guide, /goes into an email campaign, never send_email/);
      assert.match(live.guide, /offer a LinkedIn campaign/);
      const none = (await runTool(jess, "guide", { topic: "cold_email" })) as { guide: string };
      assert.match(none.guide, /goes into an email campaign/);
      const unconnected = (await runTool(outsider, "guide", { topic: "cold_email" })) as { guide: string };
      assert.doesNotMatch(unconnected.guide, /LinkedIn campaign/);
      assert.ok(!/[‒–—―]/.test(coldEmailGuide("Eclipse", { email: true, linkedin: true })));
    });
  });
});
