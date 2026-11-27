import "./svg-stub";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as pdfRoute } from "@/app/api/d/[token]/pdf/route";
import { GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import PublicDocPage from "@/app/d/[token]/page";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { removeMember } from "@/lib/crm/team";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { isExpiryDay } from "@/lib/docs/public-expiry";
import { toPage } from "@/lib/docs/view";
import { addDays, addMonths, availabilityLabel, daysLeft, endOfDayInstant, expiryDayOf, expiryLabel, londonToday, presetDay, presetOf } from "@/lib/docs/public-expiry";
import { openPublicDoc, publicDocPdf } from "@/lib/docs/public";
import { createDoc, getDoc, listDocs, setDocPublic, updateDoc } from "@/lib/docs/store";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebhook, deliverDueWebhooks } from "@/lib/crm/webhooks";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const NOW = new Date(Date.now() + 2 * 86_400_000);

let mark: UserActor;
let priya: UserActor;
let agent: AgentActor;
let agentToken = "";
let otherAgent: AgentActor;

function tokenOf(url: string | null) {
  const match = /\/d\/([A-Za-z0-9_-]{32})$/.exec(url ?? "");
  assert.ok(match, `a public url, got ${url}`);
  return match[1];
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pageParams = (token: string) => ({ params: Promise.resolve({ token }) });

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "public-timers", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      return { error: result.isError ? text : null, value: result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function setExpiry(docId: string, sql: string) {
  await getAdminPool().query(`update crm.pages set public_expires_at = ${sql} where id = $1`, [docId]);
}

async function addMember(email: string, name: string, role: "member" | "admin") {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, id, role]);
  return { ...mark, userId: id, email, fullName: name, role, scopes: scopesForRole(role) } as UserActor;
}

async function asAgent(actor: AgentActor, sql: string, values: unknown[]) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true), set_config('app.agent_id', $2, true), set_config('app.actor_type', 'agent', true)", [actor.workspaceId, actor.agentId]);
    await client.query("set local role crm_agent");
    return (await client.query(sql, values)).rows;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@docs-timers.test", "Mark Ridgeon");
  priya = await addMember("priya@docs-timers.test", "Priya Shah", "member");
  const made = await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Claude Code");
  agent = made.actor;
  agentToken = made.token;
  otherAgent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Other agent")).actor;
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.SITE_URL;
  await getPool().end();
  await getAdminPool().end();
});

describe("Public doc timers: London end of day", () => {
  it("lands the presets on midnight UK time across the March clock change", () => {
    const before = new Date("2027-03-10T12:00:00Z");
    assert.equal(presetDay("7d", before), "2027-03-17");
    assert.equal(endOfDayInstant(presetDay("7d", before)).toISOString(), "2027-03-18T00:00:00.000Z");
    assert.equal(presetDay("30d", before), "2027-04-09");
    assert.equal(endOfDayInstant(presetDay("30d", before)).toISOString(), "2027-04-09T23:00:00.000Z");
    const change = new Date("2027-03-21T12:00:00Z");
    assert.equal(presetDay("7d", change), "2027-03-28");
    assert.equal(endOfDayInstant("2027-03-28").toISOString(), "2027-03-28T23:00:00.000Z");
    assert.equal(endOfDayInstant("2027-03-27").toISOString(), "2027-03-28T00:00:00.000Z");
  });

  it("lands the presets on midnight UK time across the October clock change", () => {
    assert.equal(endOfDayInstant(presetDay("7d", new Date("2027-10-20T12:00:00Z"))).toISOString(), "2027-10-27T23:00:00.000Z");
    assert.equal(presetDay("7d", new Date("2027-10-24T12:00:00Z")), "2027-10-31");
    assert.equal(endOfDayInstant("2027-10-31").toISOString(), "2027-11-01T00:00:00.000Z");
    assert.equal(endOfDayInstant(presetDay("7d", new Date("2027-10-25T12:00:00Z"))).toISOString(), "2027-11-02T00:00:00.000Z");
    assert.equal(presetDay("3m", new Date("2027-07-31T12:00:00Z")), "2027-10-31");
    assert.equal(endOfDayInstant("2027-10-31").toISOString(), "2027-11-01T00:00:00.000Z");
  });

  it("counts months from today and keeps to the end of a short month", () => {
    assert.equal(addMonths("2027-01-31", 3), "2027-04-30");
    assert.equal(addMonths("2028-02-29", 12), "2029-02-28");
    assert.equal(presetDay("3m", new Date("2026-11-26T09:00:00Z")), "2027-02-26");
    assert.equal(presetDay("12m", new Date("2026-11-26T09:00:00Z")), "2027-11-26");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  it("counts today in London, so late evening in summer is already the next day", () => {
    assert.equal(londonToday(new Date("2027-06-10T23:30:00Z")), "2027-06-11");
    assert.equal(londonToday(new Date("2027-12-10T23:30:00Z")), "2027-12-10");
    assert.equal(presetDay("7d", new Date("2027-06-10T23:30:00Z")), "2027-06-18");
  });

  it("names the day a timer covers, not the midnight after it", () => {
    const instant = endOfDayInstant("2026-12-26");
    assert.equal(expiryDayOf(instant), "2026-12-26");
    assert.equal(expiryLabel(instant.toISOString()), "26 Dec 2026");
    assert.equal(presetOf(instant, new Date("2026-11-26T09:00:00Z")), "30d");
    assert.equal(presetOf(endOfDayInstant("2026-12-27"), new Date("2026-11-26T09:00:00Z")), null);
    assert.equal(presetOf(null), null);
  });

  it("words the countdown for many days, one day and the last day", () => {
    const instant = endOfDayInstant("2026-12-26").toISOString();
    assert.equal(daysLeft(instant, new Date("2026-11-26T09:00:00Z")), 30);
    assert.equal(availabilityLabel(instant, new Date("2026-11-26T09:00:00Z")), "Available for 30 more days, until 26 Dec 2026");
    assert.equal(availabilityLabel(instant, new Date("2026-12-24T09:00:00Z")), "Available for 2 more days, until 26 Dec 2026");
    assert.equal(availabilityLabel(instant, new Date("2026-12-25T00:30:00Z")), "Available for 1 more day, until 26 Dec 2026");
    assert.equal(availabilityLabel(instant, new Date("2026-12-26T00:00:00Z")), "Available until midnight tonight");
    assert.equal(availabilityLabel(instant, new Date("2026-12-26T23:59:00Z")), "Available until midnight tonight");
  });

  it("reads a summer end of day in London, not UTC", () => {
    const instant = endOfDayInstant("2027-07-01");
    assert.equal(instant.toISOString(), "2027-07-01T23:00:00.000Z");
    assert.equal(availabilityLabel(instant, new Date("2027-07-01T22:30:00Z")), "Available until midnight tonight");
  });
});

describe("Public doc timers: the link and the PDF", () => {
  useServerlessPool();

  it("defaults to no expiry, and the link counts as live until the timer runs out", async () => {
    const doc = await createDoc(mark, { title: "Default", content: "Body" });
    assert.equal((await getDoc(mark, doc.id)).publicExpiresAt, null);
    const on = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(on.publicExpiresAt, null);
    assert.ok(await openPublicDoc(tokenOf(on.publicUrl)));
  });

  it("sets a timer with the link, replaces it, lengthens it and clears it", async () => {
    const doc = await createDoc(mark, { title: "Timer", content: "Body" });
    const day = presetDay("30d", NOW);
    const made = await setDocPublic(mark, doc.id, { public: true, expiresAt: day });
    assert.equal(made.public, true);
    assert.equal(made.publicExpiresAt, endOfDayInstant(day).toISOString());
    const shorter = await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d", NOW) });
    assert.equal(shorter.publicExpiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
    const longer = await setDocPublic(mark, doc.id, { expiresAt: presetDay("12m", NOW) });
    assert.equal(longer.publicExpiresAt, endOfDayInstant(presetDay("12m", NOW)).toISOString());
    assert.equal(longer.publicUrl, made.publicUrl);
    const cleared = await setDocPublic(mark, doc.id, { expiresAt: null });
    assert.equal(cleared.publicExpiresAt, null);
    assert.equal(cleared.public, true);
  });

  it("stores the London end of day through a clock change", async () => {
    const doc = await createDoc(mark, { title: "Clocks", content: "Body" });
    await setDocPublic(mark, doc.id, { public: true });
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: "2030-03-30" })).publicExpiresAt, "2030-03-31T00:00:00.000Z");
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: "2030-03-31" })).publicExpiresAt, "2030-03-31T23:00:00.000Z");
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: "2030-10-26" })).publicExpiresAt, "2030-10-26T23:00:00.000Z");
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: "2030-10-27" })).publicExpiresAt, "2030-10-28T00:00:00.000Z");
  });

  it("returns not found for an expired page and PDF straight away, with nothing running in the background", async () => {
    const doc = await createDoc(mark, { title: "Expires", content: "Body" });
    const made = await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("7d", NOW) });
    const token = tokenOf(made.publicUrl);
    assert.ok(await openPublicDoc(token));
    assert.ok(await publicDocPdf(token));
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 200);

    await setExpiry(doc.id, "now() - interval '1 second'");
    assert.equal(await openPublicDoc(token), null);
    assert.equal(await publicDocPdf(token), null);
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 404);
    await assert.rejects(PublicDocPage(pageParams(token)), (error: { digest?: string }) => String(error.digest).includes("404"));
    const stored = await getAdminPool().query<{ public_enabled: boolean }>("select public_enabled from crm.pages where id = $1", [doc.id]);
    assert.equal(stored.rows[0].public_enabled, true, "nothing clears the stored switch");
  });

  it("stops serving a link that runs out between two requests", async () => {
    const doc = await createDoc(mark, { title: "Between", content: "Body" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true, allowDownload: true })).publicUrl);
    await setExpiry(doc.id, "now() + interval '1 hour'");
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 200);
    assert.ok(renderToStaticMarkup(await PublicDocPage(pageParams(token))).includes("Between"));
    await setExpiry(doc.id, "now() - interval '1 millisecond'");
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 404);
    await assert.rejects(PublicDocPage(pageParams(token)), (error: { digest?: string }) => String(error.digest).includes("404"));
  });

  it("reads as off everywhere once it has run out, and shows when", async () => {
    const doc = await createDoc(mark, { title: "Reads off", content: "Body", shared: true });
    const made = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(doc.id, "now() - interval '1 day'");
    const read = await getDoc(mark, doc.id);
    assert.equal(read.public, false);
    assert.equal(read.publicUrl, null);
    assert.ok(read.publicExpiresAt);
    assert.equal((await getDoc(priya, doc.id)).public, false);
    const listed = (await listDocs(mark, {})).data.find((item) => item.id === doc.id);
    assert.equal(listed?.public, false);
    assert.equal(toPage(mark, await getDoc(mark, doc.id)).public, false);
    assert.ok(made.publicUrl);
  });

  it("turns back on with the same url and no timer", async () => {
    const doc = await createDoc(mark, { title: "Back on", content: "Body" });
    const first = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(doc.id, "now() - interval '1 hour'");
    assert.equal((await getDoc(mark, doc.id)).public, false);
    const back = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(back.public, true);
    assert.equal(back.publicUrl, first.publicUrl);
    assert.equal(back.publicExpiresAt, null);
    assert.ok(await openPublicDoc(tokenOf(back.publicUrl)));
  });

  it("clears the timer when the link is turned off by hand, and starts again with none", async () => {
    const doc = await createDoc(mark, { title: "Off by hand", content: "Body" });
    const first = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("30d", NOW) });
    const off = await setDocPublic(mark, doc.id, { public: false });
    assert.equal(off.public, false);
    assert.equal(off.publicExpiresAt, null);
    const on = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(on.publicExpiresAt, null);
    assert.equal(on.publicUrl, first.publicUrl);
  });

  it("rejects past dates, bad dates and a timer on a link that is off", async () => {
    const doc = await createDoc(mark, { title: "Rejects", content: "Body" });
    await setDocPublic(mark, doc.id, { public: true });
    const today = londonToday();
    const yesterday = addDays(today, -1);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: yesterday }), /That date has passed\. Pick today or a later date\./);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "2030-02-30" }), /YYYY-MM-DD/);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "next week" }), /YYYY-MM-DD/);
    assert.equal((await getDoc(mark, doc.id)).publicExpiresAt, null);
    const onToday = await setDocPublic(mark, doc.id, { expiresAt: today });
    assert.equal(onToday.publicExpiresAt, endOfDayInstant(today).toISOString());
    await setDocPublic(mark, doc.id, { public: false });
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: presetDay("7d", NOW) }), /Turn the public link on/);
    await assert.rejects(setDocPublic(mark, doc.id, { public: false, expiresAt: presetDay("7d", NOW) }), /Turn the public link on/);
  });

  it("keeps the download choice across a timer running out", async () => {
    const doc = await createDoc(mark, { title: "Download kept", content: "Body" });
    await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(doc.id, "now() - interval '1 hour'");
    const back = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(back.allowDownload, true);
  });

  it("sets the timer through updateDoc and records it in the audit event", async () => {
    const doc = await createDoc(mark, { title: "Audited", content: "Body", shared: true });
    const day = presetDay("30d", NOW);
    const result = await updateDoc(mark, doc.id, { public: true, expiresAt: day });
    assert.equal(result.doc.publicExpiresAt, endOfDayInstant(day).toISOString());
    const rows = await getAdminPool().query<{ changes: unknown }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'page.public_changed'", [doc.id]);
    assert.ok(JSON.stringify(rows.rows.at(-1)?.changes).includes(endOfDayInstant(day).toISOString()));
  });
});

describe("Public doc timers: the page", () => {
  useServerlessPool();

  it("shows nothing about time when there is no timer", async () => {
    const doc = await createDoc(mark, { title: "No timer page", content: "Body" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    assert.ok(!renderToStaticMarkup(await PublicDocPage(pageParams(token))).includes("Available"));
  });

  it("counts the days left, one day and the last day, in London time", async () => {
    const doc = await createDoc(mark, { title: "Countdown page", content: "Body" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    const render = async () => renderToStaticMarkup(await PublicDocPage(pageParams(token)));

    const today = londonToday();
    const thirty = addDays(today, 30);
    await setDocPublic(mark, doc.id, { expiresAt: thirty });
    assert.ok((await render()).includes(`Available for 30 more days, until ${expiryLabel(endOfDayInstant(thirty))}`));

    const tomorrow = addDays(today, 1);
    await setDocPublic(mark, doc.id, { expiresAt: tomorrow });
    assert.ok((await render()).includes(`Available for 1 more day, until ${expiryLabel(endOfDayInstant(tomorrow))}`));

    await setDocPublic(mark, doc.id, { expiresAt: today });
    assert.ok((await render()).includes("Available until midnight tonight"));
  });

  it("leaves the line out of the PDF", async () => {
    const doc = await createDoc(mark, { title: "PDF without the line", content: "Body text" });
    const made = await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("30d", NOW) });
    const { extractText, getDocumentProxy } = await import("unpdf");
    const file = await publicDocPdf(tokenOf(made.publicUrl));
    assert.ok(file);
    const text = (await extractText(await getDocumentProxy(new Uint8Array(file.data)), { mergePages: true })).text;
    assert.ok(text.includes("Body text"));
    assert.ok(!text.includes("Available"));
  });

  it("returns the expiry from the public function and nothing that identifies the doc", async () => {
    const doc = await createDoc(mark, { title: "Payload timer", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d", NOW) })).publicUrl);
    const opened = await openPublicDoc(token);
    assert.equal(opened?.expiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
    assert.ok(!JSON.stringify(opened).includes(doc.id));
  });
});

describe("Public doc timers: who can change them", () => {
  useServerlessPool();

  it("lets the owner set it and refuses a teammate in the app and the database", async () => {
    const doc = await createDoc(mark, { title: "Owner timer", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("30d", NOW) });
    await assert.rejects(setDocPublic(priya, doc.id, { expiresAt: presetDay("7d", NOW) }), /Only Mark Ridgeon can change this note's public link/);
    await assert.rejects(setDocPublic(priya, doc.id, { public: true, expiresAt: presetDay("7d", NOW) }), /Only Mark Ridgeon can change/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_expires_at = null where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await getDoc(priya, doc.id)).canChangePublic, false);
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d", NOW) })).publicExpiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
    const own = await queryAsUser(mark.userId, "update crm.pages set public_expires_at = null where id = $1 returning id", [doc.id]);
    assert.equal(own.length, 1);
  });

  it("refuses an agent that didn't make the doc, and lets the one that did", async () => {
    const doc = await createDoc(agent, { title: "Agent timer", content: "Body" });
    await setDocPublic(agent, doc.id, { public: true });
    await assert.rejects(setDocPublic(otherAgent, doc.id, { expiresAt: presetDay("7d", NOW) }), /Only Claude Code or the workspace owner/);
    await assert.rejects(asAgent(otherAgent, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    assert.equal((await asAgent(agent, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id])).length, 1);
    assert.equal((await setDocPublic(agent, doc.id, { expiresAt: presetDay("30d", NOW) })).publicExpiresAt, endOfDayInstant(presetDay("30d", NOW)).toISOString());
    const marks = await createDoc(mark, { title: "Mark's for the agent", content: "Body", shared: true });
    await assert.rejects(setDocPublic(agent, marks.id, { public: true, expiresAt: presetDay("7d", NOW) }), /Only Mark Ridgeon can change/);
  });

  it("lets the workspace owner, but not an admin or a member, change an agent-made doc's timer", async () => {
    const admin = await addMember("admin@docs-timers.test", "Ada Admin", "admin");
    const doc = await createDoc(agent, { title: "Agent-made timer", content: "Body" });
    await setDocPublic(agent, doc.id, { public: true });
    await assert.rejects(setDocPublic(admin, doc.id, { expiresAt: presetDay("7d", NOW) }), /Only Claude Code or the workspace owner/);
    await assert.rejects(setDocPublic(priya, doc.id, { expiresAt: presetDay("7d", NOW) }), /Only Claude Code or the workspace owner/);
    await assert.rejects(queryAsUser(admin.userId, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    const set = await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d", NOW) });
    assert.equal(set.publicExpiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
  });

  it("keeps the timer when a leaver's link is turned off by the nested trigger", async () => {
    const leaver = await addMember("leaver@docs-timers.test", "Lee Leaver", "member");
    const doc = await createDoc(leaver, { title: "Leaver timer", content: "Body", shared: true });
    const url = (await setDocPublic(leaver, doc.id, { public: true, expiresAt: presetDay("30d", NOW) })).publicUrl;
    await removeMember(mark, leaver.userId);
    const row = await getAdminPool().query<{ public_enabled: boolean; public_expires_at: Date | null }>("select public_enabled, public_expires_at from crm.pages where id = $1", [doc.id]);
    assert.equal(row.rows[0].public_enabled, false);
    assert.equal(row.rows[0].public_expires_at?.toISOString(), endOfDayInstant(presetDay("30d", NOW)).toISOString());
    assert.equal(await openPublicDoc(tokenOf(url)), null);
  });
});

describe("Public doc timers: API, MCP and assistant", () => {
  useServerlessPool();

  it("sets, reads and clears the timer over the REST API", async () => {
    const own = await createDoc(agent, { title: "API timer", content: "Hello" });
    const day = presetDay("30d", NOW);
    const patched = await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: true, expiresAt: day }), params(own.id));
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as { doc: { public: boolean; publicExpiresAt: string | null } };
    assert.equal(body.doc.public, true);
    assert.equal(body.doc.publicExpiresAt, endOfDayInstant(day).toISOString());
    const read = (await (await readRoute(request(`/docs/${own.id}`), params(own.id))).json()) as { doc: { publicExpiresAt: string | null } };
    assert.equal(read.doc.publicExpiresAt, body.doc.publicExpiresAt);
    const changed = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: presetDay("7d", NOW) }), params(own.id));
    assert.equal(((await changed.json()) as { doc: { publicExpiresAt: string } }).doc.publicExpiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
    const cleared = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: null }), params(own.id));
    assert.equal(((await cleared.json()) as { doc: { publicExpiresAt: string | null } }).doc.publicExpiresAt, null);
  });

  it("rejects past and malformed dates over the REST API with a message", async () => {
    const own = await createDoc(agent, { title: "API past", content: "Hello" });
    await setDocPublic(agent, own.id, { public: true });
    const past = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: addDays(londonToday(), -1) }), params(own.id));
    assert.equal(past.status, 400);
    assert.match(JSON.stringify(await past.json()), /That date has passed/);
    const bad = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: "soon" }), params(own.id));
    assert.equal(bad.status, 400);
    const number = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: 5 }), params(own.id));
    assert.equal(number.status, 400);
    const marks = await createDoc(mark, { title: "Mark's API timer", content: "Hi", shared: true });
    const refused = await patchRoute(request(`/docs/${marks.id}`, "PATCH", { public: true, expiresAt: presetDay("7d", NOW) }), params(marks.id));
    assert.equal(refused.status, 403);
  });

  it("sets, reads and clears the timer over MCP", async () => {
    const personal = await connect(mark);
    const workspace = await connect(agent);
    try {
      const doc = await createDoc(mark, { title: "MCP timer", content: "Body" });
      const day = presetDay("3m", NOW);
      const on = (await personal.call("set_doc_public", { id: doc.id, public: true, expires_at: day })).value!.doc as { public: boolean; publicExpiresAt: string };
      assert.equal(on.public, true);
      assert.equal(on.publicExpiresAt, endOfDayInstant(day).toISOString());
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { publicExpiresAt: string };
      assert.equal(read.publicExpiresAt, on.publicExpiresAt);
      const only = (await personal.call("set_doc_public", { id: doc.id, expires_at: presetDay("7d", NOW) })).value!.doc as { publicExpiresAt: string };
      assert.equal(only.publicExpiresAt, endOfDayInstant(presetDay("7d", NOW)).toISOString());
      const cleared = (await personal.call("set_doc_public", { id: doc.id, expires_at: null })).value!.doc as { publicExpiresAt: string | null };
      assert.equal(cleared.publicExpiresAt, null);
      assert.match((await personal.call("set_doc_public", { id: doc.id, expires_at: addDays(londonToday(), -1) })).error ?? "", /That date has passed/);
      assert.match((await personal.call("set_doc_public", { id: doc.id, expires_at: "tomorrow" })).error ?? "", /YYYY-MM-DD/);
      const shared = await createDoc(mark, { title: "MCP shared timer", content: "Body", shared: true });
      assert.match((await workspace.call("set_doc_public", { id: shared.id, public: true, expires_at: day })).error ?? "", /forbidden: Only Mark Ridgeon/);
      const own = await createDoc(agent, { title: "MCP agent timer", content: "Body" });
      const mine = (await workspace.call("set_doc_public", { id: own.id, public: true, expires_at: day })).value!.doc as { publicExpiresAt: string };
      assert.equal(mine.publicExpiresAt, endOfDayInstant(day).toISOString());
    } finally {
      await personal.close();
      await workspace.close();
    }
  });

  it("names the date on the assistant's approval card and runs it", async () => {
    const doc = await createDoc(mark, { title: "Assistant timer", content: "Body" });
    const day = presetDay("30d", NOW);
    const label = expiryLabel(endOfDayInstant(day));
    const publish = { action: "publish", docId: doc.id, expiresAt: day };
    const publishCard = describeAction("save_doc", publish, await recordNames(mark, [publish], ["save_doc"]));
    assert.equal(publishCard.title, `Turn on the public link until ${label}`);
    assert.deepEqual(publishCard.lines, ["Assistant timer", `Anyone with the link can read it until ${label}. Download stays off. Comments stay off.`]);
    const published = (await runTool(mark, "save_doc", publish)) as { saved: boolean; doc: { public: boolean; publicExpiresAt: string } };
    assert.equal(published.saved, true);
    assert.equal(published.doc.public, true);
    assert.equal(published.doc.publicExpiresAt, endOfDayInstant(day).toISOString());

    const later = presetDay("3m", NOW);
    const timer = { action: "set_timer", docId: doc.id, expiresAt: later };
    const timerCard = describeAction("save_doc", timer, await recordNames(mark, [timer], ["save_doc"]));
    assert.equal(timerCard.title, `Turn off the public link on ${expiryLabel(endOfDayInstant(later))}`);
    assert.match((await runTool(mark, "save_doc", timer, { unattended: true }) as { error: string }).error, /Only edits to a doc's text/);
    assert.equal(((await runTool(mark, "save_doc", timer)) as { doc: { publicExpiresAt: string } }).doc.publicExpiresAt, endOfDayInstant(later).toISOString());

    const clear = { action: "set_timer", docId: doc.id };
    const clearCard = describeAction("save_doc", clear, await recordNames(mark, [clear], ["save_doc"]));
    assert.equal(clearCard.title, "Remove the timer on the public link");
    assert.equal(((await runTool(mark, "save_doc", clear)) as { doc: { publicExpiresAt: string | null } }).doc.publicExpiresAt, null);
  });

  it("warns on the card and refuses a past date or a timer on a link that is off", async () => {
    const doc = await createDoc(mark, { title: "Assistant past", content: "Body" });
    const past = addDays(londonToday(), -2);
    const publish = { action: "publish", docId: doc.id, expiresAt: past };
    const card = describeAction("save_doc", publish, await recordNames(mark, [publish], ["save_doc"]));
    assert.ok(card.lines.some((line) => line.includes("That date has passed")));
    assert.match(((await runTool(mark, "save_doc", publish)) as { error: string }).error, /That date has passed/);
    assert.equal((await getDoc(mark, doc.id)).public, false);

    const off = { action: "set_timer", docId: doc.id, expiresAt: presetDay("7d", NOW) };
    const offCard = describeAction("save_doc", off, await recordNames(mark, [off], ["save_doc"]));
    assert.ok(offCard.lines.some((line) => line.includes("The public link is off")));
    assert.match(((await runTool(mark, "save_doc", off)) as { error: string }).error, /Turn the public link on/);
  });

  it("refuses the assistant on a teammate's doc", async () => {
    const theirs = await createDoc(priya, { title: "Priya's timer doc", content: "Body", shared: true });
    const timer = { action: "set_timer", docId: theirs.id, expiresAt: presetDay("7d", NOW) };
    assert.match(((await runTool(mark, "save_doc", timer)) as { error: string }).error, /Only Priya Shah can change/);
  });
});

describe("Public doc timers: review fixes", () => {
  useServerlessPool();

  it("keeps the helpers in London time whatever the server's zone, and handles a leap day", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      assert.equal(londonToday(new Date("2027-06-10T23:30:00Z")), "2027-06-11");
      assert.equal(endOfDayInstant("2027-03-27").toISOString(), "2027-03-28T00:00:00.000Z");
      assert.equal(endOfDayInstant("2027-03-28").toISOString(), "2027-03-28T23:00:00.000Z");
      assert.equal(presetDay("7d", new Date("2027-10-24T12:00:00Z")), "2027-10-31");
      assert.equal(availabilityLabel(endOfDayInstant("2027-07-01"), new Date("2027-07-01T22:30:00Z")), "Available until midnight tonight");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    assert.equal(addMonths("2028-02-29", 3), "2028-05-29");
    assert.equal(addMonths("2027-11-29", 3), "2028-02-29");
    assert.equal(addMonths("2027-11-30", 3), "2028-02-29");
  });

  it("only accepts real days in a sensible range", () => {
    assert.equal(isExpiryDay("2100-12-31"), true);
    assert.equal(isExpiryDay("9999-12-31"), false);
    assert.equal(isExpiryDay("2101-01-01"), false);
    assert.equal(isExpiryDay(""), false);
    assert.equal(isExpiryDay("2030-02-30"), false);
    assert.throws(() => endOfDayInstant(""), RangeError);
    assert.throws(() => endOfDayInstant("9999-12-31"), RangeError);
  });

  it("rejects an empty or far-future day cleanly in the app, the API and MCP", async () => {
    const doc = await createDoc(agent, { title: "Bad days", content: "Body" });
    await setDocPublic(agent, doc.id, { public: true });
    await assert.rejects(setDocPublic(agent, doc.id, { expiresAt: "" }), /YYYY-MM-DD/);
    await assert.rejects(setDocPublic(agent, doc.id, { expiresAt: "9999-12-31" }), /no later than 2100/);
    for (const bad of ["", "9999-12-31"]) {
      const response = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { expiresAt: bad }), params(doc.id));
      assert.equal(response.status, 400);
    }
    const workspace = await connect(agent);
    try {
      assert.match((await workspace.call("set_doc_public", { id: doc.id, expires_at: "9999-12-31" })).error ?? "", /no later than 2100/);
      assert.match((await workspace.call("set_doc_public", { id: doc.id, expires_at: "" })).error ?? "", /YYYY-MM-DD/);
    } finally {
      await workspace.close();
    }
    assert.equal((await getDoc(agent, doc.id)).publicExpiresAt, null);
  });

  it("changes download on an expired link without turning the stored link off or firing an event", async () => {
    const doc = await createDoc(mark, { title: "Expired download", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(doc.id, "now() - interval '1 hour'");
    const events = async () => (await getAdminPool().query("select 1 from crm.audit_events where entity_id = $1 and event_type = 'page.public_changed'", [doc.id])).rowCount;
    const before = await events();
    const changed = await setDocPublic(mark, doc.id, { allowDownload: true });
    assert.equal(changed.allowDownload, true);
    assert.equal(changed.public, false);
    assert.ok(changed.publicExpiresAt, "the ran-out timer is kept");
    const stored = await getAdminPool().query<{ public_enabled: boolean }>("select public_enabled from crm.pages where id = $1", [doc.id]);
    assert.equal(stored.rows[0].public_enabled, true);
    assert.equal(await events(), before, "no event for a change nobody can see");
    const workspace = await connect(mark);
    try {
      const viaMcp = (await workspace.call("set_doc_public", { id: doc.id, allow_download: false })).value!.doc as { public: boolean; publicExpiresAt: string | null };
      assert.equal(viaMcp.public, false);
      assert.ok(viaMcp.publicExpiresAt);
    } finally {
      await workspace.close();
    }
    assert.equal(await events(), before);
    const noop = await setDocPublic(mark, doc.id, { public: false });
    assert.equal(noop.public, false);
    assert.ok(noop.publicExpiresAt);

    const stillStored = async () => (await getAdminPool().query<{ public_enabled: boolean; public_expires_at: Date | null }>("select public_enabled, public_expires_at from crm.pages where id = $1", [doc.id])).rows[0];
    const kept = await stillStored();
    const cleared = await setDocPublic(mark, doc.id, { expiresAt: null });
    assert.equal(cleared.public, false);
    assert.ok(cleared.publicExpiresAt, "removing the timer on a ran-out link keeps the caption");
    const agentDoc = await createDoc(agent, { title: "Expired over REST", content: "Body" });
    await setDocPublic(agent, agentDoc.id, { public: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(agentDoc.id, "now() - interval '1 hour'");
    const viaRest = await patchRoute(request(`/docs/${agentDoc.id}`, "PATCH", { expiresAt: null }), params(agentDoc.id));
    assert.equal(viaRest.status, 200);
    const restDoc = ((await viaRest.json()) as { doc: { public: boolean; publicExpiresAt: string | null } }).doc;
    assert.equal(restDoc.public, false);
    assert.ok(restDoc.publicExpiresAt);
    const restStored = await getAdminPool().query<{ public_enabled: boolean }>("select public_enabled from crm.pages where id = $1", [agentDoc.id]);
    assert.equal(restStored.rows[0].public_enabled, true);
    const owner = await connect(mark);
    try {
      const viaMcp = (await owner.call("set_doc_public", { id: doc.id, expires_at: null })).value!.doc as { public: boolean; publicExpiresAt: string | null };
      assert.equal(viaMcp.public, false);
      assert.ok(viaMcp.publicExpiresAt);
      const both = (await owner.call("set_doc_public", { id: doc.id, public: false, expires_at: null, allow_download: true })).value!.doc as { public: boolean; publicExpiresAt: string | null };
      assert.equal(both.public, false);
      assert.ok(both.publicExpiresAt);
    } finally {
      await owner.close();
    }
    assert.deepEqual(await stillStored(), kept);
    assert.equal(await events(), before);
    const back = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(back.public, true);
    assert.equal(back.publicExpiresAt, null);
    assert.equal(await events(), (before ?? 0) + 1, "turning it back on is the one visible change");
  });

  it("calls a date before 2000 past and a date after 2100 out of range", async () => {
    const doc = await createDoc(mark, { title: "Old dates", content: "Body" });
    await setDocPublic(mark, doc.id, { public: true });
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "1999-12-31" }), /That date has passed\. Pick today or a later date\./);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "2101-01-01" }), /no later than 2100/);
    const own = await createDoc(agent, { title: "Old dates API", content: "Body" });
    await setDocPublic(agent, own.id, { public: true });
    const past = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: "1999-12-31" }), params(own.id));
    assert.equal(past.status, 400);
    assert.match(JSON.stringify(await past.json()), /That date has passed/);
    const card = { action: "set_timer", docId: doc.id, expiresAt: "1999-12-31" };
    assert.ok(describeAction("save_doc", card, await recordNames(mark, [card], ["save_doc"])).lines.some((line) => line.includes("That date has passed")));
  });

  it("reports an expired link as off on every reader", async () => {
    const doc = await createDoc(mark, { title: "Readers", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d", NOW) });
    await setExpiry(doc.id, "now() - interval '1 hour'");

    const rest = (await (await readRoute(request(`/docs/${doc.id}`), params(doc.id))).json()) as { doc: { public: boolean; publicUrl: string | null; publicExpiresAt: string | null } };
    assert.equal(rest.doc.public, false);
    assert.equal(rest.doc.publicUrl, null);
    assert.ok(rest.doc.publicExpiresAt);

    const personal = await connect(mark);
    try {
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { public: boolean; publicUrl: string | null };
      assert.equal(read.public, false);
      assert.equal(read.publicUrl, null);
      const listed = ((await personal.call("list_docs", {})).value!.docs as { id: string; public: boolean }[]).find((item) => item.id === doc.id);
      assert.equal(listed?.public, false);
    } finally {
      await personal.close();
    }

    const assistant = (await runTool(mark, "read_knowledge", { docId: doc.id })) as { doc: { public: boolean; publicUrl: string | null } };
    assert.equal(assistant.doc.public, false);
    assert.equal(assistant.doc.publicUrl, null);
  });

  it("sends the timer in the webhook payload and nothing for a change nobody can see", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
    const bodies: string[] = [];
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const drain = async (count: number) => {
      const until = Date.now() + 3000;
      while (bodies.length < count && Date.now() < until) {
        await deliverDueWebhooks();
        if (bodies.length < count) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await createWebhook(mark, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, events: ["page.public_changed"] });
      const doc = await createDoc(mark, { title: "Hooked timer", content: "Text", shared: true });
      const day = presetDay("7d", NOW);
      await setDocPublic(mark, doc.id, { public: true, expiresAt: day });
      await drain(1);
      const payload = JSON.parse(bodies[0]) as { type: string; data: { public: boolean; expiresAt: string } };
      assert.equal(payload.type, "page.public_changed");
      assert.equal(payload.data.public, true);
      assert.equal(payload.data.expiresAt, endOfDayInstant(day).toISOString());
      await setExpiry(doc.id, "now() - interval '1 hour'");
      await setDocPublic(mark, doc.id, { allowDownload: true });
      await drain(2);
      assert.equal(bodies.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    }
  });

  it("refuses a nested update that changes the timer for someone who can't change the link", async () => {
    const doc = await createDoc(mark, { title: "Nested", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true });
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      await client.query("create function public.zz_bump_expiry() returns trigger language plpgsql as $$ begin update crm.pages set public_expires_at = now() + interval '3 days' where id = new.id; return null; end $$");
      await client.query("grant execute on function public.zz_bump_expiry() to authenticated");
      await client.query("create trigger zz_bump after update of title on crm.pages for each row execute function public.zz_bump_expiry()");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: priya.userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      await assert.rejects(client.query("update crm.pages set title = 'Nested again' where id = $1", [doc.id]), /Only the doc's owner can change its public link/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    assert.equal((await getDoc(mark, doc.id)).publicExpiresAt, null);
  });

  it("only reads the timer for publish and set_timer in the assistant", async () => {
    const doc = await createDoc(mark, { title: "Assistant scope", content: "Body" });
    const published = (await runTool(mark, "save_doc", { action: "publish", docId: doc.id })) as { saved: boolean };
    assert.equal(published.saved, true);
    const allow = (await runTool(mark, "save_doc", { action: "allow_download", docId: doc.id, expiresAt: "garbage" })) as { saved?: boolean; error?: string };
    assert.equal(allow.saved, true);
    const unpublish = { action: "unpublish", docId: doc.id, expiresAt: "garbage" };
    const card = describeAction("save_doc", unpublish, await recordNames(mark, [unpublish], ["save_doc"]));
    assert.equal(card.title, "Turn off the public link");
    await runTool(mark, "save_doc", unpublish);
    assert.equal((await getDoc(mark, doc.id)).public, false);
    const none = { action: "set_timer", docId: doc.id };
    const noneCard = describeAction("save_doc", none, await recordNames(mark, [none], ["save_doc"]));
    assert.ok(noneCard.lines.some((line) => line.includes("no timer to remove")));
    assert.match(((await runTool(mark, "save_doc", none)) as { error: string }).error, /no timer to remove/);
    const far = (await runTool(mark, "save_doc", { action: "publish", docId: doc.id, expiresAt: "9999-12-31" })) as { error: string };
    assert.match(far.error, /no later than 2100/);
  });
});
