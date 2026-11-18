import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "@/lib/assistant/tools";
import { readCampaigns } from "@/lib/campaigns/agent";
import { conversationFilters, conversationsHref, readConversationView } from "@/lib/campaigns/conversation-view";
import { conversationsWaiting, listConversations, markConversationRead, needsReplyNow, previewText, type Conversation } from "@/lib/campaigns/conversations";
import { onlySenderMessage, replyToProspect } from "@/lib/campaigns/replies";
import { getProspectThread } from "@/lib/campaigns/threads";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { registerCampaignTools } from "@/server/mcp/campaigns";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

let owner: UserActor;
let ann: UserActor;
let outsider: UserActor;
const ids: Record<string, string> = {};
const live: LiveMessage[] = [];

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function campaign(actor: UserActor, name: string, channel: "email" | "linkedin", key: string) {
  const row = await sql<{ id: string }>(
    `insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status, sequence, variables, sender_ids, backfilled_at, synced_at)
     values ($1, $2, $3, $4, $5, 'active', '[]'::jsonb, '{}', $6, now(), now()) returning id`,
    [actor.workspaceId, channel === "email" ? "smartlead" : "heyreach", channel, key, name, channel === "linkedin" ? [`acct-${key}`] : []],
  );
  return row[0].id;
}

async function contact(actor: UserActor, first: string, last: string, email: string | null, linkedin: string | null = null) {
  const created = await createContact(actor, { firstName: first, lastName: last, email: email ?? undefined, linkedinUrl: linkedin ?? undefined }, { provenance: { operation: "test" } });
  const id = created.body.contact.id;
  const row = await sql<{ normalized_email: string | null; normalized_linkedin: string | null }>("select normalized_email, normalized_linkedin from crm.contacts where id = $1", [id]);
  return { id, email: row[0].normalized_email, linkedin: row[0].normalized_linkedin };
}

async function prospect(
  actor: UserActor,
  input: { campaignId: string; lead: string; contactId?: string | null; email?: string | null; linkedin?: string | null; sender?: string | null; category?: string | null; name?: [string, string]; company?: string },
) {
  const row = await sql<{ id: string }>(
    `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, email, linkedin, sender_id, state, external_lead_id, lead_status, pushed_at, category, lead)
     values ($1, $2, $3, $4, $5, $6, 'pushed', $7, 'in_progress', '2026-11-01T09:00:00Z', $8, $9::jsonb) returning id`,
    [
      actor.workspaceId,
      input.campaignId,
      input.contactId ?? null,
      input.email ?? null,
      input.linkedin ?? null,
      input.sender ?? null,
      input.lead,
      input.category ?? null,
      JSON.stringify({ firstName: input.name?.[0], lastName: input.name?.[1], companyName: input.company }),
    ],
  );
  return row[0].id;
}

let counter = 0;

async function message(
  actor: UserActor,
  prospectId: string,
  input: { direction: "inbound" | "outbound"; body: string; at: string; channel?: "email" | "linkedin"; sender?: string | null; automatic?: boolean; sendState?: string | null; from?: string | null },
) {
  const owned = await sql<{ campaign_id: string; channel: "email" | "linkedin" }>(
    "select p.campaign_id, k.channel from crm.campaign_prospects p join crm.campaigns k on k.id = p.campaign_id where p.id = $1",
    [prospectId],
  );
  const channel = input.channel ?? owned[0].channel;
  counter += 1;
  await sql(
    `insert into crm.campaign_messages (workspace_id, campaign_id, prospect_id, channel, direction, body, sent_at, external_id, conversation_id, sender_id, automatic, send_state, stats_id, from_address)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      actor.workspaceId,
      owned[0].campaign_id,
      prospectId,
      channel,
      input.direction,
      input.body,
      input.at,
      `msg-${counter}`,
      channel === "linkedin" ? `conv-${prospectId}` : null,
      channel === "linkedin" ? (input.sender ?? null) : null,
      input.automatic ?? false,
      input.sendState ?? null,
      channel === "email" ? `stats-${prospectId}` : null,
      input.from ?? null,
    ],
  );
}

function names(list: { conversations: Conversation[] }) {
  return list.conversations.map((item) => item.name).sort();
}

function byName(list: { conversations: Conversation[] }, name: string) {
  return list.conversations.find((item) => item.name === name);
}

async function mcpRead(actor: UserActor, args: Record<string, unknown>) {
  const server = new McpServer({ name: "crm", version: "1.0.0" });
  registerCampaignTools(server, actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "conversations-test", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name: "read_campaigns", arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!result.isError, result.content.map((part) => part.text).join(""));
    return JSON.parse(result.content.map((part) => part.text).join("")) as { conversations: Conversation[]; needsReply: number };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("campaign conversations", () => {
  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@conversations.test", "Mark Ridgeon");
    const second = await createUser("ann@conversations.test", "Ann Lee");
    outsider = await createUser("zed@elsewhere.test", "Zed Other");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, second.userId]);
    ann = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    setLiveTesting({ batch: async (messages) => void live.push(...messages) });

    const longevity = await campaign(owner, "Longevity Clinics", "linkedin", "li-1");
    const clinics = await campaign(owner, "Clinic owners Q4", "email", "em-1");
    const spring = await campaign(owner, "Spring follow-up", "email", "em-2");
    ids.longevity = longevity;
    ids.clinics = clinics;
    ids.spring = spring;
    await sql("insert into crm.campaign_senders (workspace_id, provider, external_id, name, email, user_id) values ($1, 'heyreach', 'acct-li-1', 'Mark Ridgeon', 'mark@conversations.test', $2)", [owner.workspaceId, owner.userId]);

    const priya = await contact(owner, "Priya", "Shah", "priya@vitalyears.test", "https://www.linkedin.com/in/priyashah");
    ids.priyaContact = priya.id;
    ids.priyaEmail = await prospect(owner, { campaignId: clinics, lead: "priya-em", contactId: priya.id, email: priya.email });
    ids.priyaLinkedin = await prospect(owner, { campaignId: longevity, lead: "priya-li", contactId: priya.id, linkedin: priya.linkedin, sender: "acct-li-1", category: "Interested" });
    await message(owner, ids.priyaEmail, { direction: "outbound", body: "Priya, saw Vital Years opened a second clinic.", at: "2026-11-12T09:00:00Z" });
    await message(owner, ids.priyaLinkedin, { direction: "outbound", body: "Hi Priya, would be good to connect.", at: "2026-11-13T09:00:00Z", sender: "acct-li-1" });
    await message(owner, ids.priyaLinkedin, { direction: "inbound", body: "Thanks Mark. Onboarding is exactly what we are stuck on.", at: "2026-11-15T09:41:00Z", sender: "acct-li-1" });

    ids.nina1 = await prospect(owner, { campaignId: clinics, lead: "nina-1", email: "nina@fischer.test", name: ["Nina", "Fischer"], company: "Fischer Longevity" });
    ids.nina2 = await prospect(owner, { campaignId: spring, lead: "nina-2", email: "nina@fischer.test", name: ["Nina", "Fischer"], company: "Fischer Longevity" });
    await message(owner, ids.nina1, { direction: "outbound", body: "Quick question, Nina.", at: "2026-11-10T09:00:00Z" });
    await message(owner, ids.nina2, { direction: "inbound", body: "Who else are you working with in Munich?", at: "2026-11-14T10:00:00Z" });

    const lena = await prospect(owner, { campaignId: longevity, lead: "lena", linkedin: "linkedin.com/in/lenahart", sender: "acct-li-1", name: ["Lena", "Hart"] });
    ids.lena = lena;
    await message(owner, lena, { direction: "inbound", body: "Sounds interesting, tell me more.", at: "2026-11-14T08:00:00Z", sender: "acct-li-1" });

    const james = await prospect(owner, { campaignId: clinics, lead: "james", email: "james@okafor.test", name: ["James", "Okafor"], category: "Meeting booked" });
    await message(owner, james, { direction: "inbound", body: "Thursday works.", at: "2026-11-13T10:00:00Z" });
    await message(owner, james, { direction: "outbound", body: "Great, I have sent a calendar invite for Thursday.", at: "2026-11-13T11:00:00Z" });

    const tom = await prospect(owner, { campaignId: clinics, lead: "tom", email: "tom@baker.test", name: ["Tom", "Baker"], category: "Not Interested" });
    await message(owner, tom, { direction: "inbound", body: "Not for us right now.", at: "2026-11-15T08:12:00Z" });

    const oscar = await prospect(owner, { campaignId: clinics, lead: "oscar", email: "oscar@away.test", name: ["Oscar", "Away"], category: "Out of office" });
    await message(owner, oscar, { direction: "inbound", body: "I'm away until Monday.", at: "2026-11-15T07:00:00Z" });

    const dina = await prospect(owner, { campaignId: clinics, lead: "dina", email: "dina@blocked.test", name: ["Dina", "Blocked"] });
    await message(owner, dina, { direction: "inbound", body: "Please remove me.", at: "2026-11-15T06:00:00Z" });
    await sql("insert into crm.suppressions (workspace_id, kind, value, reason, source) values ($1, 'email', 'dina@blocked.test', 'manual', 'test')", [owner.workspaceId]);

    const amelia = await prospect(owner, { campaignId: clinics, lead: "amelia", email: "amelia@hart.test", name: ["Amelia", "Hart"] });
    await message(owner, amelia, { direction: "outbound", body: "Thanks for connecting, Amelia.", at: "2026-11-11T09:00:00Z" });

    const robo = await prospect(owner, { campaignId: clinics, lead: "robo", email: "robo@auto.test", name: ["Robo", "Reply"] });
    await message(owner, robo, { direction: "outbound", body: "Hello.", at: "2026-11-11T09:00:00Z" });
    await message(owner, robo, { direction: "inbound", body: "Thanks for your email, this is an automatic reply.", at: "2026-11-11T09:01:00Z", automatic: true });

    const faye = await prospect(owner, { campaignId: clinics, lead: "faye", email: "faye@retry.test", name: ["Faye", "Retry"] });
    await message(owner, faye, { direction: "inbound", body: "Can you send pricing?", at: "2026-11-12T09:00:00Z" });
    await message(owner, faye, { direction: "outbound", body: "Here it is.", at: "2026-11-12T10:00:00Z", sendState: "failed" });

    const elsewhere = await campaign(outsider, "Elsewhere", "email", "em-out");
    const zara = await prospect(outsider, { campaignId: elsewhere, lead: "zara", email: "priya@vitalyears.test", name: ["Zara", "Hidden"] });
    await message(outsider, zara, { direction: "inbound", body: "A reply only the other workspace sees.", at: "2026-11-15T12:00:00Z" });
    ids.zara = zara;
  });

  useServerlessPool();

  after(async () => {
    setLiveTesting(null);
    await getPool().end();
    await getAdminPool().end();
  });

  it("shows one row per person across channels and campaigns", async () => {
    const all = await listConversations(owner, { needsReply: false });
    assert.deepEqual(names(all), ["Amelia Hart", "Dina Blocked", "Faye Retry", "James Okafor", "Lena Hart", "Nina Fischer", "Oscar Away", "Priya Shah", "Robo Reply", "Tom Baker"]);
    const priya = byName(all, "Priya Shah")!;
    assert.deepEqual(priya.channels, ["email", "linkedin"]);
    assert.deepEqual(priya.campaigns.map((item) => item.name), ["Longevity Clinics", "Clinic owners Q4"]);
    assert.equal(priya.prospectId, ids.priyaLinkedin);
    assert.equal(priya.category, "Interested");
    assert.equal(priya.messages, 3);
    assert.deepEqual(priya.lastMessage, { direction: "inbound", channel: "linkedin", text: "Thanks Mark. Onboarding is exactly what we are stuck on.", at: "2026-11-15T09:41:00.000Z" });
    const nina = byName(all, "Nina Fischer")!;
    assert.deepEqual(nina.campaigns.map((item) => item.name).sort(), ["Clinic owners Q4", "Spring follow-up"]);
    assert.equal(nina.prospectId, ids.nina2);
    assert.equal(byName(all, "James Okafor")!.lastMessage?.direction, "outbound");
    const order = all.conversations.map((item) => item.lastMessage!.at);
    assert.deepEqual(order, [...order].sort().reverse());
  });

  it("needs a reply only when their last message is newer than ours, not quiet and not Do not contact", async () => {
    const waiting = await listConversations(owner, {});
    assert.deepEqual(names(waiting), ["Faye Retry", "Lena Hart", "Nina Fischer", "Priya Shah"]);
    assert.equal(waiting.needsReply, 4);
    assert.equal(await conversationsWaiting(owner), 4);
    const all = await listConversations(owner, { needsReply: false });
    for (const name of ["James Okafor", "Tom Baker", "Oscar Away", "Dina Blocked", "Amelia Hart", "Robo Reply"]) assert.equal(byName(all, name)!.needsReply, false, name);
    assert.equal(byName(all, "Dina Blocked")!.doNotContact, true);
    assert.equal(needsReplyNow({ lastIn: new Date("2026-11-02"), lastOut: new Date("2026-11-01"), category: " out of OFFICE ", doNotContact: false }), false);
    assert.equal(needsReplyNow({ lastIn: new Date("2026-11-02"), lastOut: new Date("2026-11-03"), category: null, doNotContact: false }), false);
    assert.equal(needsReplyNow({ lastIn: new Date("2026-11-02"), lastOut: null, category: "Interested", doNotContact: false }), true);
  });

  it("filters by channel, campaign and search", async () => {
    assert.deepEqual(names(await listConversations(owner, { needsReply: false, channel: "linkedin" })), ["Lena Hart", "Priya Shah"]);
    assert.deepEqual(names(await listConversations(owner, { needsReply: false, campaignId: ids.spring })), ["Nina Fischer"]);
    assert.deepEqual(names(await listConversations(owner, { needsReply: false, search: "vitalyears" })), ["Priya Shah"]);
    assert.deepEqual(names(await listConversations(owner, { needsReply: false, search: "lenahart" })), ["Lena Hart"]);
    assert.deepEqual(names(await listConversations(owner, { needsReply: false, search: "fischer longevity" })), ["Nina Fischer"]);
    const limited = await listConversations(owner, { needsReply: false, limit: 2 });
    assert.equal(limited.conversations.length, 2);
    assert.equal(limited.more, true);
    await assert.rejects(listConversations(owner, { campaignId: "nope" }), (error: unknown) => error instanceof CrmError && error.code === "invalid_input");
  });

  it("keeps unread shared, cleared by opening the conversation and never by the assistant", async () => {
    assert.equal(byName(await listConversations(ann, {}), "Lena Hart")!.unread, true);
    await runTool(owner, "campaigns", { view: "thread", prospectId: ids.lena });
    await readCampaigns(owner, { view: "conversations" });
    await getProspectThread(owner, ids.lena);
    assert.equal(byName(await listConversations(ann, {}), "Lena Hart")!.unread, true, "reading through the assistant leaves it unread");

    const { actor: agent } = await createAgent(owner.workspaceId, ["crm:read"]);
    assert.deepEqual(await markConversationRead(agent, ids.lena), { read: 0 });

    live.length = 0;
    assert.equal(byName(await listConversations(ann, {}), "Priya Shah")!.unread, true);
    assert.deepEqual(await markConversationRead(owner, ids.priyaEmail), { read: 1 });
    assert.equal(byName(await listConversations(ann, {}), "Priya Shah")!.unread, false, "opened by Mark, read for Ann");
    assert.deepEqual(live.map((item) => [item.topic, item.event, item.payload]), [[`docs-workspace:${owner.workspaceId}`, "synced", { kind: "campaigns" }]]);
    assert.deepEqual(await markConversationRead(ann, ids.priyaLinkedin), { read: 0 });
    assert.equal(live.length, 1, "nothing to clear sends no signal");

    await message(owner, ids.priyaLinkedin, { direction: "inbound", body: "Also, can we do Tuesday?", at: "2026-11-15T10:00:00Z", sender: "acct-li-1" });
    assert.equal(byName(await listConversations(owner, {}), "Priya Shah")!.unread, true, "a new reply is unread again");
    await markConversationRead(ann, ids.priyaLinkedin);
    assert.equal(byName(await listConversations(owner, {}), "Priya Shah")!.unread, false);
    assert.equal(byName(await listConversations(owner, { needsReply: false }), "Robo Reply")!.unread, false, "an automatic reply isn't unread");
  });

  it("never shows or clears another workspace's conversations", async () => {
    const theirs = await listConversations(outsider, { needsReply: false });
    assert.deepEqual(names(theirs), ["Zara Hidden"]);
    assert.ok(!names(await listConversations(owner, { needsReply: false })).includes("Zara Hidden"));
    assert.deepEqual(names((await runTool(outsider, "campaigns", { view: "conversations", needsReply: false })) as { conversations: Conversation[] }), ["Zara Hidden"]);
    assert.deepEqual(names(await mcpRead(outsider, { view: "conversations", needs_reply: false })), ["Zara Hidden"]);
    await assert.rejects(markConversationRead(outsider, ids.lena), (error: unknown) => error instanceof CrmError && error.status === 404);
    await assert.rejects(markConversationRead(owner, ids.zara), (error: unknown) => error instanceof CrmError && error.status === 404);
    assert.equal(byName(await listConversations(outsider, {}), "Zara Hidden")!.unread, true);
    await assert.rejects(sql("select private.campaign_conversation_read($1, $2, $3::uuid[])", [owner.workspaceId, outsider.userId, [ids.lena]]), /forbidden/);
    assert.deepEqual(await sql("select private.campaign_conversation_read($1, $2, $3::uuid[]) as count", [outsider.workspaceId, outsider.userId, [ids.lena]]), [{ count: 0 }]);
  });

  it("only lets the sender's own member reply on LinkedIn", async () => {
    const theirs = await getProspectThread(ann, ids.lena);
    const option = theirs.replyOptions.find((item) => item.channel === "linkedin")!;
    assert.equal(option.canReply, false);
    assert.equal(option.reason, onlySenderMessage("Mark Ridgeon"));
    await assert.rejects(replyToProspect(ann, ids.lena, { text: "Happy to." }), (error: unknown) => error instanceof CrmError && error.code === "forbidden");
    const mine = (await getProspectThread(owner, ids.lena)).replyOptions.find((item) => item.channel === "linkedin")!;
    assert.equal(mine.canReply, true);
  });

  it("gives the assistant and MCP the same list as the screen", async () => {
    const screen = async (show: string, extra: Record<string, string> = {}) => listConversations(owner, conversationFilters(readConversationView({ show, ...extra })));
    const assistant = async (args: Record<string, unknown>) => (await runTool(owner, "campaigns", { view: "conversations", ...args })) as { conversations: Conversation[]; needsReply: number };
    const strip = (list: { conversations: Conversation[] }) => list.conversations.map((item) => JSON.stringify(item));
    assert.deepEqual(strip(await assistant({})), strip(await screen("needs_reply")));
    assert.deepEqual(strip(await mcpRead(owner, { view: "conversations" })), strip(await screen("needs_reply")));
    assert.deepEqual(strip(await assistant({ needsReply: false, channel: "linkedin" })), strip(await screen("linkedin")));
    assert.deepEqual(strip(await mcpRead(owner, { view: "conversations", needs_reply: false, channel: "email", campaign_id: ids.spring })), strip(await screen("email", { campaign: ids.spring })));
    assert.deepEqual(strip(await assistant({ needsReply: false, search: "priya" })), strip(await screen("all", { q: "priya" })));
    const row = (await assistant({})).conversations.find((item) => item.name === "Lena Hart")!;
    assert.deepEqual(Object.keys(row).sort(), ["campaigns", "category", "channels", "companyName", "contactId", "doNotContact", "lastMessage", "messages", "name", "needsReply", "prospectId", "unread"]);
    assert.equal((await assistant({ limit: 1 })).conversations.length, 1);
  });

  it("reads the screen's filters from the address and keeps them in links", () => {
    assert.deepEqual(readConversationView({}), { show: "needs_reply", campaignId: null, search: "" });
    assert.deepEqual(readConversationView({ show: "bogus", campaign: "not-a-uuid", q: "  priya " }), { show: "needs_reply", campaignId: null, search: "priya" });
    const view = readConversationView({ show: "linkedin", campaign: ids.longevity, q: "pri" });
    assert.deepEqual(conversationFilters(view), { needsReply: false, channel: "linkedin", campaignId: ids.longevity, search: "pri" });
    assert.equal(conversationsHref(view, ids.lena), `/campaigns/conversations/${ids.lena}?show=linkedin&campaign=${ids.longevity}&q=pri`);
    assert.equal(conversationsHref(readConversationView({}), null), "/campaigns/conversations");
  });

  it("previews email without the quoted text", () => {
    assert.equal(previewText("Sounds good.\n\nOn Mon, 10 Nov 2026 at 09:00, Mark wrote:\n> Quick question", "email"), "Sounds good.");
    assert.equal(previewText("Line one\n\nline two", "linkedin"), "Line one line two");
    assert.equal(previewText("x".repeat(900), "linkedin").length, 500);
  });

  it("names the member behind a sending mailbox and keeps the address, falling back to the address", async () => {
    await sql("update crm.profiles set other_emails = array['Mark@GetRidgeon.test'] where id = $1", [owner.userId]);
    const gil = await prospect(owner, { campaignId: ids.clinics, lead: "gil", email: "gil@mailbox.test", name: ["Gil", "Mailbox"] });
    await message(owner, gil, { direction: "outbound", body: "From Mark's mailbox.", at: "2026-11-09T09:00:00Z", from: "mark@getridgeon.test" });
    await message(owner, gil, { direction: "outbound", body: "From the agency's mailbox.", at: "2026-11-09T10:00:00Z", from: "sends@agency-mailbox.test" });
    await message(owner, gil, { direction: "outbound", body: "From the sign-in address.", at: "2026-11-09T11:00:00Z", from: "ann@conversations.test" });
    await message(owner, gil, { direction: "outbound", body: "From a lookalike mailbox with a name.", at: "2026-11-09T12:00:00Z", from: "Mark at Ridgeon <mark@ridgeon-mail.test>" });
    await message(owner, gil, { direction: "outbound", body: "From Mark's mailbox with a name.", at: "2026-11-09T13:00:00Z", from: "Someone Else <MARK@getridgeon.test>" });
    for (const viewer of [owner, ann]) {
      const thread = await getProspectThread(viewer, gil);
      const authors = thread.items.flatMap((item) => (item.type === "message" ? [[item.author, item.address]] : []));
      assert.deepEqual(authors, [
        ["Mark Ridgeon", "mark@getridgeon.test"],
        ["sends@agency-mailbox.test", "sends@agency-mailbox.test"],
        ["Ann Lee", "ann@conversations.test"],
        ["Mark at Ridgeon", "mark@ridgeon-mail.test"],
        ["Mark Ridgeon", "MARK@getridgeon.test"],
      ]);
    }
    const theirs = await sql<{ id: string }>("select id from crm.campaigns where workspace_id = $1", [outsider.workspaceId]);
    const stranger = await prospect(outsider, { campaignId: theirs[0].id, lead: "stranger", email: "stranger@elsewhere.test", name: ["Stranger", "Elsewhere"] });
    await message(outsider, stranger, { direction: "outbound", body: "Sent from a mailbox Mark owns elsewhere.", at: "2026-11-09T09:00:00Z", from: "mark@getridgeon.test" });
    const other = await getProspectThread(outsider, stranger);
    assert.deepEqual(other.items.flatMap((item) => (item.type === "message" ? [item.author] : [])), ["mark@getridgeon.test"], "only members of this workspace are named");
  });

  it("counts a row's messages, unread and Needs reply exactly as the thread it opens", async () => {
    const shared = await campaign(owner, "Chain email", "email", "em-chain");
    const bridge = await campaign(owner, "Chain bridge", "email", "em-bridge");
    const a = await prospect(owner, { campaignId: shared, lead: "chain-a", email: "kit@chain.test", name: ["Kit", "Chain"] });
    const b = await prospect(owner, { campaignId: bridge, lead: "chain-b", email: "kit@chain.test", linkedin: "linkedin.com/in/kitchain", name: ["Kit", "Chain"] });
    const c = await prospect(owner, { campaignId: ids.longevity, lead: "chain-c", linkedin: "linkedin.com/in/kitchain", sender: "acct-li-1", name: ["Kit", "Chain"] });
    await message(owner, a, { direction: "outbound", body: "Hello Kit.", at: "2026-11-10T09:00:00Z" });
    await message(owner, c, { direction: "inbound", body: "Hi, saw your email too.", at: "2026-11-11T09:00:00Z", sender: "acct-li-1" });
    const all = await listConversations(owner, { needsReply: false });
    assert.equal(all.conversations.filter((item) => item.name === "Kit Chain").length, 1, "A, B and C are one person through B");
    const kit = byName(all, "Kit Chain")!;
    assert.equal(kit.prospectId, c);
    assert.deepEqual(new Set((await getProspectThread(owner, a)).campaigns.map((item) => item.prospectId)), new Set([a, b, c]));
    for (const row of all.conversations) {
      const thread = await getProspectThread(owner, row.prospectId);
      const messages = thread.items.flatMap((item) => (item.type === "message" ? [item] : []));
      const lastIn = messages.filter((item) => item.direction === "inbound" && !item.automatic).at(-1)?.at ?? null;
      const lastOut = messages.filter((item) => item.direction === "outbound" && item.sendState !== "failed").at(-1)?.at ?? null;
      const ids = thread.campaigns.map((item) => item.prospectId);
      const unread = await sql<{ unread: boolean }>(
        `select exists (select 1 from crm.campaign_messages m join crm.campaign_prospects p on p.id = m.prospect_id
           where p.id = any($1::uuid[]) and m.direction = 'inbound' and not m.automatic and m.created_at > coalesce(p.conversation_read_at, '-infinity'::timestamptz)) as unread`,
        [ids],
      );
      assert.equal(row.messages, messages.length, `${row.name} messages`);
      assert.equal(row.unread, unread[0].unread, `${row.name} unread`);
      assert.equal(
        row.needsReply,
        needsReplyNow({ lastIn: lastIn ? new Date(lastIn) : null, lastOut: lastOut ? new Date(lastOut) : null, category: thread.category, doNotContact: Boolean(thread.doNotContact) }),
        `${row.name} needs reply`,
      );
    }
    assert.deepEqual(await markConversationRead(owner, a), { read: 1 }, "opening through A clears C");
    assert.equal(byName(await listConversations(owner, { needsReply: false }), "Kit Chain")!.unread, false);
    assert.equal(await conversationsWaiting(owner), (await listConversations(owner, {})).needsReply);
  });

  it("counts the assistant's waiting people within its channel, and the screen's across channels", async () => {
    const screen = await listConversations(owner, { needsReply: true, channel: "linkedin" });
    const assistant = (await runTool(owner, "campaigns", { view: "conversations", channel: "linkedin" })) as { needsReply: number; conversations: Conversation[] };
    assert.equal(assistant.needsReply, assistant.conversations.length);
    assert.equal(screen.needsReply, (await listConversations(owner, {})).needsReply);
    assert.ok(screen.needsReply > assistant.needsReply);
    assert.equal((await mcpRead(owner, { view: "conversations", channel: "linkedin" })).needsReply, assistant.needsReply);
  });
});
