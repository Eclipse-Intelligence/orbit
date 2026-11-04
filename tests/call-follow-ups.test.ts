import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { captureStatus } from "@/lib/crm/capture";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { callsWithoutNextStep, closeFollowUp, followUpCalls, followUpDueAt, listFollowUps } from "@/lib/crm/follow-ups";
import { saveMailbox } from "@/lib/crm/inbox";
import { createOpportunity, updateOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { syncMail } from "@/lib/mail/sync";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const NOW = Date.parse("2026-10-29T16:00:00Z");
const TUESDAY_CALL = "2026-10-27T14:00:00Z";

function mailbox(state: { inbox: unknown[]; sent: unknown[] }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    const value = folder ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
}

function sentMessage(id: string, to: string, at: string) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: "Next steps",
    bodyPreview: "",
    body: { contentType: "text", content: "Thanks for today. Here are the next steps." },
    from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
    toRecipients: [{ emailAddress: { name: "Someone", address: to } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: at,
    receivedDateTime: at,
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
  };
}

function model(replies: unknown[]) {
  const prompts: { system: string; user: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push({ system: body.messages[0].content, user: body.messages[1].content });
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(replies.shift()) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, prompts };
}

const DRAFT = {
  label: "Demo",
  subject: "Following up on the Acme demo",
  body: "Hi Jane,\n\nThanks for your time on Tuesday. As a next step, how about 30 minutes next week to scope the import?\n\nMark",
};

let seeded = 0;

async function seedCall(
  owner: UserActor,
  options: { name?: string; deal?: "open" | "lost" | null; occurredAt?: string; source?: "granola" | "teams"; actionItems?: unknown[] } = {},
) {
  seeded += 1;
  const domain = `acme-${seeded}.test`;
  const company = (await createCompany(owner, { name: options.name ?? `Acme ${seeded}`, domain })).body.company.id;
  const contact = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: `jane@${domain}`, companyId: company })).body.contact.id;
  const deal = options.deal === undefined ? "open" : options.deal;
  if (deal) {
    const opportunity = (await createOpportunity(owner, { companyId: company, name: "Pilot" })).body.opportunity.id;
    if (deal === "lost") await updateOpportunity(owner, opportunity, { status: "lost" });
  }
  const occurredAt = options.occurredAt ?? TUESDAY_CALL;
  const activity = (await createActivity(owner, { type: "meeting", title: "Acme demo", occurredAt, contactId: contact, companyId: company })).body.activity.id;
  const admin = getAdminPool();
  await admin.query(
    `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, occurred_at, ended_at, participants, status, activity_id, contact_id, company_id)
     values ($1, $2, $3, $4, 'meeting', 'Acme demo', $5, $5::timestamptz + interval '30 minutes', $6::jsonb, 'filed', $7, $8, $9)`,
    [owner.workspaceId, owner.userId, options.source ?? "granola", `note-${seeded}`, occurredAt, JSON.stringify([{ name: "Jane Doe", email: `jane@${domain}` }]), activity, contact, company],
  );
  await admin.query(
    `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, status, summary, key_points, action_items)
     values ($1, $2, $3, $4, $5, 'Jane: we need one pipeline.', 'ready', 'Jane wants one shared pipeline and a clean HubSpot import before April.', '["One pipeline"]'::jsonb, $6::jsonb)`,
    [owner.workspaceId, activity, contact, company, options.source ?? "granola", JSON.stringify(options.actionItems ?? [])],
  );
  return { company, contact, activity, domain };
}

async function addMeeting(owner: UserActor, attendee: string, start: Date) {
  const admin = getAdminPool();
  const connection = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId])).rows[0].id;
  const calendar =
    (await admin.query<{ id: string }>("select id from crm.calendars where user_id = $1", [owner.userId])).rows[0]?.id ??
    (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, 'cal-follow', 'Calendar', '#4f9be8', true, true, true, true) returning id`,
        [owner.workspaceId, owner.userId, connection],
      )
    ).rows[0].id;
  await admin.query(
    `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, organizer, attendees)
     values ($1, $2, $3, $4, $5, 'Scoping', $6, $7, $8::jsonb, $9::jsonb)`,
    [owner.workspaceId, calendar, connection, owner.userId, `evt-${attendee}`, start, new Date(start.getTime() + 30 * 60_000), JSON.stringify({ email: owner.email }), JSON.stringify([{ email: attendee, name: "Ops" }])],
  );
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
});

describe("calls that ended with no next step", () => {
  it("waits two working days, skipping the weekend and bank holidays", () => {
    assert.equal(followUpDueAt("2026-10-27T14:00:00Z", "Europe/London"), Date.parse("2026-10-29T14:00:00Z"));
    assert.equal(followUpDueAt("2026-10-23T15:00:00Z", "Europe/London"), Date.parse("2026-10-27T16:00:00Z"), "Friday 16:00 waits until Tuesday");
    assert.equal(followUpDueAt("2026-10-27T19:30:00Z", "Europe/London"), Date.parse("2026-10-29T09:00:00Z"), "an evening call counts from 09:00");
    assert.equal(followUpDueAt("2026-12-23T11:00:00Z", "Europe/London"), Date.parse("2027-01-05T11:00:00Z"), "the Christmas break doesn't count");
  });

  describe("which calls qualify", () => {
    let owner: UserActor;

    before(async () => {
      owner = await createUser("rules@orbit.test", "Mark Ridgeon");
      await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    });

    it("flags a call with an open deal and nothing since, but not one with no open deal", async () => {
      const open = await seedCall(owner);
      const none = await seedCall(owner, { deal: null });
      const lost = await seedCall(owner, { deal: "lost" });
      const ids = (await callsWithoutNextStep(owner, NOW)).map((row) => row.activity_id);
      assert.ok(ids.includes(open.activity));
      assert.ok(!ids.includes(none.activity), "no deal");
      assert.ok(!ids.includes(lost.activity), "a lost deal isn't open");
    });

    it("counts an email the user sent to anyone at the company since the call", async () => {
      const emailed = await seedCall(owner);
      const before = await seedCall(owner);
      await syncMail(owner, {
        budgetMs: 30_000,
        fetchImpl: mailbox({
          inbox: [],
          sent: [sentMessage("sent-after", `ops@${emailed.domain}`, "2026-10-28T09:00:00Z"), sentMessage("sent-before", `jane@${before.domain}`, "2026-10-26T09:00:00Z")],
        }),
      });
      const ids = (await callsWithoutNextStep(owner, NOW)).map((row) => row.activity_id);
      assert.ok(!ids.includes(emailed.activity), "an email to a colleague at the company is a next step");
      assert.ok(ids.includes(before.activity), "an email from before the call doesn't count");
    });

    it("counts an upcoming meeting with them", async () => {
      const booked = await seedCall(owner);
      await addMeeting(owner, `ops@${booked.domain}`, new Date(Date.now() + 5 * 86_400_000));
      const ids = (await callsWithoutNextStep(owner, NOW)).map((row) => row.activity_id);
      assert.ok(!ids.includes(booked.activity));
    });

    it("counts an accepted action item or an open task created since the call", async () => {
      const accepted = await seedCall(owner, {
        actionItems: [{ id: "a1", title: "Send the pilot proposal", owner: "me", dueDate: null, status: "accepted", taskId: null }],
      });
      const tasked = await seedCall(owner);
      await createTask(owner, { title: "Send Acme the import plan", companyId: tasked.company });
      const done = await seedCall(owner);
      await createTask(owner, { title: "Old task", companyId: done.company, completed: true });
      const ids = (await callsWithoutNextStep(owner, NOW)).map((row) => row.activity_id);
      assert.ok(!ids.includes(accepted.activity));
      assert.ok(!ids.includes(tasked.activity));
      assert.ok(ids.includes(done.activity), "a completed task isn't an open next step");
    });

    it("waits two working days and looks back no further than 14 days", async () => {
      const friday = await seedCall(owner, { occurredAt: "2026-10-23T15:00:00Z" });
      const monday = Date.parse("2026-10-26T17:00:00Z");
      assert.ok(!(await callsWithoutNextStep(owner, monday)).some((row) => row.activity_id === friday.activity), "Friday's call isn't due on Monday");
      assert.ok((await callsWithoutNextStep(owner, Date.parse("2026-10-27T16:30:00Z"))).some((row) => row.activity_id === friday.activity), "due on Tuesday");
      const old = await seedCall(owner, { occurredAt: "2026-10-13T10:00:00Z" });
      assert.ok(!(await callsWithoutNextStep(owner, NOW)).some((row) => row.activity_id === old.activity), "older than 14 days");
    });
  });

  describe("drafting and flagging", () => {
    let owner: UserActor;

    before(async () => {
      process.env.LLM_API_KEY = "test-llm-key";
      owner = await createUser("flag@orbit.test", "Mark Ridgeon");
      await saveMailbox(owner, { email: "mark@flag.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    });

    it("drafts once, shows it in Capture and sends one bell notification", async () => {
      const call = await seedCall(owner, { name: "Acme", source: "teams" });
      const { fetchImpl, prompts } = model([DRAFT]);
      const report = await followUpCalls(owner, { deadline: Date.now() + 60_000, fetchImpl, now: NOW });
      assert.equal(report.drafted, 1);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0].user, /one shared pipeline/);
      assert.match(prompts[0].system, /one concrete proposed next step/);

      const listed = await listFollowUps(owner);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].source, "teams");
      assert.equal(listed[0].title, "Demo with Acme ended with no next step");
      assert.equal(listed[0].line, "Tue 27 Oct with Jane Doe. Nothing has gone to Jane since. Orbit drafted a follow-up.");
      assert.deepEqual(listed[0].to, { name: "Jane Doe", address: `jane@${call.domain}` });
      assert.equal(listed[0].subject, DRAFT.subject);

      const bell = await getAdminPool().query<{ title: string; href: string }>("select title, href from crm.notifications where user_id = $1", [owner.userId]);
      assert.deepEqual(bell.rows, [{ title: "Demo with Acme ended with no next step", href: "/capture" }]);

      const status = await captureStatus(owner);
      assert.equal(status.followUps, 1);
      assert.equal(status.waiting, 1);
      assert.equal(status.fresh, 1, "a new follow-up counts toward the Capture dot");

      const again = model([DRAFT]);
      const second = await followUpCalls(owner, { deadline: Date.now() + 60_000, fetchImpl: again.fetchImpl, now: NOW });
      assert.equal(second.drafted, 0);
      assert.equal(again.prompts.length, 0, "flagged once, no second draft");

      await closeFollowUp(owner, listed[0].id, "dismissed");
      assert.equal((await listFollowUps(owner)).length, 0);
      const third = model([DRAFT]);
      await followUpCalls(owner, { deadline: Date.now() + 60_000, fetchImpl: third.fetchImpl, now: NOW });
      assert.equal(third.prompts.length, 0, "Not needed stays dismissed");
      assert.equal((await getAdminPool().query("select 1 from crm.notifications where user_id = $1", [owner.userId])).rowCount, 1);
    });

    it("clears a waiting follow-up once the user writes to the company", async () => {
      const call = await seedCall(owner);
      await followUpCalls(owner, { deadline: Date.now() + 60_000, fetchImpl: model([DRAFT]).fetchImpl, now: NOW });
      assert.ok((await listFollowUps(owner)).length >= 1);
      await syncMail(owner, { budgetMs: 30_000, fetchImpl: mailbox({ inbox: [], sent: [{ ...sentMessage("sent-follow", `jane@${call.domain}`, "2026-10-29T10:00:00Z"), from: { emailAddress: { name: "Mark", address: "mark@flag.test" } } }] }) });
      const report = await followUpCalls(owner, { deadline: Date.now() + 60_000, fetchImpl: model([]).fetchImpl, now: NOW });
      assert.equal(report.settled, 1);
      assert.equal((await listFollowUps(owner)).length, 0);
    });

    it("keeps suggestions private to the person whose call it was", async () => {
      const admin = getAdminPool();
      const colleagueId = (await admin.query<{ id: string }>("select private.create_local_user('colleague@flag.test', 'password-123', 'Colleague') as id")).rows[0].id;
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, colleagueId]);
      const colleague: UserActor = { ...owner, userId: colleagueId, email: "colleague@flag.test", fullName: "Colleague", role: "member", scopes: scopesForRole("member") };
      assert.ok((await queryAsUser(owner.userId, "select id from crm.follow_up_suggestions")).length > 0);
      assert.equal((await queryAsUser(colleagueId, "select id from crm.follow_up_suggestions")).length, 0);
      assert.deepEqual(await listFollowUps(colleague), []);
      const row = (await admin.query<{ id: string; activity_id: string }>("select id, activity_id from crm.follow_up_suggestions where user_id = $1 and state <> 'dismissed' limit 1", [owner.userId])).rows[0];
      await assert.rejects(
        queryAsUser(colleagueId, "insert into crm.follow_up_suggestions (workspace_id, user_id, activity_id, source, call_at) values ($1, $2, $3, 'teams', now())", [owner.workspaceId, owner.userId, row.activity_id]),
      );
      await queryAsUser(colleagueId, "update crm.follow_up_suggestions set state = 'dismissed' where id = $1", [row.id]);
      assert.notEqual((await admin.query<{ state: string }>("select state from crm.follow_up_suggestions where id = $1", [row.id])).rows[0].state, "dismissed");
    });
  });
});
