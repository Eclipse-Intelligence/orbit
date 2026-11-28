import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { scopesForRole } from "@/lib/crm/scopes";
import { removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { appendToDailyNote, getDailyNote } from "@/lib/docs/daily-notes";
import { getDoc, listVersions, saveDoc } from "@/lib/docs/store";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const CHILD_TABLES = ["page_versions", "page_tags", "page_links", "page_watchers"] as const;

let mark: UserActor;
let leaver: UserActor;
let leaverElsewhere: UserActor;

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@daily-removal.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('lee@daily-removal.test', 'password-123', 'Lee Leaver') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  leaver = { ...mark, userId: id, email: "lee@daily-removal.test", fullName: "Lee Leaver", role: "member", scopes: scopesForRole("member") };
  const created = await createWorkspace(mark, { name: "Lee's other workspace" });
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [created.id, id]);
  leaverElsewhere = { ...leaver, workspaceId: created.id, workspaceName: "Lee's other workspace" };
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

async function childWorkspaces(pageId: string) {
  const out: Record<string, string[]> = {};
  for (const table of CHILD_TABLES) {
    const rows = await getAdminPool().query<{ workspace_id: string }>(`select workspace_id from crm.${table} where page_id = $1`, [pageId]);
    out[table] = [...new Set(rows.rows.map((row) => row.workspace_id))];
  }
  return out;
}

describe("a leaver's daily notes", () => {
  useServerlessPool();

  it("keep their history, tags and links in the workspace they move to when they are removed from the one that held them", async () => {
    const admin = getAdminPool();
    const day = "2026-11-10";
    const first = await appendToDailyNote(leaver, { text: "Prep #northwind with [[Anything]]", date: day, now: new Date("2026-11-10T08:00:00Z") });
    await appendToDailyNote(leaver, { text: "Call went well", date: day, now: new Date("2026-11-10T09:00:00Z") });
    await admin.query("insert into crm.page_watchers (page_id, user_id, workspace_id) values ($1, $2, $3) on conflict do nothing", [first.page.id, leaver.userId, mark.workspaceId]);
    const before = await childWorkspaces(first.page.id);
    for (const table of ["page_versions", "page_tags", "page_links", "page_watchers"] as const) assert.deepEqual(before[table], [mark.workspaceId], table);
    const versionsBefore = (await listVersions(leaver, first.page.id)).length;
    assert.ok(versionsBefore >= 1);

    await removeMember(mark, leaver.userId);

    const after = await childWorkspaces(first.page.id);
    for (const table of CHILD_TABLES) assert.deepEqual(after[table], [leaverElsewhere.workspaceId], `${table} stayed behind`);
    const moved = await getDailyNote(leaverElsewhere, day);
    assert.equal(moved?.page.id, first.page.id);
    assert.deepEqual(moved?.page.tags, ["northwind"]);
    assert.equal((await listVersions(leaverElsewhere, first.page.id)).length, versionsBefore);

    await saveDoc(leaverElsewhere, first.page.id, { content: "09:00 Call went well, now about #acme" });
    assert.deepEqual((await getDoc(leaverElsewhere, first.page.id)).tags, ["acme"]);
    const after2 = await childWorkspaces(first.page.id);
    assert.deepEqual(after2.page_tags, [leaverElsewhere.workspaceId]);
  });

  it("repairs history already left behind by an earlier removal", async () => {
    const admin = getAdminPool();
    const row = await admin.query<{ id: string; workspace_id: string }>("select id, workspace_id from crm.pages where kind = 'daily' and user_id = $1 limit 1", [leaver.userId]);
    const page = row.rows[0];
    await admin.query("update crm.page_tags set workspace_id = $2 where page_id = $1", [page.id, mark.workspaceId]);
    await admin.query("update crm.page_versions set workspace_id = $2 where page_id = $1", [page.id, mark.workspaceId]);
    const { readFileSync } = await import("node:fs");
    const { applyMigrationSql } = await import("@/lib/db/migration-sql");
    await applyMigrationSql(admin, readFileSync("supabase/migrations/20270316400000_move_daily_note_history.sql", "utf8"));
    const repaired = await childWorkspaces(page.id);
    assert.deepEqual(repaired.page_tags, [page.workspace_id]);
    assert.deepEqual(repaired.page_versions, [page.workspace_id]);
  });
});
