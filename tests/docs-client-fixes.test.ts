import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { EditorState } from "@codemirror/state";
import { threadHolding, threadsOf } from "@/components/docs/comment-threads";
import { liveRemoteTitle } from "@/components/docs/remote-title";
import { queueRename, renameIfLatest } from "@/components/docs/rename-queue";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listArchivedDocs, listFormerOwners } from "@/lib/docs/admin";
import { wrapChanges, taskToggleChange } from "@/lib/docs/editor/setup";
import { DocsError, type DocsData, type Page } from "@/lib/docs/client-types";
import type { DocComment } from "@/lib/docs/comments";
import { connectDocs } from "@/lib/docs/connection";
import { archiveDoc, createDoc, listDocs } from "@/lib/docs/store";
import { LIST_PAGE_SIZE, prepareDocs, useDocsStore } from "@/stores/docs-store";
import { createFakeDocs } from "./docs-fake";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

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

type Listener = (activity: Record<string, never>, revisions?: Record<string, number>) => void;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let viewerCount = 0;

async function open(count = 1) {
  const viewer = { id: `client-${++viewerCount}`, name: "Mark Ridgeon" };
  const fake = createFakeDocs({ now: NOW, viewer, longNote: false });
  const listeners = new Set<Listener>();
  const data: DocsData = {
    ...fake,
    watchActivity(listener) {
      listeners.add(listener as Listener);
      return () => listeners.delete(listener as Listener);
    },
  };
  connectDocs({}, data);
  useDocsStore.getState().init({ now: NOW, workspaceId: "workspace-1", viewer }, await data.nav());
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) ids.push((await data.createPage({ title: `Note ${index}`, body: "text" })).id);
  return { data, ids, announce: (revisions: Record<string, number>) => listeners.forEach((listener) => listener({}, revisions)) };
}

beforeEach(() => memory.clear());

after(() => {
  prepareDocs({ workspaceId: "done", viewer: { id: "done", name: "" } });
});

describe("title rename", () => {
  it("never sends a title the person has typed past", async () => {
    let typed = "Plan";
    const sent: string[] = [];
    const steps = () => ({
      latest: () => typed,
      settle: async () => {
        await tick();
        return true;
      },
      send: async (value: string) => {
        sent.push(value);
        return true;
      },
    });
    const first = renameIfLatest("rename-a", "Plan", steps());
    typed = "Plan B";
    assert.equal(await first, null);
    assert.deepEqual(sent, []);
    assert.equal(await renameIfLatest("rename-a", "Plan B", steps()), true);
    assert.deepEqual(sent, ["Plan B"]);
  });

  it("sends renames of one note one after another, newest last", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = queueRename("rename-b", async () => {
      order.push("first start");
      await gate;
      order.push("first end");
    });
    const next = queueRename("rename-b", async () => {
      order.push("second");
    });
    await tick();
    assert.deepEqual(order, ["first start"]);
    release();
    await Promise.all([slow, next]);
    assert.deepEqual(order, ["first start", "first end", "second"]);
  });
});

describe("comment threads", () => {
  const comment = (id: string, parentId: string | null, resolved = false) => ({ id, parentId, resolved }) as unknown as DocComment;

  it("finds the thread for a root or a reply, so a reply alert opens its thread", () => {
    const threads = threadsOf([comment("root-a", null), comment("reply-a", "root-a"), comment("root-b", null, true), comment("reply-b", "root-b")]);
    assert.equal(threadHolding(threads, "root-a")?.root.id, "root-a");
    assert.equal(threadHolding(threads, "reply-a")?.root.id, "root-a");
    assert.equal(threadHolding(threads, "reply-b")?.root.resolved, true);
    assert.equal(threadHolding(threads, "missing"), null);
  });
});

describe("remote titles", () => {
  const live = (id: string) => liveRemoteTitle(useDocsStore.getState(), id);

  it("adopts a live title only while it is still the note's own title", async () => {
    const { ids } = await open(2);
    const store = useDocsStore.getState();
    await store.loadPage(ids[0]);
    store.remoteTitle(ids[0], "R");
    assert.equal(live(ids[0]), "R");
    store.clearRemoteTitle(ids[0]);
    assert.equal(live(ids[0]), undefined);
    store.remoteTitle(ids[0], "T");
    assert.equal(live(ids[0]), "T");
    await store.loadPage(ids[1]);
    store.remoteTitle(ids[1], "U");
    useDocsStore.setState((state) => ({ pages: { ...state.pages, [ids[1]]: { ...state.pages[ids[1]], title: "Server title" } } }));
    assert.equal(live(ids[1]), undefined);
  });

  it("never adopts a stale live title after a refresh, a kept conflict or a restore, so nothing is sent on remount", async () => {
    const { data, ids } = await open(3);
    const store = useDocsStore.getState();
    for (const id of ids) {
      await store.loadPage(id);
      store.remoteTitle(id, "R");
      assert.equal(live(id), "R");
    }

    await data.renamePage(ids[0], "Q");
    await store.refreshPage(ids[0]);
    assert.equal(useDocsStore.getState().pages[ids[0]].title, "Q");
    assert.equal(live(ids[0]), undefined);
    assert.equal(useDocsStore.getState().remoteTitles[ids[0]], undefined);

    const theirs = await data.renamePage(ids[1], "Theirs");
    useDocsStore.setState((state) => ({ conflicts: { ...state.conflicts, [ids[1]]: theirs } }));
    store.resolveConflict(ids[1], "theirs");
    assert.equal(useDocsStore.getState().pages[ids[1]].title, "Theirs");
    assert.equal(live(ids[1]), undefined);
    assert.equal(useDocsStore.getState().remoteTitles[ids[1]], undefined);

    const versions = await data.listVersions(ids[2]);
    await data.savePage(ids[2], { title: "V2", body: "changed", baseRevision: useDocsStore.getState().pages[ids[2]].revision });
    const older = (await data.listVersions(ids[2])).at(-1) ?? versions[0];
    store.remoteTitle(ids[2], "R");
    assert.equal(await store.restoreVersion(ids[2], older.id), null);
    assert.equal(live(ids[2]), undefined);
    assert.equal(useDocsStore.getState().remoteTitles[ids[2]], undefined);
  });

  it("drops a remembered remote title when the person types, and takes a later one", async () => {
    const { ids } = await open();
    const store = useDocsStore.getState();
    await store.loadPage(ids[0]);
    store.remoteTitle(ids[0], "R");
    store.clearRemoteTitle(ids[0]);
    for (let mount = 0; mount < 3; mount += 1) assert.equal(live(ids[0]), undefined);
    store.remoteTitle(ids[0], "T");
    assert.equal(live(ids[0]), "T");
  });
});

describe("docs store reads", () => {
  it("never rolls a note back to an older revision from a late refresh", async () => {
    const { data, ids, announce } = await open();
    const store = useDocsStore.getState();
    const held = await store.loadPage(ids[0]);
    assert.ok(held);
    const newer: Page = { ...held, revision: held.revision + 2, body: "newer text" };
    useDocsStore.setState((state) => ({ pages: { ...state.pages, [held.id]: newer } }));
    data.getPage = async () => ({ ...held, revision: held.revision + 1, body: "older text" });
    announce({ [held.id]: held.revision + 5 });
    await tick();
    await tick();
    assert.equal(useDocsStore.getState().pages[held.id]?.body, "newer text");
    assert.equal(useDocsStore.getState().pages[held.id]?.revision, held.revision + 2);
  });

  it("forgets a note the server no longer shows, wherever the answer comes from", async () => {
    const { data, ids, announce } = await open(3);
    const store = useDocsStore.getState();
    await store.loadList({ kind: "all" });
    for (const id of ids) await store.loadPage(id);
    for (const id of ids) store.visit(id);
    const gone = (id: string) => {
      const state = useDocsStore.getState();
      return !state.pages[id] && !state.summaries[id] && !state.recent.includes(id) && Object.values(state.lists).every((list) => !list.includes(id));
    };

    await data.archivePage(ids[0]);
    assert.equal(await store.refreshPage(ids[0]), false);
    assert.ok(gone(ids[0]));

    data.getPage = async (id) => {
      if (id === ids[1]) throw new DocsError("No access", "forbidden");
      return null;
    };
    announce({ [ids[1]]: 99 });
    await tick();
    await tick();
    assert.ok(gone(ids[1]));

    assert.equal(await store.loadPage(ids[2], true), null);
    assert.ok(gone(ids[2]));
  });

  it("keeps offering more after an archive, because the server said there is more", async () => {
    const { data } = await open(LIST_PAGE_SIZE);
    const store = useDocsStore.getState();
    const ids = await store.loadList({ kind: "all" });
    assert.ok(ids.length >= LIST_PAGE_SIZE);
    const key = `all|${store.sort}`;
    assert.equal(useDocsStore.getState().listMore[key], true);
    await store.archive(ids[0]);
    assert.equal(useDocsStore.getState().lists[key].length, ids.length - 1);
    assert.equal(useDocsStore.getState().listMore[key], true);
    await data.nav();
  });
});

describe("editor edits", () => {
  it("ticks a checkbox by changing only its marker character", () => {
    for (const line of ["- [ ] call Acme", "  * [x] done thing", "1. [X] numbered", "- [ ]"]) {
      const change = taskToggleChange(line);
      assert.ok(change, line);
      const state = EditorState.create({ doc: line });
      const next = state.update({ changes: { from: change.at, to: change.at + 1, insert: change.insert } }).state.doc.toString();
      assert.equal(line.length, next.length);
      assert.equal([...line].filter((char, index) => char !== next[index]).length, 1);
      assert.equal(change.insert === " " || change.insert === "x", true);
    }
    assert.equal(taskToggleChange("plain line"), null);
  });

  it("unwraps bold by deleting only the two markers", () => {
    const state = EditorState.create({ doc: "a **bold** b", selection: { anchor: 2, head: 10 } });
    const transaction = state.update(wrapChanges(state, "**"));
    const deleted: [number, number, string][] = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => deleted.push([from, to, inserted.toString()]));
    assert.deepEqual(deleted, [
      [2, 4, ""],
      [8, 10, ""],
    ]);
    assert.equal(transaction.state.doc.toString(), "a bold b");
    assert.equal(transaction.state.sliceDoc(transaction.state.selection.main.from, transaction.state.selection.main.to), "bold");
  });

  it("wraps a selection by adding the markers at its ends", () => {
    const state = EditorState.create({ doc: "a word b", selection: { anchor: 2, head: 6 } });
    const transaction = state.update(wrapChanges(state, "**"));
    assert.equal(transaction.state.doc.toString(), "a **word** b");
  });
});

describe("former members and archived notes", () => {
  useServerlessPool();
  let mark: UserActor;
  let leaver: UserActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@docs-client.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", ["leaver@docs-client.test", "Lee Leaver"])).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
    leaver = { ...mark, userId: id, email: "leaver@docs-client.test", fullName: "Lee Leaver", role: "member", scopes: scopesForRole("member") };
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("finds every former owner however many notes there are, without a row limit", async () => {
    for (let index = 0; index < 205; index += 1) await createDoc(mark, { title: `Mark ${index}`, shared: true });
    for (const title of ["Leaver one", "Leaver two", "Leaver three", "Leaver four"]) await createDoc(leaver, { title, shared: true });
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, leaver.userId]);
    const owners = await listFormerOwners(mark);
    assert.equal(owners.length, 1);
    assert.equal(owners[0].id, leaver.userId);
    assert.equal(owners[0].docs, 4);
    assert.equal(owners[0].examples.length, 3);
  });

  it("offers a former member who owned only private notes, or only archived ones, and tells no private titles", async () => {
    const admin = getAdminPool();
    const person = async (email: string, name: string, role = "member") => {
      const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, id, role]);
      return { ...mark, userId: id, email, fullName: name, role: role as "member" | "admin", scopes: scopesForRole(role as "member" | "admin") };
    };
    const secretOnly = await person("secret@docs-client.test", "Sam Secret");
    const archivedOnly = await person("archived@docs-client.test", "Ada Archived");
    const plain = await person("plain@docs-client.test", "Pat Plain");
    const admin2 = await person("admin@docs-client.test", "Alex Admin", "admin");
    await createDoc(secretOnly, { title: "Private plans" });
    await createDoc(secretOnly, { title: "More private plans" });
    const old = await createDoc(archivedOnly, { title: "Old shared note", shared: true });
    await archiveDoc(archivedOnly, old.id);
    await admin.query("delete from crm.workspace_members where workspace_id = $1 and user_id = any($2::uuid[])", [mark.workspaceId, [secretOnly.userId, archivedOnly.userId]]);
    const offered = await listFormerOwners(mark);
    const byId = new Map(offered.map((owner) => [owner.id, owner]));
    assert.equal(byId.get(secretOnly.userId)?.docs, 2);
    assert.deepEqual(byId.get(secretOnly.userId)?.examples, []);
    assert.equal(byId.get(archivedOnly.userId)?.docs, 1);
    assert.equal(JSON.stringify(offered).includes("Private plans"), false);
    assert.equal(byId.has(plain.userId), false);
    assert.equal(byId.has(mark.userId), false);
    assert.ok((await listFormerOwners(admin2)).some((owner) => owner.id === secretOnly.userId));
    await assert.rejects(listFormerOwners(plain), /Only the owner or an admin/);
    await assert.rejects(listFormerOwners({ ...mark, workspaceId: "00000000-0000-0000-0000-000000000000" }), /Only the owner or an admin/);
  });

  it("keeps explicit and default sorts on edit order for archived lists, and newest archived first only for the sheet", async () => {
    const stale = await createDoc(mark, { title: "Edited long ago, archived last" });
    const fresh = await createDoc(mark, { title: "Edited lately, archived first" });
    const admin = getAdminPool();
    await archiveDoc(mark, stale.id);
    await archiveDoc(mark, fresh.id);
    await admin.query("update crm.pages set edited_at = now() - interval '30 days', archived_at = now() where id = $1", [stale.id]);
    await admin.query("update crm.pages set edited_at = now() - interval '1 day', archived_at = now() - interval '1 hour' where id = $1", [fresh.id]);
    const order = async (query: Parameters<typeof listDocs>[1]) => (await listDocs(mark, { archived: true, kind: "any", limit: 200, ...query })).data.map((doc) => doc.id).filter((id) => id === stale.id || id === fresh.id);
    assert.deepEqual(await order({ sort: "edited" }), [fresh.id, stale.id]);
    assert.deepEqual(await order({}), [fresh.id, stale.id]);
    const sheet = (await listArchivedDocs(mark)).map((doc) => doc.id).filter((id) => id === stale.id || id === fresh.id);
    assert.deepEqual(sheet, [stale.id, fresh.id]);
  });

  it("lists every archived note, newest archived first", async () => {
    const already = (await listArchivedDocs(mark)).length;
    const made = [];
    for (let index = 0; index < 205; index += 1) made.push(await createDoc(mark, { title: `Archive me ${index}` }));
    for (const doc of made) await archiveDoc(mark, doc.id);
    const first = await createDoc(mark, { title: "Touched later" });
    await archiveDoc(mark, first.id);
    const all = await listArchivedDocs(mark);
    assert.equal(all.length, already + 206);
    assert.equal(all[0].id, first.id);
    const archivedTimes = all.map((doc) => doc.archivedAt ?? "");
    assert.deepEqual([...archivedTimes].sort().reverse(), archivedTimes);
    assert.equal((await listDocs(mark, { archived: true, kind: "any", limit: 200 })).data.length, 200);
  });
});
