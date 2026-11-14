import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { fileInboundMessages, saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import { completeTask, createTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createUser, resetDatabase } from "./helpers";

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function openFollowUps(workspaceId: string, companyId: string) {
  const result = await getAdminPool().query<{ count: string }>(
    "select count(*) from crm.tasks where workspace_id = $1 and company_id = $2 and title like 'Reply to%' and completed_at is null and archived_at is null",
    [workspaceId, companyId],
  );
  return Number(result.rows[0].count);
}

describe("mail follow-ups when a colleague already has a task", () => {
  let owner: UserActor;
  let member: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("colleague-owner@example.com", "Owner");
    const other = await createUser("colleague-member@example.com", "Member");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, other.userId]);
    member = { ...other, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
    await saveMailbox(member, {
      email: "member@orbit-colleague.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("doesn't add a follow-up from the inbox while a colleague's task is open", async () => {
    const company = (await createCompany(owner, { name: "Inbox Shared", domain: "inbox-shared.test" })).body.company;
    await createContact(owner, { firstName: "Ivy", lastName: "Shared", email: "ivy@inbox-shared.test", companyId: company.id });
    const colleagues = await createTask(owner, { title: "Call Inbox Shared back", companyId: company.id, ownerId: owner.userId });
    assert.equal((await listTasks(member, { companyId: company.id })).data.length, 0);

    const first = await fileInboundMessages(member, [
      { providerMessageId: "colleague-inbox-1", subject: "Question", fromEmail: "ivy@inbox-shared.test", receivedAt: minutesAgo(5) },
    ]);
    assert.equal(first.attached, 1);
    assert.equal(first.followUps, 0);
    assert.equal(await openFollowUps(owner.workspaceId, company.id), 0);

    await completeTask(owner, colleagues.body.task.id);
    const later = await fileInboundMessages(member, [
      { providerMessageId: "colleague-inbox-2", subject: "Another", fromEmail: "ivy@inbox-shared.test", receivedAt: minutesAgo(2) },
      { providerMessageId: "colleague-inbox-3", subject: "And another", fromEmail: "ivy@inbox-shared.test", receivedAt: minutesAgo(1) },
    ]);
    assert.equal(later.attached, 2);
    assert.equal(later.followUps, 1);
    assert.equal(await openFollowUps(owner.workspaceId, company.id), 1);
  });

  it("doesn't add a follow-up from the mail timeline while a colleague's task is open", async () => {
    const admin = getAdminPool();
    const company = (await createCompany(owner, { name: "Timeline Shared", domain: "timeline-shared.test" })).body.company;
    await createContact(owner, { firstName: "Tom", lastName: "Shared", email: "tom@timeline-shared.test", companyId: company.id });
    const colleagues = await createTask(owner, { title: "Call Timeline Shared back", companyId: company.id, ownerId: owner.userId });

    const sourceId = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
         select $1, $2, 'member@orbit-colleague.test', id from crm.mailbox_connections where user_id = $2 returning id`,
        [member.workspaceId, member.userId],
      )
    ).rows[0].id;
    const inbox = (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'inbox', 'inbox') returning id",
        [member.workspaceId, member.userId, sourceId],
      )
    ).rows[0].id;
    const addMessage = (id: string, at: string) =>
      admin.query(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, subject, snippet, body_text,
           from_email, to_recipients, cc_recipients, sent_at, received_at, is_draft)
         values ($1, $2, $3, $4, $5, $6, 'Timeline question', 'Hello', 'Hello', 'tom@timeline-shared.test', $7::jsonb, '[]'::jsonb, $8, $8, false)`,
        [member.workspaceId, member.userId, sourceId, inbox, id, `<${id}@mail.test>`, JSON.stringify([{ name: "", address: "member@orbit-colleague.test" }]), at],
      );

    await addMessage("colleague-timeline-1", minutesAgo(5));
    assert.equal((await fileMailOnTimeline(member, { actors: [member] })).filed, 1);
    assert.equal(await openFollowUps(owner.workspaceId, company.id), 0);

    await completeTask(owner, colleagues.body.task.id);
    await addMessage("colleague-timeline-2", minutesAgo(2));
    await addMessage("colleague-timeline-3", minutesAgo(1));
    assert.equal((await fileMailOnTimeline(member, { actors: [member] })).filed, 2);
    assert.equal(await openFollowUps(owner.workspaceId, company.id), 1);
  });
});
