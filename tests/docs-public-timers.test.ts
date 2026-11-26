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
import { toPage } from "@/lib/docs/view";
import { addDays, addMonths, availabilityLabel, daysLeft, endOfDayInstant, expiryDayOf, expiryLabel, londonToday, presetDay, presetOf } from "@/lib/docs/public-expiry";
import { openPublicDoc, publicDocPdf } from "@/lib/docs/public";
import { createDoc, getDoc, listDocs, setDocPublic, updateDoc } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

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
    const day = presetDay("30d");
    const made = await setDocPublic(mark, doc.id, { public: true, expiresAt: day });
    assert.equal(made.public, true);
    assert.equal(made.publicExpiresAt, endOfDayInstant(day).toISOString());
    const shorter = await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d") });
    assert.equal(shorter.publicExpiresAt, endOfDayInstant(presetDay("7d")).toISOString());
    const longer = await setDocPublic(mark, doc.id, { expiresAt: presetDay("12m") });
    assert.equal(longer.publicExpiresAt, endOfDayInstant(presetDay("12m")).toISOString());
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
    const made = await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("7d") });
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
    const made = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d") });
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
    const first = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d") });
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
    const first = await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("30d") });
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
    const yesterday = addDays(londonToday(), -1);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: yesterday }), /That date has passed\. Pick today or a later date\./);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "2030-02-30" }), /YYYY-MM-DD/);
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: "next week" }), /YYYY-MM-DD/);
    assert.equal((await getDoc(mark, doc.id)).publicExpiresAt, null);
    const today = await setDocPublic(mark, doc.id, { expiresAt: londonToday() });
    assert.equal(today.publicExpiresAt, endOfDayInstant(londonToday()).toISOString());
    await setDocPublic(mark, doc.id, { public: false });
    await assert.rejects(setDocPublic(mark, doc.id, { expiresAt: presetDay("7d") }), /Turn the public link on/);
    await assert.rejects(setDocPublic(mark, doc.id, { public: false, expiresAt: presetDay("7d") }), /Turn the public link on/);
  });

  it("keeps the download choice across a timer running out", async () => {
    const doc = await createDoc(mark, { title: "Download kept", content: "Body" });
    await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("7d") });
    await setExpiry(doc.id, "now() - interval '1 hour'");
    const back = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(back.allowDownload, true);
  });

  it("sets the timer through updateDoc and records it in the audit event", async () => {
    const doc = await createDoc(mark, { title: "Audited", content: "Body", shared: true });
    const day = presetDay("30d");
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

    const thirty = presetDay("30d");
    await setDocPublic(mark, doc.id, { expiresAt: thirty });
    assert.ok((await render()).includes(`Available for 30 more days, until ${expiryLabel(endOfDayInstant(thirty))}`));

    const tomorrow = addDays(londonToday(), 1);
    await setDocPublic(mark, doc.id, { expiresAt: tomorrow });
    assert.ok((await render()).includes(`Available for 1 more day, until ${expiryLabel(endOfDayInstant(tomorrow))}`));

    await setDocPublic(mark, doc.id, { expiresAt: londonToday() });
    assert.ok((await render()).includes("Available until midnight tonight"));
  });

  it("leaves the line out of the PDF", async () => {
    const doc = await createDoc(mark, { title: "PDF without the line", content: "Body text" });
    const made = await setDocPublic(mark, doc.id, { public: true, allowDownload: true, expiresAt: presetDay("30d") });
    const { extractText, getDocumentProxy } = await import("unpdf");
    const file = await publicDocPdf(tokenOf(made.publicUrl));
    assert.ok(file);
    const text = (await extractText(await getDocumentProxy(new Uint8Array(file.data)), { mergePages: true })).text;
    assert.ok(text.includes("Body text"));
    assert.ok(!text.includes("Available"));
  });

  it("returns the expiry from the public function and nothing that identifies the doc", async () => {
    const doc = await createDoc(mark, { title: "Payload timer", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("7d") })).publicUrl);
    const opened = await openPublicDoc(token);
    assert.equal(opened?.expiresAt, endOfDayInstant(presetDay("7d")).toISOString());
    assert.ok(!JSON.stringify(opened).includes(doc.id));
  });
});

describe("Public doc timers: who can change them", () => {
  useServerlessPool();

  it("lets the owner set it and refuses a teammate in the app and the database", async () => {
    const doc = await createDoc(mark, { title: "Owner timer", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true, expiresAt: presetDay("30d") });
    await assert.rejects(setDocPublic(priya, doc.id, { expiresAt: presetDay("7d") }), /Only Mark Ridgeon can change this note's public link/);
    await assert.rejects(setDocPublic(priya, doc.id, { public: true, expiresAt: presetDay("7d") }), /Only Mark Ridgeon can change/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_expires_at = null where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await getDoc(priya, doc.id)).canChangePublic, false);
    assert.equal((await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d") })).publicExpiresAt, endOfDayInstant(presetDay("7d")).toISOString());
    const own = await queryAsUser(mark.userId, "update crm.pages set public_expires_at = null where id = $1 returning id", [doc.id]);
    assert.equal(own.length, 1);
  });

  it("refuses an agent that didn't make the doc, and lets the one that did", async () => {
    const doc = await createDoc(agent, { title: "Agent timer", content: "Body" });
    await setDocPublic(agent, doc.id, { public: true });
    await assert.rejects(setDocPublic(otherAgent, doc.id, { expiresAt: presetDay("7d") }), /Only Claude Code or the workspace owner/);
    await assert.rejects(asAgent(otherAgent, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    assert.equal((await asAgent(agent, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id])).length, 1);
    assert.equal((await setDocPublic(agent, doc.id, { expiresAt: presetDay("30d") })).publicExpiresAt, endOfDayInstant(presetDay("30d")).toISOString());
    const marks = await createDoc(mark, { title: "Mark's for the agent", content: "Body", shared: true });
    await assert.rejects(setDocPublic(agent, marks.id, { public: true, expiresAt: presetDay("7d") }), /Only Mark Ridgeon can change/);
  });

  it("lets the workspace owner, but not an admin or a member, change an agent-made doc's timer", async () => {
    const admin = await addMember("admin@docs-timers.test", "Ada Admin", "admin");
    const doc = await createDoc(agent, { title: "Agent-made timer", content: "Body" });
    await setDocPublic(agent, doc.id, { public: true });
    await assert.rejects(setDocPublic(admin, doc.id, { expiresAt: presetDay("7d") }), /Only Claude Code or the workspace owner/);
    await assert.rejects(setDocPublic(priya, doc.id, { expiresAt: presetDay("7d") }), /Only Claude Code or the workspace owner/);
    await assert.rejects(queryAsUser(admin.userId, "update crm.pages set public_expires_at = now() + interval '1 day' where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    const set = await setDocPublic(mark, doc.id, { expiresAt: presetDay("7d") });
    assert.equal(set.publicExpiresAt, endOfDayInstant(presetDay("7d")).toISOString());
  });

  it("keeps the timer when a leaver's link is turned off by the nested trigger", async () => {
    const leaver = await addMember("leaver@docs-timers.test", "Lee Leaver", "member");
    const doc = await createDoc(leaver, { title: "Leaver timer", content: "Body", shared: true });
    const url = (await setDocPublic(leaver, doc.id, { public: true, expiresAt: presetDay("30d") })).publicUrl;
    await removeMember(mark, leaver.userId);
    const row = await getAdminPool().query<{ public_enabled: boolean; public_expires_at: Date | null }>("select public_enabled, public_expires_at from crm.pages where id = $1", [doc.id]);
    assert.equal(row.rows[0].public_enabled, false);
    assert.equal(row.rows[0].public_expires_at?.toISOString(), endOfDayInstant(presetDay("30d")).toISOString());
    assert.equal(await openPublicDoc(tokenOf(url)), null);
  });
});

describe("Public doc timers: API, MCP and assistant", () => {
  useServerlessPool();

  it("sets, reads and clears the timer over the REST API", async () => {
    const own = await createDoc(agent, { title: "API timer", content: "Hello" });
    const day = presetDay("30d");
    const patched = await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: true, expiresAt: day }), params(own.id));
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as { doc: { public: boolean; publicExpiresAt: string | null } };
    assert.equal(body.doc.public, true);
    assert.equal(body.doc.publicExpiresAt, endOfDayInstant(day).toISOString());
    const read = (await (await readRoute(request(`/docs/${own.id}`), params(own.id))).json()) as { doc: { publicExpiresAt: string | null } };
    assert.equal(read.doc.publicExpiresAt, body.doc.publicExpiresAt);
    const changed = await patchRoute(request(`/docs/${own.id}`, "PATCH", { expiresAt: presetDay("7d") }), params(own.id));
    assert.equal(((await changed.json()) as { doc: { publicExpiresAt: string } }).doc.publicExpiresAt, endOfDayInstant(presetDay("7d")).toISOString());
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
    const refused = await patchRoute(request(`/docs/${marks.id}`, "PATCH", { public: true, expiresAt: presetDay("7d") }), params(marks.id));
    assert.equal(refused.status, 403);
  });

  it("sets, reads and clears the timer over MCP", async () => {
    const personal = await connect(mark);
    const workspace = await connect(agent);
    try {
      const doc = await createDoc(mark, { title: "MCP timer", content: "Body" });
      const day = presetDay("3m");
      const on = (await personal.call("set_doc_public", { id: doc.id, public: true, expires_at: day })).value!.doc as { public: boolean; publicExpiresAt: string };
      assert.equal(on.public, true);
      assert.equal(on.publicExpiresAt, endOfDayInstant(day).toISOString());
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { publicExpiresAt: string };
      assert.equal(read.publicExpiresAt, on.publicExpiresAt);
      const only = (await personal.call("set_doc_public", { id: doc.id, expires_at: presetDay("7d") })).value!.doc as { publicExpiresAt: string };
      assert.equal(only.publicExpiresAt, endOfDayInstant(presetDay("7d")).toISOString());
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
    const day = presetDay("30d");
    const label = expiryLabel(endOfDayInstant(day));
    const publish = { action: "publish", docId: doc.id, expiresAt: day };
    const publishCard = describeAction("save_doc", publish, await recordNames(mark, [publish], ["save_doc"]));
    assert.equal(publishCard.title, `Turn on the public link until ${label}`);
    assert.deepEqual(publishCard.lines, ["Assistant timer", `Anyone with the link can read it until ${label}. Download stays off.`]);
    const published = (await runTool(mark, "save_doc", publish)) as { saved: boolean; doc: { public: boolean; publicExpiresAt: string } };
    assert.equal(published.saved, true);
    assert.equal(published.doc.public, true);
    assert.equal(published.doc.publicExpiresAt, endOfDayInstant(day).toISOString());

    const later = presetDay("3m");
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

    const off = { action: "set_timer", docId: doc.id, expiresAt: presetDay("7d") };
    const offCard = describeAction("save_doc", off, await recordNames(mark, [off], ["save_doc"]));
    assert.ok(offCard.lines.some((line) => line.includes("The public link is off")));
    assert.match(((await runTool(mark, "save_doc", off)) as { error: string }).error, /Turn the public link on/);
  });

  it("refuses the assistant on a teammate's doc", async () => {
    const theirs = await createDoc(priya, { title: "Priya's timer doc", content: "Body", shared: true });
    const timer = { action: "set_timer", docId: theirs.id, expiresAt: presetDay("7d") };
    assert.match(((await runTool(mark, "save_doc", timer)) as { error: string }).error, /Only Priya Shah can change/);
  });
});
