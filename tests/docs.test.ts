import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { takeOverFormerMemberDocs } from "@/lib/docs/admin";
import { appendToDailyNote, getDailyNote, listDailyNotes, openDailyNote } from "@/lib/docs/daily-notes";
import { archiveFolder, createFolder, folderSharing, listFolders, moveFolder, restoreFolder, shareFolder } from "@/lib/docs/folders";
import { searchDocs } from "@/lib/docs/search";
import {
  archiveDoc,
  createDoc,
  docsMentioning,
  getDoc,
  getVersion,
  listBacklinks,
  listDocs,
  listDocTags,
  listUnlinkedMentions,
  listVersions,
  moveDoc,
  readDoc,
  renameDoc,
  restoreDoc,
  restoreVersion,
  saveDoc,
  setAssistantCanEdit,
  shareDoc,
} from "@/lib/docs/store";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let sam: UserActor;
let agent: AgentActor;
let blindAgent: AgentActor;

async function member(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member" as const, scopes: scopesForRole("member") };
}

async function titles(actor: UserActor | AgentActor, query: Parameters<typeof listDocs>[1] = {}) {
  return (await listDocs(actor, query)).data.map((doc) => doc.title).sort();
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs.test", "Mark Ridgeon");
  priya = await member("priya@docs.test", "Priya Shah");
  sam = await member("sam@docs.test", "Sam Colleague");
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Docs agent")).actor;
  blindAgent = (await createAgent(mark.workspaceId, ["crm:read"], "No docs")).actor;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("docs privacy", () => {
  it("keeps docs private by default and shares them with every member when asked", async () => {
    const mine = await createDoc(mark, { title: "Private plan", content: "Only me." });
    assert.equal(mine.visibility, "private");
    assert.equal(mine.ownedByMe, true);
    await assert.rejects(getDoc(priya, mine.id), /private to someone else/);
    assert.deepEqual(await queryAsUser(priya.userId, "select id from crm.pages where id = $1", [mine.id]), []);
    await assert.rejects(getDoc(agent, mine.id), /private to someone else/);

    const shared = await shareDoc(mark, mine.id, true);
    assert.equal(shared.doc.visibility, "shared");
    assert.deepEqual(shared.visibility, { before: "private", after: "shared", changed: true });
    const seen = await getDoc(priya, mine.id);
    assert.equal(seen.ownedByMe, false);
    assert.equal(seen.owner?.name, "Mark Ridgeon");
    await saveDoc(priya, mine.id, { content: "Only me. Priya was here." });
    assert.equal((await getDoc(mark, mine.id)).content, "Only me. Priya was here.");
    assert.equal((await getDoc(agent, mine.id)).title, "Private plan");

    await assert.rejects(shareDoc(priya, mine.id, false), /Only Mark Ridgeon can make this doc private/);
    await assert.rejects(shareDoc(agent, mine.id, false), /Only Mark Ridgeon can make this doc private/);
    await shareDoc(mark, mine.id, false);
    await assert.rejects(getDoc(priya, mine.id), /private to someone else/);
  });

  it("shares everything inside a shared folder, nested folders included, and takes it back when unshared", async () => {
    const clients = await createFolder(mark, { name: "Clients" });
    const acme = await createFolder(mark, { name: "Acme", parentId: clients.id });
    const deep = await createFolder(mark, { name: "Renewal", parentId: acme.id });
    const note = await createDoc(mark, { title: "Acme renewal", content: "January.", folderId: deep.id });
    const own = await createDoc(mark, { title: "Shared on its own", folderId: acme.id, shared: true });
    assert.deepEqual((await listFolders(priya)).map((folder) => folder.name).includes("Clients"), false);

    const preview = await folderSharing(mark, clients.id);
    assert.deepEqual({ docs: preview.docs, folders: preview.folders, sharedOnTheirOwn: preview.sharedOnTheirOwn }, { docs: 2, folders: 2, sharedOnTheirOwn: 1 });

    const result = await shareFolder(mark, clients.id, true);
    assert.equal(result.folder.visibility, "shared");
    const priyaFolders = await listFolders(priya);
    assert.deepEqual(priyaFolders.filter((folder) => ["Clients", "Acme", "Renewal"].includes(folder.name)).map((folder) => folder.visibility).sort(), [
      "shared",
      "shared_by_folder",
      "shared_by_folder",
    ]);
    const seen = await getDoc(priya, note.id);
    assert.equal(seen.visibility, "shared_by_folder");
    assert.deepEqual(seen.path.map((step) => step.name), ["Clients", "Acme", "Renewal"]);
    assert.equal((await getDoc(agent, note.id)).id, note.id);

    const priyaNote = await createDoc(priya, { title: "Priya in Acme", folderId: acme.id });
    assert.equal(priyaNote.visibility, "shared_by_folder");
    assert.equal((await getDoc(mark, priyaNote.id)).owner?.name, "Priya Shah");
    await assert.rejects(shareFolder(priya, clients.id, false), /Only Mark Ridgeon can make this folder private/);

    const back = await shareFolder(mark, clients.id, false);
    assert.equal(back.sharing.ownedByOthers, 1);
    await assert.rejects(getDoc(priya, note.id), /private to someone else/);
    assert.equal((await getDoc(priya, own.id)).visibility, "shared");
    assert.equal((await getDoc(priya, priyaNote.id)).visibility, "private");
    await assert.rejects(getDoc(mark, priyaNote.id), /private to someone else/);
    assert.ok((await titles(priya, { folderId: null })).includes("Priya in Acme"));
  });

  it("makes moves that change who sees something explicit", async () => {
    const team = await createFolder(mark, { name: "Team", shared: true });
    const draft = await createDoc(mark, { title: "Moving draft" });
    await assert.rejects(moveDoc(mark, draft.id, { folderId: team.id }), (error: Error & { code?: string }) => {
      assert.equal(error.code, "visibility_change");
      assert.match(error.message, /shares it with everyone/);
      return true;
    });
    const moved = await moveDoc(mark, draft.id, { folderId: team.id, allowVisibilityChange: true });
    assert.deepEqual(moved.visibility, { before: "private", after: "shared_by_folder", changed: true });
    assert.equal((await getDoc(sam, draft.id)).title, "Moving draft");

    await assert.rejects(moveDoc(priya, draft.id, { folderId: null, allowVisibilityChange: true }), /private to Mark Ridgeon, so only they can move it/);
    await assert.rejects(moveDoc(mark, draft.id, { folderId: null }), /makes it private/);
    await moveDoc(mark, draft.id, { folderId: null, allowVisibilityChange: true });
    await assert.rejects(getDoc(sam, draft.id), /private to someone else/);

    const privateFolder = await createFolder(priya, { name: "Priya private" });
    await assert.rejects(moveDoc(mark, draft.id, { folderId: privateFolder.id }), /private to someone else/);

    const outer = await createFolder(mark, { name: "Outer" });
    const inner = await createFolder(mark, { name: "Inner", parentId: outer.id });
    const innerDoc = await createDoc(mark, { title: "Inner doc", folderId: inner.id });
    await assert.rejects(moveFolder(mark, outer.id, { parentId: inner.id }), /inside one of its own folders/);
    await assert.rejects(moveFolder(mark, outer.id, { parentId: team.id }), /shares it with everyone/);
    const shifted = await moveFolder(mark, outer.id, { parentId: team.id, allowVisibilityChange: true });
    assert.equal(shifted.folder.visibility, "shared_by_folder");
    assert.equal((await getDoc(sam, innerDoc.id)).visibility, "shared_by_folder");
    await moveFolder(mark, outer.id, { parentId: null, allowVisibilityChange: true });
    await assert.rejects(getDoc(sam, innerDoc.id), /private to someone else/);
  });

  it("orders folders among their siblings", async () => {
    const parent = await createFolder(mark, { name: "Ordering" });
    const a = await createFolder(mark, { name: "A", parentId: parent.id });
    const b = await createFolder(mark, { name: "B", parentId: parent.id });
    const c = await createFolder(mark, { name: "C", parentId: parent.id });
    await moveFolder(mark, c.id, { parentId: parent.id, index: 0 });
    const order = (await listFolders(mark)).filter((folder) => folder.parentId === parent.id).map((folder) => folder.name);
    assert.deepEqual(order, ["C", "A", "B"]);
    assert.ok([a.id, b.id].every(Boolean));
  });

  it("gives agent tokens shared docs only, and needs the docs scopes", async () => {
    const shared = await createDoc(mark, { title: "For agents", shared: true });
    await createDoc(mark, { title: "Not for agents" });
    const seen = await titles(agent);
    assert.ok(seen.includes("For agents"));
    assert.ok(!seen.includes("Not for agents"));
    await assert.rejects(listDocs(blindAgent), /Missing scope docs:read/);
    await assert.rejects(createDoc(blindAgent, { title: "Nope" }), /Missing scope docs:write/);
    const made = await createDoc(agent, { title: "Agent wrote this", content: "Hello" });
    assert.equal(made.visibility, "shared");
    assert.equal(made.owner, null);
    assert.equal(made.lastEditor?.editor, "agent");
    assert.equal(made.lastEditor?.name, "Docs agent");
    await saveDoc(agent, shared.id, { content: "Agent edit" });
    await assert.rejects(openDailyNote(agent), /agent tokens can't open them/);
    await assert.rejects(setAssistantCanEdit(agent, shared.id, true), /Only a person/);
    const daily = await openDailyNote(mark);
    await assert.rejects(getDoc(agent, daily.page.id), /private to someone else/);
  });

  it("keeps daily notes private and lets an admin take over a former member's notes, but not their daily notes", async () => {
    const daily = await openDailyNote(sam, "2026-10-20");
    await assert.rejects(shareDoc(sam, daily.page.id, true), /always private/);
    const folder = await createFolder(sam, { name: "Sam folder", shared: true });
    await assert.rejects(moveDoc(sam, daily.page.id, { folderId: folder.id }), /can't go in folders/);
    const kept = await createDoc(sam, { title: "Sam private note" });
    await assert.rejects(takeOverFormerMemberDocs(mark, sam.userId), /still in this workspace/);
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, sam.userId]);
    await assert.rejects(getDoc(mark, kept.id), /private to someone else/);
    assert.equal((await getDoc(priya, (await createDoc(priya, { title: "In Sam folder", folderId: folder.id })).id)).visibility, "shared_by_folder");
    await assert.rejects(takeOverFormerMemberDocs(priya, sam.userId), /Only the owner or an admin/);
    const moved = await takeOverFormerMemberDocs(mark, sam.userId);
    assert.deepEqual(moved, { docs: 1, folders: 1 });
    assert.equal((await getDoc(mark, kept.id)).ownedByMe, true);
    const rows = await getAdminPool().query("select user_id from crm.pages where id = $1", [daily.page.id]);
    assert.equal(rows.rows[0].user_id, sam.userId);
  });
});

describe("docs links, tags and mentions", () => {
  it("resolves links among docs the author can see, and resolves unresolved ones later", async () => {
    const hub = await createDoc(mark, { title: "Q4 partner strategy", content: "See [[Northwind MSA redlines]] and [[Acme pricing notes#Tiers|tiers]].", shared: true });
    assert.deepEqual(hub.links.map((link) => ({ title: link.title, pageId: link.pageId })), [
      { title: "Northwind MSA redlines", pageId: null },
      { title: "Acme pricing notes", pageId: null },
    ]);
    const northwind = await createDoc(mark, { title: "northwind msa redlines", content: "Clause 9." });
    const pricing = await createDoc(priya, { title: "Acme pricing notes", content: "Tiers" });
    const after = await getDoc(mark, hub.id);
    assert.equal(after.links.find((link) => link.title === "Northwind MSA redlines")?.pageId, northwind.id);
    assert.equal(after.links.find((link) => link.title === "Acme pricing notes")?.pageId, null);
    await shareDoc(priya, pricing.id, true);
    const shared = await getDoc(mark, hub.id);
    assert.equal(shared.links.find((link) => link.title === "Acme pricing notes")?.pageId, pricing.id);
    assert.equal(shared.links.find((link) => link.title === "Acme pricing notes")?.heading, "Tiers");
    assert.deepEqual((await listBacklinks(mark, northwind.id)).map((link) => [link.title, link.snippet]), [
      ["Q4 partner strategy", "See Northwind MSA redlines and tiers."],
    ]);
    await assert.rejects(listBacklinks(priya, northwind.id), /private to someone else/);
  });

  it("rewrites links in every doc that points at a renamed doc, with versions", async () => {
    const target = await createDoc(mark, { title: "Partner tiers", shared: true });
    const one = await createDoc(mark, { title: "Links one", content: "Read [[Partner tiers]] first.", shared: true });
    const two = await createDoc(priya, { title: "Links two", content: "Also [[partner tiers#Select|Select]].", shared: true });
    const hidden = await createDoc(priya, { title: "Priya hidden", content: "Mine: [[Partner tiers]]" });
    const result = await renameDoc(mark, target.id, "Partner tiers and margins");
    assert.equal(result.linksUpdated, 2);
    assert.equal((await getDoc(mark, one.id)).content, "Read [[Partner tiers and margins]] first.");
    assert.equal((await getDoc(priya, two.id)).content, "Also [[Partner tiers and margins#Select|Select]].");
    const versions = await listVersions(priya, two.id);
    assert.deepEqual(versions.map((version) => version.reason), ["link_renamed", "created"]);
    assert.ok(versions.some((version) => version.reason === "link_renamed" && version.summary === "Updated links to Partner tiers and margins"));
    const stale = await getDoc(priya, hidden.id);
    assert.equal(stale.content, "Mine: [[Partner tiers]]");
    assert.equal(stale.links[0].pageId, target.id);
    await saveDoc(priya, hidden.id, { content: "Mine: [[Partner tiers]] again" });
    assert.equal((await getDoc(priya, hidden.id)).content, "Mine: [[Partner tiers and margins]] again");
    assert.equal((await listBacklinks(mark, target.id)).length, 2);
    assert.equal((await listBacklinks(priya, target.id)).length, 3);
  });

  it("indexes tags for the tag tree and filters by a tag and its children", async () => {
    await createDoc(mark, { title: "Tagged acme", content: "Note #clients/acme #wins", shared: true });
    await createDoc(mark, { title: "Tagged northwind", content: "Note #clients/northwind\n```\n#ignored\n```" });
    await createDoc(priya, { title: "Priya tagged", content: "#clients/secret" });
    const tags = await listDocTags(mark);
    assert.ok(tags.some((tag) => tag.tag === "clients/acme"));
    assert.ok(!tags.some((tag) => tag.tag === "ignored" || tag.tag === "clients/secret"));
    assert.deepEqual(await titles(mark, { tag: "clients" }), ["Tagged acme", "Tagged northwind"]);
    assert.deepEqual(await titles(mark, { tag: "#clients/acme" }), ["Tagged acme"]);
    assert.deepEqual(await titles(priya, { tag: "clients" }), ["Priya tagged", "Tagged acme"]);
  });

  it("lists the notes that mention a record, for its page", async () => {
    const acme = (await createCompany(mark, { name: "Acme Docs", domain: "acme-docs.test" })).body.company.id;
    await createDoc(mark, { title: "Mentions Acme", content: `Call with @[Acme Docs](company:${acme}) today.`, shared: true });
    await createDoc(mark, { title: "Private mention", content: `@[Acme Docs](company:${acme})` });
    const forMark = await docsMentioning(mark, { kind: "company", id: acme });
    assert.deepEqual(forMark.map((doc) => doc.title).sort(), ["Mentions Acme", "Private mention"]);
    assert.equal(forMark.find((doc) => doc.title === "Mentions Acme")?.snippet, "Call with Acme Docs today.");
    assert.deepEqual((await docsMentioning(priya, { kind: "company", id: acme })).map((doc) => doc.title), ["Mentions Acme"]);
    assert.deepEqual((await getDoc(mark, forMark[0].id)).mentions.map((mention) => mention.kind), ["company"]);
  });

  it("finds unlinked mentions of a title", async () => {
    const helix = await createDoc(mark, { title: "Helix joint offer", shared: true });
    await createDoc(mark, { title: "Mentions Helix", content: "We need the Helix joint offer signed.", shared: true });
    await createDoc(mark, { title: "Links Helix", content: "See [[Helix joint offer]].", shared: true });
    assert.deepEqual((await listUnlinkedMentions(mark, helix.id)).map((doc) => doc.title), ["Mentions Helix"]);
  });
});

describe("docs search", () => {
  it("finds docs by title prefix, fuzzy title and content, only among docs the caller can see", async () => {
    await createDoc(mark, { title: "Acme renewal plan", content: "The pilot results need to land by 12 December.", shared: true });
    await createDoc(mark, { title: "Northwind legal", content: "Clause nine is the sticking point." });
    await createDoc(priya, { title: "Acme renewal secrets", content: "Private." });
    const prefix = await searchDocs(mark, "acme ren");
    assert.equal(prefix[0].title, "Acme renewal plan");
    assert.equal(prefix[0].titleMatch, "prefix");
    assert.ok(!prefix.some((hit) => hit.title === "Acme renewal secrets"));
    const fuzzy = await searchDocs(mark, "Acme renwal plan");
    assert.equal(fuzzy[0].title, "Acme renewal plan");
    assert.equal(fuzzy[0].titleMatch, "fuzzy");
    const body = await searchDocs(mark, "sticking point");
    assert.equal(body[0].title, "Northwind legal");
    assert.match(body[0].snippet ?? "", /sticking point/);
    assert.deepEqual((await searchDocs(priya, "sticking")).map((hit) => hit.title), []);
    const agentHits = await searchDocs(agent, "acme renewal");
    assert.deepEqual(agentHits.map((hit) => hit.title), ["Acme renewal plan"]);
    const recent = await searchDocs(mark, "", { limit: 3 });
    assert.equal(recent.length, 3);
  });
});

describe("docs versions", () => {
  it("snapshots people on a throttle, agents every time, and restores as a new version", async () => {
    const doc = await createDoc(mark, { title: "Versioned", content: "One" });
    await saveDoc(mark, doc.id, { content: "One two" });
    await saveDoc(mark, doc.id, { content: "One two three" });
    let versions = await listVersions(mark, doc.id);
    assert.deepEqual(versions.map((version) => version.reason), ["created"]);
    await getAdminPool().query("update crm.pages set versioned_at = now() - interval '11 minutes' where id = $1", [doc.id]);
    await saveDoc(mark, doc.id, { content: "One two three four" });
    versions = await listVersions(mark, doc.id);
    assert.deepEqual(versions.map((version) => version.reason), ["edited", "created"]);
    await saveDoc(mark, doc.id, { content: "One two three four five" });
    await saveDoc(mark, doc.id, { content: "Assistant rewrote it" }, { operation: "save_doc", source: "assistant" });
    versions = await listVersions(mark, doc.id);
    assert.deepEqual(versions.map((version) => [version.reason, version.by.editor]), [
      ["edited", "assistant"],
      ["before_agent", "person"],
      ["edited", "person"],
      ["created", "person"],
    ]);
    assert.equal(versions[0].by.name, "Orbit assistant");
    assert.equal(versions[0].by.personName, "Mark Ridgeon");
    assert.equal((await getVersion(mark, versions[1].id)).content, "One two three four five");

    const restored = await restoreVersion(mark, doc.id, versions[1].id);
    assert.equal(restored.content, "One two three four five");
    versions = await listVersions(mark, doc.id);
    assert.equal(versions[0].reason, "restored");
    assert.match(versions[0].summary ?? "", /^Restored the version from/);
    await assert.rejects(saveDoc(mark, doc.id, { content: "stale", baseRevision: 1 }), /changed since you opened it/);
    const renamed = await renameDoc(mark, doc.id, "Versioned and renamed");
    assert.equal(renamed.doc.title, "Versioned and renamed");
    assert.equal((await listVersions(mark, doc.id))[0].reason, "renamed");
  });

  it("archives and restores docs and folders without deleting anything", async () => {
    const folder = await createFolder(mark, { name: "Archive me", shared: true });
    const inside = await createDoc(mark, { title: "Inside archive", folderId: folder.id });
    const alone = await createDoc(mark, { title: "Archived alone", shared: true });
    await archiveDoc(mark, alone.id);
    assert.ok(!(await titles(mark)).includes("Archived alone"));
    assert.ok((await titles(mark, { archived: true })).includes("Archived alone"));
    await archiveFolder(mark, folder.id);
    assert.ok((await getDoc(mark, inside.id)).archivedAt);
    await assert.rejects(restoreDoc(mark, inside.id), /Restore that folder first/);
    await restoreFolder(mark, folder.id);
    assert.equal((await getDoc(mark, inside.id)).archivedAt, null);
    await restoreDoc(mark, alone.id);
    assert.ok((await titles(mark)).includes("Archived alone"));
    const events = await getAdminPool().query<{ event_type: string }>(
      "select event_type from crm.audit_events where entity_id = any($1::uuid[]) order by created_at",
      [[alone.id, folder.id]],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), ["page_folder.created", "page.created", "page.archived", "page_folder.archived", "page_folder.restored", "page.restored"]);
  });

  it("audits shared docs only", async () => {
    const quiet = await createDoc(mark, { title: "Quiet one", content: "x" });
    await saveDoc(mark, quiet.id, { title: "Quiet renamed" });
    const loud = await createDoc(mark, { title: "Loud one", content: "x", shared: true });
    await renameDoc(mark, loud.id, "Loud renamed");
    const events = await getAdminPool().query<{ entity_id: string; event_type: string }>(
      "select entity_id, event_type from crm.audit_events where entity_id = any($1::uuid[]) order by created_at",
      [[quiet.id, loud.id]],
    );
    assert.deepEqual(events.rows.map((row) => [row.entity_id === loud.id, row.event_type]), [
      [true, "page.created"],
      [true, "page.updated"],
    ]);
  });
});

describe("daily notes", () => {
  it("creates one note per person per London day and appends timed entries", async () => {
    const now = new Date("2026-10-29T08:42:00Z");
    assert.equal(await getDailyNote(priya, "2026-10-29", { now }), null);
    const first = await appendToDailyNote(priya, { text: "Slept badly. Coffee first.", now }, { operation: "daily" });
    assert.equal(first.date, "2026-10-29");
    assert.equal(first.isToday, true);
    assert.equal(first.page.content, "08:42 Slept badly. Coffee first.");
    assert.equal(first.page.kind, "daily");
    assert.equal(first.page.title, "2026-10-29");
    const second = await appendToDailyNote(priya, { text: "Call with #northwind", now: new Date("2026-10-29T14:05:00Z") });
    assert.equal(second.page.id, first.page.id);
    assert.equal(second.page.content, "08:42 Slept badly. Coffee first.\n\n14:05 Call with #northwind");
    assert.deepEqual(second.page.tags, ["northwind"]);
    const late = await appendToDailyNote(priya, { text: "Late", now: new Date("2026-10-30T00:30:00Z") });
    assert.equal(late.date, "2026-10-30");
    const opened = await openDailyNote(priya, "2026-10-29", { now, meetings: true });
    assert.equal(opened.page.id, first.page.id);
    assert.deepEqual(opened.meetings, []);
    await openDailyNote(priya, "2026-10-01");
    const days = await listDailyNotes(priya);
    assert.deepEqual(days.map((day) => [day.date, day.entryCount]), [
      ["2026-10-30", 1],
      ["2026-10-29", 2],
    ]);
    assert.equal(days[1].excerpt, "Slept badly. Coffee first. Call with #northwind");
    await assert.rejects(getDoc(mark, first.page.id), /private to someone else/);
    await assert.rejects(renameDoc(priya, first.page.id, "New"), /can't be renamed/);
    await assert.rejects(appendToDailyNote(priya, { text: "  " }), /Say what to write/);
    await assert.rejects(openDailyNote(priya, "29/10/2026"), /YYYY-MM-DD/);
  });

  it("reads long docs in windows", async () => {
    const long = await createDoc(mark, { title: "Long one", content: "x".repeat(150_000) });
    const first = await readDoc(mark, long.id, 0);
    assert.equal(first.text.length, 100_000);
    assert.equal(first.nextOffset, 100_000);
    const second = await readDoc(mark, long.id, first.nextOffset!);
    assert.equal(second.text.length, 50_000);
    assert.equal(second.nextOffset, null);
  });
});
