import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import { describeAction, recordNames } from "@/lib/assistant/tools";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createFolder, folderSharing, listFolders, moveFolder, shareFolder } from "@/lib/docs/folders";
import { createDoc, getDoc, listVersions, renameDoc, saveDoc, shareDoc, updateDoc } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

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

async function queryAsAgent<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true), set_config('app.agent_id', $2, true), set_config('app.actor_type', 'agent', true)", [
      agent.workspaceId,
      agent.agentId,
    ]);
    await client.query("set local role crm_agent");
    return (await client.query<T>(text, values)).rows;
  } finally {
    try {
      await client.query("rollback");
    } catch {
      return [];
    }
    client.release();
  }
}

async function connect(actor: UserActor | AgentActor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "docs-sharing", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { error: result.isError ? (result.content[0]?.text ?? "") : null };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const admin = () => getAdminPool();

async function flags(table: "pages" | "page_folders", id: string) {
  const result = await admin().query<{ shared: boolean; effective_shared: boolean; folder_id?: string | null; parent_id?: string | null }>(
    `select shared, effective_shared, ${table === "pages" ? "folder_id" : "parent_id"} from crm.${table} where id = $1`,
    [id],
  );
  return result.rows[0];
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-sharing.test", "Mark Ridgeon");
  priya = await member("priya@docs-sharing.test", "Priya Shah");
  const created = await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Docs agent");
  agent = created.actor;
  token = created.token;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("who can change sharing", () => {
  useServerlessPool();

  it("lets only the owner change a note or folder's own sharing, on every route", async () => {
    const team = await createFolder(mark, { name: "Team space", shared: true });
    const note = await createDoc(mark, { title: "Mark's draft", content: "Draft", folderId: team.id });
    const sub = await createFolder(mark, { name: "Mark's corner", parentId: team.id });
    assert.equal(note.visibility, "shared_by_folder");
    assert.equal(sub.visibility, "shared_by_folder");

    await assert.rejects(shareDoc(priya, note.id, true), /Only Mark Ridgeon can share this note/);
    await assert.rejects(shareFolder(priya, sub.id, true), /Only Mark Ridgeon can share this folder/);
    await assert.rejects(updateDoc(priya, note.id, { shared: true }), /Only Mark Ridgeon can share this note/);
    await assert.rejects(shareDoc(agent, note.id, true), /Only Mark Ridgeon can share this note/);
    await assert.rejects(shareFolder(agent, sub.id, true), /Only Mark Ridgeon can share this folder/);

    const rest = await patchRoute(
      new Request(`http://crm.test/api/v1/docs/${note.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ shared: true }),
      }),
      { params: Promise.resolve({ id: note.id }) },
    );
    assert.equal(rest.status, 403);

    const mcp = await connect(agent);
    try {
      assert.match((await mcp.call("share_doc", { id: note.id, shared: true })).error ?? "", /Only Mark Ridgeon can share this note/);
    } finally {
      await mcp.close();
    }

    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set shared = true where id = $1", [note.id]), /Only the owner can change who can see this doc/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.page_folders set shared = true where id = $1", [sub.id]), /Only the owner can change who can see this folder/);
    await assert.rejects(queryAsAgent("update crm.pages set shared = true where id = $1", [note.id]), /Only the owner can change who can see this doc/);
    await assert.rejects(queryAsAgent("update crm.page_folders set shared = true where id = $1", [sub.id]), /Only the owner can change who can see this folder/);

    assert.equal((await flags("pages", note.id)).shared, false);
    assert.equal((await flags("page_folders", sub.id)).shared, false);

    await shareFolder(mark, team.id, false);
    assert.equal((await getDoc(mark, note.id)).visibility, "private");
    await assert.rejects(getDoc(priya, note.id), /doesn't exist|private/);
    assert.equal((await listFolders(priya)).some((folder) => folder.id === sub.id), false);
  });

  it("keeps an ownerless item shared, and lets only the owner change what a person owns", async () => {
    const agentDoc = await createDoc(agent, { title: "Agent report" });
    const agentFolder = await createFolder(agent, { name: "Agent output" });
    assert.equal(agentDoc.visibility, "shared");
    assert.equal((await shareDoc(priya, agentDoc.id, true)).doc.visibility, "shared");
    assert.equal((await shareFolder(priya, agentFolder.id, true)).folder.visibility, "shared");
    await assert.rejects(shareDoc(priya, agentDoc.id, false), /no owner/);
    await assert.rejects(shareFolder(priya, agentFolder.id, false), /no owner/);

    const own = await createDoc(priya, { title: "Priya's own" });
    assert.equal((await shareDoc(priya, own.id, true)).doc.visibility, "shared");
    await assert.rejects(shareDoc(mark, own.id, false), /Only Priya Shah can make this note private/);
    assert.equal((await shareDoc(priya, own.id, false)).doc.visibility, "private");
  });

  it("counts subfolders that are shared on their own when a folder goes private", async () => {
    const parent = await createFolder(mark, { name: "Counted parent", shared: true });
    await createFolder(mark, { name: "Shared child", parentId: parent.id, shared: true });
    await createFolder(mark, { name: "Plain child", parentId: parent.id });
    await createDoc(mark, { title: "Shared own note", folderId: parent.id, shared: true });
    const counts = await folderSharing(mark, parent.id);
    assert.equal(counts.folders, 2);
    assert.equal(counts.sharedOnTheirOwn, 2);
  });
});

describe("a folder that stops being shared", () => {
  useServerlessPool();

  it("takes other people's private notes out of it, so sharing it again never shares them", async () => {
    const team = await createFolder(mark, { name: "Reshared", shared: true });
    const inner = await createFolder(mark, { name: "Reshared inner", parentId: team.id });
    const theirs = await createDoc(priya, { title: "Priya inside", folderId: team.id });
    const theirsDeep = await createDoc(priya, { title: "Priya deep", folderId: inner.id });
    const theirsShared = await createDoc(priya, { title: "Priya shared on her own", folderId: team.id, shared: true });
    const mine = await createDoc(mark, { title: "Mark inside", folderId: team.id });

    await shareFolder(mark, team.id, false);
    assert.equal((await flags("pages", theirs.id)).folder_id, null);
    assert.equal((await flags("pages", theirsDeep.id)).folder_id, null);
    assert.equal((await flags("pages", theirsShared.id)).folder_id, team.id);
    assert.equal((await flags("pages", mine.id)).folder_id, team.id);

    await shareFolder(mark, team.id, true);
    for (const id of [theirs.id, theirsDeep.id]) {
      const row = await flags("pages", id);
      assert.deepEqual([row.shared, row.effective_shared], [false, false]);
      await assert.rejects(getDoc(mark, id), /doesn't exist|private/);
    }
    assert.equal((await getDoc(mark, theirsShared.id)).visibility, "shared");

    const sharedParent = await createFolder(mark, { name: "Shared parent", shared: true });
    const other = await createFolder(mark, { name: "Moved out later", parentId: sharedParent.id });
    const placed = await createDoc(priya, { title: "Priya in moved", folderId: other.id });
    const holder = await createFolder(mark, { name: "Private holder" });
    await moveFolder(mark, other.id, { parentId: holder.id, allowVisibilityChange: true });
    assert.equal((await flags("pages", placed.id)).folder_id, null);
    await moveFolder(mark, other.id, { parentId: sharedParent.id, allowVisibilityChange: true });
    assert.equal((await flags("pages", placed.id)).effective_shared, false);
  });
});

describe("renaming a private note", () => {
  useServerlessPool();

  it("never writes its new title into a page someone else can read", async () => {
    const secret = await createDoc(mark, { title: "Quiet plan", content: "Private" });
    const sharedLinker = await createDoc(mark, { title: "Team page", content: "See [[Quiet plan]] for details", shared: true });
    const privateLinker = await createDoc(mark, { title: "My page", content: "Also [[Quiet plan]]" });
    assert.match((await getDoc(priya, sharedLinker.id)).content, /\[\[Quiet plan\]\]/);

    await renameDoc(mark, secret.id, "Layoff list");

    const shared = await getAdminPool().query<{ content: string }>("select content from crm.pages where id = $1", [sharedLinker.id]);
    assert.doesNotMatch(shared.rows[0].content, /Layoff list/);
    assert.match(shared.rows[0].content, /Quiet plan/);
    const versions = await getAdminPool().query<{ summary: string | null; title: string; content: string }>("select summary, title, content from crm.page_versions where page_id = $1", [sharedLinker.id]);
    for (const version of versions.rows) assert.doesNotMatch(`${version.summary} ${version.title} ${version.content}`, /Layoff list/);
    const audit = await getAdminPool().query<{ payload: unknown }>("select a.changes as payload from crm.audit_events a where a.entity_id = $1", [sharedLinker.id]);
    for (const row of audit.rows) assert.doesNotMatch(JSON.stringify(row.payload), /Layoff list/);
    const links = await getAdminPool().query<{ target_page_id: string | null }>("select target_page_id from crm.page_links where page_id = $1 and target_kind = 'page'", [sharedLinker.id]);
    assert.equal(links.rows[0].target_page_id, secret.id);

    const mine = await getAdminPool().query<{ content: string }>("select content from crm.pages where id = $1", [privateLinker.id]);
    assert.match(mine.rows[0].content, /\[\[Layoff list\]\]/);
    assert.equal((await listVersions(mark, privateLinker.id)).some((version) => /Layoff list/.test(version.summary ?? "")), true);

    const again = await saveDoc(mark, sharedLinker.id, { content: "See [[Quiet plan]] for details, again" });
    assert.doesNotMatch(again.content, /Layoff list/);

    await shareDoc(mark, secret.id, true);
    await renameDoc(mark, secret.id, "Open plan");
    const opened = await getAdminPool().query<{ content: string }>("select content from crm.pages where id = $1", [sharedLinker.id]);
    assert.match(opened.rows[0].content, /\[\[Open plan\]\]/);
  });
});

describe("the assistant's rename card", () => {
  useServerlessPool();

  it("counts only the notes a rename will rewrite", async () => {
    const secret = await createDoc(mark, { title: "Card secret", content: "Private" });
    await createDoc(mark, { title: "Card shared linker", content: "See [[Card secret]]", shared: true });
    await createDoc(mark, { title: "Card private linker one", content: "And [[Card secret]]" });
    await createDoc(mark, { title: "Card private linker two", content: "Also [[Card secret]]" });
    const args = { action: "rename", docId: secret.id, title: "Card renamed" };
    const privateCard = describeAction("save_doc", args, await recordNames(mark, [args], ["save_doc"]));
    assert.ok(privateCard.lines.includes("Updates links in 2 notes."), privateCard.lines.join(" | "));
    await shareDoc(mark, secret.id, true);
    const sharedCard = describeAction("save_doc", args, await recordNames(mark, [args], ["save_doc"]));
    assert.ok(sharedCard.lines.includes("Updates links in 3 notes."), sharedCard.lines.join(" | "));
    const result = await renameDoc(mark, secret.id, "Card renamed");
    assert.equal(result.linksUpdated, 3);
  });
});

describe("moving folders at the same time", () => {
  it("never lets two moves form a loop", async () => {
    const left = await createFolder(mark, { name: "Loop left", shared: true });
    const right = await createFolder(mark, { name: "Loop right", shared: true });
    const first = await getAdminPool().connect();
    const second = await getAdminPool().connect();
    try {
      await first.query("begin");
      await second.query("begin");
      await first.query("update crm.page_folders set parent_id = $2 where id = $1", [left.id, right.id]);
      const racing = second.query("update crm.page_folders set parent_id = $2 where id = $1", [right.id, left.id]).then(
        () => "moved",
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("commit");
      const outcome = await racing;
      await second.query(outcome === "moved" ? "commit" : "rollback");
      assert.match(outcome, /A folder can't go inside itself/);
    } finally {
      first.release();
      second.release();
    }
    const rows = await getAdminPool().query<{ id: string; parent_id: string | null }>("select id, parent_id from crm.page_folders where id = any($1)", [[left.id, right.id]]);
    const parent = new Map(rows.rows.map((row) => [row.id, row.parent_id]));
    assert.ok(parent.get(left.id) === null || parent.get(right.id) === null);
    assert.equal((await listFolders(mark)).length > 0, true);
  });
});

describe("moving a folder and its parent at the same time", () => {
  it("lets both moves finish, whichever one reaches the database first", async () => {
    const root = await createFolder(mark, { name: "Order root", shared: true });
    const parent = await createFolder(mark, { name: "Order parent", parentId: root.id });
    const child = await createFolder(mark, { name: "Order child", parentId: parent.id });
    const target = await createFolder(mark, { name: "Order target", shared: true });
    const holder = await createFolder(mark, { name: "Order holder" });
    const blocker = await getAdminPool().connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('page_folders:' || $1::text, 0))", [mark.workspaceId]);
      const outcome = (promise: Promise<unknown>) => promise.then(() => "moved", (error: Error) => error.message);
      const parentMove = outcome(moveFolder(mark, parent.id, { parentId: holder.id, allowVisibilityChange: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const childMove = outcome(moveFolder(mark, child.id, { parentId: target.id, allowVisibilityChange: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      await blocker.query("commit");
      assert.deepEqual(await Promise.all([parentMove, childMove]), ["moved", "moved"]);
    } finally {
      blocker.release();
    }
    assert.equal((await flags("page_folders", child.id)).parent_id, target.id);
    assert.equal((await flags("page_folders", parent.id)).parent_id, holder.id);
  });
});

describe("folders whose parent is hidden", () => {
  it("says so, so the client can offer Top level", async () => {
    const root = await createFolder(mark, { name: "Hidden root" });
    const child = await createFolder(mark, { name: "Visible child", parentId: root.id, shared: true });
    const seen = (await listFolders(priya)).find((folder) => folder.id === child.id);
    assert.equal(seen?.parentId, null);
    assert.equal(seen?.parentHidden, true);
    assert.equal((await listFolders(mark)).find((folder) => folder.id === child.id)?.parentHidden, false);
    const moved = await moveFolder(priya, child.id, { parentId: null, allowVisibilityChange: true });
    assert.equal(moved.folder.parentId, null);
    assert.equal((await flags("page_folders", child.id)).parent_id, null);
  });
});
