import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DELETE as archiveRoute, GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import { GET as listRoute } from "@/app/api/v1/docs/route";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { localDate, parseDailyEntries } from "@/lib/docs/daily";
import { appendToDailyNote, openDailyNote } from "@/lib/docs/daily-notes";
import { createFolder, folderSharing, listFolders, shareFolder } from "@/lib/docs/folders";
import { parseDocsRoute } from "@/lib/docs/routes";
import { searchDocs } from "@/lib/docs/search";
import {
  archiveDoc as archive,
  assistantMayEdit,
  createDoc,
  editDoc,
  getDoc,
  getVersion,
  listBacklinks,
  listDocs,
  listDocTags,
  listVersions,
  readDoc,
  renameDoc,
  saveDoc,
  setAssistantCanEdit,
} from "@/lib/docs/store";
import { docsListPage, docsNav, docsTitles, toSummary } from "@/lib/docs/view";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let agent: AgentActor;
let token = "";

async function member(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member" as const, scopes: scopesForRole("member") };
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-safety.test", "Mark Ridgeon");
  priya = await member("priya@docs-safety.test", "Priya Shah");
  const created = await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Docs agent");
  agent = created.actor;
  token = created.token;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("edit without asking", () => {
  it("only lets the owner switch it on, and only honours it for the owner", async () => {
    const shared = await createDoc(mark, { title: "Mark's shared plan", content: "Plan", shared: true });
    await assert.rejects(setAssistantCanEdit(priya, shared.id, true), /Only Mark Ridgeon can let the assistant edit this doc without asking/);
    assert.equal(await assistantMayEdit(mark, shared.id), false);
    await assert.rejects(
      queryAsUser(priya.userId, "update crm.pages set assistant_can_edit = true where id = $1", [shared.id]),
      /Only the doc's owner can let the assistant edit it without asking/,
    );

    await setAssistantCanEdit(mark, shared.id, true);
    assert.equal(await assistantMayEdit(mark, shared.id), true);
    assert.equal(await assistantMayEdit(priya, shared.id), false);
    await assert.rejects(editDoc(priya, shared.id, { action: "append", content: "x" }, { operation: "save_doc", source: "assistant" }, { assistantCanEdit: true }), /isn't allowed to edit this doc without asking/);
    assert.equal((await getDoc(priya, shared.id)).canChangeAssistantEdit, false);
    assert.equal((await getDoc(mark, shared.id)).canChangeAssistantEdit, true);

    const agentDoc = await createDoc(agent, { title: "Agent made" });
    await assert.rejects(setAssistantCanEdit(mark, agentDoc.id, true), /no owner, so the assistant always asks/);
  });
});

describe("links across private docs", () => {
  it("keeps the owner's links to their private docs when a teammate saves the shared doc", async () => {
    const secret = await createDoc(mark, { title: "Secret plan", content: "Only Mark." });
    const hub = await createDoc(mark, { title: "Team hub", content: "See [[Secret plan]] and [[Team roadmap]].", shared: true });
    const roadmap = await createDoc(priya, { title: "Team roadmap", shared: true });
    assert.deepEqual((await listBacklinks(mark, secret.id)).map((link) => link.id), [hub.id]);

    await saveDoc(priya, hub.id, { content: "See [[Secret plan]] and [[Team roadmap]]. Priya added this." });
    assert.deepEqual((await listBacklinks(mark, secret.id)).map((link) => link.id), [hub.id]);
    assert.deepEqual((await listBacklinks(priya, roadmap.id)).map((link) => link.id), [hub.id]);
    const seenByPriya = await getDoc(priya, hub.id);
    assert.equal(seenByPriya.links.find((link) => link.title === "Secret plan")?.pageId, null);
    assert.equal((await getDoc(mark, hub.id)).links.find((link) => link.title === "Secret plan")?.pageId, secret.id);

    await saveDoc(agent, hub.id, { content: "See [[Secret plan]] and [[Team roadmap]]. The agent added this." });
    assert.deepEqual((await listBacklinks(mark, secret.id)).map((link) => link.id), [hub.id]);
  });

  it("rejects # in titles, because links read it as a heading", async () => {
    await assert.rejects(createDoc(mark, { title: "Issue #42" }), /can't contain #, \[, \] or \|/);
    const doc = await createDoc(mark, { title: "C sharp notes" });
    await assert.rejects(renameDoc(mark, doc.id, "C# notes"), /can't contain #/);
    await assert.rejects(saveDoc(mark, doc.id, { title: "C# notes" }), /can't contain #/);
  });
});

describe("title saves and renames", () => {
  it("saves a typed title without touching linking docs, and rewrites links once on rename", async () => {
    const target = await createDoc(mark, { title: "Roadmap", shared: true });
    const linking = await createDoc(mark, { title: "Links to the roadmap", content: "See [[Roadmap]] and [[Roadmap#Q1|the first quarter]].", shared: true });
    const before = (await listVersions(mark, linking.id)).length;
    for (const title of ["Roadmap 2", "Roadmap 20", "Roadmap 202", "Roadmap 2027"]) await saveDoc(mark, target.id, { title });
    assert.equal((await getDoc(mark, target.id)).title, "Roadmap 2027");
    assert.equal((await getDoc(mark, linking.id)).content, "See [[Roadmap]] and [[Roadmap#Q1|the first quarter]].");
    assert.equal((await listVersions(mark, linking.id)).length, before);
    assert.deepEqual((await listBacklinks(mark, target.id)).map((link) => link.id), [linking.id]);
    assert.ok((await listVersions(mark, target.id)).length <= 2);

    const renamed = await renameDoc(mark, target.id, "Roadmap 2027");
    assert.equal(renamed.linksUpdated, 1);
    assert.equal((await getDoc(mark, linking.id)).content, "See [[Roadmap 2027]] and [[Roadmap 2027#Q1|the first quarter]].");
    const versions = await listVersions(mark, linking.id);
    assert.equal(versions.filter((version) => version.reason === "link_renamed").length, 1);
    assert.equal((await renameDoc(mark, target.id, "Roadmap 2027")).linksUpdated, 0);
  });
});

describe("daily notes", () => {
  it("refuses to archive a daily note, and brings back one archived before", async () => {
    const note = await openDailyNote(mark, "2026-03-02");
    await assert.rejects(archive(mark, note.page.id), /Daily notes can't be archived/);
    await getAdminPool().query("update crm.pages set archived_at = now() where id = $1", [note.page.id]);
    const reopened = await openDailyNote(mark, "2026-03-02");
    assert.equal(reopened.page.id, note.page.id);
    assert.equal(reopened.page.archivedAt, null);
  });

  it("validates entry times and daily routes", () => {
    assert.deepEqual(parseDailyEntries("25:99 Not a time\n09:15 Call"), [{ time: "09:15", text: "Call" }]);
    assert.equal(parseDocsRoute("/docs/daily/2026-02-30").date, null);
    assert.equal(parseDocsRoute("/docs/daily/2028-02-29").date, "2028-02-29");
  });

  it("dates London days by British Summer Time, not GMT", () => {
    assert.equal(localDate(new Date("2026-06-30T23:30:00Z"), "Europe/London"), "2026-07-01");
    assert.equal(localDate(new Date("2026-03-29T00:30:00Z"), "Europe/London"), "2026-03-29");
    assert.equal(localDate(new Date("2026-10-25T23:30:00Z"), "Europe/London"), "2026-10-25");
    assert.equal(localDate(new Date("2026-12-31T23:30:00Z"), "Europe/London"), "2026-12-31");
  });
});

describe("folders after an unshare", () => {
  it("moves teammates' subfolders to their own top level, and counts what belongs to others", async () => {
    const team = await createFolder(mark, { name: "Team space", shared: true });
    const priyaSub = await createFolder(priya, { name: "Priya's corner", parentId: team.id });
    await createDoc(priya, { title: "Priya's corner note", folderId: priyaSub.id });
    const agentSub = await createFolder(agent, { name: "Agent output", parentId: team.id });
    const agentDoc = await createDoc(agent, { title: "Agent report", folderId: team.id });
    assert.equal(agentSub.owner, null);
    assert.equal(agentDoc.owner, null);
    assert.equal(agentDoc.visibility, "shared");
    assert.equal((await folderSharing(mark, team.id)).ownedByOthers, 4);

    await shareFolder(mark, team.id, false);
    const priyaFolders = await listFolders(priya);
    const corner = priyaFolders.find((folder) => folder.id === priyaSub.id);
    assert.equal(corner?.parentId, null);
    assert.equal(corner?.visibility, "private");
    assert.equal(priyaFolders.find((folder) => folder.id === agentSub.id)?.parentId, null);
    assert.equal(priyaFolders.some((folder) => folder.id === team.id), false);
    assert.equal((await listFolders(mark)).some((folder) => folder.id === priyaSub.id), false);
    assert.equal((await getDoc(priya, agentDoc.id)).visibility, "shared");
    assert.equal((await getDoc(agent, agentDoc.id)).owner, null);
  });

  it("shows a folder shared from inside a private folder at the recipient's top level", async () => {
    const root = await createFolder(mark, { name: "Mark private root" });
    const child = await createFolder(mark, { name: "Shared from inside", parentId: root.id, shared: true });
    const seen = (await listFolders(priya)).find((folder) => folder.id === child.id);
    assert.equal(seen?.parentId, null);
    assert.equal((await docsNav(priya)).folders.find((folder) => folder.id === child.id)?.parentId, null);
    assert.equal((await listFolders(mark)).find((folder) => folder.id === child.id)?.parentId, root.id);
  });

  it("shows an agent's name, not Former member, on what an agent created", async () => {
    const doc = await createDoc(agent, { title: "Written by the agent" });
    const summary = toSummary(mark, await getDoc(mark, doc.id));
    assert.equal(summary.owner.name, "Docs agent");
    assert.equal(summary.owner.kind, "mcp");
  });
});

describe("row-level security for docs", () => {
  it("stops a member inserting a doc or folder in someone else's name", async () => {
    await assert.rejects(
      queryAsUser(priya.userId, "insert into crm.pages (workspace_id, user_id, title, shared) values ($1, $2, 'Forged', true)", [mark.workspaceId, mark.userId]),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(priya.userId, "insert into crm.page_folders (workspace_id, user_id, name, shared) values ($1, $2, 'Forged', true)", [mark.workspaceId, mark.userId]),
      /row-level security/,
    );
    const own = await queryAsUser<{ id: string }>(priya.userId, "insert into crm.pages (workspace_id, user_id, title, shared) values ($1, $2, 'Mine', true) returning id", [
      mark.workspaceId,
      priya.userId,
    ]);
    assert.equal(own.length, 1);
  });

  it("keeps a private doc's versions from teammates and agents, even by id", async () => {
    const doc = await createDoc(mark, { title: "Private history", content: "Secret words" });
    const [version] = await listVersions(mark, doc.id);
    assert.equal((await getVersion(mark, version.id)).content, "Secret words");
    await assert.rejects(getVersion(priya, version.id), /That version doesn't exist/);
    await assert.rejects(getVersion(agent, version.id), /That version doesn't exist/);
  });
});

describe("REST API edge cases", () => {
  it("renames and saves in one step, so a stale revision changes nothing", async () => {
    const doc = await createDoc(agent, { title: "Atomic patch", content: "One" });
    const stale = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { title: "Renamed anyway", content: "Two", baseRevision: doc.revision + 5 }), params(doc.id));
    assert.equal(stale.status, 409);
    const after = await getDoc(agent, doc.id);
    assert.equal(after.title, "Atomic patch");
    assert.equal(after.content, "One");

    const fresh = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { title: "Renamed properly", content: "Two", baseRevision: after.revision }), params(doc.id));
    assert.equal(fresh.status, 200);
    assert.equal((await getDoc(agent, doc.id)).title, "Renamed properly");
  });

  it("refuses private docs, making docs private, and bad paging, without a server error", async () => {
    const privateDoc = await createDoc(mark, { title: "Mark's own" });
    assert.equal((await readRoute(request(`/docs/${privateDoc.id}`), params(privateDoc.id))).status, 404);
    assert.equal((await patchRoute(request(`/docs/${privateDoc.id}`, "PATCH", { append: "x" }), params(privateDoc.id))).status, 404);
    assert.equal((await archiveRoute(request(`/docs/${privateDoc.id}`, "DELETE"), params(privateDoc.id))).status, 404);

    const shared = await createDoc(agent, { title: "Agent shared" });
    const unshare = await patchRoute(request(`/docs/${shared.id}`, "PATCH", { shared: false }), params(shared.id));
    assert.equal(unshare.status, 403);
    assert.equal((await getDoc(agent, shared.id)).visibility, "shared");

    for (const query of ["?limit=abc", "?offset=abc", "?limit=-5&offset=1e309", "?q=agent&limit=NaN"]) {
      assert.equal((await listRoute(request(`/docs${query}`))).status, 200, query);
    }
    const far = await readRoute(request(`/docs/${shared.id}?offset=1e300`), params(shared.id));
    assert.equal(far.status, 200);
    assert.equal(((await far.json()) as { nextOffset: number | null }).nextOffset, null);
    assert.equal((await listDocs(agent, { limit: Number.NaN, offset: Number.POSITIVE_INFINITY })).data.length > 0, true);
    assert.ok(Array.isArray(await searchDocs(agent, "agent", { limit: Number.NaN })));
  });
});

describe("reading long docs", () => {
  it("reads every character of a doc full of emoji, window by window", async () => {
    const content = `${"😀".repeat(60_000)}${"a".repeat(90_000)}`;
    const doc = await createDoc(mark, { title: "Emoji heavy", content });
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const window: Awaited<ReturnType<typeof readDoc>> = await readDoc(mark, doc.id, offset);
      text += window.text;
      assert.equal(window.characters, 150_000);
      offset = window.nextOffset;
    }
    assert.equal(text, content);
  });
});

describe("archived docs drop out everywhere", () => {
  it("leaves search, backlinks, tags, titles and link resolution", async () => {
    const target = await createDoc(mark, { title: "Archive target", content: "Gone soon #archivetag", shared: true });
    const linking = await createDoc(mark, { title: "Archive linker", content: "Points at [[Archive target]]." });
    assert.deepEqual((await listBacklinks(mark, target.id)).map((link) => link.id), [linking.id]);
    await archive(mark, linking.id);
    assert.deepEqual(await listBacklinks(mark, target.id), []);
    await archive(mark, target.id);
    assert.equal((await searchDocs(mark, "Archive target")).some((hit) => hit.id === target.id), false);
    assert.equal((await listDocTags(mark)).some((tag) => tag.tag === "archivetag"), false);
    assert.equal(Object.values(await docsTitles(mark)).includes(target.id), false);
    const later = await createDoc(mark, { title: "Later linker", content: "Still [[Archive target]]?" });
    assert.equal(later.links[0].pageId, null);
  });
});

describe("tags across notes and daily notes", () => {
  it("counts and lists daily notes under a tag the same way, and says when there is more", async () => {
    await appendToDailyNote(mark, { text: "Felt good #mood", date: "2026-04-01" });
    await createDoc(mark, { title: "Mood note", content: "#mood" });
    const nav = await docsNav(mark);
    assert.equal(nav.tags.find((tag) => tag.path === "mood")?.count, 2);
    const listed = await docsListPage(mark, { kind: "tag", path: "mood" });
    assert.equal(listed.pages.length, 2);
    assert.equal(listed.hasMore, false);
    assert.deepEqual(listed.pages.map((page) => page.kind).sort(), ["daily", "note"]);
  });
});
