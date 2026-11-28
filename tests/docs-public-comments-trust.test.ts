import "./svg-stub";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DELETE as deleteRoute, PATCH as editRoute } from "@/app/api/d/[token]/comments/[id]/route";
import { GET as listRoute, POST as addRoute } from "@/app/api/d/[token]/comments/route";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listDocComments, replyToDocComment } from "@/lib/docs/comments";
import { createDoc, saveDoc, setDocPublic } from "@/lib/docs/store";
import { createAgent, createUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let agent: AgentActor;
let counter = 0;

type Wire = { id: string; parentId: string | null; authorName: string; authorKind?: string; body: string; mine: boolean };

const CONTENT = "We will receive the parcel on Friday.\n\nThe **second** paragraph has a [link](https://example.com/x) in it.";
const ANCHOR = { quote: "parcel", prefix: "We will receive the ", suffix: " on Friday", at: 20 };

const newKey = () => randomBytes(24).toString("base64url");

function nextIp() {
  counter += 1;
  return `198.51.${Math.floor(counter / 250)}.${counter % 250}`;
}

function call(method: string, token: string, options: { key?: string; body?: unknown; id?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp(), "content-type": "application/json" };
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

async function post(token: string, key: string, body: Record<string, unknown>) {
  const response = await call("POST", token, { key, body });
  const json = (await response.json()) as { comment?: Wire; error?: string };
  return { status: response.status, comment: json.comment, error: json.error };
}

async function list(token: string, key?: string) {
  const response = await call("GET", token, { key });
  return ((await response.json()) as { comments: Wire[] }).comments;
}

async function publish(content = CONTENT) {
  const doc = await createDoc(mark, { title: "Trust", content, shared: true });
  const on = await setDocPublic(mark, doc.id, { public: true, allowComments: true });
  return { id: doc.id, token: /\/d\/([A-Za-z0-9_-]{32})$/.exec(on.publicUrl ?? "")![1] };
}

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@docs-trust.test", "Mark Ridgeon");
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Claude Code")).actor;
});

after(async () => {
  delete process.env.SITE_URL;
  await getPool().end();
  await getAdminPool().end();
});

describe("Public comments mark who is on the team", () => {
  useServerlessPool();

  it("marks Orbit replies as team and a visitor using the same name as a visitor", async () => {
    const { id, token } = await publish();
    const key = newKey();
    const posed = await post(token, key, { name: "Mark Ridgeon", body: "I am definitely Mark", anchor: ANCHOR });
    assert.equal(posed.status, 201, posed.error);
    assert.equal(posed.comment?.authorKind, "visitor");
    const reply = await replyToDocComment(mark, id, posed.comment!.id, { body: "Thanks, this is Mark" });
    const robot = await replyToDocComment(agent, id, posed.comment!.id, { body: "Agent reply" });
    const other = await post(token, newKey(), { name: "Mark Ridgeon", body: "Me too", parentId: posed.comment!.id });
    assert.equal(other.comment?.authorKind, "visitor");
    const read = await list(token, key);
    const kinds = new Map(read.map((comment) => [comment.id, comment.authorKind]));
    assert.equal(kinds.get(posed.comment!.id), "visitor");
    assert.equal(kinds.get(reply.id), "team");
    assert.equal(kinds.get(robot.id), "team");
    assert.equal(kinds.get(other.comment!.id), "visitor");
    const visitors = read.filter((comment) => comment.authorName === "Mark Ridgeon");
    assert.equal(visitors.filter((comment) => comment.authorKind === "team").length, 1);
  });

  it("keeps the kind on edits and never sends a user id", async () => {
    const { id, token } = await publish();
    const key = newKey();
    const made = await post(token, key, { name: "Rae", body: "First", anchor: ANCHOR });
    const edited = await call("PATCH", token, { key, id: made.comment!.id, body: { body: "Second" } });
    assert.equal(edited.status, 200);
    assert.equal(((await edited.json()) as { comment: Wire }).comment.authorKind, "visitor");
    await replyToDocComment(mark, id, made.comment!.id, { body: "Reply" });
    const raw = JSON.stringify(await list(token, key));
    assert.ok(!raw.includes(mark.userId), "no user id on the page");
    assert.ok(!/author_?user|author_?agent/i.test(raw));
    const stored = (await listDocComments(mark, id)).comments.find((comment) => comment.authorKind === "person");
    assert.ok(stored);
  });
});

describe("Public comments only quote text the doc holds", () => {
  useServerlessPool();

  it("refuses a new comment whose quote was never in the doc, whatever the wording", async () => {
    const { token } = await publish();
    const invented = [
      "parcel on Saturday",
      "PARCEL",
      "We will receive  the parcel",
      "**second**",
      "[link](https://example.com/x)",
      "https://example.com/x",
      "text from some other doc",
      "parcel on Friday.\nThe second paragraph has a link in it. And more",
    ];
    for (const quote of invented) {
      const made = await post(token, newKey(), { name: "Rae", body: "Hello", anchor: { quote, prefix: "", suffix: "", at: 0 } });
      assert.equal(made.status, 400, quote);
      assert.match(made.error ?? "", /text has changed/i);
    }
    assert.equal((await list(token)).length, 0);
  });

  it("takes quotes the page really shows, including across blocks, and replies without a quote", async () => {
    const { token } = await publish();
    const quotes = ["parcel", "parcel on Friday.\nThe second paragraph", "second", "link", "We will receive the parcel on Friday."];
    for (const quote of quotes) {
      const made = await post(token, newKey(), { name: "Rae", body: "Fine", anchor: { quote, prefix: "", suffix: "", at: 0 } });
      assert.equal(made.status, 201, `${quote}: ${made.error}`);
    }
    const [first] = await list(token);
    const reply = await post(token, newKey(), { name: "Rae", body: "A reply", parentId: first.id });
    assert.equal(reply.status, 201);
  });

  it("refuses a quote once the doc has changed under the visitor", async () => {
    const { id, token } = await publish();
    assert.equal((await post(token, newKey(), { name: "Rae", body: "Before", anchor: ANCHOR })).status, 201);
    await saveDoc(mark, id, { content: "The parcel came early." });
    const after = await post(token, newKey(), { name: "Rae", body: "After", anchor: { quote: "on Friday", prefix: "the parcel ", suffix: ".", at: 28 } });
    assert.equal(after.status, 400);
    assert.equal((await post(token, newKey(), { name: "Rae", body: "Now", anchor: { quote: "parcel came", prefix: "The ", suffix: " early.", at: 4 } })).status, 201);
  });
});
