import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { archiveContact, createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import {
  companyNameFromDomain,
  createContactAndFile,
  internalAddresses,
  listUnfiledImports,
  type Participant,
} from "@/lib/crm/conversations";
import { cleanOtherEmails, getMyEmails, saveOtherEmails } from "@/lib/crm/profile";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

let counter = 0;

async function unfiledImport(actor: UserActor, title: string, participants: Participant[]) {
  counter += 1;
  const result = await getAdminPool().query<{ id: string }>(
    `insert into crm.conversation_imports (
       workspace_id, user_id, source, external_id, kind, title, occurred_at, participants,
       transcript, status
     ) values ($1, $2, 'granola', $3, 'meeting', $4, now() - make_interval(mins => $5::int), $6::jsonb, $7, 'unfiled')
     returning id`,
    [
      actor.workspaceId,
      actor.userId,
      `not_attendee_${counter}`,
      title,
      counter,
      JSON.stringify(participants),
      "Isabelle: Let's talk next week.",
    ],
  );
  return result.rows[0].id;
}

async function importRow(id: string) {
  const result = await getAdminPool().query<{
    status: string;
    contact_id: string | null;
    company_id: string | null;
    activity_id: string | null;
  }>("select status, contact_id, company_id, activity_id from crm.conversation_imports where id = $1", [id]);
  return result.rows[0];
}

async function contactsByEmail(workspaceId: string, email: string) {
  const result = await getAdminPool().query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    company_id: string | null;
    source: string | null;
  }>(
    `select id, first_name, last_name, company_id, source from crm.contacts
     where workspace_id = $1 and normalized_email = $2 and archived_at is null`,
    [workspaceId, email],
  );
  return result.rows;
}

async function companiesByDomain(workspaceId: string, domain: string) {
  const result = await getAdminPool().query<{ id: string; name: string; source: string | null }>(
    "select id, name, source from crm.companies where workspace_id = $1 and domain = $2",
    [workspaceId, domain],
  );
  return result.rows;
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("my email addresses", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("mark@geteclipse.co", "Mark Ridgeon");
  });

  it("cleans, dedupes and drops the sign-in address", () => {
    assert.deepEqual(
      cleanOtherEmails(
        [" Mark@Ridgeon.ME ", "mark@ridgeon.me", "", "MARK@geteclipse.co", "marky@gmail.com"],
        "mark@geteclipse.co",
      ),
      ["mark@ridgeon.me", "marky@gmail.com"],
    );
    assert.throws(() => cleanOtherEmails(["not an email"], "mark@geteclipse.co"), /isn't a valid email/);
    assert.throws(() => cleanOtherEmails("mark@ridgeon.me", "mark@geteclipse.co"), /list of email/);
    const many = Array.from({ length: 21 }, (_, index) => `me${index}@example.com`);
    assert.throws(() => cleanOtherEmails(many, "mark@geteclipse.co"), /up to 20/);
    assert.equal(cleanOtherEmails([...many.slice(0, 20), "mark@geteclipse.co"], "mark@geteclipse.co").length, 20);
  });

  it("saves and reads the signed-in user's other addresses", async () => {
    assert.deepEqual(await getMyEmails(owner), { loginEmail: "mark@geteclipse.co", otherEmails: [] });
    const saved = await saveOtherEmails(owner, ["Mark@Ridgeon.me", "mark@geteclipse.co", "mark@ridgeon.me"]);
    assert.deepEqual(saved, { loginEmail: "mark@geteclipse.co", otherEmails: ["mark@ridgeon.me"] });
    assert.deepEqual(await getMyEmails(owner), saved);
    await assert.rejects(saveOtherEmails(owner, ["mark@ridgeon.me", "nope"]), /isn't a valid email/);
    assert.deepEqual((await getMyEmails(owner)).otherEmails, ["mark@ridgeon.me"]);
    await assert.rejects(
      getAdminPool().query("update crm.profiles set other_emails = $2 where id = $1", [
        owner.userId,
        Array.from({ length: 21 }, (_, index) => `me${index}@example.com`),
      ]),
      /profiles_other_emails_count/,
    );
  });

  it("treats every member's other addresses and their work domains as internal", async () => {
    const teammate = await createUser("ana@elsewhere.test", "Ana");
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, teammate.userId],
    );
    await saveOtherEmails(owner, ["mark@ridgeon.me", "marky@gmail.com"]);
    await saveOtherEmails(teammate, ["ana@sidegig.io"]);
    const internal = await withActor(owner, (db) => internalAddresses(db, owner.workspaceId, []));
    assert.equal(internal.isInternal("mark@ridgeon.me"), true);
    assert.equal(internal.isInternal("Partner@Ridgeon.me"), true);
    assert.equal(internal.isInternal("marky@gmail.com"), true);
    assert.equal(internal.isInternal("friend@gmail.com"), false);
    assert.equal(internal.isInternal("ana@sidegig.io"), true);
    assert.equal(internal.isInternal("boss@sidegig.io"), true);
    assert.equal(internal.isInternal("colleague@geteclipse.co"), true);
    assert.equal(internal.isInternal("isabelle@jumpstart-uk.com"), false);
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [
      owner.workspaceId,
      teammate.userId,
    ]);
    await saveOtherEmails(owner, ["mark@ridgeon.me"]);
  });
});

describe("create and file from an attendee", () => {
  let owner: UserActor;
  let acmeId: string;
  let janeId: string;
  let globexId: string;

  before(async () => {
    owner = await createUser("founder@orbit-attendees.test", "Founder");
    await saveOtherEmails(owner, ["founder@ridgeon.me", "founder.personal@gmail.com"]);
    acmeId = (await createCompany(owner, { name: "Acme", domain: "acme.com" })).body.company.id;
    globexId = (await createCompany(owner, { name: "Globex Corporation", domain: "globex.com" })).body.company.id;
    janeId = (
      await createContact(owner, { companyId: acmeId, firstName: "Jane", lastName: "Doe", email: "jane@acme.com" })
    ).body.contact.id;
    const gone = await createContact(owner, { firstName: "Gone", email: "gone@oldco.com" });
    await archiveContact(owner, gone.body.contact.id);
  });

  it("names companies from the email domain", () => {
    assert.equal(companyNameFromDomain("jumpstart-uk.com"), "Jumpstart UK");
    assert.equal(companyNameFromDomain("acme_co.io"), "Acme CO");
    assert.equal(companyNameFromDomain("big-data-ai.co.uk"), "Big Data AI");
    assert.equal(companyNameFromDomain("orbit.com"), "Orbit");
  });

  it("lists new people per unfiled conversation without internal or known addresses", async () => {
    const meeting = await unfiledImport(owner, "Jumpstart intro", [
      { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
      { name: "founder@ridgeon.me", email: "founder@ridgeon.me" },
      { name: "Founder", email: "founder@orbit-attendees.test" },
      { name: "Teammate", email: "someone@orbit-attendees.test" },
      { name: "Jane Doe", email: "JANE@acme.com" },
      { name: "pat@gmail.com", email: "pat@gmail.com" },
      { name: "Personal", email: "founder.personal@gmail.com" },
      { name: null, email: "Isabelle@Jumpstart-UK.com" },
      { name: "Phone only", email: null },
      { name: "Gone Again", email: "gone@oldco.com" },
    ]);
    const second = await unfiledImport(owner, "Only us", [
      { name: "Founder", email: "founder@orbit-attendees.test" },
      { name: "founder@ridgeon.me", email: "founder@ridgeon.me" },
    ]);
    const unfiled = await listUnfiledImports(owner);
    const byId = new Map(unfiled.map((item) => [item.id, item]));
    assert.deepEqual(byId.get(meeting)!.newPeople, [
      { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
      { name: null, email: "pat@gmail.com" },
      { name: "Gone Again", email: "gone@oldco.com" },
    ]);
    assert.deepEqual(byId.get(second)!.newPeople, []);
  });

  it("creates the company and contact from an attendee and files the meeting", async () => {
    const meeting = await unfiledImport(owner, "Jumpstart catch-up", [
      { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
      { name: "founder@ridgeon.me", email: "founder@ridgeon.me" },
    ]);
    const filed = await createContactAndFile(owner, meeting, "Isabelle@Jumpstart-UK.com", { summarise: false });
    assert.equal(filed.created, true);
    assert.equal(filed.contactName, "Isabelle Pitman");
    const companies = await companiesByDomain(owner.workspaceId, "jumpstart-uk.com");
    assert.equal(companies.length, 1);
    assert.equal(companies[0].name, "Jumpstart UK");
    assert.equal(companies[0].source, "meeting");
    const contacts = await contactsByEmail(owner.workspaceId, "isabelle@jumpstart-uk.com");
    assert.deepEqual(contacts, [
      {
        id: filed.contactId,
        first_name: "Isabelle",
        last_name: "Pitman",
        company_id: companies[0].id,
        source: "meeting",
      },
    ]);
    const row = await importRow(meeting);
    assert.equal(row.status, "filed");
    assert.equal(row.contact_id, filed.contactId);
    assert.equal(row.company_id, companies[0].id);
    assert.equal(row.activity_id, filed.activityId);
    const activities = await listActivities(owner, { contactId: filed.contactId });
    const activity = activities.data.find((item) => item.id === filed.activityId)!;
    assert.equal(activity.type, "meeting");
    assert.equal(activity.title, "Jumpstart catch-up");
    assert.equal(activity.companyId, companies[0].id);
    const audit = await getAdminPool().query<{ event_type: string; source: string; operation: string }>(
      `select event_type, source, operation from crm.audit_events
       where entity_id = any($1::uuid[]) and event_type like '%.created'
       order by event_type`,
      [[filed.contactId, companies[0].id]],
    );
    assert.deepEqual(audit.rows, [
      { event_type: "company.created", source: "meeting", operation: "create_from_attendee" },
      { event_type: "contact.created", source: "meeting", operation: "create_from_attendee" },
    ]);

    const again = await unfiledImport(owner, "Jumpstart follow-up", [
      { name: "Isabelle Pitman", email: "isabelle@jumpstart-uk.com" },
      { name: "Tom Pitman", email: "tom@jumpstart-uk.com" },
    ]);
    const unfiled = await listUnfiledImports(owner);
    assert.deepEqual(unfiled.find((item) => item.id === again)!.newPeople, [
      { name: "Tom Pitman", email: "tom@jumpstart-uk.com" },
    ]);
    const tom = await createContactAndFile(owner, again, "tom@jumpstart-uk.com", { summarise: false });
    assert.equal((await contactsByEmail(owner.workspaceId, "tom@jumpstart-uk.com"))[0].company_id, companies[0].id);
    assert.equal((await companiesByDomain(owner.workspaceId, "jumpstart-uk.com")).length, 1);
    assert.equal((await importRow(again)).contact_id, tom.contactId);
  });

  it("reuses an existing company by domain without renaming it", async () => {
    const meeting = await unfiledImport(owner, "Globex call", [{ name: "Sam Smith", email: "sam@globex.com" }]);
    const filed = await createContactAndFile(owner, meeting, "sam@globex.com", { summarise: false });
    const companies = await companiesByDomain(owner.workspaceId, "globex.com");
    assert.equal(companies.length, 1);
    assert.equal(companies[0].name, "Globex Corporation");
    const [sam] = await contactsByEmail(owner.workspaceId, "sam@globex.com");
    assert.equal(sam.id, filed.contactId);
    assert.equal(sam.company_id, globexId);
    assert.equal(sam.first_name, "Sam");
    assert.equal(sam.last_name, "Smith");
  });

  it("reuses an existing contact with the same email", async () => {
    const meeting = await unfiledImport(owner, "Acme sync", [{ name: "Janet Doe-Smith", email: "jane@acme.com" }]);
    const filed = await createContactAndFile(owner, meeting, "jane@acme.com", { summarise: false });
    assert.equal(filed.contactId, janeId);
    assert.equal(filed.created, false);
    const contacts = await contactsByEmail(owner.workspaceId, "jane@acme.com");
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].first_name, "Jane");
    assert.equal(contacts[0].company_id, acmeId);
    assert.equal((await importRow(meeting)).company_id, acmeId);
  });

  it("creates no company for a free-mail attendee and uses the email when there's no name", async () => {
    const before = await getAdminPool().query("select count(*)::int as n from crm.companies where workspace_id = $1", [
      owner.workspaceId,
    ]);
    const meeting = await unfiledImport(owner, "Coffee", [{ name: "pat@gmail.com", email: "pat@gmail.com" }]);
    const filed = await createContactAndFile(owner, meeting, "pat@gmail.com", { summarise: false });
    assert.equal(filed.contactName, "pat@gmail.com");
    const [pat] = await contactsByEmail(owner.workspaceId, "pat@gmail.com");
    assert.equal(pat.company_id, null);
    assert.equal(pat.first_name, null);
    assert.equal(pat.last_name, null);
    const afterCount = await getAdminPool().query(
      "select count(*)::int as n from crm.companies where workspace_id = $1",
      [owner.workspaceId],
    );
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
    assert.equal((await importRow(meeting)).status, "filed");
  });

  it("rejects addresses that aren't outside participants", async () => {
    const meeting = await unfiledImport(owner, "Mixed", [
      { name: "Lee", email: "lee@newco.io" },
      { name: "founder@ridgeon.me", email: "founder@ridgeon.me" },
      { name: "Colleague", email: "colleague@orbit-attendees.test" },
      { name: "Personal", email: "founder.personal@gmail.com" },
    ]);
    await assert.rejects(createContactAndFile(owner, meeting, "stranger@newco.io", { summarise: false }), /wasn't in this conversation/);
    await assert.rejects(createContactAndFile(owner, meeting, "founder@ridgeon.me", { summarise: false }), /belongs to you/);
    await assert.rejects(
      createContactAndFile(owner, meeting, "colleague@orbit-attendees.test", { summarise: false }),
      /belongs to you/,
    );
    await assert.rejects(
      createContactAndFile(owner, meeting, "founder.personal@gmail.com", { summarise: false }),
      /belongs to you/,
    );
    await assert.rejects(createContactAndFile(owner, meeting, "not-an-email", { summarise: false }), /valid email/);
    assert.deepEqual(await contactsByEmail(owner.workspaceId, "founder@ridgeon.me"), []);
    assert.deepEqual(await companiesByDomain(owner.workspaceId, "ridgeon.me"), []);
    assert.deepEqual(await companiesByDomain(owner.workspaceId, "newco.io"), []);
    assert.equal((await importRow(meeting)).status, "unfiled");

    await createContactAndFile(owner, meeting, "lee@newco.io", { summarise: false });
    await assert.rejects(createContactAndFile(owner, meeting, "lee@newco.io", { summarise: false }), /already filed/);

    const outsider = await createUser("outsider@elsewhere.test", "Outsider");
    const other = await unfiledImport(owner, "Private", [{ name: "Kim", email: "kim@private.io" }]);
    await assert.rejects(createContactAndFile(outsider, other, "kim@private.io", { summarise: false }), /not found/i);
    assert.deepEqual(await contactsByEmail(outsider.workspaceId, "kim@private.io"), []);
  });
});
