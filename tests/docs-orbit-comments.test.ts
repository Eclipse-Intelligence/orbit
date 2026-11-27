import "./svg-stub";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { POST as addRoute, GET as listRoute } from "@/app/api/d/[token]/comments/route";
import { DELETE as restDelete, PATCH as restResolve } from "@/app/api/v1/docs/[id]/comments/[commentId]/route";
import { POST as restReply } from "@/app/api/v1/docs/[id]/comments/[commentId]/replies/route";
import { GET as restList } from "@/app/api/v1/docs/[id]/comments/route";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { alertDocOwner } from "@/lib/docs/comment-alerts";
import { deleteDocComment, listDocComments, replyToDocComment, setDocCommentResolved } from "@/lib/docs/comments";
import { createDoc, getDoc, setDocPublic } from "@/lib/docs/store";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let outsider: UserActor;
let agent: AgentActor;
let agentToken = "";
let otherAgent: AgentActor;
let counter = 0;

type Wire = { id: string; parentId: string | null; authorName: string; body: string; resolved: boolean; mine: boolean };

const ANCHOR = { quote: "parcel", prefix: "We will receive the ", suffix: " on Friday", at: 20 };

function tokenOf(url: string | null) {
  const match = /\/d\/([A-Za-z0-9_-]{32})$/.exec(url ?? "");
  assert.ok(match, `a public url, got ${url}`);
  return match[1];
}

const newKey = () => randomBytes(24).toString("base64url");

function nextIp() {
  counter += 1;
  return `198.51.${Math.floor(counter / 250)}.${counter % 250}`;
}

async function publicList(token: string, key: string | null = null) {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (key) headers["x-visitor-key"] = key;
  const response = await listRoute(new Request(`http://crm.test/api/d/${token}/comments`, { headers }), { params: Promise.resolve({ token }) });
  return ((await response.json()) as { comments: Wire[] }).comments;
}

async function publicPost(token: string, key: string, body: Record<string, unknown>) {
  const response = await addRoute(
    new Request(`http://crm.test/api/d/${token}/comments`, {
      method: "POST",
      headers: { "x-forwarded-for": nextIp(), "content-type": "application/json", "x-visitor-key": key },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
  const json = (await response.json()) as { comment?: Wire; error?: string };
  assert.equal(response.status, 201, json.error);
  return json.comment!;
}

async function visitorRoot(token: string, text = "A first thought", name = "Rae Reader") {
  return publicPost(token, newKey(), { name, body: text, anchor: ANCHOR });
}

async function publish(actor: UserActor | AgentActor, title = "Doc", options: { shared?: boolean } = {}) {
  const doc = await createDoc(actor, { title, content: `We will receive the parcel on Friday.\n\nBody of ${title}`, shared: options.shared });
  const on = await setDocPublic(actor, doc.id, { public: true, allowComments: true });
  return { id: doc.id, token: tokenOf(on.publicUrl) };
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

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "orbit-comments", version: "1.0.0" });
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

function rest(path: string, method: string, body?: unknown, token = agentToken) {
  return new Request(`http://crm.test/api/v1/docs/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function notificationsFor(userId: string) {
  const result = await getAdminPool().query<{ title: string; body: string; href: string }>("select title, body, href from crm.notifications where user_id = $1 and source = 'doc_comment' order by created_at", [userId]);
  return result.rows;
}

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@orbit-comments.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('priya@orbit-comments.test', 'password-123', 'Priya Shah') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@orbit-comments.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("olive@orbit-comments.test", "Olive Outsider");
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

describe("Orbit comments: who can see and change them", () => {
  useServerlessPool();

  it("follows the doc: a private doc's comments stay with its owner", async () => {
    const doc = await publish(mark, "Private doc");
    const comment = await visitorRoot(doc.token);
    assert.equal((await queryAsUser(mark.userId, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 1);
    assert.equal((await queryAsUser(priya.userId, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 0);
    assert.equal((await queryAsUser(outsider.userId, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 0);
    await assert.rejects(listDocComments(priya, doc.id), /doesn't exist|private to someone else/);
    await assert.rejects(replyToDocComment(priya, doc.id, comment.id, { body: "Hello" }), /doesn't exist|private to someone else/);
    assert.equal((await queryAsUser(priya.userId, "update crm.page_comments set resolved_at = now() where id = $1 returning id", [comment.id])).length, 0);
    assert.equal((await asAgent(agent, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 0);
  });

  it("shows a workspace-shared doc's comments to members, never to another workspace", async () => {
    const doc = await publish(mark, "Shared doc", { shared: true });
    const comment = await visitorRoot(doc.token);
    assert.equal((await queryAsUser(priya.userId, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 1);
    assert.equal((await queryAsUser(outsider.userId, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 0);
    assert.equal((await asAgent(agent, "select id from crm.page_comments where page_id = $1", [doc.id])).length, 1);
    assert.equal((await listDocComments(priya, doc.id)).comments.length, 1);
    await assert.rejects(listDocComments(outsider, doc.id));
    const reply = await replyToDocComment(priya, doc.id, comment.id, { body: "Priya here" });
    assert.equal(reply.authorName, "Priya Shah");
    assert.equal(reply.authorKind, "person");
  });

  it("never lets a visitor key hash be read, and only allows replies as the signed-in person", async () => {
    const doc = await publish(mark, "Guarded", { shared: true });
    const comment = await visitorRoot(doc.token);
    await assert.rejects(queryAsUser(mark.userId, "select visitor_key_hash from crm.page_comments where page_id = $1", [doc.id]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "select * from crm.page_comments where page_id = $1", [doc.id]), /permission denied/);
    const insert = "insert into crm.page_comments (workspace_id, page_id, parent_id, author_name, author_user_id, body) values ($1, $2, $3, 'Someone', $4, 'x') returning id";
    await assert.rejects(queryAsUser(mark.userId, insert, [mark.workspaceId, doc.id, comment.id, priya.userId]), /row-level security/);
    await assert.rejects(queryAsUser(mark.userId, insert, [mark.workspaceId, doc.id, null, mark.userId]), /row-level security/);
    await assert.rejects(queryAsUser(outsider.userId, insert, [mark.workspaceId, doc.id, comment.id, outsider.userId]), /row-level security/);
    assert.equal((await queryAsUser(mark.userId, insert, [mark.workspaceId, doc.id, comment.id, mark.userId])).length, 1);
    await assert.rejects(queryAsUser(mark.userId, "update crm.page_comments set body = 'changed' where id = $1", [comment.id]), /permission denied/);
    await assert.rejects(queryAsUser(mark.userId, "update crm.page_comments set resolved_by = $2, resolved_at = now() where id = $1", [comment.id, priya.userId]), /row-level security/);
  });

  it("lets a workspace agent token act only on docs it can already open", async () => {
    const shared = await publish(mark, "Agent can see", { shared: true });
    const root = await visitorRoot(shared.token);
    const own = await publish(agent, "Agent made");
    const ownRoot = await visitorRoot(own.token);
    const privateDoc = await publish(mark, "Agent cannot see");
    const privateRoot = await visitorRoot(privateDoc.token);
    assert.equal((await listDocComments(agent, shared.id)).comments.length, 1);
    assert.equal((await listDocComments(otherAgent, own.id)).comments.length, 1);
    await assert.rejects(listDocComments(agent, privateDoc.id));
    await assert.rejects(replyToDocComment(agent, privateDoc.id, privateRoot.id, { body: "No" }));
    await assert.rejects(setDocCommentResolved(agent, privateDoc.id, privateRoot.id, true));
    const reply = await replyToDocComment(agent, shared.id, root.id, { body: "From the agent" });
    assert.equal(reply.authorKind, "agent");
    assert.equal(reply.authorName, "Claude Code");
    assert.equal((await setDocCommentResolved(agent, own.id, ownRoot.id, true)).resolved, true);
    assert.equal((await asAgent(agent, "update crm.page_comments set resolved_at = null where id = $1 returning id", [privateRoot.id])).length, 0);
  });
});

describe("Orbit comments: what readers see", () => {
  useServerlessPool();

  it("shows a reply from Orbit on the public link under the person's name", async () => {
    const doc = await publish(mark, "Replies");
    const key = newKey();
    const root = await publicPost(doc.token, key, { name: "Rae Reader", body: "Is this right?", anchor: ANCHOR });
    const reply = await replyToDocComment(mark, doc.id, root.id, { body: "  Yes, it is.  " });
    assert.equal(reply.body, "Yes, it is.");
    assert.equal(reply.parentId, root.id);
    const seen = await publicList(doc.token, key);
    const wire = seen.find((item) => item.id === reply.id)!;
    assert.equal(wire.authorName, "Mark Ridgeon");
    assert.equal(wire.mine, false);
    assert.equal(wire.parentId, root.id);
    assert.equal(seen.find((item) => item.id === root.id)!.mine, true);
    const second = await replyToDocComment(mark, doc.id, reply.id, { body: "Replying to the reply" });
    assert.equal(second.parentId, root.id);
    const agentReply = await replyToDocComment(agent, doc.id, root.id, { body: "Agent note" }).catch((error: unknown) => error);
    assert.ok(agentReply instanceof Error);
  });

  it("shows an agent's reply under the agent's name", async () => {
    const doc = await publish(agent, "Agent reply doc");
    const root = await visitorRoot(doc.token);
    await replyToDocComment(agent, doc.id, root.id, { body: "On it" });
    const seen = await publicList(doc.token);
    assert.equal(seen.find((item) => item.parentId === root.id)!.authorName, "Claude Code");
  });

  it("takes a resolved thread out of the public margin and puts it back when reopened", async () => {
    const doc = await publish(mark, "Resolving");
    const root = await visitorRoot(doc.token);
    const reply = await replyToDocComment(mark, doc.id, root.id, { body: "Done" });
    const resolved = await setDocCommentResolved(mark, doc.id, reply.id, true);
    assert.equal(resolved.id, root.id);
    assert.equal(resolved.resolved, true);
    assert.deepEqual((await publicList(doc.token)).map((item) => item.resolved), [true, true]);
    assert.equal((await setDocCommentResolved(mark, doc.id, root.id, true)).resolved, true);
    const reopened = await setDocCommentResolved(mark, doc.id, root.id, false);
    assert.equal(reopened.resolved, false);
    assert.deepEqual((await publicList(doc.token)).map((item) => item.resolved), [false, false]);
    const row = await getAdminPool().query<{ resolved_by: string | null }>("select resolved_by from crm.page_comments where id = $1", [root.id]);
    assert.equal(row.rows[0].resolved_by, null);
    await setDocCommentResolved(mark, doc.id, root.id, true);
    assert.equal((await getAdminPool().query("select resolved_by from crm.page_comments where id = $1", [root.id])).rows[0].resolved_by, mark.userId);
  });

  it("soft deletes any comment from Orbit, and a deleted thread takes its replies with it", async () => {
    const doc = await publish(mark, "Deleting", { shared: true });
    const key = newKey();
    const root = await publicPost(doc.token, key, { name: "Rae", body: "One", anchor: ANCHOR });
    const other = await visitorRoot(doc.token, "Two", "Sam");
    const reply = await replyToDocComment(priya, doc.id, root.id, { body: "Reply" });
    await deleteDocComment(priya, doc.id, reply.id);
    assert.deepEqual((await publicList(doc.token, key)).map((item) => item.id).sort(), [root.id, other.id].sort());
    await replyToDocComment(mark, doc.id, root.id, { body: "Another" });
    await deleteDocComment(mark, doc.id, root.id);
    assert.deepEqual((await publicList(doc.token)).map((item) => item.id), [other.id]);
    const row = await getAdminPool().query<{ deleted_at: Date | null; body: string }>("select deleted_at, body from crm.page_comments where id = $1", [root.id]);
    assert.ok(row.rows[0].deleted_at);
    assert.equal(row.rows[0].body, "One");
    await assert.rejects(replyToDocComment(mark, doc.id, root.id, { body: "Too late" }), /no longer there/);
    await assert.rejects(deleteDocComment(mark, doc.id, root.id), /no longer there/);
    await assert.rejects(deleteDocComment(mark, doc.id, "not-an-id"), /no longer there/);
  });

  it("refuses an empty or oversized reply and daily notes", async () => {
    const doc = await publish(mark, "Limits");
    const root = await visitorRoot(doc.token);
    await assert.rejects(replyToDocComment(mark, doc.id, root.id, { body: "   " }), /Write a comment/);
    await assert.rejects(replyToDocComment(mark, doc.id, root.id, { body: "x".repeat(2001) }), /2000 characters/);
    const seen = await publicList(doc.token);
    assert.equal(seen.length, 1);
  });

  it("counts open and total threads on the doc", async () => {
    const doc = await publish(mark, "Counting");
    assert.deepEqual([(await getDoc(mark, doc.id)).openComments, (await getDoc(mark, doc.id)).commentCount], [0, 0]);
    const one = await visitorRoot(doc.token);
    await visitorRoot(doc.token, "Second");
    await replyToDocComment(mark, doc.id, one.id, { body: "Reply" });
    assert.deepEqual([(await getDoc(mark, doc.id)).openComments, (await getDoc(mark, doc.id)).commentCount], [2, 2]);
    await setDocCommentResolved(mark, doc.id, one.id, true);
    assert.deepEqual([(await getDoc(mark, doc.id)).openComments, (await getDoc(mark, doc.id)).commentCount], [1, 2]);
    await deleteDocComment(mark, doc.id, one.id);
    assert.deepEqual([(await getDoc(mark, doc.id)).openComments, (await getDoc(mark, doc.id)).commentCount], [1, 1]);
  });
});

describe("Orbit comments: audit", () => {
  useServerlessPool();

  it("records Orbit-side changes on a shared doc without any visitor key", async () => {
    const doc = await publish(mark, "Audited", { shared: true });
    const root = await visitorRoot(doc.token);
    const reply = await replyToDocComment(mark, doc.id, root.id, { body: "Reply" }, { operation: "docs.app" });
    await setDocCommentResolved(priya, doc.id, root.id, true);
    await setDocCommentResolved(priya, doc.id, root.id, false);
    await deleteDocComment(mark, doc.id, reply.id);
    const events = await getAdminPool().query<{ event_type: string; changes: Record<string, unknown> }>(
      "select event_type, changes from crm.audit_events where entity_id = $1 and event_type like 'page.comment_%' order by created_at",
      [doc.id],
    );
    assert.deepEqual(events.rows.map((event) => event.event_type), ["page.comment_replied", "page.comment_resolved", "page.comment_reopened", "page.comment_deleted"]);
    assert.doesNotMatch(JSON.stringify(events.rows), /[0-9a-f]{64}/);
    assert.equal(events.rows[0].changes.commentId, reply.id);
  });

  it("records nothing for a private doc, and nothing for a visitor's post", async () => {
    const doc = await publish(mark, "Private audit");
    const root = await visitorRoot(doc.token);
    await replyToDocComment(mark, doc.id, root.id, { body: "Reply" });
    const events = await getAdminPool().query("select 1 from crm.audit_events where entity_id = $1 and event_type like 'page.comment_%'", [doc.id]);
    assert.equal(events.rowCount, 0);
    const shared = await publish(mark, "Shared audit", { shared: true });
    await visitorRoot(shared.token);
    assert.equal((await getAdminPool().query("select 1 from crm.audit_events where entity_id = $1 and event_type like 'page.comment_%'", [shared.id])).rowCount, 0);
  });
});

describe("Orbit comments: alerts to the doc's owner", () => {
  useServerlessPool();

  function pusher() {
    const sent: Record<string, unknown>[] = [];
    const send: PushSender = async (_subscription, payload) => {
      sent.push(JSON.parse(payload));
    };
    return { send, sent };
  }

  it("tells the owner of a visitor's comment once, and nobody else", async () => {
    await getAdminPool().query("delete from crm.notifications");
    await getAdminPool().query("delete from crm.push_subscriptions");
    await savePushSubscription(mark, { endpoint: "https://web.push.apple.com/phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await savePushSubscription(priya, { endpoint: "https://web.push.apple.com/tablet", keys: { p256dh: "BKey", auth: "auth" } }, "iPad");
    const doc = await publish(mark, "Blog performance", { shared: true });
    const comment = await visitorRoot(doc.token, "Is this clicks or impressions?", "Sarah Jones");
    const first = pusher();
    await getAdminPool().query("delete from crm.notifications");
    await getAdminPool().query("delete from crm.push_log");
    assert.equal(await alertDocOwner(comment.id, first.send), true);
    assert.equal(await alertDocOwner(comment.id, first.send), false);
    const mine = await notificationsFor(mark.userId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Sarah Jones commented on Blog performance");
    assert.equal(mine[0].body, "Is this clicks or impressions?");
    assert.match(mine[0].href, new RegExp(`/docs/${doc.id}\\?comments=1&comment=${comment.id}`));
    assert.equal((await notificationsFor(priya.userId)).length, 0);
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0].title, "Sarah Jones commented on Blog performance");
  });

  it("alerts through the public route and calls a visitor's reply a reply", async () => {
    await getAdminPool().query("delete from crm.notifications");
    const doc = await publish(mark, "Route alerts");
    const key = newKey();
    const root = await publicPost(doc.token, key, { name: "Rae Reader", body: "First", anchor: ANCHOR });
    await publicPost(doc.token, key, { name: "Rae Reader", body: "Follow up", parentId: root.id });
    const mine = await notificationsFor(mark.userId);
    assert.deepEqual(mine.map((item) => item.title), ["Rae Reader commented on Route alerts", "Rae Reader replied on Route alerts"]);
    assert.equal((await notificationsFor(priya.userId)).length, 0);
  });

  it("sends a doc made by a person to that person, and an agent's doc to the workspace owner", async () => {
    await getAdminPool().query("delete from crm.notifications");
    const hers = await publish(priya, "Priya's doc", { shared: true });
    await visitorRoot(hers.token);
    assert.equal((await notificationsFor(priya.userId)).length, 1);
    assert.equal((await notificationsFor(mark.userId)).length, 0);
    const made = await publish(agent, "Agent's doc");
    await visitorRoot(made.token);
    assert.equal((await notificationsFor(mark.userId)).length, 1);
    assert.equal((await notificationsFor(priya.userId)).length, 1);
  });

  it("stays quiet for replies written from Orbit", async () => {
    await getAdminPool().query("delete from crm.notifications");
    const doc = await publish(mark, "Quiet", { shared: true });
    const root = await visitorRoot(doc.token);
    await getAdminPool().query("delete from crm.notifications");
    const reply = await replyToDocComment(priya, doc.id, root.id, { body: "From Orbit" });
    const agentReply = await replyToDocComment(agent, doc.id, root.id, { body: "From an agent" });
    assert.equal(await alertDocOwner(reply.id), false);
    assert.equal(await alertDocOwner(agentReply.id), false);
    assert.equal((await notificationsFor(mark.userId)).length, 0);
    assert.equal((await notificationsFor(priya.userId)).length, 0);
  });
});

describe("Orbit comments: agents", () => {
  useServerlessPool();

  it("reads, replies, resolves and deletes through the REST API", async () => {
    const doc = await publish(agent, "REST comments");
    const root = await visitorRoot(doc.token, "Please check");
    const listed = await restList(rest(`${doc.id}/comments`, "GET"), { params: Promise.resolve({ id: doc.id }) });
    const body = (await listed.json()) as { allowComments: boolean; comments: { id: string; quote: string; status: string; orphaned: boolean; author: { kind: string }; replies: unknown[] }[] };
    assert.equal(listed.status, 200);
    assert.equal(body.allowComments, true);
    assert.deepEqual([body.comments[0].id, body.comments[0].quote, body.comments[0].status, body.comments[0].orphaned, body.comments[0].author.kind], [root.id, "parcel", "open", false, "visitor"]);
    const replied = await restReply(rest(`${doc.id}/comments/${root.id}/replies`, "POST", { body: "Fixed" }), { params: Promise.resolve({ id: doc.id, commentId: root.id }) });
    assert.equal(replied.status, 201);
    assert.equal(((await replied.json()) as { comment: { authorName: string } }).comment.authorName, "Claude Code");
    const resolved = await restResolve(rest(`${doc.id}/comments/${root.id}`, "PATCH", { resolved: true }), { params: Promise.resolve({ id: doc.id, commentId: root.id }) });
    assert.equal(((await resolved.json()) as { comment: { resolved: boolean } }).comment.resolved, true);
    const bad = await restResolve(rest(`${doc.id}/comments/${root.id}`, "PATCH", { resolved: "yes" }), { params: Promise.resolve({ id: doc.id, commentId: root.id }) });
    assert.equal(bad.status, 400);
    const removed = await restDelete(rest(`${doc.id}/comments/${root.id}`, "DELETE"), { params: Promise.resolve({ id: doc.id, commentId: root.id }) });
    assert.equal(removed.status, 200);
    const after = await restList(rest(`${doc.id}/comments`, "GET"), { params: Promise.resolve({ id: doc.id }) });
    assert.deepEqual(((await after.json()) as { comments: unknown[] }).comments, []);
    const privateDoc = await publish(mark, "Not for agents");
    const hidden = await restList(rest(`${privateDoc.id}/comments`, "GET"), { params: Promise.resolve({ id: privateDoc.id }) });
    assert.equal(hidden.status, 404);
  });

  it("marks a thread orphaned once its text is gone, and reports the open count on the doc", async () => {
    const doc = await publish(agent, "Orphans");
    await visitorRoot(doc.token);
    assert.equal((await getDoc(agent, doc.id)).openComments, 1);
    assert.equal((await listDocComments(agent, doc.id)).text.includes("parcel"), true);
    await getAdminPool().query("update crm.pages set content = 'Nothing like it any more.' where id = $1", [doc.id]);
    const listed = await restList(rest(`${doc.id}/comments`, "GET"), { params: Promise.resolve({ id: doc.id }) });
    const body = (await listed.json()) as { comments: { orphaned: boolean }[] };
    assert.equal(body.comments[0].orphaned, true);
  });

  it("reads, replies, resolves and deletes over MCP", async () => {
    const personal = await connect(mark);
    const bot = await connect(agent);
    try {
      const doc = await publish(mark, "MCP comments", { shared: true });
      const root = await visitorRoot(doc.token, "Look here");
      const listed = (await personal.call("list_doc_comments", { id: doc.id })).value as { comments: { id: string; replies: unknown[] }[] };
      assert.equal(listed.comments.length, 1);
      assert.equal(((await personal.call("read_doc", { id: doc.id })).value!.doc as { openComments: number }).openComments, 1);
      const sent = await bot.call("reply_to_doc_comment", { id: doc.id, comment_id: root.id, body: "Agent says hi" });
      assert.equal(sent.error, null);
      const reply = sent.value as { comment: { authorName: string } };
      assert.equal(reply.comment.authorName, "Claude Code");
      const again = (await personal.call("reply_to_doc_comment", { id: doc.id, comment_id: root.id, body: "And me" })).value as { comment: { authorName: string } };
      assert.equal(again.comment.authorName, "Mark Ridgeon");
      assert.equal(((await personal.call("resolve_doc_comment", { id: doc.id, comment_id: root.id })).value as { comment: { resolved: boolean } }).comment.resolved, true);
      assert.equal(((await personal.call("resolve_doc_comment", { id: doc.id, comment_id: root.id, reopen: true })).value as { comment: { resolved: boolean } }).comment.resolved, false);
      assert.match((await bot.call("reply_to_doc_comment", { id: doc.id, comment_id: root.id, body: "" })).error ?? "", /Write a comment/);
      assert.equal((await personal.call("delete_doc_comment", { id: doc.id, comment_id: root.id })).error, null);
      assert.deepEqual(((await personal.call("list_doc_comments", { id: doc.id })).value as { comments: unknown[] }).comments, []);
      const hidden = await publish(mark, "MCP hidden");
      assert.match((await bot.call("list_doc_comments", { id: hidden.id })).error ?? "", /not_found/);
    } finally {
      await personal.close();
      await bot.close();
    }
  });

  it("reads comments with the doc and writes through an approval card in the assistant", async () => {
    const doc = await publish(mark, "Assistant comments");
    const root = await visitorRoot(doc.token, "Is this right?", "Sarah Jones");
    const read = (await runTool(mark, "read_knowledge", { docId: doc.id })) as { doc: { openComments: number }; comments: { id: string; quote: string; status: string; replies: unknown[] }[] };
    assert.equal(read.doc.openComments, 1);
    assert.deepEqual([read.comments[0].id, read.comments[0].quote, read.comments[0].status], [root.id, "parcel", "open"]);

    const reply = { action: "reply_comment", docId: doc.id, commentId: root.id, content: "Yes, it is." };
    const card = describeAction("save_doc", reply, await recordNames(mark, [reply], ["save_doc"]));
    assert.equal(card.title, "Reply to a comment on Assistant comments");
    assert.deepEqual(card.lines, ['"Yes, it is."', "Everyone with the public link sees the reply under your name."]);
    assert.match(((await runTool(mark, "save_doc", reply, { unattended: true })) as { error: string }).error, /Only edits to a doc's text/);
    const done = (await runTool(mark, "save_doc", reply)) as { saved: boolean; comment: { authorName: string; body: string } };
    assert.deepEqual([done.saved, done.comment.authorName, done.comment.body], [true, "Mark Ridgeon", "Yes, it is."]);

    const resolve = { action: "resolve_comment", docId: doc.id, commentId: root.id };
    const resolveCard = describeAction("save_doc", resolve, await recordNames(mark, [resolve], ["save_doc"]));
    assert.equal(resolveCard.title, "Resolve a comment on Assistant comments");
    assert.equal(resolveCard.lines[0], "Sarah Jones: Is this right?");
    assert.equal(((await runTool(mark, "save_doc", resolve)) as { comment: { resolved: boolean } }).comment.resolved, true);
    assert.equal(((await runTool(mark, "save_doc", { ...resolve, action: "reopen_comment" })) as { comment: { resolved: boolean } }).comment.resolved, false);

    const remove = { action: "delete_comment", docId: doc.id, commentId: root.id };
    assert.equal(describeAction("save_doc", remove, await recordNames(mark, [remove], ["save_doc"])).title, "Delete a comment on Assistant comments");
    assert.equal(((await runTool(mark, "save_doc", remove)) as { deleted: boolean }).deleted, true);
    assert.match(((await runTool(mark, "save_doc", { action: "reply_comment", docId: doc.id, content: "No id" })) as { error: string }).error, /commentId/);
  });
});
