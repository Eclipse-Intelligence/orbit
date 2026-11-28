import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DELETE as restDelete, PATCH as restResolve } from "@/app/api/v1/docs/[id]/comments/[commentId]/route";
import { POST as restReply } from "@/app/api/v1/docs/[id]/comments/[commentId]/replies/route";
import { DELETE as archiveRoute, GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import { GET as foldersRoute } from "@/app/api/v1/docs/folders/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/docs/route";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createFolder } from "@/lib/docs/folders";
import { createDoc, getDoc } from "@/lib/docs/store";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let token = "";
let blindToken = "";

function request(path: string, method = "GET", body?: unknown, bearer = token) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-api.test", "Mark Ridgeon");
  token = (await createAgent(mark.workspaceId, ["docs:read", "docs:write"], "API agent")).token;
  blindToken = (await createAgent(mark.workspaceId, ["crm:read"], "Blind")).token;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("Docs REST API", () => {
  it("lists, searches, creates, reads, changes and archives shared docs only", async () => {
    await createDoc(mark, { title: "Mark private" });
    const folder = await createFolder(mark, { name: "Team", shared: true });
    const plan = await createDoc(mark, { title: "Team plan", content: "Plan #q4", folderId: folder.id });

    const listed = (await (await listRoute(request("/docs"))).json()) as { data: { title: string }[] };
    assert.deepEqual(listed.data.map((doc) => doc.title), ["Team plan"]);
    const searched = (await (await listRoute(request("/docs?q=team"))).json()) as { data: { title: string }[] };
    assert.deepEqual(searched.data.map((doc) => doc.title), ["Team plan"]);
    const folders = (await (await foldersRoute(request("/docs/folders"))).json()) as { folders: { name: string }[] };
    assert.deepEqual(folders.folders.map((entry) => entry.name), ["Team"]);

    const created = await createRoute(request("/docs", "POST", { title: "From the API", content: "One", folderId: folder.id, provenance: { sourceUrl: "https://example.test" } }));
    assert.equal(created.status, 201);
    const doc = ((await created.json()) as { doc: { id: string; visibility: string; owner: { name: string } | null; createdByAgent: { name: string } | null } }).doc;
    assert.equal(doc.visibility, "shared");
    assert.equal(doc.owner, null);
    assert.equal(doc.createdByAgent?.name, "API agent");

    const patched = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { title: "From the API, renamed", append: "Two", find: "One", replace: "Uno" }), params(doc.id));
    assert.equal(patched.status, 200);
    assert.equal((await getDoc(mark, doc.id)).content, "Uno\n\nTwo");
    assert.equal((await getDoc(mark, doc.id)).title, "From the API, renamed");

    const refused = await patchRoute(request(`/docs/${plan.id}`, "PATCH", { folderId: null }), params(plan.id));
    assert.equal(refused.status, 403);
    const movedOut = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { folderId: null }), params(doc.id));
    assert.equal(movedOut.status, 200);
    const unknown = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { colour: "red" }), params(doc.id));
    assert.equal(unknown.status, 400);

    const read = (await (await readRoute(request(`/docs/${doc.id}`), params(doc.id))).json()) as { text: string; doc: Record<string, unknown> };
    assert.equal(read.text, "Uno\n\nTwo");
    assert.equal("content" in read.doc, false);
    const archived = (await (await archiveRoute(request(`/docs/${doc.id}`, "DELETE"), params(doc.id))).json()) as { doc: { archivedAt: string | null } };
    assert.ok(archived.doc.archivedAt);

    const blind = await listRoute(request("/docs", "GET", undefined, blindToken));
    assert.equal(blind.status, 403);
  });

  it("applies find and replace before append, as documented, so appended text stays as sent", async () => {
    const folder = await createFolder(mark, { name: "Order", shared: true });
    const doc = await createDoc(mark, { title: "Order of edits", content: "Draft plan", folderId: folder.id });
    const patched = await patchRoute(
      request(`/docs/${doc.id}`, "PATCH", { find: "Draft", replace: "Final", all: true, append: "Draft notes follow" }),
      params(doc.id),
    );
    assert.equal(patched.status, 200);
    assert.equal((await getDoc(mark, doc.id)).content, "Final plan\n\nDraft notes follow");

    const missing = await patchRoute(request(`/docs/${doc.id}`, "PATCH", { find: "Later", replace: "Now", append: "Later" }), params(doc.id));
    assert.equal(missing.status, 400);
    assert.equal((await getDoc(mark, doc.id)).content, "Final plan\n\nDraft notes follow");

    const badOffset = await readRoute(request(`/docs/${doc.id}?offset=1.5`), params(doc.id));
    assert.equal(badOffset.status, 400);
    const badLimit = await listRoute(request("/docs?limit=ten"));
    assert.equal(badLimit.status, 400);
  });
});

describe("Docs REST API provenance", () => {
  const RESERVED = ["assistant", "web", " Email ", "clickup", "mcp"];

  it("never lets an agent label a doc write with a source Orbit reserves for itself", async () => {
    const folder = await createFolder(mark, { name: "Provenance", shared: true });
    const doc = await createDoc(mark, { title: "Provenance doc", content: "Body", folderId: folder.id });
    const comment = (
      await getAdminPool().query<{ id: string }>(
        "insert into crm.page_comments (workspace_id, page_id, author_name, body) values ($1, $2, 'Rae', 'Hello') returning id",
        [mark.workspaceId, doc.id],
      )
    ).rows[0].id;
    const created: string[] = [];
    for (const source of RESERVED) {
      const made = await createRoute(request("/docs", "POST", { title: `Made as ${source.trim()}`, folderId: folder.id, provenance: { source } }));
      assert.equal(made.status, 201);
      created.push(((await made.json()) as { doc: { id: string } }).doc.id);
      assert.equal((await patchRoute(request(`/docs/${doc.id}`, "PATCH", { append: `as ${source}`, provenance: { source } }), params(doc.id))).status, 200);
      assert.equal((await restReply(request(`/docs/${doc.id}/comments/${comment}/replies`, "POST", { body: "Reply", provenance: { source } }), { params: Promise.resolve({ id: doc.id, commentId: comment }) })).status, 201);
      assert.equal((await restResolve(request(`/docs/${doc.id}/comments/${comment}`, "PATCH", { resolved: source === RESERVED[0], provenance: { source } }), { params: Promise.resolve({ id: doc.id, commentId: comment }) })).status, 200);
    }
    const kept = await createRoute(request("/docs", "POST", { title: "Own source", folderId: folder.id, provenance: { source: "research-agent" } }));
    created.push(((await kept.json()) as { doc: { id: string } }).doc.id);
    const events = await getAdminPool().query<{ source: string | null }>(
      "select source from crm.audit_events where entity_id = any($1::uuid[]) and event_type like 'page%' and actor_agent_id is not null",
      [[doc.id, ...created]],
    );
    const sources = events.rows.map((row) => (row.source ?? "").trim().toLowerCase());
    for (const reserved of ["assistant", "web", "email", "clickup", "mcp"]) assert.ok(!sources.includes(reserved), `${reserved} reached the audit log`);
    assert.ok(sources.includes("research-agent"));
    await restDelete(request(`/docs/${doc.id}/comments/${comment}`, "DELETE", { provenance: { source: "assistant" } }), { params: Promise.resolve({ id: doc.id, commentId: comment }) });
    const deleted = await getAdminPool().query<{ source: string | null }>("select source from crm.audit_events where entity_id = $1 and event_type = 'page.comment_deleted'", [doc.id]);
    assert.ok(deleted.rows.every((row) => row.source !== "assistant"));
  });
});
