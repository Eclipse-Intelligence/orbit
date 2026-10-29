import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { docsChanges } from "@/lib/docs/http";
import { docsMentions } from "@/lib/docs/view";
import { createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let priya: UserActor;

async function member(email: string, name: string) {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  return { ...mark, userId: id, email, fullName: name, role: "member" as const, scopes: scopesForRole("member") };
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-record-notes.test", "Mark Ridgeon");
  priya = await member("priya@docs-record-notes.test", "Priya Shah");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("Notes on records", () => {
  it("lists notes that mention a task, newest first, with who edited them", async () => {
    const task = (await createTask(mark, { title: "Send the proposal" })).body.task;
    const first = await docsChanges.create(mark, { title: "Prep", body: `Before @[Send the proposal](task:${task.id}) check pricing.` });
    const second = await docsChanges.create(mark, { title: "Follow up", body: `| Step | Owner |\n|---|---|\n| @[Send the proposal](task:${task.id}) | Mark |` });
    const hits = await docsMentions(mark, { kind: "task", id: task.id });
    assert.deepEqual(
      hits.map((hit) => hit.page.id),
      [second.id, first.id],
    );
    assert.equal(hits[0].page.updatedBy.name, "Mark Ridgeon");
    assert.equal(hits[0].page.shared, false);
    assert.doesNotMatch(hits[0].snippet, /\|/);
  });

  it("shows other people only the notes they can see", async () => {
    const company = (await createCompany(mark, { name: "Globex Notes", domain: "globex-notes.test" })).body.company;
    const mention = `@[Globex Notes](company:${company.id})`;
    const hidden = await docsChanges.create(mark, { title: "Private thoughts", body: `${mention} is slow to reply.` });
    const open = await docsChanges.create(mark, { title: "Team brief", body: `${mention} kick-off.` });
    await docsChanges.share(mark, { kind: "page", id: open.id }, "shared");
    const mine = await docsMentions(mark, { kind: "company", id: company.id });
    assert.deepEqual(new Set(mine.map((hit) => hit.page.id)), new Set([hidden.id, open.id]));
    const theirs = await docsMentions(priya, { kind: "company", id: company.id });
    assert.deepEqual(
      theirs.map((hit) => hit.page.id),
      [open.id],
    );
    assert.equal(theirs[0].page.shared, true);
  });

  it("returns nothing for unknown kinds or ids", async () => {
    assert.deepEqual(await docsMentions(mark, { kind: "page", id: mark.userId }), []);
    assert.deepEqual(await docsMentions(mark, { kind: "task", id: "not-a-uuid" }), []);
  });
});
