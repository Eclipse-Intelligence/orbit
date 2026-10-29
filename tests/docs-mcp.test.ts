import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createFolder } from "@/lib/docs/folders";
import { createDoc, getDoc } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, resetDatabase } from "./helpers";

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "docs-check", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      return { error: result.isError ? text : null, value: result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let mark: UserActor;
let agent: AgentActor;
let readOnly: AgentActor;

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-mcp.test", "Mark Ridgeon");
  agent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Claude Code")).actor;
  readOnly = (await createAgent(mark.workspaceId, ["crm:read", "docs:read"], "Reader")).actor;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("Docs over MCP", () => {
  it("gives personal tokens their own docs, shared docs and daily notes", async () => {
    const mcp = await connect(mark);
    try {
      const names = await mcp.names();
      for (const name of ["list_doc_folders", "list_docs", "search_docs", "read_doc", "create_doc", "update_doc", "rename_doc", "move_doc", "tag_doc", "share_doc", "archive_doc", "list_doc_versions", "restore_doc_version", "get_daily_note", "append_daily_note"]) {
        assert.ok(names.includes(name), name);
      }
      const folder = (await mcp.call("create_doc_folder", { name: "Clients" })).value!.folder as { id: string; visibility: string };
      assert.equal(folder.visibility, "private");
      const created = (await mcp.call("create_doc", { title: "Mark's MCP note", content: "Hello [[Other]] #clients/acme", folder_id: folder.id })).value!.doc as { id: string; visibility: string; tags: string[]; links: { title: string }[] };
      assert.equal(created.visibility, "private");
      assert.deepEqual(created.tags, ["clients/acme"]);
      const read = (await mcp.call("read_doc", { id: created.id })).value!;
      assert.equal(read.text, "Hello [[Other]] #clients/acme");
      assert.deepEqual((read.doc as { path: string[] }).path, ["Clients"]);
      const updated = (await mcp.call("update_doc", { id: created.id, mode: "edit", find: "Hello", replace: "Hi" })).value!;
      assert.deepEqual(updated.changed, { added: 1, removed: 1 });
      const stale = await mcp.call("update_doc", { id: created.id, mode: "append", content: "x", base_revision: 1 });
      assert.match(stale.error ?? "", /^conflict: This doc changed/);
      assert.match((await mcp.call("update_doc", { id: created.id, mode: "replace" })).error ?? "", /^invalid_input: Give content, the whole new text/);
      assert.equal((await getDoc(mark, created.id)).content, "Hi [[Other]] #clients/acme");
      assert.match((await mcp.call("read_doc", { id: created.id, offset: 1e12 })).error ?? "", /offset|too_big|Too big|less than/i);
      const versions = (await mcp.call("list_doc_versions", { id: created.id })).value!.versions as { id: string; reason: string; by: { editor: string; name: string; personName: string } }[];
      assert.deepEqual(versions.map((version) => version.reason), ["edited", "created"]);
      assert.equal(versions[0].by.name, "MCP");
      assert.equal(versions[0].by.personName, "Mark Ridgeon");
      await mcp.call("restore_doc_version", { id: created.id, version_id: versions[1].id });
      assert.equal((await getDoc(mark, created.id)).content, "Hello [[Other]] #clients/acme");
      const moved = await mcp.call("move_doc", { id: created.id, folder_id: null });
      assert.equal(moved.error, null);
      const tagged = (await mcp.call("tag_doc", { id: created.id, add: ["wins"], remove: ["clients/acme"] })).value!.doc as { tags: string[] };
      assert.deepEqual(tagged.tags, ["wins"]);
      assert.equal(((await mcp.call("rename_doc", { id: created.id, title: "Renamed note" })).value!.doc as { title: string }).title, "Renamed note");
      const shared = (await mcp.call("share_doc", { id: created.id, shared: true })).value!;
      assert.deepEqual(shared.visibility, { before: "private", after: "shared", changed: true });
      assert.equal(((await mcp.call("archive_doc", { id: created.id })).value!.doc as { archivedAt: string | null }).archivedAt !== null, true);
      assert.equal(((await mcp.call("archive_doc", { id: created.id, restore: true })).value!.doc as { archivedAt: string | null }).archivedAt, null);
      const daily = (await mcp.call("append_daily_note", { text: "Wrote from Claude" })).value!;
      assert.match(daily.text as string, /^\d{2}:\d{2} Wrote from Claude$/);
      const today = (await mcp.call("get_daily_note", {})).value!;
      assert.equal(today.isToday, true);
      assert.equal(((await mcp.call("get_daily_note", { list: true })).value!.days as unknown[]).length, 1);
      const hits = (await mcp.call("search_docs", { query: "renamed" })).value!.results as { title: string }[];
      assert.deepEqual(hits.map((hit) => hit.title), ["Renamed note"]);
      const listed = (await mcp.call("list_docs", { tag: "wins" })).value!.docs as { title: string }[];
      assert.deepEqual(listed.map((doc) => doc.title), ["Renamed note"]);
      const folders = (await mcp.call("list_doc_folders", {})).value!.folders as { name: string }[];
      assert.deepEqual(folders.map((entry) => entry.name), ["Clients"]);
    } finally {
      await mcp.close();
    }
  });

  it("gives workspace agent tokens shared docs only, never private docs or daily notes", async () => {
    const privateDoc = await createDoc(mark, { title: "Mark private" });
    const sharedDoc = await createDoc(mark, { title: "Team shared", content: "Start", shared: true });
    const mcp = await connect(agent);
    try {
      const names = await mcp.names();
      assert.ok(names.includes("read_doc"));
      assert.ok(!names.includes("get_daily_note") && !names.includes("append_daily_note"));
      const listed = ((await mcp.call("list_docs", {})).value!.docs as { title: string }[]).map((doc) => doc.title);
      assert.ok(listed.includes("Team shared"));
      assert.ok(!listed.includes("Mark private"));
      assert.match((await mcp.call("read_doc", { id: privateDoc.id })).error ?? "", /^not_found: That doc doesn't exist, or it's private to someone else/);
      assert.match((await mcp.call("update_doc", { id: privateDoc.id, mode: "append", content: "x" })).error ?? "", /^not_found/);
      assert.deepEqual(((await mcp.call("search_docs", { query: "Mark private" })).value!.results as unknown[]).length, 0);
      await mcp.call("update_doc", { id: sharedDoc.id, mode: "append", content: "From the agent" });
      const after = await getDoc(mark, sharedDoc.id);
      assert.equal(after.content, "Start\n\nFrom the agent");
      assert.equal(after.lastEditor?.name, "Claude Code");
      assert.match((await mcp.call("share_doc", { id: sharedDoc.id, shared: false })).error ?? "", /^forbidden: Only Mark Ridgeon can make this doc private/);
      const teamFolder = await createFolder(mark, { name: "Team", shared: true });
      const inFolder = await createDoc(mark, { title: "Shared by folder", folderId: teamFolder.id });
      assert.match((await mcp.call("move_doc", { id: inFolder.id, folder_id: null })).error ?? "", /^forbidden: That would make it private to Mark Ridgeon/);
      const made = (await mcp.call("create_doc", { title: "Agent research", content: "Findings" })).value!.doc as { id: string; visibility: string; owner: string | null };
      assert.deepEqual([made.visibility, made.owner], ["shared", null]);
      const events = await getAdminPool().query<{ actor_type: string; source: string }>("select actor_type, source from crm.audit_events where entity_id = $1", [made.id]);
      assert.deepEqual(events.rows, [{ actor_type: "agent", source: "mcp" }]);
    } finally {
      await mcp.close();
    }
  });

  it("respects the docs scopes", async () => {
    const mcp = await connect(readOnly);
    try {
      assert.equal((await mcp.call("list_docs", {})).error, null);
      assert.match((await mcp.call("create_doc", { title: "No" })).error ?? "", /^forbidden: Missing scope docs:write/);
    } finally {
      await mcp.close();
    }
    const blind = await connect((await createAgent(mark.workspaceId, ["crm:read"], "Blind")).actor);
    try {
      assert.match((await blind.call("list_docs", {})).error ?? "", /^forbidden: Missing scope docs:read/);
    } finally {
      await blind.close();
    }
  });
});
