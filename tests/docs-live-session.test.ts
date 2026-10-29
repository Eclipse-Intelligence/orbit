import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import * as Y from "yjs";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { presenceOf, watchLiveActivity } from "@/lib/docs/live/client";
import { docTopic, workspaceTopic, type LiveEvent } from "@/lib/docs/live/protocol";
import { changesBetween } from "@/lib/docs/live/rebase";
import { clearTrust } from "@/lib/docs/live/registry";
import { LiveSession, LiveSyncError, openSettled, TOO_LONG, type LiveServer, type SessionTiming } from "@/lib/docs/live/session";
import { memoryHub } from "@/lib/docs/live/transport";
import { createLiveDoc, encodeBytes, liveText } from "@/lib/docs/live/ydoc";
import { createDoc, editDoc, getDoc, openLiveDoc, saveDoc, shareDoc, syncLiveDoc } from "@/lib/docs/store";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let agent: AgentActor;
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

type Calls = { count: number; fail: boolean; error?: unknown };

function server(actor: UserActor, pageId: string, calls: Calls = { count: 0, fail: false }): LiveServer {
  return {
    async sync(input) {
      calls.count += 1;
      if (calls.error) throw calls.error;
      if (calls.fail) throw new Error("offline");
      const result = await syncLiveDoc(actor, pageId, { update: input.update, vector: input.vector, title: input.title });
      return { vector: result.vector, missing: result.missing, revision: result.doc.revision, title: result.doc.title, summary: result.doc };
    },
  };
}

type Hub = ReturnType<typeof memoryHub>;

async function session(actor: UserActor, pageId: string, transport: ReturnType<Hub["transport"]> | null, calls?: Calls) {
  const opened = await openLiveDoc(actor, pageId);
  const doc = createLiveDoc(opened.state);
  const live = new LiveSession({
    pageId,
    user: { id: actor.userId, name: actor.fullName ?? "Someone", kind: "person" },
    doc,
    serverVector: Y.encodeStateVector(doc),
    revision: opened.doc.revision,
    title: opened.doc.title,
    transport,
    server: server(actor, pageId, calls),
    timing: FAST,
  });
  live.start();
  open.push(live);
  return live;
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 4_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function type(live: LiveSession, at: number | "end", text: string) {
  const target = liveText(live.doc);
  target.insert(at === "end" ? target.length : at, text);
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@session.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["priya@session.test", "Priya Shah"])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@session.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Docs agent")).actor;
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

async function sharedDoc(title: string, content: string) {
  const doc = await createDoc(mark, { title, content });
  await shareDoc(mark, doc.id, true);
  return doc;
}

describe("live sessions", () => {
  it("syncs two people typing at once and saves the merged text once settled", async () => {
    const doc = await sharedDoc("Two typists", "Start");
    const hub = memoryHub();
    const markCalls = { count: 0, fail: false };
    const priyaCalls = { count: 0, fail: false };
    const markLive = await session(mark, doc.id, hub.transport(), markCalls);
    const priyaLive = await session(priya, doc.id, hub.transport(), priyaCalls);
    await until(() => markLive.status === "live" && priyaLive.status === "live", "both live");
    await until(() => markLive.remoteStates().length === 1 && priyaLive.remoteStates().length === 1, "presence");
    type(markLive, 0, "Mark: ");
    type(priyaLive, "end", " and Priya 😀");
    type(markLive, "end", "!");
    await until(() => liveText(markLive.doc).toString() === liveText(priyaLive.doc).toString(), "convergence");
    const text = liveText(markLive.doc).toString();
    assert.ok(text.startsWith("Mark: Start"));
    assert.ok(text.includes(" and Priya 😀"));
    await until(async () => (await getDoc(mark, doc.id)).content === text, "the merged text is saved");
    await until(() => !markLive.unconfirmed() && !priyaLive.unconfirmed(), "both confirmed");
  });

  it("elects one saver so a watching tab doesn't write", async () => {
    const doc = await sharedDoc("One saver", "Base");
    const hub = memoryHub();
    const calls: Calls[] = [
      { count: 0, fail: false },
      { count: 0, fail: false },
      { count: 0, fail: false },
    ];
    const lives = [await session(mark, doc.id, hub.transport(), calls[0]), await session(priya, doc.id, hub.transport(), calls[1]), await session(mark, doc.id, hub.transport(), calls[2])];
    await until(() => lives.every((live) => live.remoteStates().length === 2), "presence");
    const saverIndex = lives.findIndex((live) => live.isSaver());
    assert.equal(lives.filter((live) => live.isSaver()).length, 1);
    const [typistIndex, watcherIndex] = [0, 1, 2].filter((index) => index !== saverIndex);
    const typist = lives[typistIndex];
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = calls.map((entry) => entry.count);
    for (let index = 0; index < 5; index += 1) {
      type(typist, "end", ` ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await until(async () => (await getDoc(mark, doc.id)).content === "Base 0 1 2 3 4", "saved by the saver");
    await until(() => !typist.unconfirmed(), "typist confirmed by the server");
    assert.ok(calls[saverIndex].count - before[saverIndex] >= 1);
    assert.equal(calls[watcherIndex].count - before[watcherIndex], 0, "the watching tab didn't write");
  });

  it("brings a late joiner up to date with changes nobody has saved yet", async () => {
    const doc = await sharedDoc("Late joiner", "Hello");
    const hub = memoryHub();
    const priyaLive = await session(priya, doc.id, hub.transport(), { count: 0, fail: true });
    type(priyaLive, "end", " from Priya, unsaved");
    const phone = await session(mark, doc.id, hub.transport());
    await until(() => liveText(phone.doc).toString() === "Hello from Priya, unsaved", "late joiner catches up");
  });

  it("keeps edits made while disconnected and merges them on reconnect", async () => {
    const doc = await sharedDoc("Reconnect", "Line");
    const hub = memoryHub();
    const markTransport = hub.transport();
    const markLive = await session(mark, doc.id, markTransport);
    const priyaLive = await session(priya, doc.id, hub.transport());
    await until(() => markLive.status === "live" && priyaLive.status === "live", "both live");
    hub.disconnect(markTransport.id);
    await until(() => markLive.status === "solo", "mark without a channel");
    type(markLive, 0, "Offline edit. ");
    type(priyaLive, "end", " online edit.");
    hub.reconnect(markTransport.id);
    await until(() => markLive.status === "live", "mark back");
    await until(() => liveText(markLive.doc).toString() === "Offline edit. Line online edit." && liveText(priyaLive.doc).toString() === "Offline edit. Line online edit.", "merge");
    await until(async () => (await getDoc(mark, doc.id)).content === "Offline edit. Line online edit.", "saved");
  });

  it("fetches a change whose broadcast was lost as soon as its author saves", async () => {
    const doc = await sharedDoc("Lost broadcast", "Base");
    const hub = memoryHub();
    const markTransport = hub.transport();
    const markLive = await session(mark, doc.id, markTransport);
    const priyaLive = await session(priya, doc.id, hub.transport());
    await until(() => markLive.status === "live" && priyaLive.status === "live", "both live");
    hub.mute(markTransport.id);
    type(markLive, "end", " typed while the network dropped it");
    await new Promise((resolve) => setTimeout(resolve, 12));
    hub.unmute(markTransport.id);
    await until(() => liveText(priyaLive.doc).toString() === "Base typed while the network dropped it", "priya pulls the missed change");
  });

  it("shows offline when the server can't be reached and syncs once it can", async () => {
    const doc = await sharedDoc("Server down", "Text");
    const hub = memoryHub();
    const calls = { count: 0, fail: true };
    const markLive = await session(mark, doc.id, hub.transport(), calls);
    type(markLive, "end", " kept");
    await until(() => markLive.status === "offline", "offline");
    assert.ok(markLive.unconfirmed());
    calls.fail = false;
    await until(() => markLive.status === "live" && !markLive.unconfirmed(), "recovered", 6_000);
    assert.equal((await getDoc(mark, doc.id)).content, "Text kept");
  });

  it("works without a realtime connection by syncing through the server", async () => {
    const doc = await sharedDoc("No realtime", "A");
    const markLive = await session(mark, doc.id, null);
    assert.equal(markLive.status, "solo");
    type(markLive, "end", "B");
    await until(async () => (await getDoc(mark, doc.id)).content === "AB", "saved over http");
  });

  it("delivers an agent's edit live with its cursor, merged with unsaved typing", async () => {
    const doc = await sharedDoc("Agent live", "Partners carry Q4.");
    const hub = memoryHub();
    const writers = new Set<string>();
    setLiveTesting({
      sink: async (topic, event, payload) => hub.publish(topic, event as LiveEvent, payload),
      wait: async () => new Promise((resolve) => setTimeout(resolve, 5)),
      watched: async () => true,
    });
    const markLive = await session(mark, doc.id, hub.transport(), { count: 0, fail: true });
    await until(() => markLive.status !== "connecting", "settled");
    markLive.subscribe(() => {
      for (const { state } of markLive.remoteStates()) if (state.writing) writers.add(state.user.name);
    });
    type(markLive, 0, "Unsaved: ");
    await editDoc(agent, doc.id, { action: "append", content: "Acme's renewal lands in January, so the pilot results need to be in their hands by 12 December." });
    await until(() => liveText(markLive.doc).toString() === "Unsaved: Partners carry Q4.\n\nAcme's renewal lands in January, so the pilot results need to be in their hands by 12 December.", "agent edit arrives");
    assert.ok(writers.has("Docs agent"));
    await until(() => markLive.remoteStates().length === 0, "agent presence clears", 4_000);
  });

  it("picks up a classic save made while the note is live", async () => {
    const doc = await sharedDoc("Classic during live", "One");
    const hub = memoryHub();
    setLiveTesting({ sink: async (topic, event, payload) => hub.publish(topic, event as LiveEvent, payload), wait: async () => {}, watched: async () => true });
    const markLive = await session(mark, doc.id, hub.transport());
    await until(() => markLive.status === "live", "live");
    await saveDoc(priya, doc.id, { content: "One, two", baseRevision: (await getDoc(priya, doc.id)).revision });
    await until(() => liveText(markLive.doc).toString() === "One, two", "classic save arrives");
  });

  it("sends title changes with the next save and tells the other people", async () => {
    const doc = await sharedDoc("Old title", "Body");
    const hub = memoryHub();
    const markLive = await session(mark, doc.id, hub.transport());
    const priyaLive = await session(priya, doc.id, hub.transport());
    await until(() => markLive.status === "live" && priyaLive.status === "live", "live");
    const seen: string[] = [];
    priyaLive.onTitle((title) => seen.push(title));
    markLive.setTitle("New title");
    await until(async () => (await getDoc(mark, doc.id)).title === "New title", "title saved");
    await until(() => seen.includes("New title"), "title broadcast");
  });
});

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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forget(live: LiveSession) {
  const index = open.indexOf(live);
  if (index >= 0) open.splice(index, 1);
}

describe("live session safety", () => {
  it("keeps protecting a change whose broadcast was dropped, even after the saver confirms later ones", async () => {
    const doc = await sharedDoc("Dropped broadcast", "Base");
    const hub = memoryHub();
    const calls: Calls[] = [
      { count: 0, fail: false },
      { count: 0, fail: false },
    ];
    const transports = [hub.transport(), hub.transport()];
    const lives = [await session(mark, doc.id, transports[0], calls[0]), await session(priya, doc.id, transports[1], calls[1])];
    await until(() => lives.every((live) => live.remoteStates().length === 1), "presence");
    await wait(40);
    const typistIndex = lives[0].isSaver() ? 1 : 0;
    const typist = lives[typistIndex];
    const saver = lives[1 - typistIndex];
    calls[typistIndex].fail = true;
    hub.mute(transports[typistIndex].id);
    type(typist, "end", " one");
    await wait(30);
    hub.unmute(transports[typistIndex].id);
    type(typist, "end", " two");
    await wait(30);
    assert.equal(liveText(saver.doc).toString(), "Base", "the saver can't integrate the second change without the first");
    type(saver, 0, "S:");
    await until(async () => (await getDoc(mark, doc.id)).content.startsWith("S:"), "the saver saved for another reason");
    await wait(150);
    assert.ok(typist.unconfirmed(), "the typist still protects its text");
    calls[typistIndex].fail = false;
    await typist.close();
    forget(typist);
    const saved = (await getDoc(mark, doc.id)).content;
    assert.ok(saved.includes("Base one two"), saved);
  });

  it("treats peer saved messages as hints and ignores a server flag from a peer", async () => {
    const doc = await sharedDoc("Forged", "Base");
    const hub = memoryHub();
    const calls: Calls = { count: 0, fail: true };
    const markLive = await session(mark, doc.id, hub.transport(), calls);
    const forger = await rawMember(hub, docTopic(doc.id));
    await until(() => markLive.status !== "connecting", "joined");
    type(markLive, "end", " mine");
    await wait(30);
    const before = calls.count;
    forger.channel.send("saved", { sv: encodeBytes(Y.encodeStateVector(markLive.doc)), r: 999, seqs: { [String(markLive.clientId)]: 999 } });
    await wait(120);
    assert.ok(markLive.unconfirmed(), "a forged saved message doesn't confirm anything");
    assert.ok(calls.count > before, "the hint made the session check with the server");
    calls.fail = false;
    await until(() => !markLive.unconfirmed(), "confirmed by the server");
    assert.equal((await getDoc(mark, doc.id)).content, "Base mine");
    const copy = createLiveDoc(Y.encodeStateAsUpdate(markLive.doc));
    const vector = Y.encodeStateVector(copy);
    liveText(copy).insert(liveText(copy).length, " forged");
    forger.channel.send("update", { u: encodeBytes(Y.encodeStateAsUpdate(copy, vector)), server: true });
    await until(() => liveText(markLive.doc).toString() === "Base mine forged", "update applied");
    await until(async () => (await getDoc(mark, doc.id)).content === "Base mine forged", "a peer's server flag is treated as an ordinary change and saved");
  });

  it("stops retrying after a permanent failure, leaves the channel and keeps retrying network errors", async () => {
    const doc = await sharedDoc("Gone", "Base");
    const hub = memoryHub();
    const markLive = await session(mark, doc.id, hub.transport());
    const gone: Calls = { count: 0, fail: false };
    const priyaLive = await session(priya, doc.id, hub.transport(), gone);
    await until(() => markLive.remoteStates().length === 1 && priyaLive.remoteStates().length === 1, "presence");
    gone.error = new LiveSyncError("That doc doesn't exist.", 404);
    type(priyaLive, "end", " lost access");
    await until(() => priyaLive.status === "stopped", "stopped");
    assert.equal(priyaLive.failure?.final, true);
    const count = gone.count;
    await wait(300);
    assert.equal(gone.count, count, "no retries after a 404");
    await until(() => markLive.remoteStates().length === 0, "left the channel");

    const flaky: Calls = { count: 0, fail: false, error: new LiveSyncError("Docs didn't respond.", 503) };
    const solo = await session(mark, doc.id, null, flaky);
    type(solo, "end", "!");
    await until(() => solo.status === "offline", "offline on a 503");
    const first = flaky.count;
    await until(() => flaky.count > first + 1, "retries a 503");
    flaky.error = undefined;
    await until(() => !solo.unconfirmed(), "recovers");
  });

  it("pauses on a note that is too long and saves again after the next edit", async () => {
    const doc = await sharedDoc("Too long", "Base");
    const calls: Calls = { count: 0, fail: false };
    const markLive = await session(mark, doc.id, null, calls);
    calls.error = new LiveSyncError("This note is too long to save.", 400, TOO_LONG);
    type(markLive, "end", " long");
    await until(() => markLive.status === "stopped", "stopped");
    assert.equal(markLive.failure?.code, TOO_LONG);
    assert.equal(markLive.failure?.final, false);
    const count = calls.count;
    await wait(200);
    assert.equal(calls.count, count);
    calls.error = undefined;
    type(markLive, "end", "er");
    await until(() => markLive.status === "solo" && !markLive.unconfirmed(), "saved after the next edit");
    assert.equal((await getDoc(mark, doc.id)).content, "Base longer");
  });

  it("carries text typed while attaching into the live copy once, without doubling", async () => {
    const doc = await sharedDoc("Handoff", "Start");
    const shown = "Start abc";
    const opened = await openSettled(
      async () => ({ base: "Start", revision: doc.revision }),
      () => openLiveDoc(mark, doc.id).then((result) => ({ ...result, revision: result.doc.revision })),
      () => true,
    );
    assert.ok(opened);
    const live = createLiveDoc(opened.state);
    const markLive = new LiveSession({
      pageId: doc.id,
      user: { id: mark.userId, name: "Mark Ridgeon", kind: "person" },
      doc: live,
      serverVector: Y.encodeStateVector(live),
      revision: opened.revision,
      title: opened.doc.title,
      transport: null,
      server: server(mark, doc.id),
      timing: FAST,
    });
    markLive.start();
    open.push(markLive);
    const changes = changesBetween(opened.base, shown);
    live.transact(() => {
      changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        if (to > from) liveText(live).delete(from, to - from);
        if (inserted.length) liveText(live).insert(from, inserted.toString());
      });
    }, "reconcile");
    await until(async () => (await getDoc(mark, doc.id)).content === shown, "saved once");
    await wait(100);
    assert.equal((await getDoc(mark, doc.id)).content, shown);
  });

  it("opens the live copy again when a classic save lands while it loads", async () => {
    let revision = 1;
    let opens = 0;
    const opened = await openSettled(
      async () => ({ base: `rev ${revision}`, revision }),
      async () => {
        opens += 1;
        const result = { revision };
        if (opens === 1) revision = 2;
        return result;
      },
      () => true,
    );
    assert.equal(opens, 2);
    assert.deepEqual(opened, { revision: 2, base: "rev 2" });
  });

  it("announces the departing saver's final save before leaving", async () => {
    const doc = await sharedDoc("Departing saver", "Base");
    const hub = memoryHub();
    const first = await session(mark, doc.id, hub.transport());
    const second = await session(priya, doc.id, hub.transport());
    await until(() => first.remoteStates().length === 1 && second.remoteStates().length === 1, "presence");
    const watcher = await rawMember(hub, docTopic(doc.id));
    await wait(40);
    const saver = first.isSaver() ? first : second;
    type(saver, "end", " last words");
    watcher.events.length = 0;
    await saver.close();
    forget(saver);
    await until(() => watcher.events.some((item) => item.event === "saved"), "saved announced");
    assert.equal((await getDoc(mark, doc.id)).content, "Base last words");
  });

  it("shows an assistant cursor only when the server says the assistant is writing", async () => {
    const doc = await sharedDoc("Trusted kinds", "Base");
    const hub = memoryHub();
    const markLive = await session(mark, doc.id, hub.transport());
    const forger = await session(priya, doc.id, hub.transport());
    forger.awareness.setLocalStateField("user", { id: "orbit-assistant", name: "Orbit assistant", kind: "assistant" });
    await until(() => markLive.remoteStates().some((item) => item.state.user.id === "orbit-assistant"), "forged awareness arrives");
    const kindNow = () => presenceOf(markLive, mark.userId).find((entry) => entry.participant.name === "Orbit assistant")?.participant.kind;
    assert.equal(kindNow(), "person", "a peer can't claim to be the assistant");
    const seen: string[] = [];
    const stop = await watchLiveActivity(hub.transport(), { workspaceId: mark.workspaceId, userId: mark.userId }, (_page, writer) => seen.push(writer.kind), () => {});
    await wait(20);
    hub.publish(workspaceTopic(mark.workspaceId), "writing", { pageId: doc.id, user: { id: "orbit-assistant", name: "Orbit assistant", kind: "assistant" }, writing: true });
    await until(() => seen.length === 1, "writing event");
    assert.equal(kindNow(), "assistant");
    stop();
  });

  it("hands over a rebuilt live copy instead of merging stale changes into it", async () => {
    const original = createLiveDoc();
    liveText(original).insert(0, "Hello");
    const state = Y.encodeStateAsUpdate(original);
    const fresh = createLiveDoc();
    liveText(fresh).insert(0, "Oh, Hello");
    const sent: { generation?: number; update: Uint8Array | null; title?: string }[] = [];
    const fake: LiveServer = {
      async sync(input) {
        sent.push({ generation: input.generation, update: input.update, title: input.title });
        return { vector: Y.encodeStateVector(fresh), missing: Y.encodeStateAsUpdate(fresh), revision: 7, generation: 1, rebuilt: true, title: "Renamed" };
      },
    };
    const doc = createLiveDoc(state);
    const live = new LiveSession({
      pageId: "00000000-0000-4000-8000-000000000001",
      user: { id: mark.userId, name: "Mark Ridgeon", kind: "person" },
      doc,
      serverVector: Y.encodeStateVector(doc),
      revision: 6,
      generation: 0,
      title: "Old",
      transport: null,
      server: fake,
      timing: FAST,
    });
    let rebuilt = 0;
    live.onRebuilt(() => (rebuilt += 1));
    live.start();
    open.push(live);
    type(live, "end", ", world");
    live.setTitle("Mine");
    await until(() => rebuilt === 1, "rebuilt");
    assert.equal(sent[0].generation, 0, "the session sends its generation");
    assert.equal(liveText(live.doc).toString(), "Hello, world", "the stale doc is left alone");
    assert.ok(live.replacement?.state);
    assert.equal(live.replacement.generation, 1);
    assert.equal(live.replacement.pendingTitle, "Mine");
    const count = sent.length;
    type(live, "end", "!");
    await wait(100);
    assert.equal(sent.length, count, "a rebuilt session stops syncing");
    const next = createLiveDoc(live.replacement.state);
    const shared = liveText(next).toString();
    const shown = liveText(live.doc).toString();
    const { toShared } = (await import("@/lib/docs/live/rebase")).rebase(live.serverText, shown, shared);
    next.transact(() => {
      toShared.iterChanges((from, to, _fromB, _toB, inserted) => {
        if (to > from) liveText(next).delete(from, to - from);
        if (inserted.length) liveText(next).insert(from, inserted.toString());
      });
    });
    assert.equal(liveText(next).toString(), "Oh, Hello, world!");
  });

  it("ignores Yjs bytes from another generation and checks with the server", async () => {
    const doc = await sharedDoc("Generations", "Base");
    const hub = memoryHub();
    const calls: Calls = { count: 0, fail: false };
    const markLive = await session(mark, doc.id, hub.transport(), calls);
    Object.assign(markLive, { generation: 3 });
    const peer = await rawMember(hub, docTopic(doc.id));
    await until(() => markLive.status === "live", "live");
    await wait(60);
    const copy = createLiveDoc(Y.encodeStateAsUpdate(markLive.doc));
    const vector = Y.encodeStateVector(copy);
    liveText(copy).insert(0, "Old: ");
    const before = calls.count;
    peer.channel.send("update", { u: encodeBytes(Y.encodeStateAsUpdate(copy, vector)), g: 2 });
    await until(() => calls.count > before, "checks with the server");
    assert.equal(liveText(markLive.doc).toString(), "Base");
  });

  it("ignores malformed peer messages", async () => {
    const doc = await sharedDoc("Malformed", "Base");
    const hub = memoryHub();
    const markLive = await session(mark, doc.id, hub.transport());
    const peer = await rawMember(hub, docTopic(doc.id));
    await until(() => markLive.status === "live", "live");
    peer.channel.send("hello", { c: 1, sv: "////" });
    peer.channel.send("awareness", { a: "AAAAAAAA" });
    peer.channel.send("update", { u: "AQID", a: "////" });
    peer.channel.send("state", { to: markLive.clientId, u: "////" });
    await wait(60);
    type(markLive, "end", " fine");
    await until(async () => (await getDoc(mark, doc.id)).content === "Base fine", "still saves");
  });
});
