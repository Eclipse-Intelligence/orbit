import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { DocsError, type DocsData, type Page, type SaveInput, type SaveResult } from "@/lib/docs/client-types";
import { connectDocs } from "@/lib/docs/connection";
import { draftToRestore, readDraft, writeDraft } from "@/lib/docs/drafts";
import { createStateCache } from "@/lib/docs/editor/state-cache";
import { adoptDraft, prepareDocs, retryOfflineSaves, scheduleSave, settleSaves, useDocsStore } from "@/stores/docs-store";
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
});
