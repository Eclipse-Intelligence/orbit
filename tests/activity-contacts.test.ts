import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createActivity,
  getActivity,
  listActivities,
  listActivitiesByContact,
  listCompanyTimeline,
  updateActivity,
} from "@/lib/crm/activities";
import { addActivityContact, removeActivityContact } from "@/lib/crm/activity-contacts";
import { createCompany } from "@/lib/crm/companies";
import { archiveContact, createContact } from "@/lib/crm/contacts";
import { fileImport } from "@/lib/crm/conversations";
import { fileGranolaNote } from "@/lib/crm/granola";
import { mergeContacts } from "@/lib/crm/merge";
import { moveRecordsToWorkspace } from "@/lib/crm/move-workspace";
import { relationshipsFor } from "@/lib/crm/relationship-signals";
import { scopesForRole } from "@/lib/crm/scopes";
import { encryptSecret } from "@/lib/crypto/secret";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { GranolaNote } from "@/lib/granola";
import { createUser, queryAsUser, reapplyMigrationsFrom, resetDatabase, useServerlessPool } from "./helpers";

const PROVENANCE = { operation: "activity_contacts_test", source: "test" };

let owner: UserActor;
let ridgeon: UserActor;
let outsider: UserActor;
let acme: string;
let brook: string;
let anna: string;
let ben: string;
let carl: string;
let colleagueContact: string;
let colleagueMember: UserActor;
let counter = 0;

async function admin<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function person(actor: UserActor, input: Record<string, unknown>) {
  return (await createContact(actor, input, { provenance: PROVENANCE })).body.contact.id;
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function granolaNote(id: string, attendees: { name: string | null; email: string | null }[]): GranolaNote {
  return {
    id,
    title: "Pilot call",
    owner: { name: owner.fullName, email: owner.email },
    created_at: hoursAgo(3),
    updated_at: hoursAgo(2),
    deleted_at: null,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: null,
    attendees,
    summary_text: "Summary",
    summary_markdown: "Summary",
    transcript: null,
  };
}

async function granolaActivity(externalId: string) {
  const rows = await admin<{ id: string; contact_id: string | null }>(
    "select id, contact_id from crm.activities where workspace_id = $1 and metadata->>'externalId' = $2",
    [owner.workspaceId, externalId],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function linked(activityId: string) {
  const rows = await admin<{ contact_id: string; implicit: boolean }>(
    "select contact_id, implicit from crm.activity_contacts where activity_id = $1 order by contact_id",
    [activityId],
  );
  return rows;
}

async function linkedIds(activityId: string) {
  return (await linked(activityId)).map((row) => row.contact_id).sort();
}

async function unfiled(source: "granola" | "teams", participants: { name: string | null; email: string | null }[], title: string) {
  counter += 1;
  const rows = await admin<{ id: string }>(
    `insert into crm.conversation_imports (
       workspace_id, user_id, source, external_id, kind, title, occurred_at, participants, transcript, status
     ) values ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7::int), $8::jsonb, 'Hello there.', 'unfiled')
     returning id`,
    [
      owner.workspaceId,
      owner.userId,
      source,
      `links_${counter}`,
      source === "teams" ? "call" : "meeting",
      title,
      counter,
      JSON.stringify(participants),
    ],
  );
  return rows[0].id;
}

before(async () => {
  await resetDatabase();
  owner = await createUser("mark@eclipse-links.test", "Mark Ridgeon");
  const created = await createWorkspace(owner, { name: "Mark Ridgeon" });
  ridgeon = { ...owner, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  outsider = await createUser("oscar@elsewhere-links.test", "Oscar Outsider");
  const colleague = await createUser("priya@eclipse-links.test", "Priya Shah");
  await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, colleague.userId]);
  colleagueMember = { ...colleague, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
  acme = (await createCompany(owner, { name: "Acme", domain: "acme-links.test" }, { provenance: PROVENANCE })).body.company.id;
  brook = (await createCompany(owner, { name: "Brook", domain: "brook-links.test" }, { provenance: PROVENANCE })).body.company.id;
  anna = await person(owner, { firstName: "Anna", lastName: "Acme", email: "anna@acme-links.test", companyId: acme });
  carl = await person(owner, { firstName: "Carl", lastName: "Cole", email: "carl@acme-links.test", companyId: acme });
  ben = await person(owner, { firstName: "Ben", lastName: "Brook", email: "ben@brook-links.test", companyId: brook });
  colleagueContact = await person(owner, { firstName: "Priya", lastName: "Shah", email: "priya@eclipse-links.test" });
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("meeting attendees", () => {
  useServerlessPool();

  it("links every known attendee of a Granola meeting and never members or own addresses", async () => {
    const outcome = await fileGranolaNote(
      owner,
      granolaNote("links-g1", [
        { name: "Mark Ridgeon", email: owner.email },
        { name: "Anna Acme", email: "anna@acme-links.test" },
        { name: "Ben Brook", email: "ben@brook-links.test" },
        { name: "Priya Shah", email: "priya@eclipse-links.test" },
        { name: "Stranger", email: "stranger@nowhere-links.test" },
      ]),
    );
    assert.equal(outcome, "filed");
    const meeting = await granolaActivity("links-g1");
    assert.equal(meeting.contact_id, anna);
    assert.deepEqual(await linkedIds(meeting.id), [anna, ben].sort());
    assert.ok(!(await linkedIds(meeting.id)).includes(colleagueContact));
    assert.ok((await linked(meeting.id)).every((row) => row.implicit === false));

    const read = await getActivity(owner, meeting.id);
    assert.equal(read.contactId, anna);
    assert.deepEqual([...read.contactIds].sort(), [anna, ben].sort());
    assert.deepEqual(read.contacts.map((item) => item.name), ["Anna Acme", "Ben Brook"]);

    const grouped = await listActivitiesByContact(owner, [anna, ben, carl]);
    assert.ok(grouped[anna].some((item) => item.id === meeting.id));
    assert.ok(grouped[ben].some((item) => item.id === meeting.id));
    assert.ok(!grouped[carl].some((item) => item.id === meeting.id));
    const listed = await listActivities(owner, { contactId: ben });
    assert.deepEqual(listed.data.map((item) => item.id), [meeting.id]);
    assert.equal(listed.total, 1);
    const brookTimeline = await listCompanyTimeline(owner, brook);
    assert.deepEqual(brookTimeline.map((item) => item.id), [meeting.id]);
  });

  it("lists a meeting once on a company timeline when two attendees work there", async () => {
    await fileGranolaNote(
      owner,
      granolaNote("links-g2", [
        { name: "Anna Acme", email: "anna@acme-links.test" },
        { name: "Carl Cole", email: "carl@acme-links.test" },
      ]),
    );
    const meeting = await granolaActivity("links-g2");
    const timeline = await listCompanyTimeline(owner, acme);
    assert.equal(timeline.filter((item) => item.id === meeting.id).length, 1);
    const grouped = await listActivitiesByContact(owner, [anna, carl]);
    assert.ok(grouped[carl].some((item) => item.id === meeting.id));
  });

  it("links people named without an email when the name is confident", async () => {
    const dana = await person(owner, { firstName: "Dana", lastName: "Dunn", email: "dana@dunn-links.test" });
    await fileGranolaNote(
      owner,
      granolaNote("links-g3", [
        { name: "Anna Acme", email: "anna@acme-links.test" },
        { name: "Dana Dunn", email: null },
        { name: "Zed", email: null },
      ]),
    );
    const meeting = await granolaActivity("links-g3");
    assert.equal(meeting.contact_id, anna);
    assert.deepEqual(await linkedIds(meeting.id), [anna, dana].sort());
  });

  it("links the other recognised people when a Teams conversation is filed by hand", async () => {
    const nina = await person(owner, { firstName: "Nina", lastName: "Named", email: "nina@named-links.test" });
    const paul = await person(owner, { firstName: "Paul", lastName: "Pat", email: "paul@pat-links.test" });
    const importId = await unfiled(
      "teams",
      [
        { name: "Nina Named", email: null },
        { name: "Paul Pat", email: null },
        { name: "Mark Ridgeon", email: null },
        { name: "Unknown Person", email: null },
      ],
      "Teams call",
    );
    const filed = await fileImport(owner, importId, nina, { summarise: false });
    assert.deepEqual(await linkedIds(filed.activityId), [nina, paul].sort());
    const rows = await admin<{ contact_id: string }>("select contact_id from crm.activities where id = $1", [filed.activityId]);
    assert.equal(rows[0].contact_id, nina);
  });

  it("links the other recognised attendees when a meeting is filed from Capture", async () => {
    const importId = await unfiled(
      "granola",
      [
        { name: "Anna Acme", email: "anna@acme-links.test" },
        { name: "Ben Brook", email: "ben@brook-links.test" },
        { name: "Priya Shah", email: "priya@eclipse-links.test" },
        { name: "Mark", email: owner.email },
      ],
      "Catch-up",
    );
    const filed = await fileImport(owner, importId, ben, { summarise: false });
    assert.deepEqual(await linkedIds(filed.activityId), [anna, ben].sort());
    const rows = await admin<{ contact_id: string }>("select contact_id from crm.activities where id = $1", [filed.activityId]);
    assert.equal(rows[0].contact_id, ben);
  });

  it("promotes a named attendee to the main contact when only the company matched by email", async () => {
    const eve = await person(owner, { firstName: "Eve", lastName: "Eden", email: "eve@eden-links.test" });
    await fileGranolaNote(
      owner,
      granolaNote("links-g4", [
        { name: "Unknown Acme", email: "unknown@acme-links.test" },
        { name: "Eve Eden", email: null },
      ]),
    );
    const meeting = await granolaActivity("links-g4");
    assert.equal(meeting.contact_id, eve);
    assert.deepEqual(await linkedIds(meeting.id), [eve]);
  });

  it("does not keep the person a meeting was filed to once the meeting moves to someone else", async () => {
    const importId = await unfiled("granola", [{ name: "Ben Brook", email: "ben@brook-links.test" }], "Wrong person");
    const filed = await fileImport(owner, importId, carl, { summarise: false });
    assert.deepEqual(await linkedIds(filed.activityId), [ben, carl].sort());
    assert.deepEqual(
      (await linked(filed.activityId)).find((row) => row.contact_id === carl),
      { contact_id: carl, implicit: true },
    );
    await admin("update crm.activities set contact_id = $2 where id = $1", [filed.activityId, ben]);
    assert.deepEqual(await linkedIds(filed.activityId), [ben]);
  });

  it("counts a linked meeting in the relationship of each attendee", async () => {
    const zoe = await person(owner, { firstName: "Zoe", lastName: "Zero", email: "zoe@zero-links.test" });
    const found = await relationshipsFor(owner, "contact", [ben, carl, zoe]);
    assert.notEqual(found[ben].reason, found[zoe].reason);
    assert.doesNotMatch(found[ben].reason, /yet/i);
    assert.doesNotMatch(found[carl].reason, /yet/i);
    assert.match(found[zoe].reason, /yet/i);
  });
});

describe("adding and removing people on an activity", () => {
  useServerlessPool();

  it("adds and removes a person, with an audit event for each change", async () => {
    const note = (await createActivity(owner, { type: "meeting", title: "Board lunch", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    assert.deepEqual(note.contactIds, [anna]);

    const added = await addActivityContact(owner, note.id, carl, { operation: "add_activity_person", source: "web" });
    assert.equal(added.changed, true);
    assert.deepEqual([...added.contactIds].sort(), [anna, carl].sort());
    assert.equal((await addActivityContact(owner, note.id, carl, { operation: "add_activity_person", source: "web" })).changed, false);
    assert.equal((await addActivityContact(owner, note.id, anna, { operation: "add_activity_person", source: "web" })).changed, false);

    await assert.rejects(
      removeActivityContact(owner, note.id, anna, { operation: "remove_activity_person", source: "web" }),
      /Change the person on the activity/,
    );
    const removed = await removeActivityContact(owner, note.id, carl, { operation: "remove_activity_person", source: "web" });
    assert.equal(removed.changed, true);
    assert.deepEqual(await linkedIds(note.id), [anna]);
    assert.equal((await removeActivityContact(owner, note.id, carl, { operation: "remove_activity_person", source: "web" })).changed, false);

    const audit = await admin<{ operation: string; source: string; changes: { fields: string[]; after: { attendees: string[] } } }>(
      `select operation, source, changes from crm.audit_events
       where entity_id = $1 and event_type = 'activity.updated' order by created_at, id`,
      [note.id],
    );
    assert.deepEqual(audit.map((row) => row.operation), ["add_activity_person", "remove_activity_person"]);
    assert.ok(audit.every((row) => row.source === "web" && row.changes.fields[0] === "attendees"));
    assert.deepEqual([...audit[0].changes.after.attendees].sort(), [anna, carl].sort());
  });

  it("refuses a member who can't edit the activity, and changes nothing", async () => {
    const note = (await createActivity(owner, { type: "meeting", title: "Pricing call", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, note.id, carl, PROVENANCE);
    await assert.rejects(addActivityContact(colleagueMember, note.id, ben, PROVENANCE), /Only its author, owners and admins/);
    await assert.rejects(removeActivityContact(colleagueMember, note.id, carl, PROVENANCE), /Only its author, owners and admins/);
    assert.deepEqual([...(await linkedIds(note.id))].sort(), [anna, carl].sort());
  });

  it("only links people from the activity's own workspace who are not archived", async () => {
    const note = (await createActivity(owner, { type: "meeting", title: "Another", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    const elsewhere = await person(ridgeon, { firstName: "Ravi", lastName: "Rao", email: "ravi@ridgeon-links.test" });
    await assert.rejects(addActivityContact(owner, note.id, elsewhere, PROVENANCE), /not found|Couldn't find|isn't|No contact/i);
    const gone = await person(owner, { firstName: "Gus", lastName: "Gone", email: "gus@gone-links.test" });
    await archiveContact(owner, gone, { provenance: PROVENANCE });
    await assert.rejects(addActivityContact(owner, note.id, gone, PROVENANCE));
    await assert.rejects(
      admin("insert into crm.activity_contacts (activity_id, contact_id) values ($1, $2)", [note.id, elsewhere]),
      /another workspace/,
    );
    assert.deepEqual(await linkedIds(note.id), [anna]);
  });

  it("keeps an attendee when the main contact changes, and drops a main-only link", async () => {
    const logged = (await createActivity(owner, { type: "note", body: "Spoke to Anna", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    assert.deepEqual(await linked(logged.id), [{ contact_id: anna, implicit: true }]);
    await updateActivity(owner, logged.id, { contactId: carl }, PROVENANCE);
    assert.deepEqual(await linked(logged.id), [{ contact_id: carl, implicit: true }]);

    const meeting = (await createActivity(owner, { type: "meeting", title: "Panel", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, meeting.id, ben, PROVENANCE);
    await admin("update crm.activities set contact_id = $2 where id = $1", [meeting.id, ben]);
    assert.deepEqual(await linked(meeting.id), [{ contact_id: ben, implicit: false }]);

    const panel = (await createActivity(owner, { type: "meeting", title: "Round table", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    await admin("update crm.activity_contacts set implicit = false where activity_id = $1 and contact_id = $2", [panel.id, anna]);
    await addActivityContact(owner, panel.id, ben, PROVENANCE);
    await admin("update crm.activities set contact_id = $2 where id = $1", [panel.id, carl]);
    assert.deepEqual(await linkedIds(panel.id), [anna, ben, carl].sort());
    await admin("update crm.activities set contact_id = null where id = $1", [panel.id]);
    assert.deepEqual(await linkedIds(panel.id), [anna, ben].sort());
  });

  it("keeps a merged person's meetings on the person they were merged into", async () => {
    const keep = await person(owner, { firstName: "Mo", lastName: "Merge", email: "mo@merge-links.test" });
    const dupe = await person(owner, { firstName: "Mo", lastName: "Merged", email: "mo.dupe@merge-links.test" });
    const meeting = (await createActivity(owner, { type: "meeting", title: "Merge lunch", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, meeting.id, dupe, PROVENANCE);
    await mergeContacts(owner, keep, dupe, PROVENANCE);
    const ids = await linkedIds(meeting.id);
    assert.ok(ids.includes(keep));
    assert.ok(!ids.includes(dupe));
  });
});

describe("workspaces and privacy", () => {
  useServerlessPool();

  it("never keeps a link across workspaces after a move", async () => {
    const company = (await createCompany(owner, { name: "Movers", domain: "movers-links.test" }, { provenance: PROVENANCE })).body.company.id;
    const mia = await person(owner, { firstName: "Mia", lastName: "Mover", email: "mia@movers-links.test", companyId: company });
    const noah = await person(owner, { firstName: "Noah", lastName: "Stays", email: "noah@stays-links.test" });
    const trip = (await createActivity(owner, { type: "meeting", title: "Trip", contactId: noah }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, trip.id, mia, PROVENANCE);
    const lunch = (await createActivity(owner, { type: "meeting", title: "Lunch", contactId: mia }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, lunch.id, noah, PROVENANCE);

    await moveRecordsToWorkspace(owner, { contactIds: [mia], workspaceId: ridgeon.workspaceId, includeCompany: false }, PROVENANCE);

    assert.deepEqual(await linkedIds(trip.id), [noah]);
    assert.deepEqual(await linkedIds(lunch.id), [mia]);
    const crossing = await admin(
      `select l.activity_id from crm.activity_contacts l
       join crm.activities a on a.id = l.activity_id
       join crm.contacts c on c.id = l.contact_id
       where a.workspace_id <> c.workspace_id`,
    );
    assert.deepEqual(crossing, []);
    const movedActivity = await admin<{ workspace_id: string }>("select workspace_id from crm.activities where id = $1", [lunch.id]);
    assert.equal(movedActivity[0].workspace_id, ridgeon.workspaceId);
  });

  it("shows links only to members of the activity's workspace", async () => {
    const meeting = (await createActivity(owner, { type: "meeting", title: "Private-ish", contactId: anna }, { provenance: PROVENANCE })).body.activity;
    await addActivityContact(owner, meeting.id, carl, PROVENANCE);
    const asMember = await queryAsUser<{ contact_id: string }>(owner.userId, "select contact_id from crm.activity_contacts where activity_id = $1", [meeting.id]);
    assert.equal(asMember.length, 2);
    const asOutsider = await queryAsUser<{ contact_id: string }>(outsider.userId, "select contact_id from crm.activity_contacts where activity_id = $1", [meeting.id]);
    assert.deepEqual(asOutsider, []);
    const everything = await queryAsUser<{ total: number }>(outsider.userId, "select count(*)::int as total from crm.activity_contacts");
    assert.equal(everything[0].total, 0);
    await assert.rejects(
      queryAsUser(outsider.userId, "insert into crm.activity_contacts (activity_id, contact_id) values ($1, $2)", [meeting.id, carl]),
    );
    await assert.rejects(removeActivityContact(outsider, meeting.id, carl, PROVENANCE), /not found|Couldn't find|isn't|No activity/i);
  });
});

describe("backfill", () => {
  it("links the main contact of old activities and the attendees of filed imports, and is safe to run twice", async () => {
    const gone = await person(owner, { firstName: "Archie", lastName: "Gone", email: "archie@backfill-links.test" });
    await archiveContact(owner, gone, { provenance: PROVENANCE });
    const old = await admin<{ id: string }>(
      `insert into crm.activities (workspace_id, type, title, contact_id, company_id, metadata)
       values ($1, 'meeting', 'Old meeting', $2, $3, '{}'::jsonb) returning id`,
      [owner.workspaceId, anna, acme],
    );
    const noteOnly = await admin<{ id: string }>(
      `insert into crm.activities (workspace_id, type, title, contact_id, metadata)
       values ($1, 'note', 'Old note', $2, '{}'::jsonb) returning id`,
      [owner.workspaceId, carl],
    );
    await admin(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, participants, status, activity_id, contact_id)
       values ($1, $2, 'granola', 'backfill-links-1', 'meeting', 'Old meeting', $3::jsonb, 'filed', $4, $5)`,
      [
        owner.workspaceId,
        owner.userId,
        JSON.stringify([
          { name: "Anna Acme", email: "anna@acme-links.test" },
          { name: "Ben Brook", email: "BEN@brook-links.test" },
          { name: "Priya Shah", email: "priya@eclipse-links.test" },
          { name: "Archie", email: "archie@backfill-links.test" },
          { name: "Mark", email: owner.email },
          { name: "Jane Alias", email: "jane@ridgeon-alias-links.test" },
          { name: "Nobody", email: null },
        ]),
        old[0].id,
        anna,
      ],
    );
    await person(owner, { firstName: "Jane", lastName: "Alias", email: "jane@ridgeon-alias-links.test" });
    await admin(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
       values ($1, $2, 'microsoft', 'mark@ridgeon-alias-links.test', 'connected', $3, $4, now() + interval '1 hour', true)`,
      [owner.workspaceId, owner.userId, encryptSecret("links-refresh"), encryptSecret("links-access")],
    );
    await admin("delete from crm.activity_contacts where activity_id = any($1::uuid[])", [[old[0].id, noteOnly[0].id]]);

    await reapplyMigrationsFrom("20270309100000_activity_contacts.sql");
    const first = await linked(old[0].id);
    assert.deepEqual(
      first.sort((left, right) => left.contact_id.localeCompare(right.contact_id)),
      [
        { contact_id: anna, implicit: false },
        { contact_id: ben, implicit: false },
      ].sort((left, right) => left.contact_id.localeCompare(right.contact_id)),
    );
    assert.deepEqual(await linked(noteOnly[0].id), [{ contact_id: carl, implicit: true }]);

    await reapplyMigrationsFrom("20270309100000_activity_contacts.sql");
    assert.deepEqual(await linked(noteOnly[0].id), [{ contact_id: carl, implicit: true }]);
    assert.equal((await linked(old[0].id)).length, 2);
  });
});
