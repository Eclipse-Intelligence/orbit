import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import * as Y from "yjs";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import type { LiveEvent } from "@/lib/docs/live/protocol";
import { LiveSession, type LiveServer, type SessionTiming } from "@/lib/docs/live/session";
import { memoryHub } from "@/lib/docs/live/transport";
import { createLiveDoc, liveText } from "@/lib/docs/live/ydoc";
import { createDoc, editDoc, getDoc, openLiveDoc, saveDoc, shareDoc, syncLiveDoc } from "@/lib/docs/store";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let agent: AgentActor;
const open: LiveSession[] = [];

const FAST: Partial<SessionTiming> = { batchMs: 5, awarenessMs: 5, saveMs: 30, saveMaxMs: 80, ownMs: 150, titleMs: 20, heartbeatMs: 5_000, soloHeartbeatMs: 5_000, retryMs: 40, connectMs: 200 };

function server(actor: UserActor, pageId: string, calls: { count: number; fail: boolean } = { count: 0, fail: false }): LiveServer {
  return {
    async sync(input) {
      calls.count += 1;
      if (calls.fail) throw new Error("offline");
      const result = await syncLiveDoc(actor, pageId, { update: input.update, vector: input.vector, title: input.title });
      return { vector: result.vector, missing: result.missing, revision: result.doc.revision, summary: result.doc };
    },
  };
}

async function session(actor: UserActor, pageId: string, transport: ReturnType<ReturnType<typeof memoryHub>["transport"]> | null, calls?: { count: number; fail: boolean }) {
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
    const calls = [
      { count: 0, fail: false },
      { count: 0, fail: false },
    ];
    const first = await session(mark, doc.id, hub.transport(), calls[0]);
    const second = await session(priya, doc.id, hub.transport(), calls[1]);
    await until(() => first.remoteStates().length === 1 && second.remoteStates().length === 1, "presence");
    const saver = first.isSaver() ? first : second;
    const typist = saver === first ? second : first;
    assert.notEqual(first.isSaver(), second.isSaver());
    const before = calls.map((entry) => entry.count);
    for (let index = 0; index < 5; index += 1) {
      type(typist, "end", ` ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await until(async () => (await getDoc(mark, doc.id)).content === "Base 0 1 2 3 4", "saved by the saver");
    await until(() => !typist.unconfirmed(), "typist confirmed through the saver");
    const typistCalls = calls[typist === first ? 0 : 1].count - before[typist === first ? 0 : 1];
    const saverCalls = calls[saver === first ? 0 : 1].count - before[saver === first ? 0 : 1];
    assert.ok(saverCalls >= 1);
    assert.equal(typistCalls, 0, "the typist relied on the saver");
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
    await until(() => markLive.status === "offline", "mark offline");
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    assert.equal(markLive.status, "offline");
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
