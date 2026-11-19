import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "@/lib/assistant/tools";
import { buildProgress, campaignProgress, compactProgress, eventSlots, type CampaignProgress, type CompactProgress, type ProgressEvent } from "@/lib/campaigns/progress";
import { getProspectThread } from "@/lib/campaigns/threads";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { registerCampaignTools } from "@/server/mcp/campaigns";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const OPTIONS = { now: NOW, timeZone: "Europe/London" };

let owner: UserActor;
let outsider: UserActor;
const ids: Record<string, string> = {};

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

const HEYREACH_SEQUENCE = [
  { step: 1, variant: null, subject: "View profile", body: "", delayDays: null },
  { step: 2, variant: null, subject: "Like post", body: "", delayDays: 1 },
  { step: 3, variant: "A", subject: "Invite", body: "Hi {firstName}", delayDays: 1 },
  { step: 3, variant: "B", subject: "Invite", body: "Hello {firstName}", delayDays: 1 },
  { step: 4, variant: null, subject: "Message", body: "Thanks for connecting", delayDays: 1 },
];

const SMARTLEAD_SEQUENCE = [
  { step: 1, variant: "A", subject: "Quick question", body: "A", delayDays: null },
  { step: 1, variant: "B", subject: "A thought", body: "B", delayDays: null },
  { step: 2, variant: null, subject: "", body: "Following up", delayDays: 3 },
  { step: 3, variant: null, subject: "", body: "Last note", delayDays: 4 },
];

async function campaign(actor: UserActor, name: string, channel: "email" | "linkedin", key: string, sequence: unknown[]) {
  const row = await sql<{ id: string }>(
    `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, sequence, variables, sender_ids, backfilled_at, synced_at)
     values ($1, $2, $3, $4, $5, 'active', $6::jsonb, '{}', $7, now(), now()) returning id`,
    [actor.workspaceId, channel === "email" ? "smartlead" : "heyreach", channel, key, name, JSON.stringify(sequence), channel === "linkedin" ? [`acct-${key}`] : []],
  );
  return row[0].id;
}

async function prospect(
  actor: UserActor,
  input: {
    campaignId: string;
    lead: string;
    contactId?: string | null;
    email?: string | null;
    linkedin?: string | null;
    sender?: string | null;
    name: [string, string];
    leadStatus?: string;
    providerState?: Record<string, unknown>;
    repliedAt?: string | null;
    stoppedAt?: string | null;
    stopReason?: string | null;
  },
) {
  const row = await sql<{ id: string }>(
    `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, linkedin, sender_id, state, external_lead_id, lead_status, pushed_at, lead,
       provider_state, replied_at, stop_requested_at, stopped_at, stop_reason)
     values ($1, $2, $3, $4, $5, $6, 'pushed', $7, $8, '2026-11-01T09:00:00Z', $9::jsonb, $10::jsonb, $11, $12, $12, $13) returning id`,
    [
      actor.workspaceId,
      input.campaignId,
      input.contactId ?? null,
      input.email ?? null,
      input.linkedin ?? null,
      input.sender ?? null,
      input.lead,
      input.leadStatus ?? "in_progress",
      JSON.stringify({ firstName: input.name[0], lastName: input.name[1] }),
      JSON.stringify(input.providerState ?? {}),
      input.repliedAt ?? null,
      input.stoppedAt ?? null,
      input.stopReason ?? null,
    ],
  );
  return row[0].id;
}

let counter = 0;

async function event(prospectId: string, kind: string, at: string, extra: { step?: number; variant?: string; webhook?: boolean } = {}) {
  counter += 1;
  await sql(
    `insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, step, variant, occurred_at, dedupe_key, payload)
     select p.workspace_id, p.campaign_id, p.id, $2, $3, $4, $5, $6, $7::jsonb from crm.campaign_prospects p where p.id = $1`,
    [prospectId, kind, extra.step ?? null, extra.variant ?? null, at, `test:${counter}`, JSON.stringify(extra.webhook ? { fromWebhook: true } : {})],
  );
}

async function progressOf(actor: UserActor, prospectId: string) {
  const [found] = await campaignProgress(actor, [prospectId], OPTIONS);
  assert.ok(found, "progress for the prospect");
  return found;
}

function shape(progress: CampaignProgress) {
  return progress.steps.map((step) => [step.label, step.state, step.text]);
}

describe("campaign progress", () => {
  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@progress.test", "Mark Ridgeon");
    outsider = await createUser("zed@elsewhere.test", "Zed Other");
    const longevity = await campaign(owner, "Longevity Clinics", "linkedin", "li-1", HEYREACH_SEQUENCE);
    const clinics = await campaign(owner, "Clinic owners Q4", "email", "em-1", SMARTLEAD_SEQUENCE);
    await sql("insert into crm.campaign_senders (workspace_id, provider, external_id, name, email, user_id) values ($1, 'heyreach', 'acct-li-1', 'Mark R', 'mark@progress.test', $2)", [
      owner.workspaceId,
      owner.userId,
    ]);

    const priya = await createContact(owner, { firstName: "Priya", lastName: "Shah", email: "priya@vitalyears.test", linkedinUrl: "https://www.linkedin.com/in/priyashah" }, { provenance: { operation: "test" } });
    const contactId = priya.body.contact.id;
    ids.priyaLinkedin = await prospect(owner, {
      campaignId: longevity,
      lead: "priya-li",
      contactId,
      linkedin: "linkedin.com/in/priyashah",
      sender: "acct-li-1",
      name: ["Priya", "Shah"],
      providerState: { status: "in_sequence", connection: "accepted", messaging: "replied" },
      repliedAt: "2026-11-19T09:41:00Z",
    });
    await event(ids.priyaLinkedin, "invite_sent", "2026-11-13T10:00:00Z", { webhook: true });
    await event(ids.priyaLinkedin, "invite_accepted", "2026-11-14T10:00:00Z", { webhook: true });
    await event(ids.priyaLinkedin, "message_sent", "2026-11-15T10:00:00Z", { webhook: true });
    await event(ids.priyaLinkedin, "replied", "2026-11-19T09:41:00Z");

    ids.priyaEmail = await prospect(owner, {
      campaignId: clinics,
      lead: "priya-em",
      contactId,
      email: "priya@vitalyears.test",
      name: ["Priya", "Shah"],
      stoppedAt: "2026-11-19T09:45:00Z",
      stopReason: "replied",
    });
    await event(ids.priyaEmail, "sent", "2026-11-12T09:00:00Z", { step: 1, variant: "B" });
    await event(ids.priyaEmail, "sent", "2026-11-15T09:00:00Z", { step: 2 });
    for (const at of ["2026-11-12T10:00:00Z", "2026-11-13T10:00:00Z", "2026-11-15T10:00:00Z"]) await event(ids.priyaEmail, "opened", at, { step: 1 });
    await event(ids.priyaEmail, "clicked", "2026-11-12T10:05:00Z", { step: 1 });
    await sql(
      `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, external_id, stats_id, from_address)
       select p.workspace_id, p.campaign_id, p.id, 'email', 'outbound', 'Hello', '2026-11-15T09:00:00Z', 'msg-priya-2', 'stats-priya', 'Mark <mark@progress.test>'
       from crm.campaign_prospects p where p.id = $1`,
      [ids.priyaEmail],
    );

    ids.amelia = await prospect(owner, {
      campaignId: longevity,
      lead: "amelia",
      linkedin: "linkedin.com/in/ameliahart",
      sender: "acct-li-1",
      name: ["Amelia", "Hart"],
      providerState: { status: "in_sequence", connection: "sent", messaging: "none" },
    });
    await event(ids.amelia, "invite_sent", "2026-11-18T23:00:00Z", { webhook: true });

    ids.leo = await prospect(owner, {
      campaignId: longevity,
      lead: "leo",
      linkedin: "linkedin.com/in/leo",
      name: ["Leo", "Park"],
      providerState: { status: "in_sequence", connection: "accepted", messaging: "sent", senderName: "Ann Lee" },
    });

    ids.viewer = await prospect(owner, { campaignId: longevity, lead: "vic", linkedin: "linkedin.com/in/vic", name: ["Vic", "Moss"], providerState: { status: "in_sequence" } });
    await event(ids.viewer, "profile_viewed", "2026-11-19T08:00:00Z", { webhook: true });

    ids.sam = await prospect(owner, { campaignId: clinics, lead: "sam", email: "sam@clinic.test", name: ["Sam", "Lowe"] });
    await event(ids.sam, "sent", "2026-11-17T09:00:00Z", { step: 1, variant: "A" });

    ids.removed = await prospect(owner, { campaignId: clinics, lead: "rem", email: "rem@clinic.test", name: ["Rem", "Oved"], stoppedAt: "2026-11-16T09:00:00Z", stopReason: "removed" });
    await event(ids.removed, "sent", "2026-11-14T09:00:00Z", { step: 1, variant: "A" });
    ids.blocked = await prospect(owner, { campaignId: clinics, lead: "dnc", email: "dnc@clinic.test", name: ["Dee", "Block"], stoppedAt: "2026-11-16T09:00:00Z", stopReason: "suppressed" });

    const elsewhere = await campaign(outsider, "Elsewhere", "email", "em-out", SMARTLEAD_SEQUENCE);
    ids.zara = await prospect(outsider, { campaignId: elsewhere, lead: "zara", email: "zara@elsewhere.test", name: ["Zara", "Hidden"] });
    await event(ids.zara, "sent", "2026-11-12T09:00:00Z", { step: 1 });
  });

  useServerlessPool();

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("matches Smartlead steps by step number and shows the version they got", async () => {
    const both = await campaignProgress(owner, [ids.priyaEmail, ids.priyaLinkedin], OPTIONS);
    const email = both.find((item) => item.prospectId === ids.priyaEmail)!;
    assert.deepEqual(shape(email), [
      ["Email 1 B", "done", "12 Nov"],
      ["Email 2", "done", "15 Nov"],
      ["Email 3", "stopped", "stopped"],
    ]);
    assert.equal(email.status, "stopped");
    assert.equal(email.stage, "Step 2 of 3 · Sent from Mark Ridgeon · Stopped when they replied on LinkedIn");
    assert.deepEqual(email.counts, { opens: 3, clicks: 1 });
    assert.equal((await progressOf(owner, ids.priyaEmail)).stage, "Step 2 of 3 · Sent from Mark Ridgeon · Stopped when they replied");
  });

  it("matches HeyReach steps by kind and order, with done-without-date before webhooks", async () => {
    const linkedin = await progressOf(owner, ids.priyaLinkedin);
    assert.deepEqual(shape(linkedin), [
      ["View profile", "done", ""],
      ["Like post", "done", ""],
      ["Invite", "done", "13 Nov, accepted 14 Nov"],
      ["Message", "current", "15 Nov, replied 19 Nov"],
    ]);
    assert.equal(linkedin.status, "replied");
    assert.equal(linkedin.stage, "Step 4 of 4 · Sent from Mark Ridgeon · Stopped when they replied");
    assert.deepEqual(linkedin.counts, { accepted: true, messages: 1, replied: true });

    const viewer = await progressOf(owner, ids.viewer);
    assert.deepEqual(shape(viewer).slice(0, 2), [
      ["View profile", "current", "19 Nov"],
      ["Like post", "next", "around 20 Nov"],
    ]);
  });

  it("takes done steps from the provider's state when Orbit has no event", async () => {
    const leo = await progressOf(owner, ids.leo);
    assert.deepEqual(shape(leo), [
      ["View profile", "done", ""],
      ["Like post", "done", ""],
      ["Invite", "done", "accepted"],
      ["Message", "current", ""],
    ]);
    assert.equal(leo.stage, "Step 4 of 4 · Sent from Ann Lee");
    assert.deepEqual(leo.counts, { accepted: true, messages: 1, replied: false });
  });

  it("says a LinkedIn message waits until they accept", async () => {
    const amelia = await progressOf(owner, ids.amelia);
    assert.deepEqual(shape(amelia), [
      ["View profile", "done", ""],
      ["Like post", "done", ""],
      ["Invite", "current", "18 Nov"],
      ["Message", "next", "after they accept"],
    ]);
    assert.equal(amelia.status, "in_progress");
    assert.deepEqual(amelia.counts, { accepted: false, messages: 0, replied: false });
  });

  it("dates the next step from the previous one plus its delay", async () => {
    const sam = await progressOf(owner, ids.sam);
    assert.deepEqual(shape(sam), [
      ["Email 1 A", "current", "17 Nov"],
      ["Email 2", "next", "around 20 Nov"],
      ["Email 3", "later", ""],
    ]);
    assert.equal(sam.steps[1].due, "2026-11-20T09:00:00.000Z");
    assert.equal(sam.stage, "Step 1 of 3");
    const later = await campaignProgress(owner, [ids.sam], { now: Date.parse("2026-11-25T12:00:00Z"), timeZone: "Europe/London" });
    assert.equal(later[0].steps[1].text, "due now");
  });

  it("shows a stopped person with the reason and the steps they won't get", async () => {
    const removed = await progressOf(owner, ids.removed);
    assert.equal(removed.status, "stopped");
    assert.equal(removed.stage, "Step 1 of 3 · Removed");
    assert.deepEqual(removed.steps.map((step) => step.state), ["done", "stopped", "stopped"]);
    const blocked = await progressOf(owner, ids.blocked);
    assert.equal(blocked.stage, "Not started · Do not contact");
    assert.deepEqual(blocked.steps.map((step) => step.text), ["stopped", "stopped", "stopped"]);
  });

  it("never reads another workspace's people", async () => {
    assert.deepEqual(await campaignProgress(owner, [ids.zara], OPTIONS), []);
    assert.deepEqual(await campaignProgress(outsider, [ids.priyaEmail, ids.priyaLinkedin], OPTIONS), []);
    assert.deepEqual(await campaignProgress(owner, ["not-an-id"], OPTIONS), []);
    const theirs = await campaignProgress(outsider, [ids.zara, ids.sam], OPTIONS);
    assert.deepEqual(theirs.map((item) => item.prospectId), [ids.zara]);
  });

  it("puts progress for every campaign on the thread", async () => {
    const thread = await getProspectThread(owner, ids.priyaLinkedin);
    assert.deepEqual(thread.progress.map((item) => item.prospectId).sort(), [ids.priyaEmail, ids.priyaLinkedin].sort());
  });

  it("gives the assistant and MCP a compact progress on the thread read", async () => {
    const read = (await runTool(owner, "campaigns", { view: "thread", prospectId: ids.priyaLinkedin })) as { thread: { progress: CompactProgress[] } };
    const linkedin = read.thread.progress.find((item) => item.prospectId === ids.priyaLinkedin)!;
    assert.equal(linkedin.status, "Replied");
    assert.equal(linkedin.campaign, "Longevity Clinics");
    assert.match(linkedin.stage, /^Step 4 of 4 · Sent from Mark Ridgeon/);
    assert.ok(linkedin.steps.some((step) => /^Invite: done, \d+ Nov, accepted \d+ Nov$/.test(step)), linkedin.steps.join(" | "));
    assert.equal(linkedin.counts, "Yes accepted, 1 message, Yes replied");
    const email = read.thread.progress.find((item) => item.prospectId === ids.priyaEmail)!;
    assert.equal(email.counts, "3 opens, 1 click");
    assert.ok(email.steps.includes("Email 3: stopped"), email.steps.join(" | "));

    const server = new McpServer({ name: "crm", version: "1.0.0" });
    registerCampaignTools(server, owner);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "progress-test", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const result = (await client.callTool({ name: "read_campaigns", arguments: { view: "thread", prospect_id: ids.priyaEmail } })) as { content: { text: string }[]; isError?: boolean };
      assert.ok(!result.isError, result.content.map((part) => part.text).join(""));
      const body = JSON.parse(result.content.map((part) => part.text).join("")) as { thread: { progress: CompactProgress[] } };
      assert.deepEqual(body.thread.progress.map((item) => item.prospectId).sort(), [ids.priyaEmail, ids.priyaLinkedin].sort());
      assert.ok(body.thread.progress.every((item) => typeof item.stage === "string" && Array.isArray(item.steps) && typeof item.counts === "string"));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps one HeyReach slot per action when a webhook and a sync both saw it", () => {
    const at = (iso: string) => new Date(iso);
    const slots = eventSlots([
      { step: 1, variant: null, occurred_at: at("2026-11-15T10:00:00Z"), from_webhook: false },
      { step: 2, variant: null, occurred_at: at("2026-11-17T10:00:00Z"), from_webhook: false },
      { step: null, variant: null, occurred_at: at("2026-11-15T09:59:00Z"), from_webhook: true },
    ]);
    assert.deepEqual(
      slots.map((slot) => slot.at?.toISOString() ?? null),
      ["2026-11-15T09:59:00.000Z", null],
    );
    const shared = eventSlots([
      { step: 1, variant: null, occurred_at: at("2026-11-15T10:00:00Z"), from_webhook: false },
      { step: 1, variant: null, occurred_at: at("2026-11-15T09:58:00Z"), from_webhook: true },
    ]);
    assert.deepEqual(shared.map((slot) => slot.at?.toISOString()), ["2026-11-15T09:58:00.000Z"]);
    assert.deepEqual(compactProgress([]), []);
  });

  describe("HeyReach rules", () => {
    type Row = Parameters<typeof buildProgress>[0];

    const row = (sequence: string[], state: Record<string, unknown>, extra: Partial<Row> = {}): Row => ({
      id: "p1",
      campaign_id: "c1",
      campaign_name: "LinkedIn",
      channel: "linkedin",
      provider: "heyreach",
      campaign_status: "active",
      sequence: sequence.map((subject, index) => ({ step: index + 1, variant: null, subject, body: "", delayDays: 1 })),
      state: "pushed",
      skip_reason: null,
      lead_status: "in_progress",
      provider_state: state,
      replied_at: null,
      stop_requested_at: null,
      stopped_at: null,
      stop_reason: null,
      sender_name: "Mark Ridgeon",
      mailbox: null,
      mailbox_owner: null,
      ...extra,
    });
    const ev = (kind: ProgressEvent["kind"], at: string, step: number | null, webhook: boolean): ProgressEvent => ({ prospect_id: "p1", kind, step, variant: null, occurred_at: new Date(at), from_webhook: webhook });
    const build = (input: Row, events: ProgressEvent[]) => buildProgress(input, events, [input], OPTIONS);

    it("keys message slots by step whatever the origin", () => {
      const progress = build(row(["Invite", "Message", "Message"], { status: "in_sequence", connection: "accepted", messaging: "sent" }), [
        ev("invite_sent", "2026-11-01T09:00:00Z", null, true),
        ev("invite_accepted", "2026-11-02T09:00:00Z", null, true),
        ev("message_sent", "2026-11-03T09:00:00Z", 1, false),
        ev("message_sent", "2026-11-10T09:00:00Z", 2, true),
      ]);
      assert.deepEqual(shape(progress).slice(1), [
        ["Message", "done", ""],
        ["Message", "current", "10 Nov"],
      ]);
      assert.equal(progress.counts.messages, 2);
      const both = build(row(["Invite", "Message", "Message"], { status: "in_sequence", connection: "accepted", messaging: "sent" }), [
        ev("message_sent", "2026-11-03T09:00:00Z", 1, true),
        ev("message_sent", "2026-11-10T09:00:00Z", 2, true),
      ]);
      assert.deepEqual(both.steps.slice(1).map((step) => step.text), ["3 Nov", "10 Nov"]);
    });

    it("treats polled actions as done without a date and dates nothing from them", () => {
      const progress = build(row(["Invite", "Message", "Message"], { status: "in_sequence", connection: "accepted", messaging: "sent" }), [
        ev("invite_sent", "2026-11-13T10:00:00Z", null, false),
        ev("invite_accepted", "2026-11-14T10:00:00Z", null, false),
        ev("message_sent", "2026-11-15T10:00:00Z", 1, false),
      ]);
      assert.deepEqual(shape(progress), [
        ["Invite", "done", "accepted"],
        ["Message", "current", ""],
        ["Message", "next", "next"],
      ]);
      assert.ok(progress.steps.every((step) => step.at === null && step.due === null));
    });

    it("never shows a step done when the provider's state says that action hasn't happened", () => {
      const sequences = [
        ["View profile", "Invite", "Message", "Like post"],
        ["Invite", "Message", "Message", "Like post"],
        ["InMail", "Follow", "Message"],
        ["Invite", "View profile", "Like post", "Follow"],
      ];
      const eventSets = [
        [],
        [ev("post_liked", "2026-11-08T09:00:00Z", null, true)],
        [ev("followed", "2026-11-08T09:00:00Z", null, true), ev("profile_viewed", "2026-11-07T09:00:00Z", null, true)],
        [ev("invite_sent", "2026-11-01T09:00:00Z", null, true), ev("post_liked", "2026-11-08T09:00:00Z", null, true)],
      ];
      for (const connection of ["none", "sent", "accepted"]) {
        for (const messaging of ["none", "sent", "replied"]) {
          for (const sequence of sequences) {
            for (const events of eventSets) {
              for (const status of ["in_sequence", "finished"]) {
                const progress = build(row(sequence, { status, connection, messaging }), events);
                const label = `${connection}/${messaging}/${status} ${sequence.join(",")} with ${events.map((item) => item.kind).join(",") || "no events"}`;
                const hasMessage = events.some((item) => item.kind === "message_sent" || item.kind === "inmail_sent");
                for (const step of progress.steps) {
                  const done = step.state === "done" || step.state === "current";
                  if (connection === "none" && step.label === "Invite") assert.ok(!done, `invite done: ${label}`);
                  if (messaging === "none" && !hasMessage && (step.label === "Message" || step.label === "InMail")) assert.ok(!done, `message done: ${label}`);
                }
                const unaccepted = progress.steps.findIndex((step) => step.label === "Invite" && !step.text.includes("accepted"));
                if (connection !== "accepted" && unaccepted >= 0) {
                  for (const step of progress.steps.slice(unaccepted + 1)) {
                    const own = events.some((item) => item.kind === ({ "Like post": "post_liked", "View profile": "profile_viewed", Follow: "followed" } as Record<string, string>)[step.label]);
                    const stated = (step.label === "Message" || step.label === "InMail") && messaging !== "none";
                    if (!own && !stated) assert.ok(step.state !== "done" && step.state !== "current", `inferred across an unaccepted invite: ${label}`);
                  }
                }
                assert.equal(progress.counts.messages, hasMessage ? 1 : messaging === "none" ? 0 : 1, `messages: ${label}`);
              }
            }
          }
        }
      }
      const crossed = build(row(["Invite", "Message", "Message", "Like post"], { status: "in_sequence", connection: "sent", messaging: "none" }), [
        ev("invite_sent", "2026-11-01T09:00:00Z", null, true),
        ev("post_liked", "2026-11-08T09:00:00Z", null, true),
      ]);
      assert.deepEqual(crossed.steps.slice(1, 3).map((step) => step.state), ["next", "later"]);
      assert.equal(crossed.counts.messages, 0);
    });

    it("gives no date to a next step that may never run", () => {
      const otherBranch = build(row(["Invite", "View profile", "Like post", "Follow"], { status: "in_sequence", connection: "accepted", messaging: "sent" }), [
        ev("invite_sent", "2026-11-01T09:00:00Z", null, true),
        ev("invite_accepted", "2026-11-02T09:00:00Z", null, true),
        ev("message_sent", "2026-11-03T09:00:00Z", null, true),
      ]);
      const next = otherBranch.steps.find((step) => step.state === "next")!;
      assert.equal(next.text, "next");
      assert.equal(next.due, null);

      const repeated = build(row(["View profile", "Invite", "Message", "View profile"], { status: "in_sequence", connection: "accepted", messaging: "sent" }), [
        ev("profile_viewed", "2026-11-01T09:00:00Z", null, true),
        ev("invite_sent", "2026-11-02T09:00:00Z", null, true),
        ev("invite_accepted", "2026-11-03T09:00:00Z", null, true),
        ev("message_sent", "2026-11-04T09:00:00Z", null, true),
      ]);
      assert.deepEqual(repeated.steps[3], { step: 4, label: "View profile", variant: null, state: "next", at: null, due: null, text: "next" });

      const plain = build(row(["Invite", "View profile", "Message"], { status: "in_sequence", connection: "sent", messaging: "none" }), [ev("invite_sent", "2026-11-18T09:00:00Z", null, true)]);
      assert.equal(plain.steps[1].text, "around 19 Nov");
    });
  });
});
