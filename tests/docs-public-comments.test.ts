import "./svg-stub";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DELETE as deleteRoute, PATCH as editRoute } from "@/app/api/d/[token]/comments/[id]/route";
import { GET as listRoute, POST as addRoute } from "@/app/api/d/[token]/comments/route";
import { PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import PublicDocPage from "@/app/d/[token]/page";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { publicInputOf } from "@/lib/docs/http";
import { COMMENT_POSTS_PER_MINUTE_PER_IP, hashVisitorKey } from "@/lib/docs/public-comments";
import { openPublicDoc } from "@/lib/docs/public";
import { archiveDoc, createDoc, getDoc, restoreDoc, setDocPublic } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let outsider: UserActor;
let agent: AgentActor;
let agentToken = "";
let otherAgent: AgentActor;
let counter = 0;

type Wire = { id: string; parentId: string | null; authorName: string; body: string; anchor: { quote: string } | null; createdAt: string; editedAt: string | null; resolved: boolean; mine: boolean };

const ANCHOR = { quote: "parcel", prefix: "We will receive the ", suffix: " on Friday", at: 20 };

function tokenOf(url: string | null) {
  const match = /\/d\/([A-Za-z0-9_-]{32})$/.exec(url ?? "");
  assert.ok(match, `a public url, got ${url}`);
  return match[1];
}

const newKey = () => randomBytes(24).toString("base64url");

function nextIp() {
  counter += 1;
  return `203.0.${Math.floor(counter / 250)}.${counter % 250}`;
}

function call(method: string, token: string, options: { key?: string | null; body?: unknown; ip?: string; id?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": options.ip ?? nextIp(), "content-type": "application/json" };
  if (options.key) headers["x-visitor-key"] = options.key;
  const request = new Request(`http://crm.test/api/d/${token}/comments${options.id ? `/${options.id}` : ""}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const context = { params: Promise.resolve({ token, id: options.id ?? "" }) };
  if (method === "GET") return listRoute(request, context);
  if (method === "POST") return addRoute(request, context);
  if (method === "PATCH") return editRoute(request, context);
  return deleteRoute(request, context);
}

async function list(token: string, key: string | null = null, ip?: string) {
  const response = await call("GET", token, { key, ip });
  return { status: response.status, comments: ((await response.json()) as { comments?: Wire[] }).comments ?? [] };
}

async function post(token: string, key: string, body: Record<string, unknown>, ip?: string) {
  const response = await call("POST", token, { key, body, ip });
  const json = (await response.json()) as { comment?: Wire; error?: string };
  return { status: response.status, comment: json.comment, error: json.error };
}

async function root(token: string, key: string, text = "A first thought", name = "Rae Reader") {
  const made = await post(token, key, { name, body: text, anchor: ANCHOR });
  assert.equal(made.status, 201, made.error);
  return made.comment!;
}

async function publish(actor: UserActor | AgentActor, title = "Doc", comments = true) {
  const doc = await createDoc(actor, { title, content: `We will receive the parcel on Friday.\n\nBody of ${title}` });
  const on = await setDocPublic(actor, doc.id, { public: true, allowComments: comments });
  return { id: doc.id, token: tokenOf(on.publicUrl) };
}

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "public-comments", version: "1.0.0" });
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

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@docs-comments.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('priya@docs-comments.test', 'password-123', 'Priya Shah') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@docs-comments.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("olive@docs-comments.test", "Olive Outsider");
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

describe("Public doc comments: the switch", () => {
  useServerlessPool();

  it("is off by default, kept when the link goes off and on, and shown to the page", async () => {
    const doc = await createDoc(mark, { title: "Switch", content: "Body" });
    assert.equal((await getDoc(mark, doc.id)).allowComments, false);
    const on = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(on.allowComments, false);
    const token = tokenOf(on.publicUrl);
    assert.equal((await openPublicDoc(token))?.allowComments, false);
    assert.equal((await setDocPublic(mark, doc.id, { allowComments: true })).allowComments, true);
    assert.equal((await openPublicDoc(token))?.allowComments, true);
    assert.equal((await setDocPublic(mark, doc.id, { public: false })).allowComments, true);
    assert.equal((await setDocPublic(mark, doc.id, { public: true })).allowComments, true);
    assert.equal((await openPublicDoc(token))?.allowComments, true);
    assert.equal((await setDocPublic(mark, doc.id, { allowComments: false })).allowComments, false);
    assert.equal((await openPublicDoc(token))?.allowComments, false);
  });

  it("can be set while the link is off and is audited on shared docs", async () => {
    const doc = await createDoc(mark, { title: "Audited", content: "Body", shared: true });
    await setDocPublic(mark, doc.id, { public: true });
    await setDocPublic(mark, doc.id, { allowComments: true });
    const events = await getAdminPool().query<{ changes: { allowComments: boolean } }>("select changes from crm.audit_events where entity_id = $1 and event_type = 'page.public_changed' order by created_at", [doc.id]);
    assert.deepEqual(events.rows.map((event) => event.changes.allowComments), [false, true]);
  });

  it("follows the same permission rule as downloads", async () => {
    const doc = await createDoc(mark, { title: "Marks", content: "Body", shared: true });
    await assert.rejects(setDocPublic(priya, doc.id, { allowComments: true }), /Only Mark Ridgeon can change/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set allow_comments = true where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await queryAsUser(mark.userId, "update crm.pages set allow_comments = true where id = $1 returning id", [doc.id])).length, 1);

    const own = await createDoc(agent, { title: "Agent doc", content: "Body", shared: true });
    assert.equal((await setDocPublic(agent, own.id, { public: true, allowComments: true })).allowComments, true);
    await assert.rejects(setDocPublic(agent, doc.id, { allowComments: true }), /Only Mark Ridgeon can change/);
    await assert.rejects(asAgent(otherAgent, "update crm.pages set allow_comments = false where id = $1 returning id", [own.id]), /Only the doc's owner/);
    assert.equal((await setDocPublic(mark, own.id, { allowComments: false })).allowComments, false);
  });

  it("turns off with the link when a member is removed without changing the setting", async () => {
    const leaver = await createDoc(priya, { title: "Priya doc", content: "Body", shared: true });
    await setDocPublic(priya, leaver.id, { public: true, allowComments: true });
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, priya.userId]);
    const row = await getAdminPool().query<{ public_enabled: boolean; allow_comments: boolean }>("select public_enabled, allow_comments from crm.pages where id = $1", [leaver.id]);
    assert.deepEqual(row.rows[0], { public_enabled: false, allow_comments: true });
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, priya.userId]);
  });

  it("is read and written through the REST API", async () => {
    const own = await createDoc(agent, { title: "REST doc", content: "Body" });
    const request = (method: string, body?: unknown) =>
      new Request(`http://crm.test/api/v1/docs/${own.id}`, {
        method,
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const patched = await patchRoute(request("PATCH", { public: true, allowComments: true }), { params: Promise.resolve({ id: own.id }) });
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as { doc: { allowComments: boolean; public: boolean } };
    assert.equal(body.doc.allowComments, true);
    assert.equal(body.doc.public, true);
    const bad = await patchRoute(request("PATCH", { allowComments: "yes" }), { params: Promise.resolve({ id: own.id }) });
    assert.equal(bad.status, 400);
  });

  it("is read and written over MCP", async () => {
    const personal = await connect(mark);
    try {
      const doc = await createDoc(mark, { title: "MCP doc", content: "Body" });
      const on = (await personal.call("set_doc_public", { id: doc.id, public: true, allow_comments: true })).value!.doc as { allowComments: boolean };
      assert.equal(on.allowComments, true);
      const only = (await personal.call("set_doc_public", { id: doc.id, allow_comments: false })).value!.doc as { allowComments: boolean };
      assert.equal(only.allowComments, false);
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { allowComments: boolean };
      assert.equal(read.allowComments, false);
      assert.match((await personal.call("set_doc_public", { id: doc.id })).error ?? "", /allow_comments/);
    } finally {
      await personal.close();
    }
  });

  it("goes through an approval card in the assistant", async () => {
    const doc = await createDoc(mark, { title: "Assistant doc", content: "Body" });
    await runTool(mark, "save_doc", { action: "publish", docId: doc.id });
    const allow = { action: "allow_comments", docId: doc.id };
    const card = describeAction("save_doc", allow, await recordNames(mark, [allow], ["save_doc"]));
    assert.equal(card.title, "Allow comments");
    assert.deepEqual(card.lines, ["Assistant doc", "Readers can comment and reply. Everyone on the link sees them."]);
    assert.match(((await runTool(mark, "save_doc", allow, { unattended: true })) as { error: string }).error, /Only edits to a doc's text/);
    assert.equal(((await runTool(mark, "save_doc", allow)) as { doc: { allowComments: boolean } }).doc.allowComments, true);
    const block = { action: "block_comments", docId: doc.id };
    assert.equal(describeAction("save_doc", block, await recordNames(mark, [block], ["save_doc"])).title, "Stop comments");
    assert.equal(((await runTool(mark, "save_doc", block)) as { doc: { allowComments: boolean } }).doc.allowComments, false);
    assert.equal((await getDoc(mark, doc.id)).allowDownload, false);
  });

  it("is accepted by the editor's input check", () => {
    assert.deepEqual(publicInputOf({ allowComments: true }), { public: undefined, allowDownload: undefined, allowComments: true, expiresAt: undefined, slug: undefined });
    assert.throws(() => publicInputOf({ allowComments: "yes" }));
    assert.throws(() => publicInputOf({ allowComment: true }));
  });
});

describe("Public doc comments: reading and writing", () => {
  useServerlessPool();

  it("answers not found for every way the link or the switch can be off", async () => {
    const key = newKey();
    const off = await publish(mark, "Switch off", false);
    assert.equal((await list(off.token)).status, 404);
    assert.equal((await post(off.token, key, { name: "Rae", body: "Hi", anchor: ANCHOR })).status, 404);

    const live = await publish(mark, "Live");
    const made = await root(live.token, key);
    await setDocPublic(mark, live.id, { public: false });
    assert.equal((await list(live.token, key)).status, 404);
    assert.equal((await post(live.token, key, { name: "Rae", body: "Hi", anchor: ANCHOR })).status, 404);
    assert.equal((await call("PATCH", live.token, { key, id: made.id, body: { body: "x" } })).status, 404);
    assert.equal((await call("DELETE", live.token, { key, id: made.id })).status, 404);
    await setDocPublic(mark, live.id, { public: true });
    assert.equal((await list(live.token, key)).comments.length, 1);

    await getAdminPool().query("update crm.pages set public_expires_at = now() - interval '1 minute' where id = $1", [live.id]);
    assert.equal((await list(live.token, key)).status, 404);
    assert.equal((await post(live.token, key, { name: "Rae", body: "Hi", anchor: ANCHOR })).status, 404);
    await getAdminPool().query("update crm.pages set public_expires_at = null where id = $1", [live.id]);
    assert.equal((await list(live.token, key)).status, 200);

    await archiveDoc(mark, live.id);
    assert.equal((await list(live.token, key)).status, 404);
    assert.equal((await post(live.token, key, { name: "Rae", body: "Hi", anchor: ANCHOR })).status, 404);
    await restoreDoc(mark, live.id);
    assert.equal((await list(live.token, key)).status, 200);

    assert.equal((await list("A".repeat(32))).status, 404);
    assert.equal((await list("no")).status, 404);
    assert.equal((await list("not a link!")).status, 404);
  });

  it("reaches comments by the random link and by the ending, and never by a different ending", async () => {
    const key = newKey();
    const { id, token } = await publish(mark, "Endings");
    await setDocPublic(mark, id, { slug: "comment-ending" });
    const made = await root(token, key);
    assert.equal((await list("comment-ending", key)).comments[0]?.id, made.id);
    assert.equal((await list("Comment-Ending", key)).comments.length, 1);
    assert.equal((await list("another-ending", key)).status, 404);
    const other = await publish(mark, "Other");
    assert.deepEqual((await list(other.token)).comments, []);
  });

  it("adds roots and replies and lists them in order", async () => {
    const key = newKey();
    const { token } = await publish(mark, "Thread");
    const first = await root(token, key, "  Padded comment  ", "  Rae Reader  ");
    assert.equal(first.body, "Padded comment");
    assert.equal(first.authorName, "Rae Reader");
    assert.equal(first.parentId, null);
    assert.equal(first.mine, true);
    assert.equal(first.resolved, false);
    assert.equal(first.editedAt, null);
    assert.deepEqual(first.anchor, ANCHOR);
    const reply = await post(token, newKey(), { name: "Sam", body: "A reply", parentId: first.id });
    assert.equal(reply.status, 201);
    assert.equal(reply.comment?.parentId, first.id);
    assert.equal(reply.comment?.anchor, null);
    assert.equal(reply.comment?.mine, true);
    const seen = await list(token, key);
    assert.deepEqual(seen.comments.map((comment) => [comment.authorName, comment.body, comment.mine]), [
      ["Rae Reader", "Padded comment", true],
      ["Sam", "A reply", false],
    ]);
  });

  it("refuses replies to comments that are not live roots on the same page", async () => {
    const key = newKey();
    const a = await publish(mark, "Page A");
    const b = await publish(mark, "Page B");
    const onA = await root(a.token, key);
    const onB = await root(b.token, key);
    const cross = await post(b.token, key, { name: "Rae", body: "Hi", parentId: onA.id });
    assert.equal(cross.status, 400);
    assert.equal(cross.error, "That comment is no longer there.");
    assert.equal((await post(a.token, key, { name: "Rae", body: "Hi", parentId: "00000000-0000-4000-8000-000000000000" })).status, 400);
    const reply = await post(a.token, key, { name: "Rae", body: "Hi", parentId: onA.id });
    assert.equal(reply.status, 201);
    assert.equal((await post(a.token, key, { name: "Rae", body: "Nested", parentId: reply.comment!.id })).status, 400);
    assert.equal((await post(a.token, key, { name: "Rae", body: "Anchored reply", parentId: onA.id, anchor: ANCHOR })).status, 400);
    assert.equal((await post(a.token, key, { name: "Rae", body: "No anchor" })).status, 400);
    assert.equal((await call("DELETE", a.token, { key, id: onA.id })).status, 200);
    assert.equal((await post(a.token, key, { name: "Rae", body: "Gone parent", parentId: onA.id })).status, 400);
    assert.equal((await list(b.token, key)).comments.length, 1);
    assert.equal(onB.parentId, null);
  });

  it("edits and deletes only with the key that wrote the comment", async () => {
    const key = newKey();
    const stranger = newKey();
    const { token } = await publish(mark, "Owned");
    const made = await root(token, key);
    assert.equal((await call("PATCH", token, { key: stranger, id: made.id, body: { body: "Hijack" } })).status, 404);
    assert.equal((await call("PATCH", token, { id: made.id, body: { body: "No key" } })).status, 404);
    assert.equal((await call("DELETE", token, { key: stranger, id: made.id })).status, 404);
    assert.equal((await call("DELETE", token, { id: made.id })).status, 404);
    assert.equal((await list(token, key)).comments[0].body, "A first thought");

    const edited = await call("PATCH", token, { key, id: made.id, body: { body: " Changed " } });
    assert.equal(edited.status, 200);
    const comment = ((await edited.json()) as { comment: Wire }).comment;
    assert.equal(comment.body, "Changed");
    assert.ok(comment.editedAt);
    assert.equal(comment.mine, true);
    assert.equal((await call("PATCH", token, { key, id: made.id, body: { body: "" } })).status, 400);
    assert.equal((await call("PATCH", token, { key, id: made.id, body: { body: "x".repeat(2001) } })).status, 400);
    assert.equal((await call("PATCH", token, { key, id: "not-an-id", body: { body: "x" } })).status, 404);

    assert.equal((await call("DELETE", token, { key, id: made.id })).status, 200);
    assert.equal((await call("DELETE", token, { key, id: made.id })).status, 404);
    assert.equal((await call("PATCH", token, { key, id: made.id, body: { body: "After delete" } })).status, 404);
    assert.deepEqual((await list(token, key)).comments, []);
    const kept = await getAdminPool().query("select deleted_at from crm.page_comments where id = $1", [made.id]);
    assert.ok(kept.rows[0].deleted_at, "a delete is soft");
  });

  it("hides replies when their root is deleted and keeps other roots", async () => {
    const key = newKey();
    const { token } = await publish(mark, "Cascade");
    const gone = await root(token, key, "Goes");
    const stays = await root(token, key, "Stays");
    await post(token, newKey(), { name: "Sam", body: "Reply to gone", parentId: gone.id });
    await post(token, newKey(), { name: "Sam", body: "Reply to stays", parentId: stays.id });
    await call("DELETE", token, { key, id: gone.id });
    assert.deepEqual((await list(token)).comments.map((comment) => comment.body), ["Stays", "Reply to stays"]);
  });

  it("applies the length rules to names and comments", async () => {
    const key = newKey();
    const { token } = await publish(mark, "Lengths");
    const valid = { name: "Rae", body: "Hi", anchor: ANCHOR };
    assert.equal((await post(token, key, { ...valid, name: "n".repeat(60) })).status, 201);
    assert.equal((await post(token, key, { ...valid, name: "n".repeat(61) })).status, 400);
    assert.equal((await post(token, key, { ...valid, name: "   " })).status, 400);
    assert.equal((await post(token, key, { ...valid, body: "b".repeat(2000) })).status, 201);
    assert.equal((await post(token, key, { ...valid, body: "b".repeat(2001) })).status, 400);
    assert.equal((await post(token, key, { ...valid, body: "  \n " })).status, 400);
    assert.equal((await post(token, key, { ...valid, anchor: { ...ANCHOR, quote: "q".repeat(1001) } })).status, 400);
    assert.equal((await post(token, key, { ...valid, anchor: { ...ANCHOR, quote: "" } })).status, 400);
    assert.equal((await post(token, key, { ...valid, anchor: { ...ANCHOR, prefix: "p".repeat(33) } })).status, 400);
    assert.equal((await post(token, key, { ...valid, anchor: { quote: "x" } })).status, 400);
    const message = await post(token, key, { ...valid, body: "b".repeat(2001) });
    assert.equal(message.error, "A comment is 2000 characters at most.");
    assert.equal((await post(token, "short", valid)).status, 400);
    const bad = await addRoute(
      new Request(`http://crm.test/api/d/${token}/comments`, { method: "POST", headers: { "x-visitor-key": key, "x-forwarded-for": nextIp() }, body: "{nope" }),
      { params: Promise.resolve({ token }) },
    );
    assert.equal(bad.status, 400);
  });

  it("keeps comments plain text", async () => {
    const key = newKey();
    const { token } = await publish(mark, "Plain");
    const made = await root(token, key, "<img src=x onerror=alert(1)> **bold**", "<b>Rae</b>");
    assert.equal(made.body, "<img src=x onerror=alert(1)> **bold**");
    assert.equal(made.authorName, "<b>Rae</b>");
  });

  it("never returns hashes, page ids or workspace ids, and flags only the caller's own comments", async () => {
    const key = newKey();
    const other = newKey();
    const { token } = await publish(mark, "Mine");
    await root(token, key, "From the first reader");
    await root(token, other, "From the second reader");
    const response = await call("GET", token, { key });
    const text = await response.text();
    for (const secret of [hashVisitorKey(key), hashVisitorKey(other), key, other, mark.workspaceId, "visitor_key_hash", "page_id", "workspace_id", "author_user_id"]) {
      assert.ok(!text.includes(secret), `the response leaked ${secret}`);
    }
    const comments = (JSON.parse(text) as { comments: Wire[] }).comments;
    assert.deepEqual(comments.map((comment) => [comment.body, comment.mine]), [["From the first reader", true], ["From the second reader", false]]);
    assert.deepEqual(Object.keys(comments[0]).sort(), ["anchor", "authorName", "body", "createdAt", "editedAt", "id", "mine", "parentId", "resolved"]);
    assert.deepEqual((await list(token)).comments.map((comment) => comment.mine), [false, false]);
    assert.deepEqual((await list(token, "x".repeat(30))).comments.map((comment) => comment.mine), [false, false]);
    const raw = await getAdminPool().query("select visitor_key_hash from crm.page_comments where body = 'From the first reader'");
    assert.equal(raw.rows[0].visitor_key_hash, hashVisitorKey(key));
    assert.notEqual(raw.rows[0].visitor_key_hash, key);
  });

  it("reports resolved threads, replies included, without letting readers resolve them", async () => {
    const key = newKey();
    const { token } = await publish(mark, "Resolved");
    const made = await root(token, key);
    const reply = await post(token, newKey(), { name: "Sam", body: "Reply", parentId: made.id });
    await getAdminPool().query("update crm.page_comments set resolved_at = now() where id = $1", [made.id]);
    const seen = (await list(token, key)).comments;
    assert.deepEqual(seen.map((comment) => comment.resolved), [true, true]);
    const edited = await call("PATCH", token, { key: newKey(), id: reply.comment!.id, body: { body: "x" } });
    assert.equal(edited.status, 404);
  });

  it("keeps comments when the switch goes off and on, and isolates docs and workspaces", async () => {
    const key = newKey();
    const mine = await publish(mark, "Marks");
    const theirs = await publish(outsider, "Olives");
    await root(mine.token, key, "On Mark's doc");
    await root(theirs.token, key, "On Olive's doc");
    assert.deepEqual((await list(mine.token, key)).comments.map((comment) => comment.body), ["On Mark's doc"]);
    assert.deepEqual((await list(theirs.token, key)).comments.map((comment) => comment.body), ["On Olive's doc"]);
    const olives = (await list(theirs.token, key)).comments[0];
    const cross = await call("PATCH", mine.token, { key, id: olives.id, body: { body: "Cross workspace" } });
    assert.equal(cross.status, 404);
    assert.equal((await call("DELETE", mine.token, { key, id: olives.id })).status, 404);
    assert.equal((await post(mine.token, key, { name: "Rae", body: "Cross reply", parentId: olives.id })).status, 400);

    await setDocPublic(mark, mine.id, { allowComments: false });
    assert.equal((await list(mine.token, key)).status, 404);
    await setDocPublic(mark, mine.id, { allowComments: true });
    assert.deepEqual((await list(mine.token, key)).comments.map((comment) => comment.body), ["On Mark's doc"]);
    assert.equal((await list(theirs.token, key)).comments.length, 1);
  });

  it("cascades with the doc and caps a doc at 1000 live comments", async () => {
    const key = newKey();
    const { id, token } = await publish(mark, "Full");
    await root(token, key);
    await getAdminPool().query(
      `insert into crm.page_comments (workspace_id, page_id, author_name, body, anchor)
       select workspace_id, id, 'Bulk', 'Bulk comment', '{"quote":"x","prefix":"","suffix":"","at":0}'::jsonb from crm.pages, generate_series(1, 999) where id = $1`,
      [id],
    );
    const full = await post(token, key, { name: "Rae", body: "One too many", anchor: ANCHOR });
    assert.equal(full.status, 400);
    assert.equal(full.error, "This doc has the most comments it can take.");
    await getAdminPool().query("delete from crm.pages where id = $1", [id]);
    const left = await getAdminPool().query("select count(*)::int as count from crm.page_comments where page_id = $1", [id]);
    assert.equal(left.rows[0].count, 0);
  });

  it("limits posts per client and per doc", async () => {
    const key = newKey();
    const { id, token } = await publish(mark, "Limits");
    const ip = "198.51.100.7";
    for (let index = 0; index < COMMENT_POSTS_PER_MINUTE_PER_IP; index += 1) {
      assert.equal((await post(token, key, { name: "Rae", body: `Comment ${index}`, anchor: ANCHOR }, ip)).status, 201);
    }
    const blocked = await post(token, key, { name: "Rae", body: "Too many", anchor: ANCHOR }, ip);
    assert.equal(blocked.status, 429);
    assert.match(blocked.error ?? "", /Wait a minute/);
    assert.equal((await post(token, key, { name: "Rae", body: "Another client", anchor: ANCHOR }, "198.51.100.8")).status, 201);
    assert.equal((await list(token, key, ip)).status, 200);

    await getAdminPool().query("select private.consume_rate_limit($1, 200, 86400, 188)", [`doc-comments-page:${id}`]);
    assert.equal((await post(token, key, { name: "Rae", body: "Last allowed", anchor: ANCHOR }, "198.51.100.9")).status, 201);
    const day = await post(token, key, { name: "Rae", body: "Over the day", anchor: ANCHOR }, "198.51.100.10");
    assert.equal(day.status, 429);
    assert.match(day.error ?? "", /too many comments today/);
    assert.equal((await list(token, key, "198.51.100.10")).status, 200);
  });
});

describe("Public doc comments: the database", () => {
  useServerlessPool();

  it("gives signed-in roles no access to the table or the functions", async () => {
    const { id, token } = await publish(mark, "Closed");
    await root(token, newKey());
    await assert.rejects(queryAsUser(mark.userId, "select * from crm.page_comments"), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "insert into crm.page_comments (workspace_id, page_id, author_name, body) values ($1, $2, 'x', 'y')", [mark.workspaceId, id]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select * from private.public_comments_list($1, null)", [token]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select * from private.public_comment_add($1, $2, 'x', 'y', null, '{}'::jsonb)", [token, "0".repeat(64)]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select private.public_comment_delete($1, $2, gen_random_uuid())", [token, "0".repeat(64)]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select * from private.public_comment_page($1)", [token]), /permission denied/);
    const flags = await getAdminPool().query<{ rls: boolean; forced: boolean }>("select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where oid = 'crm.page_comments'::regclass");
    assert.deepEqual(flags.rows[0], { rls: true, forced: true });
  });

  it("holds the shape rules even for direct writes", async () => {
    const { id } = await publish(mark, "Shape");
    const insert = (name: string, body: string, extra = "") =>
      getAdminPool().query(`insert into crm.page_comments (workspace_id, page_id, author_name, body ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, $3, $4 ${extra ? ", " + extra.split("=")[1] : ""})`, [mark.workspaceId, id, name, body]);
    await assert.rejects(insert("", "Body"), /page_comments_author_name/);
    await assert.rejects(insert(" padded ", "Body"), /page_comments_author_name/);
    await assert.rejects(insert("n".repeat(61), "Body"), /page_comments_author_name/);
    await assert.rejects(insert("Name", ""), /page_comments_body/);
    await assert.rejects(insert("Name", "b".repeat(2001)), /page_comments_body/);
    await assert.rejects(insert("Name", "Body", "visitor_key_hash='not-a-hash'"), /page_comments_key_hash/);
    await assert.rejects(insert("Name", "Body", "anchor='[]'::jsonb"), /page_comments_anchor_shape/);
  });
});

describe("Public doc comments: the page", () => {
  useServerlessPool();

  it("hands the switch to the page and leaves the page unchanged when it is off", async () => {
    const off = await publish(mark, "Page off", false);
    const on = await publish(mark, "Page on", true);
    const render = async (token: string) => (await import("react-dom/server")).renderToStaticMarkup(await PublicDocPage({ params: Promise.resolve({ token }) }));
    const without = await render(off.token);
    const withComments = await render(on.token);
    assert.ok(!without.includes("data-doc-comments"));
    assert.ok(withComments.includes("data-doc-comments"));
    assert.ok(without.includes("Body of Page off"));
    assert.ok(withComments.includes("Body of Page on"));
  });
});
