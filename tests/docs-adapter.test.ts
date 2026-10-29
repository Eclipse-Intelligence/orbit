import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Presence } from "@/lib/docs/client-types";
import { createFakeDocs } from "./docs-fake";
import { Q4_ID, SAMPLE_RECORDS } from "./docs-sample";

const NOW = "2026-10-29T16:00:00.000Z";

function docs(options: Partial<Parameters<typeof createFakeDocs>[0]> = {}) {
  return createFakeDocs({ now: NOW, viewer: { id: "viewer-1", name: "Mark Ridgeon" }, longNote: false, ...options });
}

describe("fake docs adapter", () => {
  it("lists folders, tags and today's daily note", async () => {
    const data = docs();
    const nav = await data.nav();
    assert.equal(nav.today, "2026-10-29");
    assert.deepEqual(
      nav.folders.map((folder) => [folder.name, folder.shared, folder.owner.name]),
      [
        ["Partnerships", true, "Mark Ridgeon"],
        ["Outbound playbooks", true, "Priya Shah"],
        ["Clients", false, "Mark Ridgeon"],
        ["Ideas", false, "Mark Ridgeon"],
      ],
    );
    assert.equal(nav.dailyCount, 29);
    assert.equal(nav.todayNote?.entries, 6);
    const clients = nav.tags.find((tag) => tag.path === "clients");
    assert.deepEqual(clients?.children.map((child) => child.name), ["acme", "northwind"]);
  });

  it("filters by folder, tag, search and daily", async () => {
    const data = docs();
    const partnerships = await data.listPages({ kind: "folder", folderId: "f-partnerships" });
    assert.equal(partnerships[0].id, Q4_ID);
    assert.ok(partnerships.every((page) => page.folderId === "f-partnerships" && page.shared));
    const acme = await data.listPages({ kind: "tag", path: "clients/acme" });
    assert.ok(acme.length >= 3 && acme.every((page) => page.tags.some((tag) => tag.startsWith("clients/acme"))));
    const search = await data.search("renewal");
    assert.ok(search.titles.some((page) => page.title === "Acme renewal timeline"));
    assert.ok(search.text.every((hit) => hit.snippet.toLowerCase().slice(hit.matchFrom, hit.matchTo) === "renewal"));
    const daily = await data.listPages({ kind: "daily" });
    assert.equal(daily[0].dailyDate, "2026-10-29");
  });

  it("saves, keeps versions and renames links in other notes", async () => {
    const data = docs();
    const page = await data.getPage("3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a02");
    assert.ok(page);
    const saved = await data.savePage(page.id, { title: "Northwind MSA", body: `${page.body}\n\nOne more line.`, baseRevision: page.revision });
    assert.ok(saved.ok);
    assert.equal(saved.page.revision, page.revision + 1);
    const versions = await data.listVersions(page.id);
    assert.match(versions[0].summary, /Added 3 words/);
    const q4 = await data.getPage(Q4_ID);
    assert.ok(q4?.body.includes("[[Northwind MSA]]"));
    const titles = await data.resolveTitles();
    assert.equal(titles["northwind msa"], page.id);
  });

  it("finds backlinks with context and unlinked mentions", async () => {
    const data = docs();
    const links = await data.backlinks(Q4_ID);
    assert.deepEqual(links.linked.map((link) => link.title).sort(), ["Acme pricing notes", "Co-marketing calendar", "Tue 27 Oct"]);
    for (const link of links.linked) assert.equal(link.snippet.slice(link.matchFrom, link.matchTo), "Q4 partner strategy");
    assert.deepEqual(links.unlinked.map((link) => link.title).sort(), ["Helix Data joint offer", "Partner programme FAQ"]);
  });

  it("offers link targets with sharing so private links can be flagged", async () => {
    const data = docs();
    const targets = await data.linkTargets("acme renewal", Q4_ID);
    const notes = targets.filter((target) => target.kind === "note");
    assert.deepEqual(notes.map((target) => target.title).sort(), ["Acme renewal call prep", "Acme renewal timeline"]);
    assert.ok(notes.some((target) => target.kind === "note" && target.title === "Acme renewal call prep" && !target.shared));
    assert.ok(targets.some((target) => target.kind === "heading" && target.heading === "For the renewal call"));
    assert.ok(targets.some((target) => target.kind === "daily"));
  });

  it("shares folders and notes, and keeps daily notes private", async () => {
    const data = docs();
    await data.share({ kind: "folder", id: "f-clients" }, "shared");
    const clients = await data.listPages({ kind: "folder", folderId: "f-clients" });
    assert.ok(clients.every((page) => page.shared));
    await assert.rejects(data.share({ kind: "folder", id: "f-outbound" }, "private"), /Only Priya Shah/);
    await assert.rejects(data.share({ kind: "page", id: "daily-2026-10-29" }, "shared"), /always private/);
  });

  it("creates, moves and archives notes and folders", async () => {
    const data = docs();
    const folder = await data.createFolder("Board prep", null);
    const child = await data.createFolder("Q1", folder.id);
    await assert.rejects(data.moveFolder(folder.id, child.id, 0), /inside itself/);
    const page = await data.createPage({ title: "Agenda", folderId: folder.id });
    assert.equal((await data.listPages({ kind: "folder", folderId: folder.id })).length, 1);
    await data.movePage(page.id, child.id);
    assert.equal((await data.listPages({ kind: "folder", folderId: folder.id })).length, 1);
    await data.archivePage(page.id);
    assert.equal(await data.getPage(page.id), null);
    await data.restorePage(page.id);
    assert.ok(await data.getPage(page.id));
    const moved = await data.moveFolder("f-ideas", null, 0);
    assert.equal(moved[0].id, "f-ideas");
  });

  it("restores versions and opens empty daily notes", async () => {
    const data = docs();
    const versions = await data.listVersions(Q4_ID);
    const restored = await data.restoreVersion(Q4_ID, versions[versions.length - 1].id);
    assert.ok(!restored.body.includes("## Q4 plan"));
    const empty = await data.dailyNote("2026-09-01");
    assert.equal(empty.body, "");
    assert.equal(empty.kind, "daily");
  });

  it("finds notes that mention a record by id or name", async () => {
    const data = docs({ recordSearch: async () => [{ kind: "company", id: "real-id", name: "Acme Ltd", detail: null }] });
    const byId = await data.recordMentions(SAMPLE_RECORDS.acme);
    assert.ok(byId.some((hit) => hit.page.id === Q4_ID));
    const byName = await data.recordMentions({ kind: "company", id: "another-id", name: "acme" });
    assert.equal(byName.length, byId.length);
    const records = await data.searchRecords("acme");
    assert.deepEqual(
      records.map((record) => record.name),
      ["Acme Ltd", "Acme"],
    );
  });

  it("reports presence for the note the assistant is writing in", async () => {
    const data = docs();
    const presence = await new Promise<Presence[]>((resolve) => {
      const stop = data.watchPresence(Q4_ID, (list) => {
        stop();
        resolve(list);
      });
    });
    const page = await data.getPage(Q4_ID);
    const assistant = presence.find((entry) => entry.participant.kind === "assistant");
    assert.ok(assistant?.writing && assistant.cursor && assistant.insertFrom !== undefined);
    assert.ok(page?.body.slice(assistant.insertFrom, assistant.cursor).startsWith("Acme's renewal lands in January"));
  });
});
