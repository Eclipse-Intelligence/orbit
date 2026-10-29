import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import * as Y from "yjs";
import { runDocAction } from "@/lib/assistant/docs";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { openDailyNote } from "@/lib/docs/daily-notes";
import { publishLiveChange, setLiveTesting, supabaseSink, typingDuration, type LiveChange } from "@/lib/docs/live/broadcast";
import { applyEdits, textEdits } from "@/lib/docs/live/text-diff";
import { createLiveDoc, liveText, setLiveText, stateFromMarkdown, textOfState, typeLiveText } from "@/lib/docs/live/ydoc";
import { createDoc, editDoc, getDoc, listVersions, openLiveDoc, saveDoc, shareDoc, syncLiveDoc } from "@/lib/docs/store";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let outsider: UserActor;
let agent: AgentActor;
let events: { topic: string; event: string; payload: Record<string, unknown> }[] = [];

async function member(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member" as const, scopes: scopesForRole("member") };
}

function clientFrom(state: Uint8Array) {
  return createLiveDoc(state);
}

async function settle() {
  let seen = -1;
  for (let index = 0; index < 40 && seen !== events.length; index += 1) {
    seen = events.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function wellFormed(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

const ALPHABET = ["a", "b", "c", " ", "\n", "é", "😀", "👩‍💻", "中", "文", "#", "[", "]", "é", "🇬🇧"];

function randomText(random: () => number, length: number) {
  let out = "";
  for (let index = 0; index < length; index += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

function mutate(random: () => number, text: string) {
  const points = Array.from(text);
  const edits = 1 + Math.floor(random() * 4);
  for (let edit = 0; edit < edits; edit += 1) {
    const at = Math.floor(random() * (points.length + 1));
    const remove = Math.floor(random() * 4);
    points.splice(at, remove, ...Array.from(randomText(random, Math.floor(random() * 6))));
  }
  return points.join("");
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@live.test", "Mark Ridgeon");
  priya = await member("priya@live.test", "Priya Shah");
  outsider = await createUser("outsider@live.test", "Other Workspace");
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Docs agent")).actor;
});

beforeEach(() => {
  events = [];
  setLiveTesting({
    sink: async (topic, event, payload) => {
      events.push({ topic, event, payload: payload as Record<string, unknown> });
    },
    wait: async () => {},
    watched: async () => true,
  });
});

after(async () => {
  setLiveTesting(null);
  await getPool().end();
  await getAdminPool().end();
});

describe("text diff", () => {
  it("turns any edit into minimal, surrogate safe changes that reproduce the target", () => {
    const random = seeded(7);
    for (let round = 0; round < 400; round += 1) {
      const before = randomText(random, Math.floor(random() * 60));
      const after = random() < 0.2 ? randomText(random, Math.floor(random() * 60)) : mutate(random, before);
      const edits = textEdits(before, after);
      assert.equal(applyEdits(before, edits), after);
      let cursor = 0;
      for (const edit of edits) {
        assert.ok(edit.at >= cursor);
        assert.ok(wellFormed(before.slice(edit.at, edit.at + edit.remove)), "a removal splits a character");
        assert.ok(wellFormed(edit.insert), "an insertion splits a character");
        cursor = edit.at + edit.remove;
      }
    }
  });

  it("keeps a small change in a large doc small", () => {
    const paragraphs = Array.from({ length: 4_000 }, (_, index) => `Paragraph ${index} talks about partner ${index % 17} and the plan for Q${(index % 4) + 1}.`);
    const before = paragraphs.join("\n\n");
    const changed = [...paragraphs];
    changed[10] = changed[10].replace("partner", "reseller");
    changed[3_000] = `${changed[3_000]} Added a line 👩‍💻.`;
    changed.splice(2_000, 1);
    const after = changed.join("\n\n");
    const started = Date.now();
    const edits = textEdits(before, after);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(applyEdits(before, edits), after);
    assert.ok(edits.reduce((total, edit) => total + edit.remove + edit.insert.length, 0) < 200);
  });

  it("still produces the right text when nearly everything changed", () => {
    const before = Array.from({ length: 3_000 }, (_, index) => `old line ${index}`).join("\n");
    const after = Array.from({ length: 3_000 }, (_, index) => `new line ${index * 7}`).join("\n");
    assert.equal(applyEdits(before, textEdits(before, after)), after);
  });
});

describe("yjs persistence", () => {
  it("initialises from Markdown and derives the same Markdown back", () => {
    const markdown = "# Plan\n\n- [ ] Call Acme 😀\n- [x] Send the deck\n\n[[Q4 partner strategy]] #partners/q4";
    const state = stateFromMarkdown(markdown);
    assert.equal(textOfState(state), markdown);
    assert.equal(textOfState(stateFromMarkdown("")), "");
  });

  it("applies an agent's change as inserts and deletes that merge with concurrent typing", () => {
    const server = createLiveDoc(stateFromMarkdown("Intro line\n\nMiddle paragraph.\n\nClosing line"));
    const client = clientFrom(Y.encodeStateAsUpdate(server));
    liveText(client).insert(0, "Typed first. ");
    const typed = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    const update = setLiveText(server, "Intro line\n\nMiddle paragraph, rewritten by the assistant.\n\nClosing line 🎉", "server");
    assert.ok(update);
    Y.applyUpdate(server, typed);
    Y.applyUpdate(client, update!);
    const expected = "Typed first. Intro line\n\nMiddle paragraph, rewritten by the assistant.\n\nClosing line 🎉";
    assert.equal(liveText(server).toString(), expected);
    assert.equal(liveText(client).toString(), expected);
  });

  it("types an agent's insertion in small steps that each leave valid text", () => {
    const doc = createLiveDoc(stateFromMarkdown("Header\n\nFooter"));
    const watcher = clientFrom(Y.encodeStateAsUpdate(doc));
    const target = "Header\n\nAcme's renewal lands in January, so the pilot results need to be in their hands by 12 December 中文 👩‍💻 done.\n\nFooter";
    const steps = typeLiveText(doc, target, { maxSteps: 12 });
    assert.ok(steps.length > 3 && steps.length <= 14, `got ${steps.length} steps`);
    let previous = "Header\n\nFooter";
    for (const step of steps) {
      Y.applyUpdate(watcher, step.update);
      const now = liveText(watcher).toString();
      assert.ok(wellFormed(now));
      assert.ok(now.length >= previous.length);
      assert.ok(step.to <= now.length);
      previous = now;
    }
    assert.equal(liveText(watcher).toString(), target);
    assert.equal(liveText(doc).toString(), target);
  });

  it("caps live typing between one and three seconds", () => {
    assert.equal(typingDuration(1), 1_000);
    assert.equal(typingDuration(100), 1_500);
    assert.equal(typingDuration(100_000), 3_000);
  });
});

describe("live saves", () => {
  it("initialises a doc without a ydoc from its Markdown when it is first opened", async () => {
    const doc = await createDoc(mark, { title: "Fresh", content: "Hello #first" });
    const before = await getAdminPool().query<{ ydoc: Buffer | null }>("select ydoc from crm.pages where id = $1", [doc.id]);
    assert.equal(before.rows[0].ydoc, null);
    const opened = await openLiveDoc(mark, doc.id);
    assert.equal(textOfState(opened.state), "Hello #first");
    const again = await openLiveDoc(mark, doc.id);
    assert.deepEqual(Y.encodeStateVector(createLiveDoc(again.state)), Y.encodeStateVector(createLiveDoc(opened.state)));
    assert.equal((await getDoc(mark, doc.id)).revision, doc.revision);
  });

  it("merges concurrent saves from two people so nothing is lost", async () => {
    const doc = await createDoc(mark, { title: "Shared plan", content: "Line one\n\nLine two" });
    await shareDoc(mark, doc.id, true);
    const opened = await openLiveDoc(mark, doc.id);
    const markDoc = clientFrom(opened.state);
    const priyaDoc = clientFrom((await openLiveDoc(priya, doc.id)).state);
    const serverVector = Y.encodeStateVector(markDoc);
    liveText(markDoc).insert(0, "Mark wrote this. ");
    liveText(priyaDoc).insert(liveText(priyaDoc).length, "\n\nPriya added #partners/q4 and [[Northwind]]");
    liveText(priyaDoc).delete(0, 4);
    const [first, second] = await Promise.all([
      syncLiveDoc(mark, doc.id, { update: Y.encodeStateAsUpdate(markDoc, serverVector), vector: Y.encodeStateVector(markDoc) }),
      syncLiveDoc(priya, doc.id, { update: Y.encodeStateAsUpdate(priyaDoc, serverVector), vector: Y.encodeStateVector(priyaDoc) }),
    ]);
    Y.applyUpdate(markDoc, first.missing);
    Y.applyUpdate(priyaDoc, second.missing);
    const latest = await syncLiveDoc(mark, doc.id, { vector: Y.encodeStateVector(markDoc) });
    Y.applyUpdate(markDoc, latest.missing);
    const saved = await getDoc(mark, doc.id);
    const expected = "Mark wrote this.  one\n\nLine two\n\nPriya added #partners/q4 and [[Northwind]]";
    assert.equal(saved.content, expected);
    assert.equal(liveText(markDoc).toString(), expected);
    assert.equal(liveText(priyaDoc).toString(), expected);
    assert.deepEqual(saved.tags, ["partners/q4"]);
    const links = await getAdminPool().query<{ target_key: string }>("select target_key from crm.page_links where page_id = $1", [doc.id]);
    assert.deepEqual(links.rows.map((row) => row.target_key), ["northwind"]);
    assert.ok(saved.revision > doc.revision);
  });

  it("treats a repeated save as harmless and leaves the revision alone when nothing changed", async () => {
    const doc = await createDoc(mark, { title: "Idempotent", content: "Same" });
    const local = clientFrom((await openLiveDoc(mark, doc.id)).state);
    const vector = Y.encodeStateVector(local);
    liveText(local).insert(4, " text");
    const update = Y.encodeStateAsUpdate(local, vector);
    await syncLiveDoc(mark, doc.id, { update, vector: Y.encodeStateVector(local) });
    const once = await getDoc(mark, doc.id);
    await syncLiveDoc(mark, doc.id, { update, vector: Y.encodeStateVector(local) });
    const twice = await getDoc(mark, doc.id);
    assert.equal(twice.content, "Same text");
    assert.equal(twice.revision, once.revision);
  });

  it("saves the title alongside live text, and keeps versions throttled for people", async () => {
    const doc = await createDoc(mark, { title: "Draft", content: "Body" });
    const local = clientFrom((await openLiveDoc(mark, doc.id)).state);
    const vector = Y.encodeStateVector(local);
    liveText(local).insert(4, " more");
    await syncLiveDoc(mark, doc.id, { update: Y.encodeStateAsUpdate(local, vector), vector: Y.encodeStateVector(local), title: "Final" });
    const saved = await getDoc(mark, doc.id);
    assert.equal(saved.title, "Final");
    assert.equal(saved.content, "Body more");
    const versions = await listVersions(mark, doc.id);
    assert.ok(versions.length >= 1);
  });

  it("refuses live saves to a doc the person can't see", async () => {
    const doc = await createDoc(mark, { title: "Mine only", content: "Private" });
    await assert.rejects(openLiveDoc(priya, doc.id), /private to someone else/);
    await assert.rejects(syncLiveDoc(priya, doc.id, { update: stateFromMarkdown("x") }), /private to someone else/);
    await assert.rejects(openLiveDoc(outsider, doc.id), /private to someone else/);
  });

  it("keeps daily notes private to their owner, on every device", async () => {
    const note = await openDailyNote(mark, "2026-10-29");
    const phone = clientFrom((await openLiveDoc(mark, note.page.id)).state);
    const laptop = clientFrom((await openLiveDoc(mark, note.page.id)).state);
    const vector = Y.encodeStateVector(phone);
    liveText(phone).insert(0, "09:00 Jotted on the phone");
    await syncLiveDoc(mark, note.page.id, { update: Y.encodeStateAsUpdate(phone, vector), vector: Y.encodeStateVector(phone) });
    const pulled = await syncLiveDoc(mark, note.page.id, { vector: Y.encodeStateVector(laptop) });
    Y.applyUpdate(laptop, pulled.missing);
    assert.equal(liveText(laptop).toString(), "09:00 Jotted on the phone");
    await assert.rejects(openLiveDoc(priya, note.page.id), /private to someone else/);
  });
});

describe("agent edits arrive live", () => {
  it("applies an MCP agent's edit to the stored ydoc, keeps a version first and streams it to the open doc", async () => {
    const doc = await createDoc(mark, { title: "Agent target", content: "Partners carry Q4.\n\nRisks: legal." });
    await shareDoc(mark, doc.id, true);
    const local = clientFrom((await openLiveDoc(mark, doc.id)).state);
    const vector = Y.encodeStateVector(local);
    liveText(local).insert(0, "Unsaved typing. ");
    events = [];
    await editDoc(agent, doc.id, { action: "edit", find: "Risks: legal.", replace: "Risks: legal review could slip into January 😬." });
    await settle();
    const updates = events.filter((entry) => entry.topic === `doc:${doc.id}` && entry.event === "update");
    assert.ok(updates.length >= 2, "the edit is streamed in several steps");
    assert.ok(updates.every((entry) => typeof entry.payload.a === "string" && entry.payload.server === true));
    const writing = events.filter((entry) => entry.topic === `docs-workspace:${mark.workspaceId}` && entry.event === "writing");
    assert.deepEqual(writing.map((entry) => entry.payload.writing), [true, false]);
    assert.equal((writing[0].payload.user as { name: string }).name, "Docs agent");
    const watcher = clientFrom(Y.encodeStateAsUpdate(createLiveDoc((await openLiveDoc(mark, doc.id)).state)));
    for (const entry of updates) Y.applyUpdate(local, Buffer.from(entry.payload.u as string, "base64"));
    assert.equal(liveText(local).toString(), "Unsaved typing. Partners carry Q4.\n\nRisks: legal review could slip into January 😬.");
    assert.equal(liveText(watcher).toString(), "Partners carry Q4.\n\nRisks: legal review could slip into January 😬.");
    const synced = await syncLiveDoc(mark, doc.id, { update: Y.encodeStateAsUpdate(local, vector), vector: Y.encodeStateVector(local) });
    Y.applyUpdate(local, synced.missing);
    assert.equal((await getDoc(mark, doc.id)).content, "Unsaved typing. Partners carry Q4.\n\nRisks: legal review could slip into January 😬.");
    const kept = await getAdminPool().query<{ content: string }>("select content from crm.page_versions where page_id = $1", [doc.id]);
    assert.ok(kept.rows.some((row) => row.content === "Partners carry Q4.\n\nRisks: legal."), "the text before the agent's edit is in the history");
  });

  it("streams the assistant's approved edit with the assistant's own presence", async () => {
    const doc = await createDoc(mark, { title: "Assistant target", content: "Start." });
    await openLiveDoc(mark, doc.id);
    events = [];
    await runDocAction(mark, { action: "append", docId: doc.id, content: "Acme's renewal lands in January." }, { baseRevision: (await getDoc(mark, doc.id)).revision });
    await settle();
    const updates = events.filter((entry) => entry.event === "update");
    assert.ok(updates.length >= 2);
    const writing = events.filter((entry) => entry.event === "writing");
    assert.equal(writing[0].topic, `docs-person:${mark.userId}`);
    assert.deepEqual(writing[0].payload.user, { id: "orbit-assistant", name: "Orbit assistant", kind: "assistant" });
    assert.ok(events.some((entry) => entry.event === "awareness"));
  });

  it("only persists when nobody has the doc open", async () => {
    setLiveTesting({ sink: async (topic, event, payload) => void events.push({ topic, event, payload: payload as Record<string, unknown> }), wait: async () => {}, watched: async () => false });
    const doc = await createDoc(mark, { title: "Closed doc", content: "Before" });
    await openLiveDoc(mark, doc.id);
    events = [];
    await editDoc(agent, doc.id, { action: "append", content: "After" }).catch(() => null);
    await shareDoc(mark, doc.id, true);
    await editDoc(agent, doc.id, { action: "append", content: "After" });
    await settle();
    assert.equal(events.filter((entry) => entry.topic.startsWith("doc:")).length, 0);
    assert.equal(textOfState((await openLiveDoc(mark, doc.id)).state), (await getDoc(mark, doc.id)).content);
  });

  it("reports the watchers it relies on from the database", async () => {
    setLiveTesting({ sink: async (topic, event, payload) => void events.push({ topic, event, payload: payload as Record<string, unknown> }), wait: async () => {} });
    const doc = await createDoc(mark, { title: "Watched", content: "A" });
    await shareDoc(mark, doc.id, true);
    events = [];
    await editDoc(agent, doc.id, { action: "append", content: "B" });
    await settle();
    assert.equal(events.filter((entry) => entry.topic.startsWith("doc:")).length, 0, "no stream before anyone opened it");
    await openLiveDoc(priya, doc.id);
    events = [];
    await editDoc(agent, doc.id, { action: "append", content: "C" });
    await settle();
    assert.ok(events.filter((entry) => entry.topic === `doc:${doc.id}`).length > 0);
  });
});

describe("fallback saves", () => {
  it("keeps the ydoc in step when a save arrives without live sync, and still refuses stale ones", async () => {
    const doc = await createDoc(mark, { title: "Classic", content: "One" });
    const local = clientFrom((await openLiveDoc(mark, doc.id)).state);
    events = [];
    const saved = await saveDoc(mark, doc.id, { content: "One and two", baseRevision: doc.revision });
    await settle();
    const update = events.find((entry) => entry.event === "update");
    assert.ok(update);
    assert.equal(update.payload.a, undefined);
    Y.applyUpdate(local, Buffer.from(update.payload.u as string, "base64"));
    assert.equal(liveText(local).toString(), "One and two");
    await assert.rejects(saveDoc(mark, doc.id, { content: "Stale", baseRevision: doc.revision }), /changed since you opened it/);
    assert.equal((await getDoc(mark, doc.id)).content, saved.content);
  });

  it("merges a ydoc passed to saveDoc instead of overwriting the stored one", async () => {
    const doc = await createDoc(mark, { title: "Merge via saveDoc", content: "Base" });
    const first = clientFrom((await openLiveDoc(mark, doc.id)).state);
    const second = clientFrom(Y.encodeStateAsUpdate(first));
    liveText(first).insert(4, " from first");
    liveText(second).insert(0, "Second: ");
    await saveDoc(mark, doc.id, { ydoc: Y.encodeStateAsUpdate(first) });
    await saveDoc(mark, doc.id, { ydoc: Y.encodeStateAsUpdate(second) });
    assert.equal((await getDoc(mark, doc.id)).content, "Second: Base from first");
  });
});

describe("realtime broadcast", () => {
  it("sends to the private channel with the service key on the server only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    try {
      const sink = supabaseSink(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 202 });
      });
      await sink!("doc:00000000-0000-4000-8000-000000000001", "update", { u: "AA==" });
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
    assert.equal(calls[0].url, "https://example.supabase.co/realtime/v1/api/broadcast/doc%3A00000000-0000-4000-8000-000000000001/events/update?private=true");
    assert.equal((calls[0].init.headers as Record<string, string>).apikey, "sb_secret_test");
    assert.equal(JSON.parse(String(calls[0].init.body)).u, "AA==");
  });

  it("sends a pull instead of an oversized update", async () => {
    const change: LiveChange = {
      pageId: "00000000-0000-4000-8000-000000000009",
      workspaceId: mark.workspaceId,
      ownerId: mark.userId,
      shared: false,
      revision: 4,
      agent: null,
      steps: [{ u: "A".repeat(200_000), from: null, head: null }],
      typedCharacters: 0,
    };
    await publishLiveChange(change);
    assert.deepEqual(events.map((entry) => entry.event), ["pull"]);
  });
});

describe("realtime authorization", () => {
  before(async () => {
    const admin = getAdminPool();
    const exists = await admin.query<{ found: string | null }>("select to_regclass('realtime.messages')::text as found");
    if (!exists.rows[0].found) await admin.query(readFileSync("supabase/bootstrap/local-realtime.sql", "utf8"));
    await admin.query(readFileSync("supabase/migrations/20261216100000_docs_realtime.sql", "utf8"));
  });

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

  it("lets only people who can see a doc join, send and receive on its channel", async () => {
    const doc = await createDoc(mark, { title: "Channel test", content: "Hi" });
    assert.deepEqual(await access(mark.userId, `doc:${doc.id}`), { read: true, write: true });
    assert.deepEqual(await access(priya.userId, `doc:${doc.id}`), { read: false, write: false });
    assert.deepEqual(await access(outsider.userId, `doc:${doc.id}`), { read: false, write: false });
    await shareDoc(mark, doc.id, true);
    assert.deepEqual(await access(priya.userId, `doc:${doc.id}`), { read: true, write: true });
    assert.deepEqual(await access(outsider.userId, `doc:${doc.id}`), { read: false, write: false });
  });

  it("keeps daily note channels to their owner", async () => {
    const note = await openDailyNote(mark, "2026-10-30");
    assert.deepEqual(await access(mark.userId, `doc:${note.page.id}`), { read: true, write: true });
    assert.deepEqual(await access(priya.userId, `doc:${note.page.id}`), { read: false, write: false });
  });

  it("lets people only listen on their own activity channels", async () => {
    assert.deepEqual(await access(mark.userId, `docs-person:${mark.userId}`), { read: true, write: false });
    assert.deepEqual(await access(priya.userId, `docs-person:${mark.userId}`), { read: false, write: false });
    assert.deepEqual(await access(priya.userId, `docs-workspace:${mark.workspaceId}`), { read: true, write: false });
    assert.deepEqual(await access(outsider.userId, `docs-workspace:${mark.workspaceId}`), { read: false, write: false });
  });

  it("refuses malformed topics and anonymous visitors", async () => {
    const doc = await createDoc(mark, { title: "Malformed", content: "" });
    assert.deepEqual(await access(mark.userId, `doc:${doc.id}x`), { read: false, write: false });
    assert.deepEqual(await access(mark.userId, `doc:not-a-uuid`), { read: false, write: false });
    assert.deepEqual(await access(mark.userId, "doc:"), { read: false, write: false });
    assert.deepEqual(await access("", `doc:${doc.id}`), { read: false, write: false });
  });
});
