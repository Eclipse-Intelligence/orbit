import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { DocsError, type DocsData, type Page, type SaveInput, type SaveResult } from "@/lib/docs/client-types";
import { connectDocs } from "@/lib/docs/connection";
import { draftToRestore, readDraft, writeDraft } from "@/lib/docs/drafts";
import { createStateCache } from "@/lib/docs/editor/state-cache";
import { adoptDraft, commitAll, holdClassicSaves, prepareDocs, retryOfflineSaves, scheduleSave, settleForLive, settleSaves, useDocsStore } from "@/stores/docs-store";
import { createFakeDocs } from "./docs-fake";

const NOW = "2026-10-29T16:00:00.000Z";
const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
Object.defineProperty(globalThis, "window", { value: { localStorage: storage, location: { pathname: "/docs" } }, configurable: true, writable: true });

let viewerCount = 0;

type Harness = {
  data: DocsData;
  sent: { id: string; input: SaveInput }[];
  saveHook: { current: ((id: string, input: SaveInput, save: () => Promise<SaveResult>) => Promise<SaveResult>) | null };
  viewer: { id: string; name: string };
};

async function open(viewer = { id: `viewer-${++viewerCount}`, name: "Mark Ridgeon" }, workspaceId = "workspace-1"): Promise<Harness> {
  const fake = createFakeDocs({ now: NOW, viewer, longNote: false });
  const sent: Harness["sent"] = [];
  const saveHook: Harness["saveHook"] = { current: null };
  const data: DocsData = {
    ...fake,
    async savePage(id, input, options) {
      sent.push({ id, input });
      const save = () => fake.savePage(id, input, options);
      return saveHook.current ? saveHook.current(id, input, save) : save();
    },
  };
  connectDocs({}, data);
  useDocsStore.getState().init({ now: NOW, workspaceId, viewer }, await data.nav());
  return { data, sent, saveHook, viewer };
}

async function note(harness: Harness, title: string, body: string) {
  const created = await harness.data.createPage({ title, body });
  const page = await useDocsStore.getState().loadPage(created.id);
  assert.ok(page);
  return page;
}

function edit(id: string, title: string, body: string) {
  scheduleSave(id, () => ({ title, body }), 60_000);
}

async function server(harness: Harness, id: string) {
  const page = await harness.data.getPage(id);
  assert.ok(page);
  return page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  memory.clear();
});

after(() => {
  prepareDocs({ workspaceId: "done", viewer: { id: "done", name: "" } });
});

describe("docs store", () => {
  it("offers any draft that differs from the server, however old", () => {
    const server = { title: "Plan", body: "saved" };
    assert.equal(draftToRestore(null, server), null);
    assert.equal(draftToRestore({ title: "Plan", body: "saved", baseRevision: 1, at: 0 }, server), null);
    assert.equal(draftToRestore({ title: "Plan", body: "typed", baseRevision: 1, at: 0 }, server)?.body, "typed");
  });

  it("saves a restored draft against the revision it was written on, so a stale draft raises a conflict", async () => {
    const harness = await open();
    const created = await harness.data.createPage({ title: "Plan", body: "one" });
    writeDraft(created.id, { title: "Plan", body: "mine", baseRevision: created.revision, at: 0 });
    await harness.data.savePage(created.id, { title: "Plan", body: "theirs", baseRevision: created.revision });
    const page = await useDocsStore.getState().loadPage(created.id);
    assert.ok(page);
    assert.equal(page.body, "theirs");

    const draft = draftToRestore(readDraft(page.id), page);
    assert.ok(draft);
    adoptDraft(page, draft);
    edit(page.id, draft.title, draft.body);
    await settleSaves(page.id);

    const state = useDocsStore.getState();
    assert.equal(harness.sent.at(-1)?.input.baseRevision, created.revision);
    assert.equal(state.saves[page.id]?.status, "conflict");
    assert.equal(state.conflicts[page.id]?.body, "theirs");
    assert.equal((await server(harness, page.id)).body, "theirs");
    assert.equal(readDraft(page.id)?.body, "mine");

    state.resolveConflict(page.id, "mine");
    await settleSaves(page.id);
    assert.equal((await server(harness, page.id)).body, "mine");
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
    assert.equal(readDraft(page.id), null);
  });

  it("drops a cached editor state once someone else's edit replaces the body", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "before");
    const cache = createStateCache<string>(4);
    cache.remember(page.id, "editor showing before", useDocsStore.getState().epochs[page.id] ?? 0);
    assert.equal(cache.take(page.id, useDocsStore.getState().epochs[page.id] ?? 0), "editor showing before");

    await harness.data.savePage(page.id, { title: "Plan", body: "assistant edit", baseRevision: page.revision });
    useDocsStore.getState().replaceBody(await server(harness, page.id));
    assert.equal(cache.take(page.id, useDocsStore.getState().epochs[page.id] ?? 0), null);
    assert.equal(cache.has(page.id), false);

    edit(page.id, "Plan", "assistant edit, then mine");
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
    assert.equal((await server(harness, page.id)).body, "assistant edit, then mine");
  });

  it("clears one person's notes, drafts and unsaved work when someone else signs in", async () => {
    const first = await open({ id: "mark", name: "Mark Ridgeon" });
    const page = await note(first, "Private plan", "secret");
    useDocsStore.getState().visit(page.id);
    writeDraft(page.id, { title: "Private plan", body: "secret, unsaved", baseRevision: page.revision, at: 0 });
    edit(page.id, "Private plan", "secret, unsaved");

    const second = await open({ id: "priya", name: "Priya Shah" });
    const state = useDocsStore.getState();
    assert.equal(state.viewer?.name, "Priya Shah");
    assert.deepEqual(state.pages, {});
    assert.equal(state.summaries[page.id], undefined);
    assert.deepEqual(state.recent, []);
    assert.equal(readDraft(page.id), null);
    await settleSaves(page.id);
    assert.equal(first.sent.length + second.sent.length, 0);
    assert.equal((await server(first, page.id)).body, "secret");

    connectDocs({}, first.data);
    useDocsStore.getState().init({ now: NOW, workspaceId: "workspace-1", viewer: first.viewer }, await first.data.nav());
    assert.equal(readDraft(page.id)?.body, "secret, unsaved");
    assert.deepEqual(useDocsStore.getState().recent, [page.id]);
  });

  it("keeps a failed save queued, shows the error and sends it again on the next edit", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    harness.saveHook.current = async () => ({ ok: false, error: "That note is too long to save." });
    edit(page.id, "Plan", "two");
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "error");
    assert.equal(useDocsStore.getState().saves[page.id]?.message, "That note is too long to save.");
    assert.equal((await server(harness, page.id)).body, "one");
    assert.equal(readDraft(page.id)?.body, "two");

    harness.saveHook.current = null;
    edit(page.id, "Plan", "two");
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
    assert.equal((await server(harness, page.id)).body, "two");
    assert.equal(readDraft(page.id), null);
  });

  it("sends a newer edit that queued behind a failed save", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    const gate = deferred<SaveResult>();
    harness.saveHook.current = () => gate.promise;
    edit(page.id, "Plan", "two");
    const first = settleSaves(page.id);
    await tick();
    harness.saveHook.current = null;
    edit(page.id, "Plan", "three");
    const second = settleSaves(page.id);
    gate.resolve({ ok: false, error: "Couldn't save." });
    await Promise.all([first, second]);
    assert.equal((await server(harness, page.id)).body, "three");
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
  });

  it("keeps the open note and notes with pending work when a rename rewrites links", async () => {
    const harness = await open();
    const renamed = await note(harness, "Alpha", "The plan");
    const busy = await note(harness, "Busy", "See [[Alpha]]");
    const linked = await note(harness, "Open", "Also [[Alpha]]");
    const plain = await note(harness, "Plain", "Nothing linked");
    const epochs = useDocsStore.getState().epochs;
    edit(busy.id, "Busy", "See [[Alpha]] and more");

    edit(renamed.id, "Beta", "The plan");
    await settleSaves(renamed.id);
    await tick();
    await tick();

    const state = useDocsStore.getState();
    assert.ok(state.pages[busy.id]);
    assert.ok(state.pages[plain.id]);
    assert.equal(state.pages[linked.id]?.body, "Also [[Beta]]");
    assert.equal(state.epochs[linked.id], (epochs[linked.id] ?? 0) + 1);
    assert.equal(state.epochs[busy.id], epochs[busy.id]);
    assert.equal(state.titles.beta, renamed.id);

    await settleSaves(busy.id);
    const busySave = harness.sent.filter((entry) => entry.id === busy.id).at(-1);
    assert.equal(busySave?.input.baseRevision, busy.revision);
    assert.notEqual(busySave?.input.baseRevision, 0);
    assert.equal(useDocsStore.getState().saves[busy.id]?.status, "conflict");
  });

  it("treats a save whose response was lost as saved instead of a conflict", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    harness.saveHook.current = async (_id, _input, save) => {
      await save();
      throw new DocsError("Docs couldn't reach Orbit.", "offline");
    };
    edit(page.id, "Plan", "two");
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "offline");
    harness.saveHook.current = null;
    retryOfflineSaves();
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
    assert.equal(useDocsStore.getState().conflicts[page.id], undefined);

    harness.saveHook.current = async (_id, _input, save) => {
      await save();
      throw new DocsError("Docs couldn't reach Orbit.", "offline");
    };
    edit(page.id, "Plan", "three");
    await settleSaves(page.id);
    harness.saveHook.current = null;
    edit(page.id, "Plan", "four");
    await settleSaves(page.id);
    assert.equal(useDocsStore.getState().conflicts[page.id], undefined);
    assert.equal((await server(harness, page.id)).body, "four");
  });

  it("finishes saving before it restores a version", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    edit(page.id, "Plan", "two");
    await settleSaves(page.id);
    const versions = await harness.data.listVersions(page.id);
    const order: string[] = [];
    const gate = deferred<void>();
    harness.saveHook.current = async (_id, _input, save) => {
      await gate.promise;
      order.push("save");
      return save();
    };
    const restoreVersion = harness.data.restoreVersion;
    harness.data.restoreVersion = async (pageId, versionId) => {
      order.push("restore");
      return restoreVersion(pageId, versionId);
    };
    edit(page.id, "Plan", "three");
    const restoring = useDocsStore.getState().restoreVersion(page.id, versions.at(-1)!.id);
    await tick();
    assert.deepEqual(order, []);
    gate.resolve();
    assert.equal(await restoring, null);
    assert.deepEqual(order, ["save", "restore"]);
    const restored: Page = await server(harness, page.id);
    assert.equal(useDocsStore.getState().pages[page.id]?.revision, restored.revision);
    assert.equal(useDocsStore.getState().pages[page.id]?.body, restored.body);
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "saved");
  });

  it("holds classic saves while a note goes live and resumes them only if that fails", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    const release = holdClassicSaves(page.id);
    edit(page.id, "Plan", "one, typed while attaching");
    await settleSaves(page.id);
    assert.equal(harness.sent.length, 0, "nothing goes through the classic save while attaching");
    assert.equal(useDocsStore.getState().saves[page.id]?.status, "pending");
    assert.deepEqual(await settleForLive(page.id), { base: "one", revision: page.revision });
    commitAll(true);
    assert.equal(readDraft(page.id)?.body, "one, typed while attaching", "held text is kept on the device when the tab hides");
    release(false);
    assert.equal(readDraft(page.id), null, "the live copy took the held text, so the device copy goes");
    assert.equal(harness.sent.length, 0);

    const again = holdClassicSaves(page.id);
    edit(page.id, "Plan", "one, then live failed");
    again(true);
    await settleSaves(page.id);
    assert.equal(harness.sent.length, 1);
    assert.equal((await server(harness, page.id)).body, "one, then live failed");
  });

  it("lets only the newest hold on a note release it", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    const stale = holdClassicSaves(page.id);
    const fresh = holdClassicSaves(page.id);
    stale(true);
    edit(page.id, "Plan", "two");
    await settleSaves(page.id);
    assert.equal(harness.sent.length, 0, "the stale release didn't end the newer hold");
    fresh(true);
    await settleSaves(page.id);
    assert.equal((await server(harness, page.id)).body, "two");
  });
});

describe("docs store public link", () => {
  async function withSetPublic(handler: (data: DocsData) => DocsData["setPublic"]) {
    const harness = await open();
    const data: DocsData = { ...harness.data, setPublic: (id, input) => handler(harness.data)(id, input) };
    connectDocs({}, data);
    const page = await note({ ...harness, data }, "Plan", "one");
    return { page, store: useDocsStore };
  }

  it("shows the change at once, keeps it when the server agrees and fills in the link", async () => {
    const gate = deferred<void>();
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      const result = await data.setPublic(id, input);
      await gate.promise;
      return result;
    });
    const saving = store.getState().setPublic(page.id, { public: true });
    assert.equal(store.getState().pages[page.id].public, true);
    assert.equal(store.getState().publicSaving[page.id], true);
    gate.resolve();
    assert.equal(await saving, null);
    assert.equal(store.getState().pages[page.id].public, true);
    assert.match(store.getState().pages[page.id].publicUrl ?? "", /\/d\//);
    assert.equal(store.getState().publicSaving[page.id], undefined);
  });

  it("rolls back and returns the error when the save fails", async () => {
    const { page, store } = await withSetPublic(() => async () => {
      throw new Error("Only Mark can change this note's public link.");
    });
    const result = await store.getState().setPublic(page.id, { public: true });
    assert.equal(result, "Only Mark can change this note's public link.");
    assert.equal(store.getState().pages[page.id].public, false);
    assert.equal(store.getState().publicSaving[page.id], undefined);
  });

  it("ignores an older reply or rollback that arrives after a newer change", async () => {
    const gates = [deferred<void>(), deferred<void>()];
    let call = 0;
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      const mine = gates[call++];
      const result = await data.setPublic(id, input);
      await mine.promise;
      if (input.public === true) throw new Error("slow failure");
      return result;
    });
    const older = store.getState().setPublic(page.id, { public: true });
    const newer = store.getState().setPublic(page.id, { public: false });
    assert.equal(store.getState().pages[page.id].public, false);
    gates[1].resolve();
    assert.equal(await newer, null);
    gates[0].resolve();
    assert.equal(await older, "slow failure");
    assert.equal(store.getState().pages[page.id].public, false, "the older failure didn't roll the newer change back");
    assert.equal(store.getState().publicSaving[page.id], undefined);
  });

  it("shows a timer at once, lets a later choice replace it and rolls a failed one back", async () => {
    const gate = deferred<void>();
    let fail = false;
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      if (fail) throw new Error("Couldn't change the public link. Try again.");
      const result = await data.setPublic(id, input);
      if (input.expiresAt) await gate.promise;
      return result;
    });
    await store.getState().setPublic(page.id, { public: true });
    const saving = store.getState().setPublic(page.id, { expiresAt: "2030-03-31" });
    assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T23:00:00.000Z");
    assert.equal(store.getState().pages[page.id].public, true);
    assert.equal(store.getState().publicSaving[page.id], true);
    gate.resolve();
    assert.equal(await saving, null);
    assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T23:00:00.000Z");
    await store.getState().setPublic(page.id, { expiresAt: "2030-03-30" });
    assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T00:00:00.000Z");
    fail = true;
    assert.equal(await store.getState().setPublic(page.id, { expiresAt: null }), "Couldn't change the public link. Try again.");
    assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T00:00:00.000Z");
    fail = false;
    await store.getState().setPublic(page.id, { public: false });
    assert.equal(store.getState().pages[page.id].publicExpiresAt, null, "turning the link off clears the timer");
  });

  it("never leaves the link frozen when the day is empty or bad", async () => {
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      if (input.expiresAt === "" || input.expiresAt === "9999-12-31" || input.expiresAt === "nonsense") throw new Error("Give the date as YYYY-MM-DD, no later than 2100.");
      return data.setPublic(id, input);
    });
    await store.getState().setPublic(page.id, { public: true });
    await store.getState().setPublic(page.id, { expiresAt: "2030-03-30" });
    for (const bad of ["", "9999-12-31", "nonsense"]) {
      const result = await store.getState().setPublic(page.id, { expiresAt: bad });
      assert.equal(result, "Give the date as YYYY-MM-DD, no later than 2100.");
      assert.equal(store.getState().publicSaving[page.id], undefined, `no stuck saving after ${JSON.stringify(bad)}`);
      assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T00:00:00.000Z");
    }
  });

  it("clears the timer at once when an expired link is turned back on", async () => {
    const gate = deferred<void>();
    let hold = false;
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      const result = await data.setPublic(id, input);
      if (hold) await gate.promise;
      return result;
    });
    await store.getState().setPublic(page.id, { public: true });
    await store.getState().setPublic(page.id, { expiresAt: "2030-03-30" });
    useDocsStore.setState((state) => ({
      pages: { ...state.pages, [page.id]: { ...state.pages[page.id], public: false, publicUrl: null } },
      summaries: state.summaries[page.id] ? { ...state.summaries, [page.id]: { ...state.summaries[page.id], public: false, publicUrl: null } } : state.summaries,
    }));
    hold = true;
    const saving = store.getState().setPublic(page.id, { public: true });
    assert.equal(store.getState().pages[page.id].public, true);
    assert.equal(store.getState().pages[page.id].publicExpiresAt, null);
    gate.resolve();
    assert.equal(await saving, null);
  });

  it("keeps a newer timer when an older save fails while it is in flight", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let call = 0;
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      const mine = gates[call++];
      const result = await data.setPublic(id, input);
      await mine.promise;
      if (input.expiresAt === "2030-03-30") throw new Error("Couldn't change the public link. Try again.");
      return result;
    });
    gates[0].resolve();
    await store.getState().setPublic(page.id, { public: true });
    const older = store.getState().setPublic(page.id, { expiresAt: "2030-03-30" });
    const newer = store.getState().setPublic(page.id, { expiresAt: "2030-03-31" });
    gates[2].resolve();
    assert.equal(await newer, null);
    gates[1].resolve();
    assert.equal(await older, "Couldn't change the public link. Try again.");
    assert.equal(store.getState().pages[page.id].publicExpiresAt, "2030-03-31T23:00:00.000Z", "the older failure didn't roll the newer timer back");
    assert.equal(store.getState().publicSaving[page.id], undefined);
  });

  it("ignores an older timer reply that arrives after a newer choice", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let call = 0;
    const { page, store } = await withSetPublic((data) => async (id, input) => {
      const mine = gates[call++];
      const result = await data.setPublic(id, input);
      await mine.promise;
      return result;
    });
    gates[0].resolve();
    await store.getState().setPublic(page.id, { public: true });
    const older = store.getState().setPublic(page.id, { expiresAt: "2030-03-30" });
    const newer = store.getState().setPublic(page.id, { expiresAt: null });
    assert.equal(store.getState().pages[page.id].publicExpiresAt, null);
    gates[2].resolve();
    assert.equal(await newer, null);
    gates[1].resolve();
    assert.equal(await older, null);
    assert.equal(store.getState().pages[page.id].publicExpiresAt, null, "the older reply didn't bring its timer back");
    assert.equal(store.getState().publicSaving[page.id], undefined);
  });
});

describe("docs store lists after sharing", () => {
  it("never empties the shown list when a note's sharing or public link changes, and asks for a fresh copy instead", async () => {
    const harness = await open();
    const page = await note(harness, "Plan", "one");
    const store = useDocsStore;
    const ids = await store.getState().loadList({ kind: "all" });
    assert.ok(ids.includes(page.id));
    const shown = () => Object.values(store.getState().lists).find((list) => list.includes(page.id));
    const version = store.getState().listsVersion;

    await store.getState().setPublic(page.id, { public: true });
    assert.deepEqual(shown(), ids, "the public link leaves the list in place");
    assert.equal(store.getState().listsVersion, version, "the public link doesn't change which notes a list holds");

    await store.getState().share({ kind: "page", id: page.id }, "shared");
    assert.deepEqual(shown(), ids, "sharing leaves the list in place while it refreshes");
    assert.equal(store.getState().listsVersion, version + 1);

    store.getState().refreshAfterAgent();
    assert.deepEqual(shown(), ids, "an agent's edit leaves the list in place while it refreshes");
    assert.equal(store.getState().listsVersion, version + 2);
  });
});
