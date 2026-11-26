import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { archiveActivity, createEmailActivityOnce, listActivities, listCompanyTimeline } from "@/lib/crm/activities";
import { addActivityContact, removeActivityContact } from "@/lib/crm/activity-contacts";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const NOW = Date.parse("2026-10-23T09:00:00Z");
const MIGRATION = "20270310100000_email_recipients.sql";

function hoursAgo(hours: number) {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

let owner: UserActor;
let sourceId: string;
let folders: Record<string, string>;
let acme: string;
let anna: string;
let carl: string;
let ben: string;
let priyaContact: string;
let counter = 0;

async function admin<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function person(input: Record<string, unknown>) {
  return (await createContact(owner, input)).body.contact.id as string;
}

async function addMessage(folder: string, values: { subject: string; from: string; to?: string[]; cc?: string[]; at?: string; internetId?: string }) {
  counter += 1;
  const id = `recipients-${counter}`;
  const rows = await admin<{ id: string }>(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, subject, snippet, body_text,
       from_email, to_recipients, cc_recipients, sent_at, received_at, is_draft)
     values ($1, $2, $3, $4, $5, $6, $7, 'Hello', 'Hello', $8, $9::jsonb, $10::jsonb, $11, $11, false) returning id`,
    [
      owner.workspaceId,
      owner.userId,
      sourceId,
      folders[folder],
      id,
      values.internetId ?? `<${id}@mail.test>`,
      values.subject,
      values.from,
      JSON.stringify((values.to ?? []).map((address) => ({ name: "", address }))),
      JSON.stringify((values.cc ?? []).map((address) => ({ name: "", address }))),
      values.at ?? hoursAgo(1),
    ],
  );
  return { id: rows[0].id, internetId: values.internetId ?? `<${id}@mail.test>` };
}

async function emailsFor(internetId: string) {
  return admin<{ id: string; contact_id: string | null; company_id: string | null; archived_at: Date | null }>(
    "select id, contact_id, company_id, archived_at from crm.activities where type = 'email' and metadata->>'internetMessageId' = $1 order by created_at",
    [internetId],
  );
}

async function linkedIds(activityId: string) {
  return (await admin<{ contact_id: string }>("select contact_id from crm.activity_contacts where activity_id = $1", [activityId]))
    .map((row) => row.contact_id)
    .sort();
}

before(async () => {
  await resetDatabase();
  owner = await createUser("mark@eclipse-recipients.test", "Mark Ridgeon");
  await saveMailbox(owner, { email: "mark@other-recipients.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(NOW + 3_600_000).toISOString() });
  sourceId = (
    await admin<{ id: string }>(
      `insert into crm.mail_sources (workspace_id, user_id, email, connection_id)
       select $1, $2, 'mark@other-recipients.test', id from crm.mailbox_connections where user_id = $2 returning id`,
      [owner.workspaceId, owner.userId],
    )
  )[0].id;
  folders = {};
  for (const role of ["inbox", "sent", "drafts", "junk", "archive"]) {
    folders[role] = (
      await admin<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $4) returning id",
        [owner.workspaceId, owner.userId, sourceId, role],
      )
    )[0].id;
  }
  const colleague = await createUser("priya@eclipse-recipients.test", "Priya Shah");
  await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, colleague.userId]);
  acme = (await createCompany(owner, { name: "Acme", domain: "acme-recipients.test" })).body.company.id;
  anna = await person({ firstName: "Anna", lastName: "Acme", email: "anna@acme-recipients.test", companyId: acme });
  carl = await person({ firstName: "Carl", lastName: "Cole", email: "carl@acme-recipients.test", companyId: acme });
  ben = await person({ firstName: "Ben", lastName: "Brook", email: "ben@brook-recipients.test" });
  priyaContact = await person({ firstName: "Priya", lastName: "Shah", email: "priya@eclipse-recipients.test" });
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("emails with several people", () => {
  useServerlessPool();

  it("files a sent email to two contacts as one activity linked to both, shown once on the company timeline", async () => {
    const sent = await addMessage("sent", { subject: "Joint plan", from: "mark@other-recipients.test", to: ["carl@acme-recipients.test"], cc: ["anna@acme-recipients.test"] });
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 1);
    const rows = await emailsFor(sent.internetId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contact_id, carl);
    assert.deepEqual(await linkedIds(rows[0].id), [anna, carl].sort());
    const timeline = (await listCompanyTimeline(owner, acme)).filter((activity) => activity.title === "Joint plan");
    assert.equal(timeline.length, 1);
    const asAnna = (await listActivities(owner, { contactId: anna, type: "email" })).data.filter((activity) => activity.title === "Joint plan");
    assert.equal(asAnna.length, 1);
    assert.deepEqual(asAnna[0].contactIds.sort(), [anna, carl].sort());
  });

  it("makes the first recipient the main contact on sent mail", async () => {
    const sent = await addMessage("sent", { subject: "Order matters", from: "mark@other-recipients.test", to: ["ben@brook-recipients.test", "anna@acme-recipients.test"] });
    await fileMailOnTimeline(owner, { now: NOW });
    const rows = await emailsFor(sent.internetId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contact_id, ben);
    assert.deepEqual(await linkedIds(rows[0].id), [anna, ben].sort());
  });

  it("links the sender and a Cc'd contact on received mail, with the sender as the main contact", async () => {
    const received = await addMessage("inbox", {
      subject: "Contract",
      from: "anna@acme-recipients.test",
      to: ["mark@other-recipients.test"],
      cc: ["carl@acme-recipients.test", "stranger@nobody-recipients.test"],
    });
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 1);
    const rows = await emailsFor(received.internetId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contact_id, anna);
    assert.deepEqual(await linkedIds(rows[0].id), [anna, carl].sort());
    const asCarl = (await listActivities(owner, { contactId: carl, type: "email" })).data.filter((activity) => activity.title === "Contract");
    assert.equal(asCarl.length, 1);
  });

  it("uses the first matched recipient as the main contact when the sender is only a company", async () => {
    const received = await addMessage("inbox", {
      subject: "From a stranger at Acme",
      from: "newperson@acme-recipients.test",
      to: ["mark@other-recipients.test"],
      cc: ["carl@acme-recipients.test"],
    });
    await fileMailOnTimeline(owner, { now: NOW });
    const rows = await emailsFor(received.internetId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contact_id, carl);
    assert.equal(rows[0].company_id, acme);
  });

  it("never links your own addresses or colleagues, and doesn't create contacts for Cc'd people", async () => {
    const before = Number((await admin("select count(*)::int as n from crm.contacts"))[0].n);
    const received = await addMessage("inbox", {
      subject: "Team thread",
      from: "ben@brook-recipients.test",
      to: ["mark@other-recipients.test", "priya@eclipse-recipients.test"],
      cc: ["mark@eclipse-recipients.test", "someone@eclipse-recipients.test", "carl@acme-recipients.test"],
    });
    await fileMailOnTimeline(owner, { now: NOW });
    const rows = await emailsFor(received.internetId);
    assert.equal(rows.length, 1);
    assert.deepEqual(await linkedIds(rows[0].id), [ben, carl].sort());
    assert.ok(!(await linkedIds(rows[0].id)).includes(priyaContact));
    assert.equal(Number((await admin("select count(*)::int as n from crm.contacts"))[0].n), before);
  });

  it("creates no copies when filing runs again or at the same time", async () => {
    const sent = await addMessage("sent", { subject: "Retry me", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "carl@acme-recipients.test"] });
    const runs = await Promise.all([1, 2, 3].map(() => fileMailOnTimeline(owner, { now: NOW })));
    assert.equal(runs.reduce((total, run) => total + run.filed, 0), 1);
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    const rows = await emailsFor(sent.internetId);
    assert.equal(rows.length, 1);
    const created = await admin("select 1 from crm.audit_events where event_type = 'activity.created' and entity_id = $1", [rows[0].id]);
    assert.equal(created.length, 1);
  });

  it("links a contact added later to the email already filed, without a new activity", async () => {
    const sent = await addMessage("sent", { subject: "Later person", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "dora@acme-recipients.test"] });
    await fileMailOnTimeline(owner, { now: NOW });
    const first = await emailsFor(sent.internetId);
    assert.deepEqual(await linkedIds(first[0].id), [anna]);
    const dora = await person({ firstName: "Dora", lastName: "Dean", email: "dora@acme-recipients.test", companyId: acme });
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    const rows = await emailsFor(sent.internetId);
    assert.equal(rows.length, 1);
    assert.deepEqual(await linkedIds(rows[0].id), [anna, dora].sort());
  });

  it("gives one activity when an email is logged at send and then filed from the mailbox", async () => {
    const sent = await addMessage("sent", { subject: "Proposal v2", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test"], cc: ["carl@acme-recipients.test"], at: hoursAgo(2) });
    await admin(
      `insert into crm.activities (workspace_id, type, title, occurred_at, company_id, contact_id, metadata)
       values ($1, 'email', 'Proposal v2', $2::timestamptz + interval '20 seconds', $3, $4, '{"source":"microsoft","direction":"outbound","to":"anna@acme-recipients.test"}'::jsonb)`,
      [owner.workspaceId, hoursAgo(2), acme, anna],
    );
    await fileMailOnTimeline(owner, { now: NOW });
    const all = await admin<{ id: string }>("select id from crm.activities where type = 'email' and title = 'Proposal v2'");
    assert.equal(all.length, 1);
    assert.deepEqual(await linkedIds(all[0].id), [anna, carl].sort());
    assert.equal((await emailsFor(sent.internetId)).length, 0);
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
  });

  it("keeps two same-titled emails sent minutes apart to different people as two activities", async () => {
    await addMessage("sent", { subject: "Quick intro", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test"], at: hoursAgo(3) });
    await addMessage("sent", { subject: "Quick intro", from: "mark@other-recipients.test", to: ["ben@brook-recipients.test"], at: hoursAgo(3) });
    for (const contactId of [anna, ben]) {
      await admin(
        `insert into crm.activities (workspace_id, type, title, occurred_at, contact_id, metadata)
         values ($1, 'email', 'Quick intro', $2::timestamptz + interval '10 seconds', $3, '{"source":"microsoft","direction":"outbound"}'::jsonb)`,
        [owner.workspaceId, hoursAgo(3), contactId],
      );
    }
    await fileMailOnTimeline(owner, { now: NOW });
    const all = await admin<{ id: string }>("select id from crm.activities where type = 'email' and title = 'Quick intro'");
    assert.equal(all.length, 2);
    assert.deepEqual(await linkedIds(all[0].id), [anna]);
    assert.deepEqual(await linkedIds(all[1].id), [ben]);
  });

  it("keeps a removed person removed through later filing runs, until they are added back", async () => {
    const sent = await addMessage("sent", { subject: "Remove me", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "carl@acme-recipients.test"] });
    await fileMailOnTimeline(owner, { now: NOW });
    const [email] = await emailsFor(sent.internetId);
    assert.deepEqual(await linkedIds(email.id), [anna, carl].sort());
    await removeActivityContact(owner, email.id, carl, { operation: "test", source: "test" });
    await fileMailOnTimeline(owner, { now: NOW });
    await fileMailOnTimeline(owner, { now: NOW });
    assert.deepEqual(await linkedIds(email.id), [anna]);
    assert.equal((await admin("select 1 from crm.activity_contact_dismissals where activity_id = $1 and contact_id = $2", [email.id, carl])).length, 1);

    const copy = await addMessage("sent", { subject: "Remove me", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "carl@acme-recipients.test"], internetId: sent.internetId });
    assert.ok(copy.id);
    await fileMailOnTimeline(owner, { now: NOW });
    assert.deepEqual(await linkedIds(email.id), [anna]);
    await withActor(owner, (db) =>
      createEmailActivityOnce(db, owner, { type: "email", title: "Remove me", contactId: carl, metadata: { source: "microsoft" } }, { internetMessageId: sent.internetId }, { operation: "sync_inbox", source: "microsoft" }),
    );
    assert.deepEqual(await linkedIds(email.id), [anna]);
    assert.equal((await emailsFor(sent.internetId)).length, 1);

    await addActivityContact(owner, email.id, carl, { operation: "test", source: "test" });
    assert.equal((await admin("select 1 from crm.activity_contact_dismissals where activity_id = $1", [email.id])).length, 0);
    assert.deepEqual(await linkedIds(email.id), [anna, carl].sort());
  });

  it("settles a message with an internal contact in one run and names the main contact as the recipient", async () => {
    const sent = await addMessage("sent", { subject: "Mixed Cc", from: "mark@other-recipients.test", to: ["priya@eclipse-recipients.test"], cc: ["carl@acme-recipients.test"] });
    await fileMailOnTimeline(owner, { now: NOW });
    const [email] = await emailsFor(sent.internetId);
    assert.equal(email.contact_id, carl);
    assert.equal(email.company_id, acme);
    assert.deepEqual(await linkedIds(email.id), [carl]);
    const stored = await admin<{ to: string }>("select metadata->>'to' as \"to\" from crm.activities where id = $1", [email.id]);
    assert.equal(stored[0].to, "carl@acme-recipients.test");
    const events = async () => (await admin("select 1 from crm.audit_events where entity_id = $1", [email.id])).length;
    const before = await events();
    await fileMailOnTimeline(owner, { now: NOW });
    assert.equal(await events(), before);
    assert.equal((await admin("select 1 from crm.activity_contact_dismissals where activity_id = $1 and contact_id = $2", [email.id, priyaContact])).length, 1);
  });

  it("leaves a deleted email deleted when a contact is created for someone on it", async () => {
    const sent = await addMessage("sent", { subject: "Deleted note", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "erin@acme-recipients.test"] });
    await fileMailOnTimeline(owner, { now: NOW });
    const [email] = await emailsFor(sent.internetId);
    await archiveActivity(owner, email.id, { operation: "test", source: "test" });
    const erin = await person({ firstName: "Erin", lastName: "Ede", email: "erin@acme-recipients.test", companyId: acme });
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    const events = async () => (await admin("select 1 from crm.audit_events where entity_id = $1", [email.id])).length;
    const before = await events();
    assert.equal((await fileMailOnTimeline(owner, { now: NOW })).filed, 0);
    assert.equal(await events(), before);
    assert.equal((await emailsFor(sent.internetId)).length, 1);
    assert.ok(!(await linkedIds(email.id)).includes(erin));
    assert.equal((await admin("select 1 from crm.activity_contact_dismissals where activity_id = $1 and contact_id = $2", [email.id, erin])).length, 1);
  });

  it("links the second contact to the activity an earlier send already logged, never a second copy", async () => {
    const ids = { internetMessageId: "<sent-direct@mail.test>" };
    const write = (contactId: string) =>
      withActor(owner, (db) =>
        createEmailActivityOnce(
          db,
          owner,
          { type: "email", title: "Direct", contactId, metadata: { source: "microsoft", direction: "outbound", ...ids } },
          ids,
          { operation: "send_email", source: "microsoft" },
        ),
      );
    const first = await write(anna);
    const second = await write(ben);
    assert.equal(first.created, true);
    assert.deepEqual(second, { id: first.id, created: false });
    assert.deepEqual(await linkedIds(first.id), [anna, ben].sort());
    const links = await admin("select 1 from crm.audit_events where event_type = 'activity.updated' and entity_id = $1", [first.id]);
    assert.equal(links.length, 1);
  });
});

describe("backfill of email activities", () => {
  it("merges copies of one email, links Cc'd contacts and is safe to run twice", async () => {
    const copy = async (contactId: string, internetId: string, mailId: string | null, createdOffset: number) =>
      (
        await admin<{ id: string }>(
          `insert into crm.activities (workspace_id, type, title, occurred_at, company_id, contact_id, created_at, metadata)
           values ($1, 'email', 'Old thread', now() - interval '3 days', $2, $3, now() - make_interval(mins => $4::int), $5::jsonb) returning id`,
          [
            owner.workspaceId,
            contactId === ben ? null : acme,
            contactId,
            createdOffset,
            JSON.stringify({ source: "microsoft", direction: "outbound", internetMessageId: internetId, ...(mailId ? { mailMessageId: mailId } : {}) }),
          ],
        )
      )[0].id;
    const sent = await addMessage("sent", { subject: "Old thread", from: "mark@other-recipients.test", to: ["anna@acme-recipients.test", "ben@brook-recipients.test"], cc: ["carl@acme-recipients.test"] });
    const oldest = await copy(anna, sent.internetId, sent.id, 30);
    const second = await copy(ben, sent.internetId, sent.id, 20);
    const third = await copy(carl, sent.internetId, sent.id, 10);

    const received = await addMessage("inbox", {
      subject: "Old reply",
      from: "anna@acme-recipients.test",
      to: ["mark@other-recipients.test", "priya@eclipse-recipients.test"],
      cc: ["ben@brook-recipients.test", "mark@eclipse-recipients.test"],
    });
    const reply = (
      await admin<{ id: string }>(
        `insert into crm.activities (workspace_id, type, title, occurred_at, company_id, contact_id, metadata)
         values ($1, 'email', 'Old reply', now() - interval '2 days', $2, $3, $4::jsonb) returning id`,
        [owner.workspaceId, acme, anna, JSON.stringify({ source: "microsoft", direction: "inbound", internetMessageId: received.internetId, mailMessageId: received.id })],
      )
    )[0].id;

    await reapplyMigrationsFrom(MIGRATION);

    const states = await admin<{ id: string; archived_at: Date | null }>("select id, archived_at from crm.activities where id = any($1::uuid[])", [[oldest, second, third]]);
    assert.deepEqual(
      states.filter((row) => row.archived_at === null).map((row) => row.id),
      [oldest],
    );
    assert.deepEqual(await linkedIds(oldest), [anna, ben, carl].sort());
    assert.deepEqual(await linkedIds(reply), [anna, ben].sort());
    assert.ok(!(await linkedIds(reply)).includes(priyaContact));

    const audits = await admin<{ event_type: string; actor_type: string; source: string }>(
      "select event_type, actor_type, source from crm.audit_events where operation = 'merge_email_copies' order by event_type",
    );
    assert.deepEqual(
      audits.map((row) => row.event_type),
      ["activity.archived", "activity.archived", "activity.updated", "activity.updated"],
    );
    assert.ok(audits.every((row) => row.actor_type === "system" && row.source === "migration"));
    const delivered = await admin("select 1 from crm.webhook_deliveries where event_type in ('activity.archived', 'activity.updated')");
    assert.equal(delivered.length, 0);

    const counts = async () => ({
      activities: (await admin("select 1 from crm.activities where archived_at is null")).length,
      links: (await admin("select 1 from crm.activity_contacts")).length,
      audits: (await admin("select 1 from crm.audit_events where source = 'migration'")).length,
    });
    const first = await counts();
    await reapplyMigrationsFrom(MIGRATION);
    assert.deepEqual(await counts(), first);
  });
});
