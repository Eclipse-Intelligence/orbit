import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { campaignConnectionViews, keyFingerprint, KEY_TAKEN, removeCampaignConnection, saveCampaignConnection } from "@/lib/campaigns/connections";
import { campaignProvider, heyReachEvents } from "@/lib/campaigns/providers";
import { linkCampaignSender, listCampaignSenders, SENDER_LINKED } from "@/lib/campaigns/senders";
import { registeredWebhooks, syncCampaigns, type SyncedEvent } from "@/lib/campaigns/sync";
import { startCampaign } from "@/lib/campaigns/manage";
import { urlSecrets } from "@/lib/upstream";
import { getCampaign, importCampaignProspects, listCampaignProspects, listCampaigns } from "@/lib/crm/campaigns";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole, SCOPES } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { decryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { lastActionLine, linkedinStatus } from "@/lib/campaigns/format";
import type { ProspectRow } from "@/lib/campaigns/types";
import {
  campaignStatus,
  createHeyReachWebhook,
  HEYREACH_WEBHOOK_EVENTS,
  HeyReachError,
  heyReachSteps,
  listHeyReachAccounts,
  listHeyReachLeads,
  startHeyReachCampaign,
  stopHeyReachLead,
  validationDetail,
  variablesIn,
} from "@/lib/heyreach";
import { fakeHeyReach, HEYREACH_WEBHOOK_TYPES, type FakeHeyReachAccount, type FakeHeyReachCampaign, type FakeHeyReachLead } from "./campaigns-fake";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const KEY = "hr_key_eclipse_0001";
const OTHER_KEY = "hr_key_ridgeon_0002";
const LIMIT_ENV = "WORKFLOW_LIMIT_HEYREACH_PER_MINUTE";

let owner: UserActor;
let adminUser: UserActor;
let member: UserActor;
let jess: UserActor;
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

function daysAgo(days: number) {
  const date = new Date(Date.now() - days * 86_400_000);
  return `${date.toISOString().slice(0, 10)}T00:00:00Z`;
}

function bulkLeads(count: number): FakeHeyReachLead[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bulk-${index + 1}`,
    profileUrl: `https://www.linkedin.com/in/bulk-person-${index + 1}/`,
    first: `Bulk${index + 1}`,
    last: "Person",
    company: "Bulk Ltd",
    accountId: index % 2 === 0 ? 1 : 2,
    connection: "ConnectionSent",
    lastActionTime: "2026-11-09T10:00:00.000Z",
  }));
}

function foundersCampaign(): FakeHeyReachCampaign {
  return {
    id: 9001,
    name: "Agency founders",
    status: "IN_PROGRESS",
    accountIds: [1, 2],
    sequence: [
      { actionType: "ConnectionRequest", message: "{connection_note}" },
      { actionType: "Message", message: "Thanks for connecting, {first_name}. {opener}", delayInDays: 1 },
      { actionType: "Message", message: "{follow_up}", delayInDays: 5 },
    ],
    leads: [
      {
        id: "lead-jane",
        profileUrl: "https://www.linkedin.com/in/Jane-Doe/",
        first: "Jane",
        last: "Doe",
        company: "Acme",
        position: "Founder",
        accountId: 1,
        connection: "ConnectionAccepted",
        messages: 2,
        lastActionTime: "2026-11-12T09:00:00.000Z",
      },
      ...bulkLeads(129),
    ],
    overall: { connectionsSent: 130, connectionsAccepted: 1, messagesSent: 2, totalMessageReplies: 0 },
    byDay: { [daysAgo(3)]: { connectionsSent: 20, connectionsAccepted: 8, messagesSent: 5, totalMessageReplies: 1 } },
  };
}

function draftCampaign(): FakeHeyReachCampaign {
  return { id: 9002, name: "Draft outreach", status: "DRAFT", accountIds: [], sequence: [], leads: [], overall: {}, byDay: {} };
}

function heyReachAccount(key: string, campaigns: FakeHeyReachCampaign[], accounts: FakeHeyReachAccount["accounts"]): FakeHeyReachAccount {
  return { key, accounts, campaigns, calls: [] };
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

async function senderAudits(workspaceId: string) {
  return sql<{ entity_id: string; actor_user_id: string | null; operation: string; changes: { linked: string | null; unlinked: string | null; sender: { name: string } } }>(
    "select entity_id, actor_user_id, operation, changes from crm.audit_events where workspace_id = $1 and event_type = $2 order by created_at, id",
    [workspaceId, SENDER_LINKED],
  );
}

describe("campaigns through HeyReach", () => {
  const eclipse = heyReachAccount(KEY, [foundersCampaign(), draftCampaign()], [
    { id: 1, firstName: "Mark", lastName: "Ridgeon", emailAddress: "Mark@HeyReach-Campaigns.test", profileUrl: "https://www.linkedin.com/in/markridgeon", connectionRequestsDailyLimit: 20 },
    { id: 2, firstName: "Jess", lastName: "Cole", emailAddress: "jess@heyreach-campaigns.test", profileUrl: "https://www.linkedin.com/in/jesscole", connectionRequestsDailyLimit: 20 },
    { id: 3, firstName: "Shared", lastName: "Inbox", emailAddress: "shared@heyreach-campaigns.test", profileUrl: "https://www.linkedin.com/in/sharedinbox" },
    { id: 4, firstName: "Nobody", lastName: "Here", emailAddress: null, profileUrl: "https://www.linkedin.com/in/nobodyhere" },
  ]);
  const ridgeon = heyReachAccount(OTHER_KEY, [{ ...draftCampaign(), id: 7001, name: "Ridgeon LinkedIn", status: "PAUSED" }], [
    { id: 50, firstName: "Oscar", lastName: "Outsider", emailAddress: "oscar@elsewhere-heyreach.test", profileUrl: "https://www.linkedin.com/in/oscar" },
  ]);
  const fetchImpl = fakeHeyReach([eclipse, ridgeon]);

  before(async () => {
    await resetDatabase();
    savedLimit = process.env[LIMIT_ENV];
    process.env[LIMIT_ENV] = "100000";
    owner = await createUser("mark@heyreach-campaigns.test", "Mark Ridgeon");
    const second = await createUser("ann@heyreach-campaigns.test", "Ann Admin");
    const third = await createUser("mo@heyreach-campaigns.test", "Mo Member");
    const fourth = await createUser("jess@heyreach-campaigns.test", "Jess Cole");
    outsider = await createUser("oscar@elsewhere-heyreach.test", "Oscar Outsider");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')", [
      owner.workspaceId,
      second.userId,
      third.userId,
      fourth.userId,
    ]);
    await sql("update crm.profiles set email = 'shared@heyreach-campaigns.test' where id = any($1::uuid[])", [[second.userId, third.userId]]);
    adminUser = { ...second, workspaceId: owner.workspaceId, role: "admin", scopes: scopesForRole("admin") };
    member = { ...third, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    jess = { ...fourth, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
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

  describe("the parser", () => {
    it("reads statuses, single-brace variables and lead events", async () => {
      assert.equal(campaignStatus("IN_PROGRESS"), "active");
      assert.equal(campaignStatus("SCHEDULED"), "drafted");
      assert.equal(campaignStatus("FINISHED"), "completed");
      assert.equal(campaignStatus("FAILED"), "stopped");
      assert.deepEqual(variablesIn([{ step: 1, variant: null, subject: "Message", body: "Hi {first_name}, {{not_this}} { opener }", delayDays: null }]), ["first_name", "opener"]);
      const page = await listHeyReachLeads(KEY, "9001", 0, { fetchImpl, workspaceId: "parser-test" });
      assert.equal(page.leads.length, 100);
      assert.equal(page.next, 100);
      const events = heyReachEvents("9001", page.leads.slice(0, 1));
      assert.deepEqual(
        events.map((event) => [event.kind, event.step, event.dedupeKey, event.linkedin]),
        [
          ["invite_sent", null, "heyreach:9001:lead-jane:invite_sent", "linkedin.com/in/jane-doe"],
          ["invite_accepted", null, "heyreach:9001:lead-jane:invite_accepted", "linkedin.com/in/jane-doe"],
          ["message_sent", 1, "heyreach:9001:lead-jane:message_sent:1", "linkedin.com/in/jane-doe"],
          ["message_sent", 2, "heyreach:9001:lead-jane:message_sent:2", "linkedin.com/in/jane-doe"],
        ],
      );
      eclipse.calls.length = 0;
    });
  });

  describe("the documented requests", () => {
    const recorder = (respond: (path: string, body: unknown) => Response) => {
      const calls: { method: string; path: string; query: string; body: unknown }[] = [];
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.search, body });
        return respond(url.pathname, body);
      };
      return { calls, impl };
    };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("lists the steps of the collection's GetCampaignSequence example, following the longest branch", async () => {
      const example = {
        nodeType: "CONNECTION_REQUEST",
        actionDelay: 0,
        actionDelayUnit: "DAY",
        payload: { messages: ["Hi {FIRST_NAME}, I'd love to connect!"], fallbackMessage: "Hi there, I'd love to connect!", toBeWithdrawnAfterDays: 30 },
        conditionalNode: {
          nodeType: "MESSAGE",
          actionDelay: 2,
          actionDelayUnit: "DAY",
          payload: { messages: ["Thanks for connecting, {FIRST_NAME}!"], fallbackMessage: "Thanks for connecting!" },
          unconditionalNode: { nodeType: "END", actionDelay: 3, actionDelayUnit: "HOUR" },
        },
        unconditionalNode: { nodeType: "END", actionDelay: 3, actionDelayUnit: "HOUR" },
      };
      assert.deepEqual(heyReachSteps(example), [
        { step: 1, variant: null, subject: "Invite", body: "Hi {FIRST_NAME}, I'd love to connect!", delayDays: 0 },
        { step: 2, variant: null, subject: "Message", body: "Thanks for connecting, {FIRST_NAME}!", delayDays: 2 },
      ]);
      const checked = {
        nodeType: "VIEW_PROFILE",
        actionDelay: 0,
        actionDelayUnit: "DAY",
        unconditionalNode: {
          nodeType: "CHECK_IS_CONNECTION",
          actionDelay: 3,
          actionDelayUnit: "HOUR",
          conditionalNode: { nodeType: "MESSAGE", actionDelay: 1, actionDelayUnit: "DAY", payload: { messages: ["Hello again"] }, unconditionalNode: { nodeType: "END" } },
          unconditionalNode: { ...example, actionDelay: 1 },
        },
      };
      assert.deepEqual(
        heyReachSteps(checked).map((step) => [step.step, step.subject, step.delayDays]),
        [
          [1, "View profile", 0],
          [2, "Invite", 1],
          [3, "Message", 2],
        ],
      );
      assert.deepEqual(heyReachSteps(null), [], "an empty 200 means no sequence");
    });

    it("reads the collection's GetLeadsFromCampaign example, with the sender and last action", async () => {
      const { calls, impl } = recorder(() =>
        reply({
          totalCount: 152,
          items: [
            {
              id: 62658,
              linkedInUserProfileId: "AC9sANasasasX0Ia-q6DQxyS35UD7a8716G5c8",
              linkedInUserProfile: {
                linkedin_id: "58344979",
                profileUrl: "https://www.linkedin.com/in/johndoe",
                firstName: "John",
                lastName: "Doe",
                headline: "Communications and Marketing Professional",
                companyName: "ACME",
                companyUrl: null,
                position: "",
                emailAddress: null,
              },
              lastActionTime: "2024-10-01T03:28:22.414791Z",
              failedTime: null,
              creationTime: "2024-09-30T21:28:06.933349Z",
              leadCampaignStatus: "Finished",
              leadConnectionStatus: "None",
              leadMessageStatus: "None",
              errorCode: null,
              leadCampaignStatusMessage: null,
              linkedInSenderId: 1108,
              linkedInSenderFullName: "Jane Doe",
            },
          ],
        }),
      );
      const page = await listHeyReachLeads("key", "1805", 0, { fetchImpl: impl, since: "2024-10-06T15:34:00.000Z", now: new Date("2024-10-07T15:36:00.000Z") });
      assert.deepEqual(calls[0], {
        method: "POST",
        path: "/api/public/campaign/GetLeadsFromCampaign",
        query: "",
        body: { campaignId: 1805, offset: 0, limit: 100, timeFrom: "2024-10-06T15:34:00.000Z", timeTo: "2024-10-07T15:36:00.000Z", timeFilter: "LastActionTakenOrFailedTime" },
      });
      const lead = page.leads[0];
      assert.equal(lead.id, "62658");
      assert.equal(lead.state, "finished");
      assert.equal(lead.status, "completed");
      assert.equal(lead.connection, "none");
      assert.equal(lead.messaging, "none");
      assert.equal(lead.lastActionAt, "2024-10-01T03:28:22.414Z");
      assert.equal(lead.senderName, "Jane Doe");
      assert.equal(lead.accountId, "1108");
      assert.equal(lead.title, "Communications and Marketing Professional");
      assert.equal(lead.invitedAt, null);
      assert.equal(page.next, null);
    });

    it("reads sender limits from accountLimits on li_account/GetAll", async () => {
      const { calls, impl } = recorder(() =>
        reply({
          totalCount: 1,
          items: [
            {
              id: 113298,
              emailAddress: "mark@accounts.test",
              firstName: "Mark",
              lastName: "Ridgeon",
              isActive: true,
              profileUrl: "https://www.linkedin.com/in/markridgeon",
              accountLimits: { messageLimit: 80, connectioRequestLimit: 25, followLimit: 30 },
            },
          ],
        }),
      );
      const accounts = await listHeyReachAccounts("key", { fetchImpl: impl });
      assert.deepEqual(calls[0].body, { offset: 0, limit: 100 });
      assert.deepEqual(accounts, [{ id: "113298", name: "Mark Ridgeon", email: "mark@accounts.test", profileUrl: "https://www.linkedin.com/in/markridgeon", inviteLimit: 25, messageLimit: 80 }]);
    });

    it("stops a lead by profile URL, since leadMemberId is the LinkedIn id Orbit doesn't keep", async () => {
      const { calls, impl } = recorder(() => new Response(null, { status: 200 }));
      await stopHeyReachLead("key", "123", "https://www.linkedin.com/in/john-doe", { fetchImpl: impl });
      assert.deepEqual(calls, [{ method: "POST", path: "/api/public/campaign/StopLeadInCampaign", query: "", body: { campaignId: 123, leadMemberId: null, leadUrl: "https://www.linkedin.com/in/john-doe" } }]);
    });

    it("sends CreateWebhook exactly as documented and logs HeyReach's validation errors", async () => {
      assert.ok(HEYREACH_WEBHOOK_EVENTS.every((event) => HEYREACH_WEBHOOK_TYPES.includes(event)), "every event Orbit registers is a documented eventType");
      const { calls, impl } = recorder((_path, body) => {
        const row = body as Record<string, unknown>;
        if (row.eventType === "VIEWED_PROFILE") {
          return reply({ type: "https://tools.ietf.org/html/rfc9110#section-15.5.1", title: "One or more validation errors occurred.", status: 400, errors: { "$.eventType": ["The JSON value could not be converted to WebhookEventType."] } }, 400);
        }
        return reply({ id: 98 });
      });
      const url = "https://orbit.test/api/webhooks/heyreach?w=workspace&secret=s3cret-value";
      assert.equal(await createHeyReachWebhook("key", "744784", url, { fetchImpl: impl, eventType: "CONNECTION_REQUEST_SENT" }), "98");
      assert.deepEqual(calls[0], {
        method: "POST",
        path: "/api/public/webhooks/CreateWebhook",
        query: "",
        body: { webhookName: "Orbit connection request sent 744784", webhookUrl: url, eventType: "CONNECTION_REQUEST_SENT", campaignIds: [744784] },
      });
      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        await assert.rejects(createHeyReachWebhook("key", "744784", url, { fetchImpl: impl, eventType: "VIEWED_PROFILE" }), (error: unknown) => {
          assert.ok(error instanceof HeyReachError);
          assert.equal(error.message, "HeyReach returned an error (400) on CreateWebhook: One or more validation errors occurred: $.eventType: The JSON value could not be converted to WebhookEventType.");
          return true;
        });
      } finally {
        console.error = original;
      }
      assert.deepEqual(logged, [["HeyReach request failed", 400, "/webhooks/CreateWebhook", "One or more validation errors occurred. Fields $.eventType: The JSON value could not be converted to WebhookEventType."]]);
      assert.ok(!JSON.stringify(logged).includes("s3cret-value"));
    });

    it("logs every field HeyReach names on a 400, without keys, addresses or the webhook secret", () => {
      const url = "https://orbit.test/api/webhooks/heyreach?w=workspace&secret=s3cret-value";
      const body = JSON.stringify({
        title: "One or more validation errors occurred.",
        status: 400,
        errors: {
          webhookName: ["A webhook with this name already exists."],
          webhookUrl: [`The url ${url} is taken by mark@eclipse.test.`],
          "$.campaignIds[0]": ["The JSON value could not be converted to System.Int64."],
          eventType: ["Not a valid key hr_key_eclipse_0001."],
        },
      });
      const detail = validationDetail(body, [KEY, ...urlSecrets(url)]) ?? "";
      for (const field of ["webhookName: A webhook with this name already exists.", "webhookUrl:", "$.campaignIds[0]: The JSON value could not be converted to System.Int64.", "eventType:"]) {
        assert.ok(detail.includes(field), `${field} in ${detail}`);
      }
      for (const secret of ["s3cret-value", KEY, "mark@eclipse.test", "orbit.test"]) assert.ok(!detail.includes(secret), `${secret} in ${detail}`);
      assert.equal(validationDetail(JSON.stringify({ errorMessage: "Campaign not found" }), []), null);
    });

    it("names each webhook after its event and campaign, and finds one HeyReach added without an id", async () => {
      const url = "https://orbit.test/api/webhooks/heyreach?w=workspace&secret=s3cret-value";
      const listed = { totalCount: 2, items: [
        { id: 123, webhookName: "Other tool", webhookUrl: "https://elsewhere.test/hook", eventType: "MESSAGE_SENT", campaignIds: [744784], isActive: true },
        { id: 124, webhookName: "Orbit message sent 744784", webhookUrl: url, eventType: "MESSAGE_SENT", campaignIds: [744784], isActive: true },
      ] };
      const { calls, impl } = recorder((path) => (path.endsWith("/GetAllWebhooks") ? reply(listed) : new Response(null, { status: 200 })));
      const provider = campaignProvider("heyreach")!;
      const context = { key: KEY, workspaceId: "webhook-test", fetchImpl: impl };
      assert.equal(await provider.registerWebhook(context, "744784", url, "MESSAGE_SENT"), "124");
      assert.deepEqual(calls.map((call) => [call.method, call.path, call.body]), [
        ["POST", "/api/public/webhooks/CreateWebhook", { webhookName: "Orbit message sent 744784", webhookUrl: url, eventType: "MESSAGE_SENT", campaignIds: [744784] }],
        ["POST", "/api/public/webhooks/GetAllWebhooks", { offset: 0, limit: 100, includeCustomHeaders: false }],
      ]);
      await assert.rejects(provider.registerWebhook(context, "744784", url, "FOLLOW_SENT"), /without saying its id/);
      assert.deepEqual(await provider.findWebhooks!(context, "744784", url, ["MESSAGE_SENT", "FOLLOW_SENT"]), { MESSAGE_SENT: "124" });
      assert.deepEqual(await provider.findWebhooks!(context, "9001", url, ["MESSAGE_SENT"]), {});
    });

    it("starts a campaign with StartCampaign and its id in the query", async () => {
      const { calls, impl } = recorder(() => new Response(null, { status: 200 }));
      await startHeyReachCampaign(KEY, "744784", { fetchImpl: impl });
      assert.deepEqual(calls, [{ method: "POST", path: "/api/public/campaign/StartCampaign", query: "?campaignId=744784", body: null }]);
    });

    it("counts only a webhook id HeyReach returned, not the placeholder older builds saved", () => {
      const heyreach = campaignProvider("heyreach")!;
      assert.deepEqual(registeredWebhooks(heyreach, { webhookId: "registered" }), []);
      assert.deepEqual(registeredWebhooks(heyreach, { webhookId: "55" }), [HEYREACH_WEBHOOK_EVENTS[0]]);
      assert.deepEqual(registeredWebhooks(campaignProvider("smartlead")!, { webhookId: "registered" }).length, 1);
    });

    it("words the status and last action like HeyReach", () => {
      const now = Date.parse("2026-11-18T19:00:00.000Z");
      const base: ProspectRow = {
        id: "p",
        contactId: null,
        companyId: null,
        name: "Ann",
        companyName: null,
        email: null,
        state: "pushed",
        skipReason: null,
        leadStatus: null,
        category: null,
        repliedAt: null,
        stopRequestedAt: null,
        stoppedAt: null,
        lastEvent: null,
        stage: null,
        sender: null,
        importError: null,
      };
      assert.equal(linkedinStatus(base), "Not enrolled yet");
      assert.equal(linkedinStatus({ ...base, leadStatus: "not_started", providerStatus: "pending" }), "Pending");
      assert.equal(linkedinStatus({ ...base, leadStatus: "not_started" }), "Pending");
      assert.equal(linkedinStatus({ ...base, leadStatus: "in_progress", providerStatus: "in_sequence" }), "In progress");
      assert.equal(linkedinStatus({ ...base, leadStatus: "stopped", providerStatus: "excluded" }), "Excluded");
      assert.equal(linkedinStatus({ ...base, leadStatus: "stopped", providerStatus: "failed" }), "Failed");
      assert.equal(linkedinStatus({ ...base, leadStatus: "completed" }), "Finished");
      assert.equal(lastActionLine(base, now), null);
      const viewed = { ...base, lastEvent: { kind: "profile_viewed" as const, step: null, at: "2026-11-18T18:30:00.000Z" }, lastActionAt: "2026-11-18T18:30:20.000Z" };
      assert.equal(lastActionLine(viewed, now), "Viewed profile, 30 minutes ago");
      assert.equal(lastActionLine({ ...viewed, lastActionAt: "2026-11-18T18:55:00.000Z" }, now), "Last action, 5 minutes ago", "a later action HeyReach didn't name isn't given an older action's name");
      assert.equal(lastActionLine({ ...viewed, repliedAt: "2026-11-18T16:00:00.000Z" }, now), "Viewed profile, 30 minutes ago");
      assert.equal(lastActionLine({ ...base, lastEvent: { kind: "invite_sent", step: null, at: "2026-11-16T18:00:00.000Z" } }, now), "Sent connection request, 2 days ago");
      assert.equal(lastActionLine({ ...base, lastEvent: { kind: "added", step: null, at: "2026-11-16T18:00:00.000Z" } }, now), null, "Orbit's own push isn't a HeyReach action");
    });
  });

  describe("connecting HeyReach", () => {
    it("refuses a key HeyReach rejects", async () => {
      await assert.rejects(saveCampaignConnection(owner, "heyreach", "hr_wrong_key_1", { fetchImpl }), refused("invalid_input", /^HeyReach rejected the key\.$/));
      assert.equal((await sql("select 1 from crm.campaign_connections")).length, 0);
      assert.equal((await sql("select 1 from crm.campaign_senders")).length, 0);
    });

    it("lets only owners and admins save a key", async () => {
      await assert.rejects(saveCampaignConnection(member, "heyreach", KEY, { fetchImpl }), refused("forbidden", /owner or admin/));
      const agent = (await createAgent(owner.workspaceId, [...SCOPES], "Admin agent")).actor;
      await assert.rejects(saveCampaignConnection(agent, "heyreach", KEY, { fetchImpl }), refused("forbidden"));
    });

    it("checks the key with the header, stores it encrypted and lists the senders", async () => {
      const saved = await saveCampaignConnection(adminUser, "heyreach", KEY, { fetchImpl });
      assert.equal(saved.line, "Connected. 4 LinkedIn accounts, 2 campaigns.");
      assert.ok(eclipse.calls.some((call) => call.path === "/auth/CheckApiKey"));
      const rows = await sql<{ key_encrypted: string; key_fingerprint: string; connected_by: string }>(
        "select key_encrypted, key_fingerprint, connected_by from crm.campaign_connections where workspace_id = $1 and provider = 'heyreach'",
        [owner.workspaceId],
      );
      assert.equal(rows.length, 1);
      assert.ok(!rows[0].key_encrypted.includes(KEY));
      assert.equal(decryptSecret(rows[0].key_encrypted), KEY);
      assert.equal(rows[0].key_fingerprint, keyFingerprint("heyreach", KEY));
      assert.equal(rows[0].connected_by, adminUser.userId);
    });

    it("matches senders to members by sign-in email, and leaves no match or two matches unlinked", async () => {
      const view = await listCampaignSenders(member);
      const byName = Object.fromEntries(view.senders.map((sender) => [sender.name, sender]));
      assert.equal(byName["Mark Ridgeon"].userId, owner.userId);
      assert.equal(byName["Jess Cole"].userId, jess.userId);
      assert.equal(byName["Shared Inbox"].userId, null);
      assert.equal(byName["Nobody Here"].userId, null);
      assert.equal(byName["Mark Ridgeon"].linkedin, "linkedin.com/in/markridgeon");
      assert.equal(byName["Mark Ridgeon"].inviteLimit, 20);
      assert.equal(view.canAdmin, false);
      const audits = await senderAudits(owner.workspaceId);
      assert.deepEqual(audits.map((row) => [row.changes.sender.name, row.changes.linked, row.changes.unlinked, row.actor_user_id]).sort(), [
        ["Jess Cole", jess.userId, null, adminUser.userId],
        ["Mark Ridgeon", owner.userId, null, adminUser.userId],
      ]);
    });

    it("keeps links made by hand when the senders are read again", async () => {
      const shared = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Shared Inbox")!;
      await linkCampaignSender(owner, shared.id, member.userId);
      await saveCampaignConnection(owner, "heyreach", KEY, { fetchImpl });
      const again = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Shared Inbox")!;
      assert.equal(again.userId, member.userId);
      await linkCampaignSender(owner, shared.id, null);
      await sql("delete from crm.notifications where workspace_id = $1", [owner.workspaceId]);
    });

    it("refuses a key already connected to another workspace", async () => {
      await assert.rejects(saveCampaignConnection(outsider, "heyreach", KEY, { fetchImpl }), refused("conflict", new RegExp(`^${KEY_TAKEN}$`)));
      await assert.rejects(
        sql("insert into crm.campaign_connections (workspace_id, provider, key_encrypted, key_fingerprint) values ($1, 'heyreach', 'x', $2)", [
          outsider.workspaceId,
          keyFingerprint("heyreach", KEY),
        ]),
        /campaign_connections_fingerprint_uidx/,
      );
      assert.equal((await sql("select 1 from crm.campaign_senders where workspace_id = $1", [outsider.workspaceId])).length, 0);
    });

    it("shows the card's senders and the key hint only to owners and admins", async () => {
      const views = await campaignConnectionViews(member);
      const heyreach = views.find((view) => view.provider === "heyreach")!;
      assert.equal(heyreach.connected, true);
      assert.equal(heyreach.line, "Connected. 4 LinkedIn accounts, 2 campaigns.");
      assert.equal(heyreach.keyHint, null);
      assert.equal(heyreach.senders?.senders.length, 4);
      assert.ok(heyreach.senders?.members.some((item) => item.userId === jess.userId));
      const ownerView = (await campaignConnectionViews(owner)).find((view) => view.provider === "heyreach")!;
      assert.equal(ownerView.keyHint, KEY.slice(-4));
      assert.equal(ownerView.senders?.canAdmin, true);
    });
  });

  describe("linking senders", () => {
    it("lets owners and admins change a link, audits it and tells both members", async () => {
      const jessSender = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Jess Cole")!;
      const before = (await senderAudits(owner.workspaceId)).length;
      const saved = await linkCampaignSender(adminUser, jessSender.id, member.userId);
      assert.equal(saved.userId, member.userId);
      const audits = await senderAudits(owner.workspaceId);
      assert.equal(audits.length, before + 1);
      const last = audits[audits.length - 1];
      assert.equal(last.actor_user_id, adminUser.userId);
      assert.equal(last.changes.linked, member.userId);
      assert.equal(last.changes.unlinked, jess.userId);
      const told = await sql<{ user_id: string; title: string }>("select user_id, title from crm.notifications where workspace_id = $1 order by title", [owner.workspaceId]);
      assert.deepEqual(told.map((row) => [row.user_id, row.title]), [
        [member.userId, "Linked to Jess Cole on LinkedIn"],
        [jess.userId, "Unlinked from Jess Cole on LinkedIn"],
      ]);

      await linkCampaignSender(owner, jessSender.id, jess.userId);
      assert.equal((await senderAudits(owner.workspaceId)).length, before + 2);
      await linkCampaignSender(owner, jessSender.id, jess.userId);
      assert.equal((await senderAudits(owner.workspaceId)).length, before + 2);
    });

    it("refuses members, agent tokens and people outside the workspace", async () => {
      const markSender = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Mark Ridgeon")!;
      const before = (await senderAudits(owner.workspaceId)).length;
      await assert.rejects(linkCampaignSender(member, markSender.id, member.userId), refused("forbidden", /owner or admin/));
      const agent = (await createAgent(owner.workspaceId, [...SCOPES], "Admin agent")).actor;
      await assert.rejects(linkCampaignSender(agent, markSender.id, null), refused("forbidden"));
      await assert.rejects(linkCampaignSender(owner, markSender.id, outsider.userId), refused("invalid_input", /^Pick someone in this workspace\.$/));
      await assert.rejects(linkCampaignSender(outsider, markSender.id, null), refused("not_found"));
      assert.deepEqual(await queryAsUser(member.userId, "update crm.campaign_senders set user_id = $1 returning id", [member.userId]), []);
      await assert.rejects(queryAsUser(owner.userId, "update crm.campaign_senders set name = 'x'"), /permission denied/);
      await assert.rejects(
        queryAsUser(owner.userId, "update crm.campaign_senders set user_id = $1 where id = $2", [outsider.userId, markSender.id]),
        /row-level security/,
      );
      assert.equal((await senderAudits(owner.workspaceId)).length, before);
      assert.equal((await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Mark Ridgeon")!.userId, owner.userId);
    });
  });

  describe("sync and backfill", () => {
    let jane: string;
    let foundersId: string;
    const seen: SyncedEvent[][] = [];
    const onEvents = async (_campaign: unknown, events: SyncedEvent[]) => {
      seen.push(events);
    };

    it("backfills every campaign, matches people by LinkedIn profile and fires nothing", async () => {
      jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", linkedinUrl: "linkedin.com/in/jane-doe" }, { provenance: { operation: "test" } })).body.contact.id;
      const before = await counts(owner.workspaceId);
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents });
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.busy, []);
      assert.ok(report.backfilled >= 1);

      const campaigns = await sql<{ id: string; external_id: string; status: string; channel: string; variables: string[]; stats: Record<string, number>; sender_ids: string[]; day_stats: unknown[]; backfilled_at: Date | null }>(
        "select id, external_id, status, channel, variables, stats, sender_ids, day_stats, backfilled_at from crm.campaigns where workspace_id = $1 and provider = 'heyreach' order by external_id",
        [owner.workspaceId],
      );
      assert.deepEqual(campaigns.map((row) => [row.external_id, row.status, row.channel]), [["9001", "active", "linkedin"], ["9002", "drafted", "linkedin"]]);
      assert.ok(campaigns.every((row) => row.backfilled_at));
      const founders = campaigns[0];
      foundersId = founders.id;
      assert.deepEqual(founders.variables, ["connection_note", "first_name", "follow_up", "opener"]);
      assert.deepEqual(founders.sender_ids.sort(), ["1", "2"]);
      assert.equal(founders.stats.invites, 130);
      assert.equal(founders.stats.accepted, 1);
      assert.equal(founders.day_stats.length, 1);

      const prospects = await sql<{ external_lead_id: string; contact_id: string | null; linkedin: string; sender_id: string | null; state: string; lead_status: string; email: string | null }>(
        "select external_lead_id, contact_id, linkedin, sender_id, state, lead_status, email from crm.campaign_prospects where campaign_id = $1",
        [foundersId],
      );
      assert.equal(prospects.length, 130);
      const janeRow = prospects.find((row) => row.external_lead_id === "lead-jane")!;
      assert.equal(janeRow.contact_id, jane);
      assert.equal(janeRow.linkedin, "linkedin.com/in/jane-doe");
      assert.equal(janeRow.sender_id, "1");
      assert.equal(janeRow.state, "pushed");
      assert.equal(janeRow.lead_status, "in_progress");
      assert.equal(janeRow.email, null);
      assert.equal(prospects.filter((row) => row.contact_id).length, 1);

      const events = await sql<{ kind: string; count: number }>(
        "select kind, count(*)::int as count from crm.campaign_events where campaign_id = $1 group by kind order by kind",
        [foundersId],
      );
      assert.deepEqual(events.map((row) => [row.kind, row.count]), [["invite_accepted", 1], ["invite_sent", 130], ["message_sent", 2]]);

      const afterCounts = await counts(owner.workspaceId);
      assert.equal(afterCounts.events, before.events);
      assert.equal(afterCounts.notifications, before.notifications);
      assert.equal(afterCounts.contacts, before.contacts);
      assert.equal(seen.length, 0);
    });

    it("adds only new events on later syncs, and hands them on", async () => {
      const lead = eclipse.campaigns[0].leads.find((item) => item.id === "bulk-2")!;
      lead.connection = "ConnectionAccepted";
      lead.lastActionTime = new Date().toISOString();
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl, onEvents });
      assert.deepEqual(report.errors, []);
      assert.equal(report.events, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].map((event) => event.kind), ["invite_accepted"]);
    });

    it("shows the LinkedIn campaign with its senders, steps and capacity", async () => {
      const list = await listCampaigns(member);
      assert.ok(list.some((item) => item.name === "Agency founders" && item.channel === "linkedin"));
      const detail = await getCampaign(member, foundersId);
      assert.deepEqual(detail.sequence.map((step) => [step.subject, step.body]), [
        ["Invite", "{connection_note}"],
        ["Message", "Thanks for connecting, {first_name}. {opener}"],
        ["Message", "{follow_up}"],
      ]);
      assert.deepEqual(detail.stepStats.map((row) => [row.sent, row.accepted ?? null]), [[130, 2], [1, null], [1, null]]);
      assert.deepEqual(detail.capacity, { senders: 2, invites: 40, messages: null });
      assert.match(detail.url ?? "", /app\.heyreach\.io\/app\/campaigns\/9001/);
      const charted = detail.days.find((day) => day.sent === 20);
      assert.equal(charted?.accepted, 8);
      const prospects = await listCampaignProspects(member, foundersId, { search: "jane" });
      assert.equal(prospects.rows.length, 1);
      assert.equal(prospects.rows[0].stage, "accepted");
      assert.equal(prospects.rows[0].sender, "Mark Ridgeon");
      const bulkThree = await listCampaignProspects(member, foundersId, { search: "bulk-person-3 bulk3" });
      assert.equal(bulkThree.rows.length, 1);
      assert.equal(bulkThree.rows[0]?.stage, "invited");
      assert.equal(bulkThree.rows[0]?.sender, "Mark Ridgeon");
    });

    it("shows only HeyReach's own figures, and each lead's HeyReach status, sender and last action", async () => {
      const detail = await getCampaign(member, foundersId);
      assert.deepEqual(detail.stats, { invites: 130, accepted: 1, messages: 2, replied: 0 }, "no lead counts are made up from Orbit's rows when HeyReach gives none");
      assert.deepEqual(detail.leadFunnel, { contacted: 130, accepted: 2, replied: 0 });
      await sql("update crm.campaigns set sync_state = sync_state - 'leadStateAt' where id = $1", [foundersId]);
      assert.equal((await getCampaign(member, foundersId)).leadFunnel, null, "the funnel waits for a full lead read");

      const lead = eclipse.campaigns[0].leads.find((item) => item.id === "bulk-9")!;
      lead.senderName = "Jess Cole (HeyReach)";
      lead.replied = true;
      lead.status = "Paused";
      lead.lastActionTime = new Date().toISOString();
      await sql("update crm.campaigns set sync_state = sync_state - 'leadsAt' where id = $1", [foundersId]);
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.deepEqual(report.errors, []);
      const after = await getCampaign(member, foundersId);
      assert.deepEqual(after.leadFunnel, { contacted: 130, accepted: 2, replied: 1 });
      const rows = await listCampaignProspects(member, foundersId, { search: "Bulk9" });
      const row = rows.rows.find((item) => item.name === "Bulk9 Person")!;
      assert.equal(row.providerStatus, "paused");
      assert.equal(row.sender, "Jess Cole (HeyReach)");
      assert.equal(row.lastActionAt, lead.lastActionTime);
      assert.equal(linkedinStatus(row), "Paused");
    });

    it("starts a lead read already part-way through again from the first page before counting the funnel", async () => {
      await sql(
        `update crm.campaigns set sync_state = (sync_state - 'leadStateAt' - 'leadStateStarted') || '{"leadsOffset": 100}'::jsonb, status = 'completed' where id = $1`,
        [foundersId],
      );
      await sql("update crm.campaign_prospects set provider_state = '{}'::jsonb where campaign_id = $1", [foundersId]);
      assert.equal((await getCampaign(member, foundersId)).leadFunnel, null);
      eclipse.calls.length = 0;
      const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.deepEqual(report.errors, []);
      const reads = eclipse.calls.filter((call) => call.path === "/campaign/GetLeadsFromCampaign" && call.body?.timeFilter === undefined);
      assert.deepEqual(
        reads.map((call) => call.body?.offset),
        [0, 100],
        "an ended campaign reads every page from the start, not only the rest",
      );
      const state = (await sql<{ state: Record<string, unknown> }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
      assert.ok(state.leadStateAt);
      assert.equal(state.leadStateStarted, undefined);
      assert.equal(state.leadsOffset, undefined);
      assert.deepEqual((await getCampaign(member, foundersId)).leadFunnel, { contacted: 130, accepted: 2, replied: 1 });
      await sql("update crm.campaigns set status = 'active' where id = $1", [foundersId]);
    });

    it("reads the steps once after the parser change, not on every sync", async () => {
      const state = (await sql<{ state: Record<string, unknown> }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
      assert.equal(state.sequenceFormat, 2);
      eclipse.calls.length = 0;
      await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.equal(eclipse.calls.filter((call) => call.path === "/campaign/GetCampaignSequence").length, 0, "a second sync doesn't read the steps again");
      await sql("update crm.campaigns set sync_state = sync_state - 'sequenceFormat' where id = $1", [foundersId]);
      eclipse.calls.length = 0;
      await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      assert.equal(eclipse.calls.filter((call) => call.path === "/campaign/GetCampaignSequence").length, 1, "only a campaign whose steps were parsed by the old reader reads them again");
    });

    it("keeps registering the other HeyReach webhooks when one is refused", async () => {
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = "https://orbit.test";
      let refusedOnce = false;
      eclipse.fail = (path) => {
        if (path !== "/webhooks/CreateWebhook" || refusedOnce) return null;
        refusedOnce = true;
        return new Response(JSON.stringify({ title: "One or more validation errors occurred.", status: 400, errors: { webhookName: ["Too long."] } }), { status: 400 });
      };
      const original = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      try {
        await sql("update crm.campaigns set sync_state = sync_state - 'webhooks' - 'webhookId' - 'webhookFailedAt' where id = $1", [foundersId]);
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      } finally {
        console.error = original;
        eclipse.fail = undefined;
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
      const state = (await sql<{ state: { webhooks?: string[]; webhookFailedAt?: string } }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
      assert.deepEqual(state.webhooks, HEYREACH_WEBHOOK_EVENTS.slice(1));
      assert.ok(state.webhookFailedAt);
      assert.ok(logged.some((line) => line.includes("Couldn't add the HeyReach webhook EVERY_MESSAGE_REPLY_RECEIVED") && line.includes("webhookName: Too long")));
    });

    it("retries a refused webhook after an hour for a paused campaign, keeps the ones HeyReach has, and ignores the old placeholder", async () => {
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = "https://orbit.test";
      const founders = eclipse.campaigns.find((item) => item.id === 9001)!;
      const hookCalls = () => eclipse.calls.filter((call) => call.path.startsWith("/webhooks/"));
      try {
        founders.status = "PAUSED";
        await sql("update crm.campaigns set sync_state = (sync_state - 'webhooks') || jsonb_build_object('webhookId', 'registered', 'webhookFailedAt', (now() - interval '30 minutes')::text) where id = $1", [foundersId]);
        eclipse.calls.length = 0;
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.equal((await sql<{ status: string }>("select status from crm.campaigns where id = $1", [foundersId]))[0].status, "paused");
        assert.deepEqual(hookCalls(), [], "nothing is tried within the hour");

        await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('webhookFailedAt', (now() - interval '61 minutes')::text) where id = $1", [foundersId]);
        const before = eclipse.webhooks?.length ?? 0;
        eclipse.calls.length = 0;
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        const created = hookCalls().filter((call) => call.path === "/webhooks/CreateWebhook").map((call) => call.body?.eventType);
        assert.deepEqual(created, [HEYREACH_WEBHOOK_EVENTS[0]], "only the event HeyReach doesn't have yet is added");
        assert.equal(hookCalls().filter((call) => call.path === "/webhooks/GetAllWebhooks").length, 1);
        assert.equal(eclipse.webhooks!.length, before + 1);
        const state = (await sql<{ state: { webhooks?: string[]; webhookId?: string; webhookFailedAt?: string | null } }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
        assert.deepEqual([...(state.webhooks ?? [])].sort(), [...HEYREACH_WEBHOOK_EVENTS].sort());
        assert.equal(state.webhookId, String(eclipse.webhooks!.find((hook) => hook.eventType === HEYREACH_WEBHOOK_EVENTS[0] && hook.campaignIds.includes(9001))!.id));
        assert.ok(!state.webhookFailedAt);
        assert.ok(new Set(eclipse.webhooks!.map((hook) => hook.webhookName)).size === eclipse.webhooks!.length, "every webhook has its own name");

        eclipse.calls.length = 0;
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.deepEqual(hookCalls(), [], "a campaign with every webhook asks nothing more");
      } finally {
        founders.status = "IN_PROGRESS";
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
      await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
    });

    it("adds no webhooks to a finished campaign", async () => {
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = "https://orbit.test";
      const founders = eclipse.campaigns.find((item) => item.id === 9001)!;
      try {
        founders.status = "FINISHED";
        await sql("update crm.campaigns set sync_state = sync_state - 'webhooks' - 'webhookId' - 'webhookFailedAt' where id = $1", [foundersId]);
        eclipse.calls.length = 0;
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.equal((await sql<{ status: string }>("select status from crm.campaigns where id = $1", [foundersId]))[0].status, "completed");
        assert.deepEqual(eclipse.calls.filter((call) => call.path.startsWith("/webhooks/")), []);
      } finally {
        founders.status = "IN_PROGRESS";
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
      await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
    });

    it("forgets every webhook on disconnect, so a reconnect registers all of them again", async () => {
      const savedSite = process.env.SITE_URL;
      process.env.SITE_URL = "https://orbit.test";
      try {
        await sql("update crm.campaigns set sync_state = sync_state || jsonb_build_object('webhooks', $2::jsonb, 'webhookId', '77', 'webhookFailedAt', now()::text) where id = $1", [foundersId, JSON.stringify(HEYREACH_WEBHOOK_EVENTS)]);
        assert.equal(await removeCampaignConnection(owner, "heyreach"), true);
        const forgotten = (await sql<{ state: Record<string, unknown> }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
        assert.deepEqual([forgotten.webhooks, forgotten.webhookId, forgotten.webhookFailedAt], [undefined, undefined, undefined]);
        await saveCampaignConnection(owner, "heyreach", KEY, { fetchImpl });
        eclipse.webhooks = [];
        eclipse.calls.length = 0;
        await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        const created = eclipse.calls.filter((call) => call.path === "/webhooks/CreateWebhook" && (call.body?.campaignIds as number[]).includes(9001)).map((call) => call.body?.eventType);
        assert.deepEqual([...created].sort(), [...HEYREACH_WEBHOOK_EVENTS].sort());
        const state = (await sql<{ state: { webhooks?: string[] } }>("select sync_state as state from crm.campaigns where id = $1", [foundersId]))[0].state;
        assert.deepEqual([...(state.webhooks ?? [])].sort(), [...HEYREACH_WEBHOOK_EVENTS].sort());
      } finally {
        if (savedSite === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = savedSite;
      }
    });

    it("starts a campaign that has never run, audits it once, and refuses one that has", async () => {
      const draft = (await sql<{ id: string; status: string }>("select id, status from crm.campaigns where workspace_id = $1 and external_id = '9002'", [owner.workspaceId]))[0];
      assert.equal(draft.status, "drafted");
      eclipse.calls.length = 0;
      assert.deepEqual(await startCampaign(member, draft.id, { fetchImpl }), { status: "active" });
      assert.deepEqual(eclipse.calls.map((call) => call.path), ["/campaign/StartCampaign"]);
      assert.equal((await sql<{ status: string }>("select status from crm.campaigns where id = $1", [draft.id]))[0].status, "active");
      assert.deepEqual(await startCampaign(member, draft.id, { fetchImpl }), { status: "active" });
      assert.equal(eclipse.calls.length, 1, "a started campaign isn't started again");
      const audits = await sql<{ actor_user_id: string }>("select actor_user_id from crm.audit_events where workspace_id = $1 and event_type = 'campaign.started' and entity_id = $2", [owner.workspaceId, draft.id]);
      assert.deepEqual(audits.map((row) => row.actor_user_id), [member.userId]);
      await sql("update crm.campaigns set status = 'paused' where id = $1", [draft.id]);
      await assert.rejects(startCampaign(member, draft.id, { fetchImpl }), refused("conflict", /Only a campaign that hasn't started can be started/));
      await assert.rejects(startCampaign(outsider, draft.id, { fetchImpl }), refused("not_found"));
      eclipse.campaigns.find((item) => item.id === 9002)!.status = "DRAFT";
      await sql("update crm.campaigns set status = 'drafted' where id = $1", [draft.id]);
    });

    it("imports the people who aren't in Orbit yet with their LinkedIn profiles", async () => {
      const before = await counts(owner.workspaceId);
      const result = await importCampaignProspects(member, foundersId, { deadline: Date.now() + 60_000 });
      assert.equal(result.linked, 129);
      assert.equal(result.left, 0);
      const afterCounts = await counts(owner.workspaceId);
      assert.equal(afterCounts.contacts, before.contacts + 129);
      const linked = await sql<{ linkedin: string; contact_linkedin: string }>(
        "select p.linkedin, c.normalized_linkedin as contact_linkedin from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where p.campaign_id = $1 and p.external_lead_id = 'bulk-7'",
        [foundersId],
      );
      assert.deepEqual(linked, [{ linkedin: "linkedin.com/in/bulk-person-7", contact_linkedin: "linkedin.com/in/bulk-person-7" }]);
    });

    it("waits when HeyReach answers 429", async () => {
      let refusedOnce = false;
      eclipse.fail = (path) => {
        if (refusedOnce || path !== "/stats/GetOverallStats") return null;
        refusedOnce = true;
        return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
      };
      try {
        const report = await syncCampaigns({ workspaceId: owner.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
        assert.deepEqual(report.errors, []);
        assert.equal(report.busy.length, 1);
        assert.match(report.busy[0], /HeyReach/);
      } finally {
        eclipse.fail = undefined;
      }
    });
  });

  describe("removing a member", () => {
    it("clears their sender links and audits each one", async () => {
      const jessSender = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Jess Cole")!;
      assert.equal(jessSender.userId, jess.userId);
      const before = (await senderAudits(owner.workspaceId)).length;
      const notesBefore = await counts(owner.workspaceId);
      await removeMember(owner, jess.userId);
      const after = (await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Jess Cole")!;
      assert.equal(after.userId, null);
      const audits = await senderAudits(owner.workspaceId);
      assert.equal(audits.length, before + 1);
      const last = audits[audits.length - 1];
      assert.equal(last.entity_id, jessSender.id);
      assert.equal(last.actor_user_id, owner.userId);
      assert.equal(last.operation, "remove_member");
      assert.equal(last.changes.linked, null);
      assert.equal(last.changes.unlinked, jess.userId);
      assert.equal((await counts(owner.workspaceId)).notifications, notesBefore.notifications);
      assert.equal((await listCampaignSenders(owner)).senders.find((sender) => sender.name === "Mark Ridgeon")!.userId, owner.userId);
    });
  });

  describe("privacy", () => {
    it("shows other workspaces nothing", async () => {
      await saveCampaignConnection(outsider, "heyreach", OTHER_KEY, { fetchImpl });
      await syncCampaigns({ workspaceId: outsider.workspaceId, deadline: Date.now() + 60_000, fetchImpl });
      const theirs = await listCampaigns(outsider);
      assert.deepEqual(theirs.map((item) => item.name), ["Ridgeon LinkedIn"]);
      const theirSenders = await listCampaignSenders(outsider);
      assert.deepEqual(theirSenders.senders.map((sender) => sender.name), ["Oscar Outsider"]);
      assert.equal(theirSenders.senders[0].userId, outsider.userId);
      assert.ok(theirSenders.members.every((item) => item.userId === outsider.userId));
      const ours = (await listCampaigns(owner)).map((item) => item.id);
      for (const id of ours) await assert.rejects(getCampaign(outsider, id), refused("not_found"));
      for (const table of ["campaigns", "campaign_prospects", "campaign_events", "campaign_senders"]) {
        const rows = await queryAsUser<{ count: number }>(outsider.userId, `select count(*)::int as count from crm.${table} where workspace_id = $1`, [owner.workspaceId]);
        assert.equal(rows[0].count, 0, table);
      }
      const elsewhere = (await createAgent(outsider.workspaceId, [...SCOPES], "Elsewhere agent")).actor;
      const agentSenders = await withActor(elsewhere, (db) => db.query<{ workspace_id: string }>("select workspace_id from crm.campaign_senders"));
      assert.ok(agentSenders.rows.every((row) => row.workspace_id === outsider.workspaceId));
      assert.equal(agentSenders.rows.length, 1);
      const reader = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).actor;
      assert.equal((await listCampaignSenders(reader)).senders.length, 4);
      await assert.rejects(withActor(reader, (db) => db.query("update crm.campaign_senders set user_id = null")), /permission denied/);
      await assert.rejects(queryAsUser(member.userId, "select * from private.campaign_sync_senders($1, 'heyreach', '[]'::jsonb)", [owner.workspaceId]), /permission denied/);
    });
  });
});
