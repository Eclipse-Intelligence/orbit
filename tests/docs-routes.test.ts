import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { Backlinks, DocsNav, Folder, Page, PageSummary, SearchHit, SearchResults } from "@/lib/docs/client-types";
import { localDate } from "@/lib/docs/daily";
import { docsAction, docsChanges, docsReads, docsRespond, docsWrites, type DocsCall } from "@/lib/docs/http";
import { loadDocsInitial } from "@/lib/docs/server";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;

async function member(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member" as const, scopes: scopesForRole("member") };
}

type Read = (call: DocsCall) => Promise<unknown>;

async function call(actor: UserActor | null, handler: Read, options: { path?: string; params?: Record<string, string>; method?: string; body?: unknown } = {}) {
  const request = new Request(`http://crm.test/api/docs${options.path ?? ""}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const response = await docsRespond(actor, (signedIn) => handler({ actor: signedIn, request, params: options.params ?? {} }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & unknown };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-routes.test", "Mark Ridgeon");
  priya = await member("priya@docs-routes.test", "Priya Shah");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("Docs route handlers", () => {
  it("refuses requests without a session", async () => {
    const response = await call(null, docsReads.nav);
    assert.equal(response.status, 401);
    assert.match(String(response.body.error), /Sign in again/);
  });

  it("starts empty for a first-time user, with today's daily note ready", async () => {
    const nav = (await call(mark, docsReads.nav)).body as unknown as DocsNav;
    assert.deepEqual(nav.folders, []);
    assert.deepEqual(nav.tags, []);
    assert.equal(nav.dailyCount, 0);
    assert.equal(nav.todayNote, null);
    assert.deepEqual((await call(mark, docsReads.list, { path: "/pages?list=all" })).body, []);
    const initial = await loadDocsInitial(mark, { list: { kind: "all" }, pageId: null, date: null, level: "home" });
    assert.deepEqual(initial, { list: { kind: "all" }, summaries: [], page: null });
  });

  it("keeps a private note private from teammates in every read", async () => {
    const secret = await docsChanges.create(mark, { title: "Salary thoughts", body: "Private plans for #pay with [[Shared plan]]" });
    const shared = await docsChanges.create(mark, { title: "Shared plan", body: "Everyone sees this. Salary thoughts are elsewhere." });
    await docsChanges.share(mark, { kind: "page", id: shared.id }, "shared");

    const own = await call(mark, docsReads.page, { params: { id: secret.id } });
    assert.equal(own.status, 200);
    assert.equal((own.body as unknown as Page).body, "Private plans for #pay with [[Shared plan]]");

    const blocked = await call(priya, docsReads.page, { params: { id: secret.id } });
    assert.equal(blocked.status, 404);
    assert.match(String(blocked.body.error), /private to someone else/);
    assert.equal((await call(priya, docsReads.versions, { params: { id: secret.id } })).status, 404);
    assert.equal((await call(priya, docsReads.backlinks, { params: { id: secret.id } })).status, 404);

    const save = await call(priya, docsWrites.save, { method: "PUT", params: { id: secret.id }, body: { title: "Mine now", body: "Taken", baseRevision: 1 } });
    assert.equal(save.status, 404);

    const list = (await call(priya, docsReads.list, { path: "/pages?list=all" })).body as unknown as PageSummary[];
    assert.deepEqual(list.map((page) => page.title), ["Shared plan"]);
    const search = (await call(priya, docsReads.search, { path: "/search?q=salary" })).body as unknown as SearchResults;
    assert.ok(![...search.titles, ...search.text.map((hit) => hit.page)].some((page) => page.id === secret.id));
    const titles = (await call(priya, docsReads.titles)).body as Record<string, string>;
    assert.equal(titles["salary thoughts"], undefined);
    assert.equal(titles["shared plan"], shared.id);
    const nav = (await call(priya, docsReads.nav)).body as unknown as DocsNav;
    assert.deepEqual(nav.tags, []);
    const backlinks = (await call(priya, docsReads.backlinks, { params: { id: shared.id } })).body as unknown as Backlinks;
    assert.deepEqual(backlinks.linked, []);
    const markLinks = (await call(mark, docsReads.backlinks, { params: { id: shared.id } })).body as unknown as Backlinks;
    assert.deepEqual(markLinks.linked.map((link) => link.title), ["Salary thoughts"]);
  });

  it("returns a conflict with the latest note when the base revision is stale", async () => {
    const page = await docsChanges.create(mark, { title: "Board prep", body: "First draft" });
    await docsChanges.share(mark, { kind: "page", id: page.id }, "shared");
    const priyaSave = await call(priya, docsWrites.save, { method: "PUT", params: { id: page.id }, body: { title: "Board prep", body: "Priya's draft", baseRevision: page.revision } });
    assert.equal(priyaSave.status, 200);
    const saved = (priyaSave.body as { page: Page }).page;
    assert.equal(saved.revision, page.revision + 1);
    assert.equal(saved.updatedBy.name, "Priya Shah");

    const stale = await call(mark, docsWrites.save, { method: "PUT", params: { id: page.id }, body: { title: "Board prep", body: "Mark's draft", baseRevision: page.revision } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "conflict");
    assert.match(String(stale.body.error), /changed this note while you were editing/);
    const latest = stale.body.page as Page;
    assert.equal(latest.body, "Priya's draft");
    assert.equal(latest.revision, saved.revision);

    const kept = await call(mark, docsWrites.save, { method: "PUT", params: { id: page.id }, body: { title: "Board prep", body: "Mark's draft", baseRevision: latest.revision, overwrite: true } });
    assert.equal(kept.status, 200);
    assert.equal((kept.body as { page: Page }).page.body, "Mark's draft");
    const versions = (await call(mark, docsReads.versions, { params: { id: page.id } })).body as unknown as { id: string; author: { name: string } }[];
    const bodies = await Promise.all(versions.map(async (version) => ((await call(mark, docsReads.version, { params: { id: page.id, versionId: version.id } })).body as { body: string }).body));
    assert.ok(bodies.includes("Priya's draft"));
  });

  it("asks before a move changes who can see a note or folder", async () => {
    const team = await docsChanges.createFolder(mark, "Team", null);
    await docsChanges.share(mark, { kind: "folder", id: team.id }, "shared");
    const note = await docsChanges.create(mark, { title: "Offsite ideas", body: "Quiet ideas" });

    const refused = await docsAction(mark, (actor) => docsChanges.move(actor, note.id, team.id, false));
    assert.equal(refused.error !== undefined && refused.code, "visibility_change");
    assert.ok(refused.error !== undefined && refused.details?.after !== "private");
    assert.match(String(refused.error), /shares it with everyone in the workspace/);
    assert.equal((await call(priya, docsReads.page, { params: { id: note.id } })).status, 404);

    const moved = await docsAction(mark, (actor) => docsChanges.move(actor, note.id, team.id, true));
    assert.ok(moved.error === undefined && moved.data.shared && moved.data.folderId === team.id);
    assert.equal((await call(priya, docsReads.page, { params: { id: note.id } })).status, 200);

    const back = await docsAction(mark, (actor) => docsChanges.move(actor, note.id, null, false));
    assert.ok(back.error !== undefined && back.code === "visibility_change" && back.details?.after === "private");

    const inner = await docsChanges.createFolder(mark, "Drafts", null);
    const folderMove = await docsAction(mark, (actor) => docsChanges.moveFolder(actor, inner.id, team.id, 0, false));
    assert.ok(folderMove.error !== undefined && folderMove.code === "visibility_change");
    const folders = await docsAction(mark, (actor) => docsChanges.moveFolder(actor, inner.id, team.id, 0, true));
    assert.ok(folders.error === undefined && (folders.data as Folder[]).find((folder) => folder.id === inner.id)?.shared);
  });

  it("rewrites links when a note is renamed", async () => {
    const target = await docsChanges.create(mark, { title: "Pricing", body: "Numbers" });
    const linking = await docsChanges.create(mark, { title: "Plan", body: "See [[Pricing]] for numbers." });
    const renamed = await docsAction(mark, (actor) => docsChanges.rename(actor, target.id, "Pricing 2027"));
    assert.ok(renamed.error === undefined && renamed.data.linksUpdated === 1);
    const after = (await call(mark, docsReads.page, { params: { id: linking.id } })).body as unknown as Page;
    assert.equal(after.body, "See [[Pricing 2027]] for numbers.");
  });

  it("lists notes that mention a record, and the record's details", async () => {
    const company = (await createCompany(mark, { name: "Acme Routes", domain: "acme-routes.test" })).body.company;
    const note = await docsChanges.create(mark, { title: "Acme call", body: `Spoke to @[Acme Routes](company:${company.id}) today.` });
    const hits = (await call(mark, docsReads.mentioning, { path: `/mentioning?kind=company&id=${company.id}` })).body as unknown as SearchHit[];
    assert.deepEqual(hits.map((hit) => hit.page.id), [note.id]);
    assert.deepEqual((await call(priya, docsReads.mentioning, { path: `/mentioning?kind=company&id=${company.id}` })).body, []);
    const records = (await call(mark, docsReads.records, { path: `/records?refs=company:${company.id}` })).body as unknown as { name: string }[];
    assert.equal(records[0].name, "Acme Routes");
  });

  it("opens daily notes privately and counts their entries", async () => {
    const opened = await call(mark, docsWrites.openDaily, { method: "POST", params: { date: "2026-10-20" } });
    assert.equal(opened.status, 200);
    const page = opened.body as unknown as Page;
    assert.equal(page.kind, "daily");
    const saved = await call(mark, docsWrites.save, { method: "PUT", params: { id: page.id }, body: { body: "09:10 Coffee\n\n10:00\n- Standup", baseRevision: page.revision } });
    assert.equal(saved.status, 200);
    const days = (await call(mark, docsReads.daily)).body as unknown as { date: string; entries: number }[];
    assert.deepEqual(days.map((day) => [day.date, day.entries]), [["2026-10-20", 2]]);
    assert.equal((await call(priya, docsReads.page, { params: { id: page.id } })).status, 404);
    assert.equal((await call(mark, docsWrites.openDaily, { method: "POST", params: { date: "2026-02-31" } })).status, 400);
    const today = (await call(mark, docsWrites.openDaily, { method: "POST", params: { date: localDate() } })).body as unknown as Page;
    await call(mark, docsWrites.save, { method: "PUT", params: { id: today.id }, body: { body: "08:30 Gym", baseRevision: today.revision } });
    const nav = (await call(mark, docsReads.nav)).body as unknown as DocsNav;
    assert.deepEqual([nav.dailyCount, nav.todayNote?.entries, nav.todayNote?.preview], [2, 1, "Gym"]);
  });
});
