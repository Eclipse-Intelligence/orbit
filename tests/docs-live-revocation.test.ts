import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, describe, it } from "node:test";
import * as Y from "yjs";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createLiveDocs } from "@/lib/docs/live-adapter";
import { publishLiveChange, setLiveTesting, type LiveChange } from "@/lib/docs/live/broadcast";
import { docTopic, type LiveEvent } from "@/lib/docs/live/protocol";
import { rebase } from "@/lib/docs/live/rebase";
import { relayAllows } from "@/lib/docs/live/relay-access";
import { clearTrust } from "@/lib/docs/live/registry";
import { LiveSession, REMOTE, type LiveServer, type SessionTiming } from "@/lib/docs/live/session";
import { memoryHub } from "@/lib/docs/live/transport";
import { createLiveDoc, encodeBytes, liveText, stateFromMarkdown } from "@/lib/docs/live/ydoc";
import { createFolder } from "@/lib/docs/folders";
import { archiveDoc, createDoc, moveDoc, openLiveDoc, shareDoc, syncLiveDoc } from "@/lib/docs/store";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let priya: UserActor;
const open: LiveSession[] = [];

const FAST: Partial<SessionTiming> = {
  batchMs: 5,
  awarenessMs: 5,
  saveMs: 30,
  saveMaxMs: 80,
  ownMs: 150,
  titleMs: 20,
  heartbeatMs: 5_000,
  soloHeartbeatMs: 5_000,
  soloMaxMs: 5_000,
  retryMs: 40,
  connectMs: 200,
  hintMs: 5,
  hintGapMs: 20,
};

type Hub = ReturnType<typeof memoryHub>;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 4_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await wait(15);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function server(actor: UserActor, pageId: string): LiveServer {
  return {
    async sync(input) {
      const result = await syncLiveDoc(actor, pageId, { update: input.update, vector: input.vector, title: input.title });
      return { vector: result.vector, missing: result.missing, revision: result.doc.revision, title: result.doc.title, key: result.key, summary: result.doc };
    },
  };
}

async function session(actor: UserActor, pageId: string, hub: Hub) {
  const opened = await openLiveDoc(actor, pageId);
  const doc = createLiveDoc(opened.state);
  const live = new LiveSession({
    pageId,
    user: { id: actor.userId, name: actor.fullName ?? "Someone", kind: "person" },
    doc,
    serverVector: Y.encodeStateVector(doc),
    revision: opened.doc.revision,
    title: opened.doc.title,
    transport: hub.transport(),
    server: server(actor, pageId),
    timing: FAST,
    key: opened.key,
  });
  live.start();
  open.push(live);
  return { live, key: opened.key as string };
}

async function rawMember(hub: Hub, topic: string) {
  const events: { event: LiveEvent; payload: unknown }[] = [];
  let joined = false;
  const channel = hub.transport().open(topic, {
    message: (event, payload) => events.push({ event, payload }),
    status: (status) => {
      joined = status === "joined";
    },
  });
  await until(() => joined, "raw member joined");
  return { channel, events };
}

async function keyOf(pageId: string) {
  return (await getAdminPool().query<{ live_key: string }>("select live_key from crm.pages where id = $1", [pageId])).rows[0].live_key;
}

async function kicked(topic: string) {
  const result = await getAdminPool().query("select 1 from realtime.sent where topic = $1 and event = 'kick'", [topic]);
  return (result.rowCount ?? 0) > 0;
}

async function access(userId: string, topic: string) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin");
    await client.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
    await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" }),
      topic,
    ]);
    await client.query("set local role authenticated");
    const read = (await client.query("select id from realtime.messages where topic = $1 and extension = 'broadcast'", [topic])).rows.length > 0;
    await client.query("savepoint send");
    let write = true;
    try {
      await client.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true)", [topic]);
    } catch {
      write = false;
      await client.query("rollback to savepoint send");
    }
    return { read, write };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function sharedDoc(title: string, content: string) {
  const doc = await createDoc(mark, { title, content });
  await shareDoc(mark, doc.id, true);
  return doc;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@revoked.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["priya@revoked.test", "Priya Shah"])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@revoked.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  const exists = await admin.query<{ found: string | null }>("select to_regclass('realtime.messages')::text as found");
  if (!exists.rows[0].found) await admin.query(readFileSync("supabase/bootstrap/local-realtime.sql", "utf8"));
  await admin.query(`
    create table if not exists realtime.sent (id bigserial primary key, topic text, event text, payload jsonb);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as
    $$ insert into realtime.sent (topic, event, payload) values (topic, event, payload) $$;
  `);
  await admin.query(readFileSync("supabase/migrations/20261216100000_docs_realtime.sql", "utf8"));
  await admin.query(readFileSync("supabase/migrations/20270316100000_docs_live_keys.sql", "utf8"));
});

afterEach(async () => {
  setLiveTesting(null);
  clearTrust();
  while (open.length) await open.pop()!.close();
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("losing access to a note ends its live channel", () => {
  const privateFolder = async () => (await createFolder(mark, { name: `Private ${Math.random()}`, shared: false })).id;

  const cases: { name: string; prepare?: () => Promise<{ before: string }>; revoke: (id: string) => Promise<void>; markReads: boolean; priyaReads: boolean; writes: boolean }[] = [
    { name: "making it private", revoke: async (id) => void (await shareDoc(mark, id, false)), markReads: true, priyaReads: false, writes: true },
    {
      name: "moving it into a private folder",
      revoke: async (id) => {
        const folder = await privateFolder();
        await moveDoc(mark, id, { folderId: folder, allowVisibilityChange: true });
        await shareDoc(mark, id, false);
      },
      markReads: true,
      priyaReads: false,
      writes: true,
    },
    {
      name: "removing a member",
      revoke: async () => void (await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, priya.userId])),
      markReads: true,
      priyaReads: false,
      writes: true,
    },
    { name: "archiving it", revoke: async (id) => void (await archiveDoc(mark, id)), markReads: true, priyaReads: true, writes: false },
  ];

  for (const item of cases) {
    it(`rotates the channel key and kicks the old channel after ${item.name}`, async () => {
      const doc = await sharedDoc(`Revoked by ${item.name}`, "Shared plan");
      await openLiveDoc(priya, doc.id);
      await openLiveDoc(mark, doc.id);
      const oldKey = await keyOf(doc.id);
      const oldTopic = docTopic(doc.id, oldKey);
      assert.deepEqual(await access(priya.userId, oldTopic), { read: true, write: true });
      await item.revoke(doc.id);
      const newKey = await keyOf(doc.id);
      const newTopic = docTopic(doc.id, newKey);
      assert.notEqual(newKey, oldKey);
      assert.equal(await kicked(oldTopic), true, "the old channel is told to sync");
      for (const person of [mark, priya]) assert.deepEqual(await access(person.userId, oldTopic), { read: false, write: false }, "the old channel is dead for everyone");
      assert.equal((await access(priya.userId, newTopic)).read, item.priyaReads);
      assert.equal((await access(mark.userId, newTopic)).read, item.markReads);
      assert.equal((await access(mark.userId, newTopic)).write, item.writes);
      if (!item.priyaReads) assert.deepEqual(await access(priya.userId, newTopic), { read: false, write: false });
      await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [mark.workspaceId, priya.userId]);
    });
  }

  it("rotates the key when a private note changes hands, and leaves it alone for ordinary edits", async () => {
    const doc = await createDoc(mark, { title: "Handed over", content: "Mine" });
    const first = await keyOf(doc.id);
    await getAdminPool().query("update crm.pages set title = 'Renamed' where id = $1", [doc.id]);
    assert.equal(await keyOf(doc.id), first);
    await getAdminPool().query("update crm.pages set user_id = $2 where id = $1", [doc.id, priya.userId]);
    const second = await keyOf(doc.id);
    assert.notEqual(second, first);
    assert.equal((await access(mark.userId, docTopic(doc.id, second))).read, false);
    assert.equal((await access(priya.userId, docTopic(doc.id, second))).read, true);
    await shareDoc(priya, doc.id, true);
    assert.equal(await keyOf(doc.id), second, "sharing widens access and keeps the channel");
  });

  it("hands people who can still read the new channel and leaves a modified client on a dead one", async () => {
    const doc = await sharedDoc("Followed", "Base");
    const hub = memoryHub();
    const { live: markLive, key } = await session(mark, doc.id, hub);
    const { live: priyaLive } = await session(priya, doc.id, hub);
    const oldTopic = docTopic(doc.id, key);
    const eavesdropper = await rawMember(hub, oldTopic);
    const injector = await rawMember(hub, oldTopic);
    await until(() => markLive.status === "live" && priyaLive.status === "live", "both live");
    await shareDoc(mark, doc.id, false);
    const newKey = await keyOf(doc.id);
    assert.equal(await kicked(oldTopic), true);
    injector.channel.send("kick", {});
    await until(() => priyaLive.status === "stopped" && priyaLive.failure?.final === true, "the removed person stops");
    await until(() => markLive.liveKey === newKey, "the owner follows the new channel");
    const watcher = await rawMember(hub, docTopic(doc.id, newKey));
    await wait(40);
    const seen = eavesdropper.events.length;
    liveText(markLive.doc).insert(liveText(markLive.doc).length, " and a secret");
    await until(() => watcher.events.some((item) => item.event === "update"), "the update reaches the new channel");
    eavesdropper.channel.send("hello", { c: 4242, sv: encodeBytes(Y.encodeStateVector(new Y.Doc())) });
    await wait(120);
    const after = eavesdropper.events.slice(seen).filter((item) => item.event === "update" || item.event === "state");
    assert.deepEqual(after, [], "nothing typed after the change reaches the old channel");
    assert.equal(priyaLive.text.toString().includes("secret"), false);
  });

  it("publishes server edits only on the current channel", async () => {
    const sent: { topic: string; event: string }[] = [];
    setLiveTesting({ sink: async (topic, event) => void sent.push({ topic, event }), wait: async () => {}, watched: async () => true });
    const doc = await sharedDoc("Server edits", "Base");
    await openLiveDoc(priya, doc.id);
    const oldTopic = docTopic(doc.id, await keyOf(doc.id));
    await shareDoc(mark, doc.id, false);
    const newTopic = docTopic(doc.id, await keyOf(doc.id));
    const change: LiveChange = {
      pageId: doc.id,
      workspaceId: mark.workspaceId,
      ownerId: mark.userId,
      shared: false,
      revision: 2,
      generation: 0,
      agent: null,
      steps: [{ u: encodeBytes(Y.encodeStateAsUpdate(createLiveDoc(Y.encodeStateAsUpdate(new Y.Doc())))), from: null, head: null }],
      typedCharacters: 0,
    };
    await publishLiveChange(change);
    await publishLiveChange({ ...change, rebuilt: true });
    assert.ok(sent.length > 0);
    assert.deepEqual([...new Set(sent.map((item) => item.topic))], [newTopic]);
    assert.ok(!sent.some((item) => item.topic === oldTopic));
  });

  it("refuses the relay to anyone without the page's current key", async () => {
    const doc = await sharedDoc("Relay", "Base");
    const oldTopic = docTopic(doc.id, await keyOf(doc.id));
    assert.equal(await relayAllows(priya, oldTopic, false), true);
    assert.equal(await relayAllows(priya, docTopic(doc.id), false), false, "a topic without a key");
    await shareDoc(mark, doc.id, false);
    assert.equal(await relayAllows(priya, oldTopic, false), false);
    assert.equal(await relayAllows(mark, oldTopic, false), false, "the old key is dead for the owner too");
    const newTopic = docTopic(doc.id, await keyOf(doc.id));
    assert.equal(await relayAllows(priya, newTopic, false), false);
    assert.equal(await relayAllows(mark, newTopic, false), true);
  });
});

describe("a stale merge base after someone else types", () => {
  it("moves the base forward when the server's state is what this person now shows", async () => {
    const base = createLiveDoc(Y.encodeStateAsUpdate(new Y.Doc()));
    liveText(base).insert(0, "Base");
    const state = Y.encodeStateAsUpdate(base);
    const server = createLiveDoc(state);
    const client = createLiveDoc(state);
    const remote = createLiveDoc(state);
    const before = Y.encodeStateVector(remote);
    liveText(remote).insert(4, "\n\nRemote paragraph");
    const remoteUpdate = Y.encodeStateAsUpdate(remote, before);
    Y.applyUpdate(server, remoteUpdate);
    const fake: LiveServer = {
      async sync(input) {
        Y.applyUpdate(client, remoteUpdate, REMOTE);
        return { vector: Y.encodeStateVector(server), missing: Y.encodeStateAsUpdate(server, input.vector), revision: 2 };
      },
    };
    const live = new LiveSession({ pageId: "00000000-0000-4000-8000-000000000001", user: { id: "u", name: "U", kind: "person" }, doc: client, serverVector: Y.encodeStateVector(client), serverText: "Base", revision: 1, title: "T", transport: null, server: fake, timing: FAST });
    live.start();
    open.push(live);
    await live.sync();
    assert.equal(live.text.toString(), "Base\n\nRemote paragraph");
    assert.equal(live.serverText, "Base\n\nRemote paragraph");
    assert.equal(live.serverRevision, 2);
    assert.ok(rebase(live.serverText, live.text.toString(), "Base\n\nRemote paragraph").toShared.empty, "a rebuild keeps one copy of the paragraph");
  });

  it("keeps the old base while this person has typed something the server hasn't seen", async () => {
    const state = (() => {
      const seed = createLiveDoc(Y.encodeStateAsUpdate(new Y.Doc()));
      liveText(seed).insert(0, "Base");
      return Y.encodeStateAsUpdate(seed);
    })();
    const server = createLiveDoc(state);
    const client = createLiveDoc(state);
    const fake: LiveServer = {
      async sync(input) {
        liveText(client).insert(0, "Typed meanwhile. ");
        return { vector: Y.encodeStateVector(server), missing: Y.encodeStateAsUpdate(server, input.vector), revision: 1 };
      },
    };
    const live = new LiveSession({ pageId: "00000000-0000-4000-8000-000000000002", user: { id: "u", name: "U", kind: "person" }, doc: client, serverVector: Y.encodeStateVector(client), serverText: "Base", revision: 1, title: "T", transport: null, server: fake, timing: FAST });
    live.start();
    open.push(live);
    await live.sync();
    assert.equal(live.serverText, "Base");
  });
});

describe("saving when the page closes", () => {
  it("counts bytes, not characters, when deciding whether a beacon save fits", async () => {
    const calls: { keepalive: boolean }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ keepalive: init?.keepalive === true });
      return new Response(JSON.stringify({ page: { id: "p" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const docs = createLiveDocs();
      await docs.savePage("p", { body: "a".repeat(30_000), baseRevision: 1 } as never, { keepalive: true });
      await docs.savePage("p", { body: "é".repeat(30_000), baseRevision: 1 } as never, { keepalive: true });
      await docs.savePage("p", { body: "é".repeat(20_000), baseRevision: 1 } as never, { keepalive: true });
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(
      calls.map((call) => call.keepalive),
      [true, false, true],
    );
  });
});

function bloated(text: string) {
  const doc = createLiveDoc(stateFromMarkdown(text));
  for (let index = 0; index < 12_000; index += 1) {
    const other = new Y.Doc();
    liveText(other).insert(0, "x");
    liveText(other).delete(0, 1);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  }
  return Y.encodeStateAsUpdate(doc);
}

describe("opening a live note on the serverless pool", () => {
  useServerlessPool();

  it("checks who is watching before it opens its transaction", async () => {
    const doc = await sharedDoc("Pooled open", "Base");
    await openLiveDoc(priya, doc.id);
    const state = bloated("Base");
    assert.ok(state.length >= 64_000, `needs a long history, got ${state.length} bytes`);
    await getAdminPool().query("update crm.pages set ydoc = $2 where id = $1", [doc.id, Buffer.from(state)]);
    await getAdminPool().query("update crm.page_watchers set seen_at = now() - interval '5 minutes' where page_id = $1", [doc.id]);
    const rebuilt = await openLiveDoc(mark, doc.id);
    assert.ok(rebuilt.state.length < state.length, "a history nobody is watching is compacted");
    await getAdminPool().query("update crm.pages set ydoc = $2 where id = $1", [doc.id, Buffer.from(state)]);
    const kept = await openLiveDoc(mark, doc.id);
    assert.equal(kept.state.length, state.length, "a history someone is watching is kept");
  });
});
