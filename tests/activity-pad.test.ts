import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { activityHeadline, parseActivityText } from "@/lib/activity-pad";
import { listActivities } from "@/lib/crm/activities";
import { activitySuggestions, logPadActivity } from "@/lib/crm/activity-pad";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { encodeMentions } from "@/lib/mentions";
import { createUser, resetDatabase } from "./helpers";

const FRIDAY_2PM = new Date("2026-10-16T13:00:00Z");

describe("activity pad parser", () => {
  it("reads the kind of activity from how it's written", () => {
    const cases: [string, string, boolean][] = [
      ["Called Jane about pricing", "call", true],
      ["Spoke with Raj, all good", "call", true],
      ["Emailed Sam the proposal", "email", true],
      ["Met the Acme team", "meeting", true],
      ["Coffee with Tom", "meeting", true],
      ["Budget approved for Q1", "note", false],
    ];
    for (const [text, type, found] of cases) {
      const parsed = parseActivityText(text, FRIDAY_2PM);
      assert.equal(parsed.type, type, text);
      assert.equal(parsed.typeFound, found, text);
    }
  });

  it("reads when it happened, looking backwards", () => {
    const cases: [string, string | null][] = [
      ["Called Jane", null],
      ["Met Acme yesterday afternoon", "2026-10-15T14:00"],
      ["Coffee with Tom on Tuesday at 8.30am", "2026-10-13T08:30"],
      ["Call this morning", "2026-10-16T09:30"],
      ["Had a call at 11:15 with Raj", "2026-10-16T11:15"],
      ["Met Priya 3 days ago", "2026-10-13T12:00"],
      ["Workshop last week", "2026-10-09T12:00"],
      ["Spoke on Friday", "2026-10-16T14:00"],
    ];
    for (const [text, when] of cases) assert.equal(parseActivityText(text, FRIDAY_2PM).when, when, text);
  });

  it("spots a follow-up deadline without mistaking it for when it happened", () => {
    const parsed = parseActivityText("Called Jane, she wants revised pricing by Friday", FRIDAY_2PM);
    assert.deepEqual(parsed.followUp, { due: "2026-10-23T09:00" });
    assert.equal(parsed.when, null);
    assert.deepEqual(
      parsed.marks.map((mark) => mark.kind),
      ["type", "followup"],
    );
    assert.deepEqual(parseActivityText("Emailed Sam, chase next week", FRIDAY_2PM).followUp, { due: "2026-10-19T09:00" });
    assert.deepEqual(parseActivityText("Met Tom, follow up in 2 days", FRIDAY_2PM).followUp, { due: "2026-10-18T09:00" });
    assert.equal(parseActivityText("Met Tom by the river", FRIDAY_2PM).followUp, null);
  });

  it("makes a short headline", () => {
    assert.equal(activityHeadline("Called Jane. She wants pricing."), "Called Jane");
    assert.equal(activityHeadline("x".repeat(200)).length, 120);
  });
});

describe("logging from the pad", () => {
  let owner: UserActor;
  let companyId: string;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("pad-activity@orbit.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Acme Pad", domain: "acme-pad-activity.test" })).body.company.id;
    contactId = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId, email: "jane@acme-pad-activity.test" })).body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("logs against the tagged person and their company, with a follow-up task", async () => {
    const text = encodeMentions("Called @Jane Doe, she wants revised pricing by Friday", [{ kind: "contact", id: contactId, name: "Jane Doe" }]);
    const result = await logPadActivity(owner, {
      text,
      type: "call",
      when: "2026-10-16T11:00",
      contactId: null,
      companyId: null,
      title: null,
      followUp: { title: "Send Jane revised pricing", due: "2026-10-23T09:00" },
      eventId: null,
    });
    assert.equal(result.warning, null);
    const activity = result.activity;
    assert.equal(activity.type, "call");
    assert.equal(activity.contactId, contactId);
    assert.equal(activity.companyId, companyId);
    assert.equal(activity.title, "Called Jane Doe, she wants revised pricing by Friday");
    assert.equal(activity.body, null);
    assert.equal(activity.occurredAt, "2026-10-16T10:00:00.000Z");
    assert.equal(activity.metadata.source, "pad");
    const tasks = await listTasks(owner, { query: "revised pricing" });
    assert.equal(tasks.data.length, 1);
    assert.equal(tasks.data[0].contactId, contactId);
    assert.equal(tasks.data[0].dueAt, "2026-10-23T08:00:00.000Z");
  });

  it("keeps long notes in the body under a short title, and needs someone tagged", async () => {
    const long = `Met the team. ${"They walked us through the roadmap in detail. ".repeat(5)}`;
    const result = await logPadActivity(owner, {
      text: long,
      type: "meeting",
      when: null,
      contactId: null,
      companyId,
      title: "Roadmap walkthrough with Acme",
      followUp: null,
      eventId: null,
    });
    assert.equal(result.activity.title, "Roadmap walkthrough with Acme");
    assert.equal(result.activity.body, long.trim());
    await assert.rejects(
      logPadActivity(owner, { text: "Called someone", type: "call", when: null, contactId: null, companyId: null, title: null, followUp: null, eventId: null }),
      /Tag who it was with/,
    );
  });

  it("suggests today's finished meetings until they're logged", async () => {
    await saveMailbox(owner, {
      email: "mark@orbit.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const admin = getAdminPool();
    const connection = await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId]);
    const calendar = await admin.query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm)
       values ($1, $2, $3, 'cal-pad', 'Calendar', '#4f9be8', true, true, true) returning id`,
      [owner.workspaceId, owner.userId, connection.rows[0].id],
    );
    const now = new Date("2026-10-16T15:00:00Z");
    const insert = (subject: string, start: string, end: string, contacts: string[]) =>
      admin.query<{ id: string }>(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, contact_ids)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[]) returning id`,
        [owner.workspaceId, calendar.rows[0].id, connection.rows[0].id, owner.userId, subject, subject, start, end, contacts],
      );
    const done = await insert("Acme pricing review", "2026-10-16T13:00:00Z", "2026-10-16T13:30:00Z", [contactId]);
    await insert("Later today", "2026-10-16T16:00:00Z", "2026-10-16T17:00:00Z", [contactId]);
    await insert("Internal standup", "2026-10-16T09:00:00Z", "2026-10-16T09:15:00Z", []);
    await insert("Last week", "2026-10-09T13:00:00Z", "2026-10-09T14:00:00Z", [contactId]);

    const suggestions = await activitySuggestions(owner, now);
    assert.deepEqual(
      suggestions.map((item) => [item.subject, item.contacts.map((contact) => contact.name)]),
      [["Acme pricing review", ["Jane Doe"]]],
    );
    await logPadActivity(owner, {
      text: "Met Jane, good review",
      type: "meeting",
      when: "2026-10-16T14:00",
      contactId,
      companyId: null,
      title: null,
      followUp: null,
      eventId: done.rows[0].id,
    });
    assert.deepEqual(await activitySuggestions(owner, now), []);
    const logged = await listActivities(owner, { contactId, limit: 10 });
    assert.ok(logged.data.some((activity) => activity.metadata.eventId === done.rows[0].id));
  });
});
