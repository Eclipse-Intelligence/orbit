import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createActivity, createEmailActivityOnce, listActivities } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { archiveContact, createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool, type Db } from "@/lib/db/pool";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createUser, resetDatabase } from "./helpers";

const NOW = Date.parse("2026-10-23T09:00:00Z");

function hoursAgo(hours: number) {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

describe("mail on the contact timeline", () => {
  let owner: UserActor;
  let janeId: string;
  let folders: Record<string, string>;
  let sourceId: string;

  async function addMessage(folder: string, values: { id: string; subject: string; from: string; to?: string[]; cc?: string[]; at: string; body?: string; draft?: boolean }) {
    await getAdminPool().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, subject, snippet, body_text,
         from_email, to_recipients, cc_recipients, sent_at, received_at, is_draft)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $13, $14)`,
      [
        owner.workspaceId,
        owner.userId,
        sourceId,
        folders[folder],
        values.id,
        `<${values.id}@mail.test>`,
        values.subject,
        (values.body ?? "").slice(0, 100),
        values.body ?? null,
        values.from,
        JSON.stringify((values.to ?? []).map((address) => ({ name: "", address }))),
        JSON.stringify((values.cc ?? []).map((address) => ({ name: "", address }))),
        values.at,
        values.draft ?? false,
      ],
    );
  }

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@eclipse.test", "Mark Ridgeon");
    janeId = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "Jane@Acme.test" })).body.contact.id;
    await createContact(owner, { firstName: "Raj", lastName: "Patel", email: "raj@acme.test" });
    const admin = getAdminPool();
    await saveMailbox(owner, { email: "mark@other.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(NOW + 3_600_000).toISOString() });
    sourceId = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
         select $1, $2, 'mark@other.test', id from crm.mailbox_connections where user_id = $2 returning id`,
        [owner.workspaceId, owner.userId],
      )
    ).rows[0].id;
    folders = {};
    for (const role of ["inbox", "sent", "drafts", "junk", "archive"]) {
      folders[role] = (
        await admin.query<{ id: string }>(
          "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $4) returning id",
          [owner.workspaceId, owner.userId, sourceId, role],
        )
      ).rows[0].id;
    }
    await addMessage("inbox", { id: "in-1", subject: "Re: Pilot", from: "jane@acme.test", to: ["mark@other.test"], at: hoursAgo(2), body: "Sounds good.\n\nOn Mon, Mark wrote:\n> earlier" });
    await addMessage("sent", { id: "out-1", subject: "Pilot", from: "mark@other.test", to: ["jane@acme.test"], cc: ["raj@acme.test", "someone@else.test"], at: hoursAgo(3), body: "Here is the plan." });
    await addMessage("archive", { id: "old-1", subject: "Intro", from: "jane@acme.test", to: ["mark@other.test"], at: hoursAgo(24 * 10), body: "Nice to meet you." });
    await addMessage("inbox", { id: "stranger", subject: "Hello", from: "nobody@else.test", to: ["mark@other.test"], at: hoursAgo(1) });
    await addMessage("drafts", { id: "draft-1", subject: "Draft", from: "mark@other.test", to: ["jane@acme.test"], at: hoursAgo(1), draft: true });
    await addMessage("junk", { id: "junk-1", subject: "Win", from: "jane@acme.test", to: ["mark@other.test"], at: hoursAgo(1) });
    await addMessage("archive", { id: "ancient", subject: "Long ago", from: "jane@acme.test", to: ["mark@other.test"], at: hoursAgo(24 * 90) });
    await addMessage("sent", { id: "orbit-sent", subject: "Proposal", from: "mark@other.test", to: ["jane@acme.test"], at: hoursAgo(5) });
    await createActivity(owner, {
      type: "email",
      title: "Proposal",
      body: "Sent from the contact page",
      contactId: janeId,
      occurredAt: new Date(Date.parse(hoursAgo(5)) + 20_000).toISOString(),
      metadata: { source: "microsoft", direction: "outbound", to: "jane@acme.test" },
    });
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("logs every email to or from a contact once, whichever app sent it", async () => {
    const events = async () => Number((await getAdminPool().query("select count(*) from crm.workflow_events")).rows[0].count);
    const before = await events();
    const first = await fileMailOnTimeline(owner, { now: NOW });
    assert.equal(first.filed, 4);
    assert.equal(await events(), before + 3);
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);

    const jane = (await listActivities(owner, { contactId: janeId, type: "email" })).data;
    const titles = jane.map((activity) => `${activity.title}:${activity.metadata.direction}`).sort();
    assert.deepEqual(titles, ["Intro:inbound", "Pilot:outbound", "Proposal:outbound", "Re: Pilot:inbound"]);
    const reply = jane.find((activity) => activity.title === "Re: Pilot")!;
    assert.equal(reply.body, "Sounds good.");
    assert.equal(reply.metadata.from, "jane@acme.test");
    assert.equal(reply.metadata.internetMessageId, "<in-1@mail.test>");
    const raj = await getAdminPool().query("select title from crm.activities a join crm.contacts c on c.id = a.contact_id where c.normalized_email = 'raj@acme.test'");
    assert.deepEqual(raj.rows.map((row) => row.title), ["Pilot"]);
  });

  it("keeps one activity per email when its sender becomes a contact, or the contact is archived", async () => {
    const admin = getAdminPool();
    const company = (await createCompany(owner, { name: "Brightlane", domain: "brightlane.test" })).body.company;
    await addMessage("inbox", { id: "nora-1", subject: "Brightlane brief", from: "nora@brightlane.test", to: ["mark@other.test"], at: hoursAgo(1), body: "Here is the brief." });
    const filedOn = async () =>
      (
        await admin.query<{ id: string; contact_id: string | null; company_id: string | null }>(
          "select id, contact_id, company_id from crm.activities where type = 'email' and metadata->>'internetMessageId' = '<nora-1@mail.test>'",
        )
      ).rows;
    const created = async () =>
      Number((await admin.query("select count(*) from crm.audit_events where event_type = 'activity.created' and workspace_id = $1", [owner.workspaceId])).rows[0].count);

    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 1);
    const first = await filedOn();
    assert.equal(first.length, 1);
    assert.equal(first[0].contact_id, null);
    assert.equal(first[0].company_id, company.id);
    const before = await created();

    const nora = (await createContact(owner, { firstName: "Nora", lastName: "Hale", email: "nora@brightlane.test", companyId: company.id })).body.contact;
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    const relinked = await filedOn();
    assert.deepEqual(relinked, [{ id: first[0].id, contact_id: nora.id, company_id: company.id }]);
    assert.equal(await created(), before);
    const updated = await admin.query("select 1 from crm.audit_events where event_type = 'activity.updated' and entity_id = $1", [first[0].id]);
    assert.equal(updated.rowCount, 1);
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);

    await archiveContact(owner, nora.id);
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    assert.equal((await filedOn()).length, 1);
    assert.equal(await created(), before);

    const again = (await createContact(owner, { firstName: "Nora", lastName: "Hale", email: "nora@brightlane.test", companyId: company.id })).body.contact;
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    assert.deepEqual((await filedOn()).map((row) => row.contact_id), [again.id]);
    assert.equal(await created(), before);
  });

  it("files an email once, with one audit event, when several filers run at the same time", async () => {
    const admin = getAdminPool();
    await addMessage("inbox", { id: "race-1", subject: "Contract", from: "jane@acme.test", to: ["mark@other.test"], at: hoursAgo(1), body: "Signed copy attached." });
    const runs = await Promise.all([1, 2, 3, 4].map(() => fileMailOnTimeline(owner, { now: NOW })));
    assert.equal(runs.reduce((total, run) => total + run.filed, 0), 1);
    const filed = await admin.query<{ id: string }>("select id from crm.activities where type = 'email' and metadata->>'internetMessageId' = '<race-1@mail.test>'");
    assert.equal(filed.rows.length, 1);
    const audits = await admin.query("select 1 from crm.audit_events where event_type = 'activity.created' and entity_id = $1", [filed.rows[0].id]);
    assert.equal(audits.rowCount, 1);
  });

  it("lets only the first of two overlapping filings of the same email write it and its audit event", async () => {
    const admin = getAdminPool();
    const write = (db: Db) =>
      createEmailActivityOnce(
        db,
        owner,
        { type: "email", title: "Overlap", contactId: janeId, metadata: { source: "microsoft", direction: "inbound", internetMessageId: "<overlap-1@mail.test>" } },
        { internetMessageId: "<overlap-1@mail.test>" },
        { operation: "file_mail", source: "microsoft" },
      );
    let second: Promise<{ id: string; created: boolean }> | null = null;
    const first = await withActor(owner, async (db) => {
      const saved = await write(db);
      second = withActor(owner, write);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return saved;
    });
    const later = await second!;
    assert.equal(first.created, true);
    assert.deepEqual(later, { id: first.id, created: false });
    const audits = await admin.query("select 1 from crm.audit_events where event_type = 'activity.created' and entity_id = $1", [first.id]);
    assert.equal(audits.rowCount, 1);
  });
});
