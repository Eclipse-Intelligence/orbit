import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Y from "yjs";
import { runDocAction } from "@/lib/assistant/docs";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { appendToDailyNote } from "@/lib/docs/daily-notes";
import { createFolder, moveFolder, shareFolder } from "@/lib/docs/folders";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { createLiveDoc, liveText } from "@/lib/docs/live/ydoc";
import { memberTagCount, peopleTagMode } from "@/lib/docs/people-tags";
import { createDocFromBody, patchDocFromBody } from "@/lib/docs/rest";
import { takeOverFormerMemberDocs } from "@/lib/docs/admin";
import { appendToDoc, createDoc, editDoc, getDoc, moveDoc, openLiveDoc, restoreVersion, listVersions, saveDoc, shareDoc, syncLiveDoc, untagFolderPages, updateDoc } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "docs_tags_test", source: "test" };

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;
let olly: UserActor;
let agent: AgentActor;
let broadcasts: LiveMessage[][];

function tag(person: UserActor, name: string) {
  return `@[${name}](member:${person.userId})`;
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return getAdminPool().query<T>(text, values);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

type AlertRow = { user_id: string; workspace_id: string; title: string; href: string; source: string };

async function docAlerts() {
  await settle();
  return (await sql<AlertRow>("select user_id::text, workspace_id::text, title, href, source from crm.notifications where source = 'doc' order by created_at, id")).rows;
}

async function eventually(check: () => Promise<boolean>, label: string) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function memberLinks(pageId: string) {
  const result = await sql<{ id: string }>("select target_record_id::text as id from crm.page_links where page_id = $1 and target_kind = 'member' order by target_record_id", [pageId]);
  return result.rows.map((row) => row.id);
}

async function mcp(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "doc-tags", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0]?.text ?? "MCP error");
      return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@doc-tags.test", "Mark Ridgeon");
  const samUser = await createUser("sam@doc-tags.test", "Sam Okafor");
  const priyaUser = await createUser("priya@doc-tags.test", "Priya Shah");
  olly = await createUser("olly@elsewhere.test", "Olly Outside");
  await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [mark.workspaceId, samUser.userId, priyaUser.userId]);
  mark = { ...mark, workspaceName: "Eclipse" };
  sam = { ...samUser, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" };
  priya = { ...priyaUser, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" };
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Claude Code")).actor;
});

beforeEach(async () => {
  broadcasts = [];
  setLiveTesting({ batch: async (messages) => void broadcasts.push(messages) });
  await settle();
  await sql("truncate crm.push_log, crm.notifications");
});

afterEach(() => {
  setLiveTesting(null);
});

after(async () => {
  await settle();
  await getPool().end();
  await getAdminPool().end();
});

describe("people tags in private and daily docs", () => {
  it("turns member tokens into plain text when a private doc is created or saved", async () => {
    const doc = await createDoc(mark, { title: "Private plan", content: `Ask ${tag(sam, "Sam Okafor")} about pricing` }, PROVENANCE);
    assert.equal(doc.content, "Ask @Sam Okafor about pricing");
    assert.deepEqual(await memberLinks(doc.id), []);
    const saved = await saveDoc(mark, doc.id, { content: `Ask ${tag(sam, "Sam Okafor")} and ${tag(priya, "Priya Shah")}` }, PROVENANCE);
    assert.equal(saved.content, "Ask @Sam Okafor and @Priya Shah");
    assert.deepEqual(saved.mentions, []);
    assert.deepEqual(await docAlerts(), []);
  });

  it("strips them from every write path into a private doc", async () => {
    const doc = await createDoc(mark, { title: "Paths", content: "Start" }, PROVENANCE);
    await appendToDoc(mark, doc.id, `Append ${tag(sam, "Sam")}`, PROVENANCE);
    await editDoc(mark, doc.id, { action: "edit", find: "Start", replace: `Edit ${tag(sam, "Sam")}` }, PROVENANCE);
    await updateDoc(mark, doc.id, { edits: [{ action: "append", content: `Update ${tag(priya, "Priya")}` }] }, PROVENANCE);
    await runDocAction(mark, { action: "append", docId: doc.id, content: `Assistant ${tag(sam, "Sam")}` });
    await patchDocFromBody(mark, doc.id, { append: `Rest ${tag(priya, "Priya")}` });
    const client = await mcp(mark);
    try {
      await client.call("update_doc", { id: doc.id, mode: "append", content: `Mcp ${tag(sam, "Sam")}` });
      const created = (await client.call("create_doc", { title: "From MCP", content: `Hi ${tag(sam, "Sam")}` })).doc as { id: string };
      assert.equal((await getDoc(mark, created.id)).content, "Hi @Sam");
    } finally {
      await client.close();
    }
    const rest = await createDocFromBody(mark, { title: "From REST", content: `Hi ${tag(priya, "Priya")}` });
    assert.equal(rest.doc.content, "Hi @Priya");
    const assistant = await runDocAction(mark, { action: "create", title: "From the assistant", content: `Hi ${tag(sam, "Sam")}` });
    assert.equal((await getDoc(mark, (assistant.doc as { id: string }).id)).content, "Hi @Sam");
    const content = (await getDoc(mark, doc.id)).content;
    assert.doesNotMatch(content, /member:/);
    for (const line of ["Append @Sam", "Edit @Sam", "Update @Priya", "Assistant @Sam", "Rest @Priya", "Mcp @Sam"]) assert.match(content, new RegExp(line));
    assert.deepEqual(await memberLinks(doc.id), []);
    assert.deepEqual(await docAlerts(), []);
  });

  it("strips them from live saves and sends the plain text back to the editor", async () => {
    const doc = await createDoc(mark, { title: "Live private", content: "Hello" }, PROVENANCE);
    const local = createLiveDoc((await openLiveDoc(mark, doc.id)).state);
    const vector = Y.encodeStateVector(local);
    liveText(local).insert(5, ` ${tag(sam, "Sam")}`);
    const result = await syncLiveDoc(mark, doc.id, { update: Y.encodeStateAsUpdate(local, vector), vector: Y.encodeStateVector(local) });
    Y.applyUpdate(local, result.missing);
    assert.equal((await getDoc(mark, doc.id)).content, "Hello @Sam");
    assert.equal(liveText(local).toString(), "Hello @Sam");
    assert.deepEqual(await docAlerts(), []);
  });

  it("never keeps them in daily notes, even when appended", async () => {
    const note = await appendToDailyNote(mark, { text: `Call ${tag(sam, "Sam")}`, date: "2026-11-11", now: new Date("2026-11-11T10:00:00Z") }, PROVENANCE);
    assert.doesNotMatch(note.page.content, /member:/);
    assert.match(note.page.content, /Call @Sam/);
    assert.deepEqual(await memberLinks(note.page.id), []);
    assert.deepEqual(await docAlerts(), []);
  });

  it("leaves member tokens inside code alone", async () => {
    const code = "`" + tag(sam, "Sam") + "`";
    const doc = await createDoc(mark, { title: "Code", content: code }, PROVENANCE);
    assert.equal(doc.content, code);
  });
});

describe("people tags in shared docs", () => {
  it("keeps tags in shared docs and alerts each newly tagged person once", async () => {
    const doc = await createDoc(mark, { title: "Kick-off", content: `Agenda led by ${tag(sam, "Sam Okafor")}`, shared: true }, PROVENANCE);
    assert.deepEqual(doc.mentions, [{ kind: "member", id: sam.userId, name: "Sam Okafor" }]);
    assert.deepEqual(await memberLinks(doc.id), [sam.userId]);
    const first = await docAlerts();
    assert.equal(first.length, 1);
    assert.deepEqual(first[0], {
      user_id: sam.userId,
      workspace_id: mark.workspaceId,
      title: "Mark tagged you in a doc",
      href: `/open?workspace=${mark.workspaceId}&to=${encodeURIComponent(`/docs/${doc.id}`)}`,
      source: "doc",
    });
    await saveDoc(mark, doc.id, { content: `Agenda led by ${tag(sam, "Sam Okafor")}, more text` }, PROVENANCE);
    await saveDoc(mark, doc.id, { content: `Agenda led by ${tag(sam, "Sam Okafor")}, more text and more` }, PROVENANCE);
    assert.equal((await docAlerts()).length, 1);
    await saveDoc(mark, doc.id, { content: `Agenda led by ${tag(sam, "Sam Okafor")} with ${tag(priya, "Priya Shah")}` }, PROVENANCE);
    const second = await docAlerts();
    assert.deepEqual(
      second.map((row) => row.user_id),
      [sam.userId, priya.userId],
    );
  });

  it("does not alert again on repeated live saves", async () => {
    const doc = await createDoc(mark, { title: "Live shared", content: "Notes", shared: true }, PROVENANCE);
    const local = createLiveDoc((await openLiveDoc(mark, doc.id)).state);
    for (const typed of [` ${tag(sam, "Sam")}`, " and", " more", " text"]) {
      const vector = Y.encodeStateVector(local);
      liveText(local).insert(liveText(local).length, typed);
      const result = await syncLiveDoc(mark, doc.id, { update: Y.encodeStateAsUpdate(local, vector), vector: Y.encodeStateVector(local) });
      Y.applyUpdate(local, result.missing);
    }
    assert.equal((await getDoc(mark, doc.id)).content, `Notes ${tag(sam, "Sam")} and more text`);
    assert.deepEqual(
      (await docAlerts()).map((row) => row.user_id),
      [sam.userId],
    );
  });

  it("does not alert twice in a day when a tag is removed and added back", async () => {
    const doc = await createDoc(mark, { title: "Back and forth", content: tag(sam, "Sam"), shared: true }, PROVENANCE);
    await saveDoc(mark, doc.id, { content: "Nobody" }, PROVENANCE);
    assert.deepEqual(await memberLinks(doc.id), []);
    await saveDoc(mark, doc.id, { content: tag(sam, "Sam") }, PROVENANCE);
    assert.equal((await docAlerts()).length, 1);
  });

  it("never tags yourself or people outside the doc's workspace", async () => {
    const doc = await createDoc(mark, { title: "Outside", content: `${tag(mark, "Mark")} ${tag(olly, "Olly")}`, shared: true }, PROVENANCE);
    assert.equal(doc.content, `${tag(mark, "Mark")} @Olly`);
    assert.deepEqual(await memberLinks(doc.id), [mark.userId]);
    assert.deepEqual(await docAlerts(), []);
  });

  it("alerts as the person for MCP, REST and the assistant", async () => {
    const doc = await createDoc(mark, { title: "Agents", content: "Start", shared: true }, PROVENANCE);
    const client = await mcp(mark);
    try {
      await client.call("update_doc", { id: doc.id, mode: "append", content: tag(sam, "Sam") });
    } finally {
      await client.close();
    }
    await patchDocFromBody(mark, doc.id, { append: tag(priya, "Priya") });
    const alerts = await docAlerts();
    assert.deepEqual(
      alerts.map((row) => [row.user_id, row.title]),
      [
        [sam.userId, "Mark tagged you in a doc"],
        [priya.userId, "Mark tagged you in a doc"],
      ],
    );
    const assisted = await runDocAction(sam, { action: "create", title: "Sam's", content: tag(priya, "Priya"), shared: true });
    assert.ok(assisted.doc);
    const after = await docAlerts();
    assert.equal(after.length, 3);
    assert.deepEqual([after[2].user_id, after[2].title], [priya.userId, "Sam tagged you in a doc"]);
  });

  it("alerts as the agent for a workspace agent token", async () => {
    const doc = await createDoc(agent, { title: "From an agent", content: `For ${tag(sam, "Sam")}` }, PROVENANCE);
    assert.deepEqual(await memberLinks(doc.id), [sam.userId]);
    const alerts = await docAlerts();
    assert.deepEqual(
      alerts.map((row) => [row.user_id, row.title, row.workspace_id]),
      [[sam.userId, "Claude Code tagged you in a doc", mark.workspaceId]],
    );
  });

  it("keeps tags in a private doc that sits in a shared folder", async () => {
    const folder = await createFolder(mark, { name: "Team", shared: true }, PROVENANCE);
    const doc = await createDoc(mark, { title: "In folder", content: tag(sam, "Sam"), folderId: folder.id }, PROVENANCE);
    assert.equal(doc.content, tag(sam, "Sam"));
    assert.equal((await docAlerts()).length, 1);
  });

  it("alerts again for a restored version only for people not already tagged", async () => {
    const doc = await createDoc(mark, { title: "Restore", content: tag(sam, "Sam"), shared: true }, PROVENANCE);
    await saveDoc(mark, doc.id, { content: "Cleared", overwrite: true }, PROVENANCE);
    const versions = await listVersions(mark, doc.id);
    const created = versions.find((version) => version.reason === "created")!;
    await restoreVersion(mark, doc.id, created.id, PROVENANCE);
    assert.deepEqual(await memberLinks(doc.id), [sam.userId]);
    assert.equal((await docAlerts()).length, 1);
  });
});

describe("sharing and tags", () => {
  it("shares then tags in one step without losing the alert", async () => {
    const doc = await createDoc(mark, { title: "Share and tag", content: "Draft agenda" }, PROVENANCE);
    const shared = await shareDoc(mark, doc.id, true, PROVENANCE);
    assert.equal(shared.doc.visibility, "shared");
    assert.deepEqual(await docAlerts(), []);
    await saveDoc(mark, doc.id, { content: `Draft agenda ${tag(sam, "Sam")}` }, PROVENANCE);
    assert.deepEqual(await memberLinks(doc.id), [sam.userId]);
    assert.deepEqual(
      (await docAlerts()).map((row) => row.user_id),
      [sam.userId],
    );
  });

  it("turns tags into plain text when a doc is made private", async () => {
    const doc = await createDoc(mark, { title: "Going private", content: `Owner ${tag(sam, "Sam")}`, shared: true }, PROVENANCE);
    const result = await shareDoc(mark, doc.id, false, PROVENANCE);
    assert.equal(result.doc.content, "Owner @Sam");
    assert.deepEqual(await memberLinks(doc.id), []);
    await shareDoc(mark, doc.id, true, PROVENANCE);
    assert.equal((await getDoc(mark, doc.id)).content, "Owner @Sam");
    assert.equal((await docAlerts()).length, 1);
  });

  it("turns tags into plain text when a doc leaves a shared folder or the folder is made private", async () => {
    const folder = await createFolder(mark, { name: "Shared folder", shared: true }, PROVENANCE);
    const moved = await createDoc(mark, { title: "Moving out", content: tag(sam, "Sam"), folderId: folder.id }, PROVENANCE);
    const staying = await createDoc(mark, { title: "Staying in", content: tag(priya, "Priya"), folderId: folder.id }, PROVENANCE);
    await moveDoc(mark, moved.id, { folderId: null, allowVisibilityChange: true }, PROVENANCE);
    assert.equal((await getDoc(mark, moved.id)).content, "@Sam");
    assert.equal((await getDoc(mark, staying.id)).content, tag(priya, "Priya"));
    await shareFolder(mark, folder.id, false, PROVENANCE);
    assert.equal((await getDoc(mark, staying.id)).content, "@Priya");
    assert.deepEqual(await memberLinks(staying.id), []);
  });
});

describe("teammates' notes in a folder that goes private", () => {
  it("turns every author's tags into text when a shared folder is made private", async () => {
    const folder = await createFolder(mark, { name: "Clients", shared: true }, PROVENANCE);
    const marks = await createDoc(mark, { title: "Mark's", content: tag(priya, "Priya"), folderId: folder.id }, PROVENANCE);
    const sams = await createDoc(sam, { title: "Sam's", content: `For ${tag(priya, "Priya")}`, folderId: folder.id }, PROVENANCE);
    const samShared = await createDoc(sam, { title: "Sam's shared", content: tag(priya, "Priya"), folderId: folder.id, shared: true }, PROVENANCE);
    const editedBefore = (await sql<{ edited_at: Date }>("select edited_at from crm.pages where id = $1", [sams.id])).rows[0].edited_at.getTime();
    await shareFolder(mark, folder.id, false, PROVENANCE);
    assert.equal((await getDoc(mark, marks.id)).content, "@Priya");
    await eventually(async () => (await getDoc(sam, sams.id)).content === "For @Priya", "Sam's note to lose its tag");
    assert.deepEqual(await memberLinks(sams.id), []);
    const versions = await listVersions(sam, sams.id);
    assert.equal(versions[0].summary, "Turned people tags into text because it's private");
    const editedAfter = (await sql<{ edited_at: Date }>("select edited_at from crm.pages where id = $1", [sams.id])).rows[0].edited_at.getTime();
    assert.equal(editedAfter, editedBefore);
    assert.equal((await getDoc(sam, samShared.id)).content, tag(priya, "Priya"));
    assert.deepEqual(await memberLinks(samShared.id), [priya.userId]);
  });

  it("does the same when a folder that was shared through its parent moves out to the top level", async () => {
    const top = await createFolder(mark, { name: "Shared top", shared: true }, PROVENANCE);
    const inner = await createFolder(mark, { name: "Inner", parentId: top.id }, PROVENANCE);
    const sams = await createDoc(sam, { title: "Sam's inner", content: `Ask ${tag(priya, "Priya")}`, folderId: inner.id }, PROVENANCE);
    assert.deepEqual(await memberLinks(sams.id), [priya.userId]);
    const result = await moveFolder(mark, inner.id, { parentId: null, allowVisibilityChange: true }, PROVENANCE);
    assert.equal(result.visibility.after, "private");
    await eventually(async () => (await getDoc(sam, sams.id)).content === "Ask @Priya", "Sam's inner note to lose its tag");
    assert.deepEqual(await memberLinks(sams.id), []);
  });
});

describe("folder cleanup edge cases", () => {
  it("cleans a note inside a third person's subfolder that moves out when the folder goes private", async () => {
    const folder = await createFolder(mark, { name: "Accounts", shared: true }, PROVENANCE);
    const priyas = await createFolder(priya, { name: "Priya's sub", parentId: folder.id }, PROVENANCE);
    const sams = await createDoc(sam, { title: "Sam in Priya's", content: `Ping ${tag(mark, "Mark")}`, folderId: priyas.id }, PROVENANCE);
    assert.deepEqual(await memberLinks(sams.id), [mark.userId]);
    await shareFolder(mark, folder.id, false, PROVENANCE);
    const moved = await sql<{ parent_id: string | null; effective_shared: boolean }>("select parent_id, effective_shared from crm.page_folders where id = $1", [priyas.id]);
    assert.deepEqual(moved.rows[0], { parent_id: null, effective_shared: false });
    await eventually(async () => (await getDoc(sam, sams.id)).content === "Ping @Mark", "Sam's note in Priya's subfolder to lose its tag");
  });

  it("leaves a folder that was shared again before the cleanup ran alone, and counts only cleaned pages", async () => {
    const folder = await createFolder(mark, { name: "Reshared", shared: true }, PROVENANCE);
    const sams = await createDoc(sam, { title: "Still shared", content: tag(priya, "Priya"), folderId: folder.id }, PROVENANCE);
    assert.equal(await untagFolderPages([folder.id]), 0);
    assert.equal((await getDoc(sam, sams.id)).content, tag(priya, "Priya"));
    await sql("update crm.page_folders set shared = false where id = $1", [folder.id]);
    assert.equal(await untagFolderPages([folder.id]), 1);
    assert.equal(await untagFolderPages([folder.id]), 0);
    assert.equal((await getDoc(sam, sams.id)).content, "@Priya");
  });

  it("leaves a former member's notes until someone takes them over, then turns their tags into text", async () => {
    const tomUser = await createUser("tom@doc-tags.test", "Tom Former");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, tomUser.userId]);
    const tom: UserActor = { ...tomUser, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" };
    const folder = await createFolder(mark, { name: "Handover", shared: true }, PROVENANCE);
    const toms = await createDoc(tom, { title: "Tom's", content: `For ${tag(sam, "Sam")}`, folderId: folder.id }, PROVENANCE);
    await sql("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, tom.userId]);
    await shareFolder(mark, folder.id, false, PROVENANCE);
    assert.equal(await untagFolderPages([folder.id]), 0);
    assert.deepEqual(await memberLinks(toms.id), [sam.userId]);
    await takeOverFormerMemberDocs(mark, tom.userId);
    assert.equal((await getDoc(mark, toms.id)).content, "For @Sam");
    assert.deepEqual(await memberLinks(toms.id), []);
  });
});

describe("who the picker offers people to", () => {
  it("counts member tags so the editor only adopts bodies where tags were removed", () => {
    assert.equal(memberTagCount(`a ${"@[Sam](member:00000000-0000-0000-0000-000000000000)"} b`), 1);
    assert.equal(memberTagCount("a @Sam b"), 0);
  });

  const owner = { id: "owner-id" };
  it("tags in shared notes, including ones shared by their folder, for everyone", () => {
    assert.equal(peopleTagMode({ kind: "note", shared: true, owner }, "owner-id"), "tag");
    assert.equal(peopleTagMode({ kind: "note", shared: true, owner }, "teammate-id"), "tag");
  });

  it("asks the owner to share a private note first", () => {
    assert.equal(peopleTagMode({ kind: "note", shared: false, owner }, "owner-id"), "share");
    assert.equal(peopleTagMode({ kind: "note", shared: false, owner }, "teammate-id"), "none");
    assert.equal(peopleTagMode({ kind: "note", shared: false, owner }, undefined), "none");
  });

  it("never tags in daily notes", () => {
    assert.equal(peopleTagMode({ kind: "daily", shared: false, owner }, "owner-id"), "none");
  });
});
