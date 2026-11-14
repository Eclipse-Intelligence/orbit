import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { recordCommunication } from "@/lib/crm/communications";
import { fileInboundMessages, saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool } from "@/lib/db/pool";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function openTasks(workspaceId: string, companyId: string) {
  const result = await getAdminPool().query<{ title: string }>(
    "select title from crm.tasks where workspace_id = $1 and company_id = $2 and completed_at is null and archived_at is null order by created_at",
    [workspaceId, companyId],
  );
  return result.rows.map((row) => row.title);
}

async function activityCount(workspaceId: string, companyId: string) {
  const result = await getAdminPool().query<{ count: string }>("select count(*) from crm.activities where workspace_id = $1 and company_id = $2", [workspaceId, companyId]);
  return Number(result.rows[0].count);
}

function heldTitleModel(title: string) {
  let asked!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => (asked = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl: typeof fetch = async () => {
    asked();
    await released;
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify({ title }) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, requested, release };
}

describe("follow-up tasks on the serverless pool", () => {
  useServerlessPool();
  let owner: UserActor;
  let sourceId: string;
  let inboxFolder: string;

  async function company(name: string, domain: string, person: string) {
    const created = (await createCompany(owner, { name, domain })).body.company;
    await createContact(owner, { firstName: person, lastName: name, email: `${person.toLowerCase()}@${domain}`, companyId: created.id });
    return created.id;
  }

  async function addInboxMessage(id: string, from: string) {
    const at = minutesAgo(3);
    await getAdminPool().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, subject, snippet, body_text,
         from_email, to_recipients, cc_recipients, sent_at, received_at, is_draft)
       values ($1, $2, $3, $4, $5, $6, 'Pilot scope', 'Could you send the scope?', 'Could you send the scope?', $7, $8::jsonb, '[]'::jsonb, $9, $9, false)`,
      [owner.workspaceId, owner.userId, sourceId, inboxFolder, id, `<${id}@mail.test>`, from, JSON.stringify([{ name: "", address: "mark@pool-mail.test" }]), at],
    );
  }

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@pool-follow.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@pool-mail.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const admin = getAdminPool();
    sourceId = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
         select $1, $2, 'mark@pool-mail.test', id from crm.mailbox_connections where user_id = $2 returning id`,
        [owner.workspaceId, owner.userId],
      )
    ).rows[0].id;
    inboxFolder = (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'inbox', 'inbox') returning id",
        [owner.workspaceId, owner.userId, sourceId],
      )
    ).rows[0].id;
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getAdminPool().end();
  });

  it("logs two emails at once on two connections and adds one follow-up", async () => {
    const companyId = await company("Hooli", "hooli-pool.test", "Gavin");
    const log = (n: number) =>
      recordCommunication(owner, { kind: "email", title: `Re: Pilot ${n}`, body: "Could you send the scope?", participantEmails: ["gavin@hooli-pool.test"] });
    const results = await Promise.allSettled([log(1), log(2)]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(await activityCount(owner.workspaceId, companyId), 2);
    assert.equal((await openTasks(owner.workspaceId, companyId)).length, 1);
  });

  it("files mail on the timeline without a second connection", async () => {
    const companyId = await company("Pied Piper", "piper-pool.test", "Richard");
    await addInboxMessage("pool-timeline-1", "richard@piper-pool.test");
    assert.equal((await fileMailOnTimeline(owner, { actors: [owner] })).filed, 1);
    assert.equal((await openTasks(owner.workspaceId, companyId)).length, 1);
  });

  it("adds one follow-up when a meeting is logged while mail filing waits for its title", async () => {
    const companyId = await company("Raviga", "raviga-pool.test", "Laurie");
    await addInboxMessage("pool-race-timeline", "laurie@raviga-pool.test");
    process.env.LLM_API_KEY = "test-llm-key";
    const model = heldTitleModel("Send Laurie the pilot scope");
    try {
      const filing = fileMailOnTimeline(owner, { actors: [owner], fetchImpl: model.fetchImpl });
      await model.requested;
      const logged = await recordCommunication(owner, { kind: "meeting", title: "Pilot call", body: "Talked through the scope.", participantEmails: ["laurie@raviga-pool.test"] });
      assert.equal(logged.suggested, true);
      model.release();
      assert.equal((await filing).filed, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
    assert.deepEqual(await openTasks(owner.workspaceId, companyId), ["Follow up with Laurie Raviga"]);
  });

  it("adds one follow-up when a meeting is logged while the inbox waits for its title", async () => {
    const companyId = await company("Bachman", "bachman-pool.test", "Erlich");
    process.env.LLM_API_KEY = "test-llm-key";
    const model = heldTitleModel("Send Erlich the pilot scope");
    try {
      const filing = fileInboundMessages(
        owner,
        [{ providerMessageId: "pool-race-inbox", subject: "Pilot scope", preview: "Could you send the scope?", fromEmail: "erlich@bachman-pool.test", receivedAt: minutesAgo(2) }],
        { fetchImpl: model.fetchImpl },
      );
      await model.requested;
      const logged = await recordCommunication(owner, { kind: "meeting", title: "Pilot call", body: "Talked through the scope.", participantEmails: ["erlich@bachman-pool.test"] });
      assert.equal(logged.suggested, true);
      model.release();
      assert.equal((await filing).followUps, 0);
    } finally {
      delete process.env.LLM_API_KEY;
    }
    assert.deepEqual(await openTasks(owner.workspaceId, companyId), ["Follow up with Erlich Bachman"]);
  });

  it("keeps a logged email and skips the follow-up when the open task check fails", async () => {
    const companyId = await company("Endframe", "endframe-pool.test", "Gilfoyle");
    const admin = getAdminPool();
    await admin.query("revoke execute on function private.company_has_open_task(uuid, uuid) from crm_app");
    try {
      const logged = await recordCommunication(owner, { kind: "email", title: "Re: Pilot", body: "Could you send the scope?", participantEmails: ["gilfoyle@endframe-pool.test"] });
      assert.equal(logged.suggested, false);
      assert.equal(logged.task, null);
      assert.equal(logged.activity.companyId, companyId);
    } finally {
      await admin.query("grant execute on function private.company_has_open_task(uuid, uuid) to crm_app");
    }
    assert.equal(await activityCount(owner.workspaceId, companyId), 1);
    assert.deepEqual(await openTasks(owner.workspaceId, companyId), []);
  });
});
