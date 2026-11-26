import "./svg-stub";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as pdfRoute } from "@/app/api/d/[token]/pdf/route";
import { PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import PublicDocPage from "@/app/d/[token]/page";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { removeMember } from "@/lib/crm/team";
import { createWebhook, deliverDueWebhooks } from "@/lib/crm/webhooks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { openDailyNote } from "@/lib/docs/daily-notes";
import { takeOverFormerMemberDocs } from "@/lib/docs/admin";
import { publicInputOf } from "@/lib/docs/http";
import { openPublicDoc, publicDocPdf } from "@/lib/docs/public";
import { settleEnding, typeEnding } from "@/lib/docs/public-ending";
import { archiveDoc, checkPublicEnding, createDoc, getDoc, restoreDoc, setDocPublic } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let outsider: UserActor;
let agent: AgentActor;
let agentToken = "";
let otherAgent: AgentActor;

function tokenOf(url: string | null) {
  const match = /\/d\/([A-Za-z0-9_-]{32})$/.exec(url ?? "");
  assert.ok(match, `a token url, got ${url}`);
  return match[1];
}

function endingOf(url: string | null) {
  const match = /^https:\/\/orbit\.test\/d\/([a-z0-9-]+)$/.exec(url ?? "");
  assert.ok(match, `an ending url, got ${url}`);
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
  const client = new Client({ name: "public-endings", version: "1.0.0" });
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

async function addMember(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member", scopes: scopesForRole("member") } as UserActor;
}

async function publish(actor: UserActor | AgentActor, title = "Doc", extra: { shared?: boolean } = {}) {
  const doc = await createDoc(actor, { title, content: `Body of ${title}`, ...extra });
  const on = await setDocPublic(actor, doc.id, { public: true, allowDownload: true });
  return { id: doc.id, token: tokenOf(on.publicUrl) };
}

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@docs-endings.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('priya@docs-endings.test', 'password-123', 'Priya Shah') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@docs-endings.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("olive@docs-endings.test", "Olive Outsider");
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

describe("Public doc endings: the rules", () => {
  useServerlessPool();

  it("turns capitals, spaces and symbols into lowercase letters and single hyphens as someone types", () => {
    assert.equal(typeEnding("ClimateWorks Report"), "climateworks-report");
    assert.equal(typeEnding("  Q3   results!! "), "q3-results-");
    assert.equal(typeEnding("--Already-hyphenated--"), "already-hyphenated-");
    assert.equal(typeEnding("Café déjà vu"), "cafe-deja-vu");
    assert.equal(typeEnding("a".repeat(60)).length, 40);
    assert.equal(settleEnding("Q3 results!! "), "q3-results");
    assert.equal(settleEnding("   "), "");
  });

  it("uses the booking link rules and messages, in the store and at the edge", async () => {
    const { id } = await publish(mark, "Rules");
    const refused = async (slug: string, pattern: RegExp) => assert.rejects(setDocPublic(mark, id, { slug }), pattern);
    await refused("ab", /Use at least 3 characters\./);
    await refused("a".repeat(41), /Keep it under 41 characters\./);
    await refused("Two Words", /Use lowercase letters, numbers and single hyphens between them\./);
    await refused("double--hyphen", /single hyphens/);
    await refused("-leading", /single hyphens/);
    await refused("trailing-", /single hyphens/);
    await refused("admin", /reserved\. Pick another\./);
    await refused("docs", /reserved/);
    await refused("", /Use at least 3 characters\./);
    assert.equal((await getDoc(mark, id)).publicSlug, null);
    assert.equal((await setDocPublic(mark, id, { slug: "  Valid-Ending  " })).publicSlug, "valid-ending");
    assert.throws(() => publicInputOf({ slug: 5 }), /Couldn't change the public link/);
    assert.deepEqual(publicInputOf({ slug: null }).slug, null);
  });

  it("sets no ending unless one is typed, and needs the link to be on", async () => {
    const doc = await createDoc(mark, { title: "Plain", content: "Text" });
    const on = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(on.publicSlug, null);
    assert.equal(on.publicOldLinks, false);
    tokenOf(on.publicUrl);
    const off = await setDocPublic(mark, doc.id, { public: false });
    await assert.rejects(setDocPublic(mark, doc.id, { slug: "while-off" }), /Turn the public link on to change its ending\./);
    assert.equal(off.publicSlug, null);
  });

  it("lets one call turn the link on and set the ending, and clears it again", async () => {
    const doc = await createDoc(mark, { title: "Both", content: "Text" });
    const both = await setDocPublic(mark, doc.id, { public: true, slug: "both-at-once" });
    assert.equal(endingOf(both.publicUrl), "both-at-once");
    assert.equal(both.publicSlug, "both-at-once");
    const cleared = await setDocPublic(mark, doc.id, { slug: null });
    assert.equal(cleared.publicSlug, null);
    assert.equal(cleared.publicOldLinks, true);
    tokenOf(cleared.publicUrl);
  });
});

describe("Public doc endings: old links", () => {
  useServerlessPool();

  it("serves the ending, and forwards the random token and any case of the ending to it", async () => {
    const { id, token } = await publish(mark, "Forward");
    const set = await setDocPublic(mark, id, { slug: "climateworks-report" });
    assert.equal(endingOf(set.publicUrl), "climateworks-report");
    const direct = await openPublicDoc("climateworks-report");
    assert.equal(direct?.title, "Forward");
    assert.equal(direct?.redirectTo, null);
    assert.equal((await openPublicDoc(token))?.redirectTo, "/d/climateworks-report");
    assert.equal((await openPublicDoc("ClimateWorks-Report"))?.redirectTo, "/d/climateworks-report");
    assert.equal((await openPublicDoc(token))?.content, "Body of Forward");
  });

  it("forwards every earlier ending to the current one, then to the token when cleared", async () => {
    const { id, token } = await publish(mark, "History");
    await setDocPublic(mark, id, { slug: "first-ending" });
    const second = await setDocPublic(mark, id, { slug: "second-ending" });
    assert.equal(second.publicOldLinks, true);
    assert.equal((await openPublicDoc("first-ending"))?.redirectTo, "/d/second-ending");
    assert.equal((await openPublicDoc("second-ending"))?.redirectTo, null);
    assert.equal((await openPublicDoc(token))?.redirectTo, "/d/second-ending");

    const cleared = await setDocPublic(mark, id, { slug: null });
    assert.equal(tokenOf(cleared.publicUrl), token);
    assert.equal(cleared.publicSlug, null);
    assert.equal((await openPublicDoc("first-ending"))?.redirectTo, `/d/${token}`);
    assert.equal((await openPublicDoc("second-ending"))?.redirectTo, `/d/${token}`);
    const landed = await openPublicDoc(token);
    assert.equal(landed?.redirectTo, null);
    assert.equal(landed?.title, "History");

    const back = await setDocPublic(mark, id, { slug: "first-ending" });
    assert.equal(endingOf(back.publicUrl), "first-ending");
    assert.equal((await openPublicDoc("second-ending"))?.redirectTo, "/d/first-ending");
    const served = await openPublicDoc("first-ending");
    assert.equal(served?.redirectTo, null, "an earlier ending taken back serves directly");
    assert.equal(served?.title, "History");
  });

  it("renders the canonical link and redirects every other form from the page", async () => {
    const { id, token } = await publish(mark, "Page");
    await setDocPublic(mark, id, { slug: "page-ending" });
    await setDocPublic(mark, id, { slug: "page-newer" });
    const redirected = async (value: string) => {
      try {
        await PublicDocPage(pageParams(value));
      } catch (error) {
        return String((error as { digest?: string }).digest ?? error);
      }
      return null;
    };
    assert.match((await redirected(token)) ?? "", /NEXT_REDIRECT;replace;\/d\/page-newer;/);
    assert.match((await redirected("page-ending")) ?? "", /NEXT_REDIRECT;replace;\/d\/page-newer;/);
    assert.equal(await redirected("page-newer"), null);
    await setDocPublic(mark, id, { slug: null });
    assert.match((await redirected("page-newer")) ?? "", new RegExp(`NEXT_REDIRECT;replace;/d/${token};`));
    assert.equal(await redirected(token), null);
  });

  it("never lets another doc take an earlier or current ending, in any workspace", async () => {
    const first = await publish(mark, "Holder");
    const second = await publish(mark, "Taker");
    const foreign = await publish(outsider, "Foreign");
    await setDocPublic(mark, first.id, { slug: "held-ending" });
    await assert.rejects(setDocPublic(mark, second.id, { slug: "held-ending" }), /Taken\. Pick another\./);
    await assert.rejects(setDocPublic(outsider, foreign.id, { slug: "held-ending" }), /Taken\. Pick another\./);
    await setDocPublic(mark, first.id, { slug: "moved-on" });
    await assert.rejects(setDocPublic(mark, second.id, { slug: "held-ending" }), /Taken\. Pick another\./);
    await assert.rejects(setDocPublic(outsider, foreign.id, { slug: "held-ending" }), /Taken\. Pick another\./);
    await setDocPublic(mark, first.id, { slug: null });
    await assert.rejects(setDocPublic(mark, second.id, { slug: "held-ending" }), /Taken\. Pick another\./);
    assert.equal((await openPublicDoc("held-ending"))?.title, "Holder");
    assert.equal((await getDoc(mark, second.id)).publicSlug, null);
    assert.equal((await getDoc(outsider, foreign.id)).publicSlug, null);
    const taken = await setDocPublic(mark, first.id, { slug: "held-ending" }).then((doc) => doc.publicSlug);
    assert.equal(taken, "held-ending");
  });

  it("gives one winner when two docs take the same ending at once", async () => {
    const left = await publish(mark, "Left");
    const right = await publish(outsider, "Right");
    const results = await Promise.allSettled([setDocPublic(mark, left.id, { slug: "photo-finish" }), setDocPublic(outsider, right.id, { slug: "photo-finish" })]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.match(String(loser.reason.message), /Taken\. Pick another\./);
    const holders = await getAdminPool().query("select page_id from crm.page_public_slugs where slug = 'photo-finish'");
    assert.equal(holders.rowCount, 1);
    const winner = holders.rows[0].page_id as string;
    assert.ok([left.id, right.id].includes(winner));
    const current = await getAdminPool().query("select count(*)::int as n from crm.pages where public_slug = 'photo-finish'");
    assert.equal(current.rows[0].n, 1);
  });

  it("keeps an ending reserved when the same doc races itself", async () => {
    const { id } = await publish(mark, "Self race");
    const results = await Promise.allSettled([setDocPublic(mark, id, { slug: "self-race" }), setDocPublic(mark, id, { slug: "self-race" })]);
    assert.ok(results.every((result) => result.status === "fulfilled"));
    assert.equal((await getDoc(mark, id)).publicSlug, "self-race");
  });

  it("never matches an ending to a token or a token to an ending", async () => {
    const holder = await publish(mark, "Token holder");
    const other = await publish(mark, "Ending holder");
    const admin = await getAdminPool().connect();
    try {
      await admin.query("set session_replication_role = replica");
      await admin.query("update crm.pages set public_token_hash = encode(sha256(convert_to('clash-text', 'UTF8')), 'hex') where id = $1", [holder.id]);
      await admin.query("reset session_replication_role");
    } finally {
      admin.release();
    }
    await assert.rejects(setDocPublic(mark, other.id, { slug: "clash-text" }), /Taken\. Pick another\./);
    assert.equal((await checkPublicEnding(mark, other.id, "clash-text")).status, "taken");
    assert.equal((await openPublicDoc("clash-text"))?.title, "Token holder");
    await getAdminPool().query("insert into crm.page_public_slugs (slug, page_id) values ('clash-text', $1)", [other.id]);
    assert.equal((await openPublicDoc("clash-text"))?.title, "Token holder", "the token wins");
    assert.equal(await openPublicDoc("CLASH-TEXT").then((doc) => doc?.title), "Ending holder", "an upper case value is never a token");
  });

  it("returns not found for every form when the link is off, ran out, or the doc is archived", async () => {
    const { id, token } = await publish(mark, "Gone");
    await setDocPublic(mark, id, { slug: "gone-first" });
    await setDocPublic(mark, id, { slug: "gone-second" });
    const forms = [token, "gone-first", "gone-second"];
    const live = async () => Promise.all(forms.map(async (form) => [Boolean(await openPublicDoc(form)), Boolean(await publicDocPdf(form))]));
    assert.deepEqual(await live(), [[true, true], [true, true], [true, true]]);

    await setDocPublic(mark, id, { public: false });
    assert.deepEqual(await live(), [[false, false], [false, false], [false, false]]);
    await setDocPublic(mark, id, { public: true });
    assert.equal((await openPublicDoc("gone-first"))?.redirectTo, "/d/gone-second");

    await setDocPublic(mark, id, { expiresAt: "2099-01-01" });
    await getAdminPool().query("update crm.pages set public_expires_at = now() - interval '1 minute' where id = $1", [id]);
    assert.deepEqual(await live(), [[false, false], [false, false], [false, false]]);
    await getAdminPool().query("update crm.pages set public_expires_at = null where id = $1", [id]);

    await archiveDoc(mark, id);
    assert.deepEqual(await live(), [[false, false], [false, false], [false, false]]);
    await restoreDoc(mark, id);
    assert.deepEqual(await live(), [[true, true], [true, true], [true, true]]);
  });

  it("gives the PDF for the token, the ending and an earlier ending, and none when download is off", async () => {
    const { id, token } = await publish(mark, "Printable");
    await setDocPublic(mark, id, { slug: "print-one" });
    await setDocPublic(mark, id, { slug: "print-two" });
    for (const form of [token, "print-one", "print-two"]) {
      const file = await publicDocPdf(form);
      assert.ok(file, `a PDF for ${form}`);
      const response = await pdfRoute(new Request(`http://crm.test/api/d/${form}/pdf`), pageParams(form));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/pdf");
    }
    await setDocPublic(mark, id, { allowDownload: false });
    for (const form of [token, "print-one", "print-two"]) {
      assert.equal(await publicDocPdf(form), null);
      assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${form}/pdf`), pageParams(form))).status, 404);
    }
  });

  it("serves the PDF route itself for an upper-case ending, and stops after the timer runs out or archiving", async () => {
    const { id, token } = await publish(mark, "Route doc");
    await setDocPublic(mark, id, { slug: "route-ending" });
    const hit = async (form: string) => (await pdfRoute(new Request(`http://crm.test/api/d/${form}/pdf`), pageParams(form))).status;
    assert.equal(await hit("ROUTE-ENDING"), 200);
    assert.equal(await hit("Route-Ending"), 200);
    assert.equal(await hit(token), 200);
    await setDocPublic(mark, id, { expiresAt: "2099-01-01" });
    await getAdminPool().query("update crm.pages set public_expires_at = now() - interval '1 minute' where id = $1", [id]);
    for (const form of ["ROUTE-ENDING", "route-ending", token]) assert.equal(await hit(form), 404);
    await getAdminPool().query("update crm.pages set public_expires_at = null where id = $1", [id]);
    assert.equal(await hit("ROUTE-ENDING"), 200);
    await archiveDoc(mark, id);
    for (const form of ["ROUTE-ENDING", "route-ending", token]) assert.equal(await hit(form), 404);
  });

  it("exposes nothing from the lookup beyond the page, the current ending and the forward", async () => {
    const { id } = await publish(mark, "Narrow");
    await setDocPublic(mark, id, { slug: "narrow-ending" });
    const columns = await getAdminPool().query("select * from private.public_page_link('narrow-ending')");
    assert.deepEqual(columns.fields.map((field) => field.name), ["title", "content", "edited_at", "allow_download", "expires_at", "public_slug", "forward_token_enc"]);
    assert.equal(columns.rows[0].forward_token_enc, null);
    const opened = await openPublicDoc("narrow-ending");
    assert.ok(!JSON.stringify(opened).includes(id));
    assert.ok(!JSON.stringify(opened).includes(mark.workspaceId));
    await assert.rejects(queryAsUser(mark.userId, "select * from private.public_page_link('x')"), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select private.public_slug_taken('x', null)"), /permission denied/);
  });
});

describe("Public doc endings: who can change them", () => {
  useServerlessPool();

  it("lets only the owner change it, in the app and in the database", async () => {
    const { id } = await publish(mark, "Mine", { shared: true });
    await assert.rejects(setDocPublic(priya, id, { slug: "teammate-try" }), /Only Mark Ridgeon can change this note's public link/);
    await assert.rejects(setDocPublic(priya, id, { slug: null }), /Only Mark Ridgeon can change/);
    await assert.rejects(setDocPublic(agent, id, { slug: "agent-try" }), /Only Mark Ridgeon can change/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_slug = 'sql-try' where id = $1 returning id", [id]), /Only the doc's owner can change its public link/);
    await assert.rejects(asAgent(agent, "update crm.pages set public_slug = 'sql-try' where id = $1 returning id", [id]), /Only the doc's owner can change its public link/);
    assert.equal((await queryAsUser(mark.userId, "update crm.pages set public_slug = 'owner-sql' where id = $1 returning id", [id])).length, 1);
    assert.equal((await getDoc(priya, id)).canChangePublic, false);
    assert.equal((await getDoc(mark, id)).publicSlug, null, "the rolled back statements changed nothing");
    assert.equal((await setDocPublic(mark, id, { slug: "owner-set" })).publicSlug, "owner-set");
    const seen = await getDoc(priya, id);
    assert.equal(seen.publicSlug, "owner-set");
    assert.match(seen.publicUrl ?? "", /\/d\/owner-set$/);
  });

  it("limits an agent to docs it made, and lets the workspace owner, not an admin or member, change an agent-made doc", async () => {
    const { id } = await publish(agent, "Agent made");
    assert.equal((await setDocPublic(agent, id, { slug: "agent-ending" })).publicSlug, "agent-ending");
    await assert.rejects(setDocPublic(otherAgent, id, { slug: "other-agent" }), /Only Claude Code or the workspace owner/);
    await assert.rejects(setDocPublic(priya, id, { slug: "member-try" }), /Only Claude Code or the workspace owner/);
    assert.equal((await setDocPublic(mark, id, { slug: null })).publicSlug, null);
    await assert.rejects(asAgent(otherAgent, "update crm.pages set public_slug = 'sql-agent' where id = $1 returning id", [id]), /Only the doc's owner can change its public link/);
    assert.equal((await asAgent(agent, "update crm.pages set public_slug = 'sql-agent' where id = $1 returning id", [id])).length, 1);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_slug = 'sql-member' where id = $1 returning id", [id]), /Only the doc's owner can change its public link/);
    const admin = await getAdminPool().query("update crm.workspace_members set role = 'admin' where user_id = $1 returning user_id", [priya.userId]);
    try {
      assert.equal(admin.rowCount, 1);
      await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_slug = 'sql-admin' where id = $1 returning id", [id]), /Only the doc's owner can change its public link/);
    } finally {
      await getAdminPool().query("update crm.workspace_members set role = 'member' where user_id = $1", [priya.userId]);
    }
  });

  it("keeps the endings table and its marker out of reach of signed-in roles", async () => {
    const { id } = await publish(mark, "Closed");
    await setDocPublic(mark, id, { slug: "closed-ending" });
    await assert.rejects(queryAsUser(mark.userId, "select * from crm.page_public_slugs"), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "insert into crm.page_public_slugs (slug, page_id) values ('sneaky', $1)", [id]), /permission denied/);
    await assert.rejects(asAgent(agent, "select * from crm.page_public_slugs", []), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_slug_retired = false where id = $1", [id]), /permission denied/);
    const flags = await getAdminPool().query("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.page_public_slugs'::regclass");
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  });

  it("refuses an ending on a doc with no link, and the shape at the database", async () => {
    const doc = await createDoc(mark, { title: "No link", content: "Text" });
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_slug = 'no-link-yet' where id = $1", [doc.id]), /pages_public_slug_has_token/);
    const { id } = await publish(mark, "Shape");
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_slug = 'Bad Shape' where id = $1", [id]), /pages_public_slug_shape/);
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_slug = 'ab' where id = $1", [id]), /pages_public_slug_shape/);
  });

  it("keeps an ending when a leaver's links are turned off, and brings it back with the link", async () => {
    const leaver = await addMember("leaver@docs-endings.test", "Lee Leaver");
    const { id, token } = await publish(leaver, "Leaver doc", { shared: true });
    await setDocPublic(leaver, id, { slug: "leaver-ending" });
    await removeMember(mark, leaver.userId);
    assert.equal(await openPublicDoc("leaver-ending"), null);
    assert.equal(await openPublicDoc(token), null);
    const after = await getAdminPool().query("select public_enabled, public_slug from crm.pages where id = $1", [id]);
    assert.deepEqual(after.rows[0], { public_enabled: false, public_slug: "leaver-ending" });
    await takeOverFormerMemberDocs(mark, leaver.userId);
    const revived = await setDocPublic(mark, id, { public: true });
    assert.equal(revived.publicSlug, "leaver-ending");
    assert.equal(endingOf(revived.publicUrl), "leaver-ending");
    assert.equal((await openPublicDoc("leaver-ending"))?.title, "Leaver doc");
    assert.equal((await openPublicDoc(token))?.redirectTo, "/d/leaver-ending");
  });

  it("keeps an ending when a person leaves the workspace themselves", async () => {
    const leaver = await addMember("self-leaver@docs-endings.test", "Sam Leaver");
    const { id, token } = await publish(leaver, "Self leaver doc", { shared: true });
    await setDocPublic(leaver, id, { slug: "self-leaver" });
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: leaver.userId, role: "authenticated" })]);
      await client.query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, leaver.userId]);
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.equal(await openPublicDoc("self-leaver"), null);
    assert.equal(await openPublicDoc(token), null);
    const after = await getAdminPool().query("select public_enabled, public_slug from crm.pages where id = $1", [id]);
    assert.deepEqual(after.rows[0], { public_enabled: false, public_slug: "self-leaver" });
    const taker = await publish(mark, "Wants it");
    await assert.rejects(setDocPublic(mark, taker.id, { slug: "self-leaver" }), /Taken\. Pick another\./);
  });

  it("refuses an ending on a daily note, in the app and at the database", async () => {
    const daily = (await openDailyNote(mark)).page;
    await assert.rejects(setDocPublic(mark, daily.id, { slug: "daily-ending" }), /Daily notes are private/);
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_slug = 'daily-ending' where id = $1", [daily.id]), /pages_public_slug_has_token|pages_daily_not_public/);
  });

  it("keeps the retired marker out of reach of agents, and sets it itself", async () => {
    const { id } = await publish(agent, "Marker");
    await assert.rejects(asAgent(agent, "update crm.pages set public_slug_retired = true where id = $1", [id]), /permission denied/);
    const marker = async () => (await getAdminPool().query("select public_slug_retired from crm.pages where id = $1", [id])).rows[0].public_slug_retired;
    assert.equal(await marker(), false);
    await setDocPublic(agent, id, { slug: "marker-one" });
    assert.equal(await marker(), false);
    await setDocPublic(agent, id, { slug: "marker-two" });
    assert.equal(await marker(), true);
  });
});

describe("Public doc endings: the availability check", () => {
  useServerlessPool();

  it("says available, taken or invalid, and an owner's own current and earlier endings are available", async () => {
    const mine = await publish(mark, "Mine");
    const theirs = await publish(outsider, "Theirs");
    await setDocPublic(outsider, theirs.id, { slug: "check-taken" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "check-free"), { status: "available" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "check-taken"), { status: "taken" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "Check-Taken"), { status: "taken" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "admin"), { status: "invalid", message: "“admin” is reserved. Pick another." });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "x"), { status: "invalid", message: "Use at least 3 characters." });
    await setDocPublic(mark, mine.id, { slug: "check-old" });
    await setDocPublic(mark, mine.id, { slug: "check-new" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "check-new"), { status: "available" });
    assert.deepEqual(await checkPublicEnding(mark, mine.id, "check-old"), { status: "available" });
    assert.deepEqual(await checkPublicEnding(outsider, theirs.id, "check-old"), { status: "taken" });
  });

  it("reveals nothing about who holds an ending", async () => {
    const mine = await publish(mark, "Mine");
    const theirs = await publish(outsider, "Theirs");
    await setDocPublic(outsider, theirs.id, { slug: "secret-holder" });
    const held = await checkPublicEnding(mark, mine.id, "secret-holder");
    await setDocPublic(outsider, theirs.id, { slug: "secret-moved" });
    const earlier = await checkPublicEnding(mark, mine.id, "secret-holder");
    assert.deepEqual(held, { status: "taken" });
    assert.deepEqual(earlier, held);
    assert.deepEqual(Object.keys(held), ["status"]);
    assert.ok(!JSON.stringify(held).includes(theirs.id));
    assert.ok(!JSON.stringify(held).includes(outsider.workspaceId));
    const other = await publish(mark, "Other mine", { shared: true });
    await assert.rejects(checkPublicEnding(priya, other.id, "whatever-ending"), /Only the person who can change/);
    await assert.rejects(checkPublicEnding(mark, theirs.id, "whatever-ending"), /doesn't exist, or it's private/);
    await assert.rejects(checkPublicEnding(mark, "not-an-id", "whatever-ending"), /doesn't exist, or it's private/);
  });

  it("is rate limited", async () => {
    const typist = await createUser("typist@docs-endings.test", "Tess Typist");
    const { id } = await publish(typist, "Limited");
    let refused = 0;
    for (let call = 0; call < 70; call += 1) {
      try {
        await checkPublicEnding(typist, id, `limit-check-${call}`);
      } catch (error) {
        assert.match((error as Error).message, /Wait a minute and try again/);
        refused += 1;
      }
    }
    assert.equal(refused, 10);
    assert.deepEqual(await checkPublicEnding(mark, (await publish(mark, "Unlimited")).id, "limit-free"), { status: "available" });
  });
});

describe("Public doc endings: API, MCP and assistant", () => {
  useServerlessPool();

  it("sets, reads and clears the ending over the REST API", async () => {
    const own = await createDoc(agent, { title: "API ending", content: "Hello" });
    await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: true }), params(own.id));
    const set = await patchRoute(request(`/docs/${own.id}`, "PATCH", { slug: "api-ending" }), params(own.id));
    assert.equal(set.status, 200);
    const body = (await set.json()) as { doc: { publicUrl: string; publicSlug: string } };
    assert.equal(body.doc.publicUrl, "https://orbit.test/d/api-ending");
    assert.equal(body.doc.publicSlug, "api-ending");
    const bad = await patchRoute(request(`/docs/${own.id}`, "PATCH", { slug: "Bad Slug" }), params(own.id));
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await bad.json()), /Use lowercase letters, numbers and single hyphens between them\./);
    const clashing = await createDoc(agent, { title: "API clash", content: "Hello" });
    await patchRoute(request(`/docs/${clashing.id}`, "PATCH", { public: true }), params(clashing.id));
    const taken = await patchRoute(request(`/docs/${clashing.id}`, "PATCH", { slug: "api-ending" }), params(clashing.id));
    assert.equal(taken.status, 409);
    assert.match(JSON.stringify(await taken.json()), /Taken\. Pick another\./);
    const cleared = await patchRoute(request(`/docs/${own.id}`, "PATCH", { slug: null }), params(own.id));
    assert.match(((await cleared.json()) as { doc: { publicUrl: string } }).doc.publicUrl, /\/d\/[A-Za-z0-9_-]{32}$/);
    const marks = await createDoc(mark, { title: "Not the agent's", content: "Hi", shared: true });
    assert.equal((await patchRoute(request(`/docs/${marks.id}`, "PATCH", { slug: "api-refused" }), params(marks.id))).status, 403);
  });

  it("sets and clears the ending over MCP with the same messages", async () => {
    const personal = await connect(mark);
    const workspace = await connect(agent);
    try {
      const doc = await createDoc(mark, { title: "MCP ending", content: "Body" });
      await personal.call("set_doc_public", { id: doc.id, public: true });
      const set = (await personal.call("set_doc_public", { id: doc.id, slug: "mcp-ending" })).value!.doc as { publicUrl: string; publicSlug: string };
      assert.equal(set.publicUrl, "https://orbit.test/d/mcp-ending");
      assert.equal(set.publicSlug, "mcp-ending");
      assert.match((await personal.call("set_doc_public", { id: doc.id, slug: "ab" })).error ?? "", /Use at least 3 characters\./);
      assert.match((await personal.call("set_doc_public", { id: doc.id, slug: "admin" })).error ?? "", /reserved/);
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { publicSlug: string };
      assert.equal(read.publicSlug, "mcp-ending");
      assert.match((await workspace.call("set_doc_public", { id: doc.id, slug: "agent-steals" })).error ?? "", /not_found|forbidden/);
      const other = await createDoc(mark, { title: "MCP other", content: "Body" });
      await personal.call("set_doc_public", { id: other.id, public: true });
      assert.match((await personal.call("set_doc_public", { id: other.id, slug: "mcp-ending" })).error ?? "", /Taken\. Pick another\./);
      const cleared = (await personal.call("set_doc_public", { id: doc.id, slug: null })).value!.doc as { publicSlug: string | null; publicUrl: string };
      assert.equal(cleared.publicSlug, null);
      assert.match(cleared.publicUrl, /\/d\/[A-Za-z0-9_-]{32}$/);
      assert.match((await personal.call("set_doc_public", { id: doc.id })).error ?? "", /Send at least one of public, allow_download, expires_at or slug\./);
    } finally {
      await personal.close();
      await workspace.close();
    }
  });

  it("goes through approval cards in the assistant", async () => {
    const { id } = await publish(mark, "Assistant ending");
    const set = { action: "set_public_ending", docId: id, slug: "assistant-ending" };
    const card = describeAction("save_doc", set, await recordNames(mark, [set], ["save_doc"]));
    assert.equal(card.title, "Change the public link to orbit.test/d/assistant-ending");
    assert.match(card.lines.join(" "), /Assistant ending/);
    assert.match(((await runTool(mark, "save_doc", set, { unattended: true })) as { error: string }).error, /Only edits to a doc's text/);
    const result = (await runTool(mark, "save_doc", set)) as { saved: boolean; doc: { publicUrl: string; publicSlug: string } };
    assert.equal(result.saved, true);
    assert.equal(result.doc.publicUrl, "https://orbit.test/d/assistant-ending");
    assert.equal(result.doc.publicSlug, "assistant-ending");

    const bad = { action: "set_public_ending", docId: id, slug: "no" };
    const badCard = describeAction("save_doc", bad, await recordNames(mark, [bad], ["save_doc"]));
    assert.match(badCard.lines.join(" "), /This won't work yet: Use at least 3 characters\./);
    assert.match(((await runTool(mark, "save_doc", bad)) as { error: string }).error, /Use at least 3 characters/);

    const taken = await publish(mark, "Assistant clash");
    const clash = { action: "set_public_ending", docId: taken.id, slug: "assistant-ending" };
    const clashCard = describeAction("save_doc", clash, await recordNames(mark, [clash], ["save_doc"]));
    assert.match(clashCard.lines.join(" "), /This won't work yet: Taken\. Pick another\./);
    assert.match(((await runTool(mark, "save_doc", clash)) as { error: string }).error, /Taken\. Pick another\./);

    const clear = { action: "clear_public_ending", docId: id };
    assert.equal(describeAction("save_doc", clear, await recordNames(mark, [clear], ["save_doc"])).title, "Go back to the random public link");
    const cleared = (await runTool(mark, "save_doc", clear)) as { doc: { publicSlug: string | null; publicUrl: string } };
    assert.equal(cleared.doc.publicSlug, null);
    assert.match(cleared.doc.publicUrl, /\/d\/[A-Za-z0-9_-]{32}$/);
  });

  it("refuses the assistant on a teammate's doc", async () => {
    const shared = await publish(priya, "Priya's", { shared: true });
    const set = { action: "set_public_ending", docId: shared.id, slug: "not-yours" };
    assert.match(((await runTool(mark, "save_doc", set)) as { error: string }).error, /Only Priya Shah can change/);
  });
});

describe("Public doc endings: audit and webhooks", () => {
  useServerlessPool();

  async function recorded(docId: string) {
    const rows = await getAdminPool().query<{ changes: Record<string, unknown> }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'page.public_changed' order by created_at", [docId]);
    return rows.rows.map((row) => row.changes);
  }

  it("records the ending on a shared doc and nothing on a private one", async () => {
    const shared = await createDoc(mark, { title: "Audited ending", content: "Text", shared: true });
    await setDocPublic(mark, shared.id, { public: true });
    await setDocPublic(mark, shared.id, { slug: "audited-ending" });
    await setDocPublic(mark, shared.id, { slug: null });
    assert.deepEqual((await recorded(shared.id)).map((changes) => changes.slug), [null, "audited-ending", null]);
    const priv = await createDoc(mark, { title: "Private ending", content: "Text" });
    await setDocPublic(mark, priv.id, { public: true, slug: "private-ending" });
    assert.deepEqual(await recorded(priv.id), []);
  });

  it("sends the ending in the webhook for a shared doc only", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      await createWebhook(mark, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, events: ["page.public_changed"] });
      const priv = await createDoc(mark, { title: "Hook private", content: "Text" });
      await setDocPublic(mark, priv.id, { public: true, slug: "hook-private" });
      const shared = await createDoc(mark, { title: "Hook shared", content: "Text", shared: true });
      await setDocPublic(mark, shared.id, { public: true, slug: "hook-shared" });
      const until = Date.now() + 5000;
      while (bodies.length === 0 && Date.now() < until) {
        await deliverDueWebhooks();
        if (bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await deliverDueWebhooks();
      assert.equal(bodies.length, 1);
      assert.match(bodies[0], /hook-shared/);
      assert.ok(!bodies[0].includes("hook-private"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    }
  });
});
