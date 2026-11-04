import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { briefTitle, getConversation, listConversations, openBrief, sendMessage } from "@/lib/assistant/chat";
import { briefKey, opensBriefOnExpand, pendingBrief } from "@/lib/assistant/brief-dock";
import { captureStatus, connectionAlert, listToFile, markCaptureSeen } from "@/lib/crm/capture";
import { archiveActivity, createActivity, listActivities, listActivityAgents } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { activityQueryFromSearchParams, companyQueryFromSearchParams } from "@/lib/crm/validation";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { insertMemory } from "@/lib/learning/memories";
import { runUnit, unreadBrief } from "@/lib/learning/nightly";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

const DAY_MS = 86_400_000;

async function teammate(owner: UserActor, email: string, name: string): Promise<UserActor> {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, id]);
  return { ...owner, userId: id, email, fullName: name, role: "member", scopes: scopesForRole("member") };
}

let imports = 0;

async function addImport(actor: UserActor, status: "unfiled" | "pending", title: string) {
  imports += 1;
  const result = await getAdminPool().query<{ id: string }>(
    `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, occurred_at, status)
     values ($1, $2, 'granola', $3, 'meeting', $4, now() - interval '1 hour', $5) returning id`,
    [actor.workspaceId, actor.userId, `tidy-${imports}`, title, status],
  );
  return result.rows[0].id;
}

async function addMeeting(actor: UserActor, providerId: string, attendee: string | string[], start = new Date(Date.now() - 2 * DAY_MS)) {
  const admin = getAdminPool();
  const connection = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [actor.userId])).rows[0].id;
  const calendar =
    (await admin.query<{ id: string }>("select id from crm.calendars where user_id = $1", [actor.userId])).rows[0]?.id ??
    (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, 'cal-tidy', 'Calendar', '#4f9be8', true, true, true, true) returning id`,
        [actor.workspaceId, actor.userId, connection],
      )
    ).rows[0].id;
  const attendees = (Array.isArray(attendee) ? attendee : [attendee]).map((email) => ({ email, name: "Outside Person" }));
  await admin.query(
    `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, organizer, attendees)
     values ($1, $2, $3, $4, $5, 'Intro', $6, $7, $8::jsonb, $9::jsonb)`,
    [
      actor.workspaceId,
      calendar,
      connection,
      actor.userId,
      providerId,
      start,
      new Date(start.getTime() + 30 * 60_000),
      JSON.stringify({ email: actor.email, name: actor.fullName }),
      JSON.stringify(attendees),
    ],
  );
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  delete process.env.LLM_API_KEY;
  await getPool().end();
});

describe("Gone quiet filter on Companies", () => {
  it("lists only companies with no interaction in the last 21 days", async () => {
    const owner = await createUser("quiet-filter@orbit.test", "Mark Ridgeon");
    const recent = (await createCompany(owner, { name: "Recent Co", domain: "recent-quiet.test" })).body.company.id;
    const old = (await createCompany(owner, { name: "Old Co", domain: "old-quiet.test" })).body.company.id;
    const never = (await createCompany(owner, { name: "Never Co", domain: "never-quiet.test" })).body.company.id;
    const archived = (await createCompany(owner, { name: "Archived Note Co", domain: "archived-quiet.test" })).body.company.id;
    await createActivity(owner, { type: "call", title: "Catch up", companyId: recent, occurredAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
    await createActivity(owner, { type: "note", body: "Old note", companyId: old, occurredAt: new Date(Date.now() - 40 * DAY_MS).toISOString() });
    const hidden = await createActivity(owner, { type: "note", body: "Logged by mistake", companyId: archived });
    await archiveActivity(owner, hidden.body.activity.id, { operation: "archive_activity", source: "web" });

    const filters = companyQueryFromSearchParams(new URLSearchParams("quiet=true"));
    assert.equal(filters.quiet, true);
    assert.equal(companyQueryFromSearchParams(new URLSearchParams("quiet=1")).quiet, undefined);

    const listed = await listCompanies(owner, { ...filters, relationships: true });
    const ids = listed.data.map((company) => company.id);
    assert.deepEqual(new Set(ids), new Set([old, never, archived]));
    assert.equal(listed.total, 3);
    assert.ok(listed.data.every((company) => company.relationship), "each quiet company keeps its relationship label");

    const everyone = await listCompanies(owner, {});
    assert.equal(everyone.total, 4);
  });
});

describe("Activity log", () => {
  it("filters by who logged it, type and dates, and every member can read it", async () => {
    const owner = await createUser("activity-log@orbit.test", "Mark Ridgeon");
    const sam = await teammate(owner, "sam@activity-log.test", "Sam Taylor");
    const acme = (await createCompany(owner, { name: "Acme Log", domain: "acme-log.test" })).body.company.id;
    await createActivity(owner, { type: "note", body: "Mark's note", companyId: acme, occurredAt: "2026-10-01T10:00:00Z" });
    await createActivity(sam, { type: "call", title: "Sam called", companyId: acme, occurredAt: "2026-10-02T10:00:00Z" });
    await createActivity(sam, { type: "note", body: "Sam's note", companyId: acme, occurredAt: "2026-10-05T10:00:00Z" });

    const mine = await listActivities(owner, { actorUserId: owner.userId });
    assert.deepEqual(mine.data.map((activity) => activity.body), ["Mark's note"]);

    const hers = await listActivities(owner, { actorUserId: sam.userId });
    assert.equal(hers.total, 2);
    assert.ok(hers.data.every((activity) => activity.actorUserId === sam.userId && activity.actorName === "Sam Taylor"));

    const calls = await listActivities(owner, { actorUserId: sam.userId, type: "call" });
    assert.deepEqual(calls.data.map((activity) => activity.title), ["Sam called"]);

    const range = activityQueryFromSearchParams(new URLSearchParams({ actor_user_id: sam.userId, from: "2026-10-02", to: "2026-10-02" }));
    assert.equal(range.actorUserId, sam.userId);
    const day = await listActivities(owner, range);
    assert.deepEqual(day.data.map((activity) => activity.title), ["Sam called"]);

    const searched = await listActivities(owner, { actorUserId: sam.userId, query: "Sam's" });
    assert.deepEqual(searched.data.map((activity) => activity.body), ["Sam's note"]);

    const fromSam = await listActivities(sam, { actorUserId: owner.userId });
    assert.equal(fromSam.total, 1, "activities are shared, so a member sees what a teammate logged");

    assert.throws(() => activityQueryFromSearchParams(new URLSearchParams({ from: "yesterday" })), CrmError);
    await assert.rejects(listActivities(owner, { actorUserId: "not-a-member" }), CrmError);
  });
});

describe("Capture seen and new count", () => {
  it("counts what's waiting and what arrived since Capture was last opened", async () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    const owner = await createUser("capture-seen@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "capture-seen@orbit.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await addImport(owner, "unfiled", "Granola call");
    await addMeeting(owner, "evt-first", "olive@outside-capture.test");

    const first = await captureStatus(owner);
    assert.equal(first.waiting, 2);
    assert.equal(first.fresh, 2, "never opened, so everything waiting is new");
    assert.equal(first.seenAt, null);

    const seenAt = await markCaptureSeen(owner);
    const opened = await captureStatus(owner);
    assert.equal(opened.waiting, 2);
    assert.equal(opened.fresh, 0);
    assert.equal(opened.seenAt, seenAt);

    await markCaptureSeen(owner, new Date(Date.now() - 7 * DAY_MS));
    assert.equal((await captureStatus(owner)).seenAt, seenAt, "an older visit never moves the mark back");

    await new Promise((resolve) => setTimeout(resolve, 50));
    await addImport(owner, "unfiled", "New Granola call");
    const pending = await addImport(owner, "pending", "Teams call still matching");
    await addMeeting(owner, "evt-second", "piers@outside-capture.test", new Date(Date.now() - 5));
    await addMeeting(owner, "evt-old-synced-late", "quinn@outside-capture.test", new Date(Date.now() - 20 * DAY_MS));
    await addMeeting(owner, "evt-future", "rosa@outside-capture.test", new Date(Date.now() + 3 * DAY_MS));
    const later = await captureStatus(owner);
    assert.equal(later.waiting, 6);
    assert.equal(later.fresh, 2, "a meeting synced late or not held yet doesn't count as new");
    assert.ok(later.newestAt && later.newestAt > seenAt!);

    await markCaptureSeen(owner);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await getAdminPool().query("update crm.conversation_imports set status = 'unfiled' where id = $1", [pending]);
    const moved = await captureStatus(owner);
    assert.equal(moved.waiting, 7);
    assert.equal(moved.fresh, 1, "an import that only now became unfiled counts as new");

    const other = await createUser("capture-other@orbit.test", "Other Person");
    const rows = await queryAsUser<{ user_id: string }>(other.userId, "select user_id from crm.capture_seen");
    assert.ok(rows.every((row) => row.user_id === other.userId), "seen marks are private");
  });

  it("raises a single line when a connection needs attention", () => {
    const mailbox = { id: "m", email: "a@b.test", status: "connected" as const, lastSyncedAt: null, lastAttemptAt: null, lastError: null };
    const quiet = { mailbox, calendar: null, calls: null, transcripts: null, granola: null };
    assert.equal(connectionAlert(quiet), null);
    assert.equal(connectionAlert({ ...quiet, mailbox: { ...mailbox, lastError: "Token expired" } }), "Microsoft 365 needs attention.");
    assert.equal(
      connectionAlert({
        ...quiet,
        calendar: { connected: true, scopeMissing: true, lastSyncedAt: null, lastAttemptAt: null, lastError: null },
      }),
      "Reconnect Microsoft to include your calendar.",
    );
    assert.equal(
      connectionAlert({
        ...quiet,
        calls: { lastSyncedAt: null, lastAttemptAt: null, lastError: "Grant CallRecords.Read.All", logged: 0, unmatched: 0 },
        granola: {
          configured: true,
          lastError: "Granola refused the key",
          lastSyncedAt: null,
          lastAttemptAt: null,
          webhookEnabled: false,
          subscriptionId: null,
          subscriptionExpiresAt: null,
          personal: { connected: true, hint: null },
          sharedKey: false,
        },
      }),
      "Teams calls and Granola need attention.",
    );
  });
});

describe("Morning brief in the assistant", () => {
  it("opens an unread brief as the first message of a private conversation and marks it read", async () => {
    const owner = await createUser("brief-chat@orbit.test", "Mark Ridgeon");
    const other = await teammate(owner, "brief-other@orbit.test", "Sam Taylor");
    const body = "### Accounts to act on\n- Acme raised a round. Worth a note today.";
    const id = (
      await getAdminPool().query<{ id: string }>(
        "insert into crm.daily_briefs (workspace_id, user_id, day, body) values ($1, $2, '2026-11-03', $3) returning id",
        [owner.workspaceId, owner.userId, body],
      )
    ).rows[0].id;

    assert.equal(briefTitle("2026-11-03"), "Brief, Tue 3 Nov");
    const unread = await unreadBrief(owner);
    assert.equal(unread?.id, id);
    assert.equal(unread?.day, "2026-11-03");
    assert.ok(unread?.createdAt);
    assert.equal(await unreadBrief(other), null);
    await assert.rejects(openBrief(other, id), CrmError);

    const opened = await openBrief(owner, id, { model: "claude-haiku-5-5", reasoning: "low" });
    assert.equal(opened.conversation.title, "Brief, Tue 3 Nov");
    assert.equal(opened.conversation.model, "claude-haiku-5-5");
    assert.equal(opened.messages.length, 1);
    assert.equal(opened.messages[0].role, "assistant");
    assert.equal(opened.messages[0].content, body);
    assert.equal(await unreadBrief(owner), null);

    const again = await openBrief(owner, id);
    assert.equal(again.conversation.id, opened.conversation.id, "opening it again reuses the same chat");
    assert.equal((await listConversations(owner)).filter((item) => item.title === "Brief, Tue 3 Nov").length, 1);
    assert.equal((await listConversations(other)).length, 0);

    const stored = await getAdminPool().query<{ read_at: Date | null; conversation_id: string | null }>(
      "select read_at, conversation_id from crm.daily_briefs where id = $1",
      [id],
    );
    assert.ok(stored.rows[0].read_at);
    assert.equal(stored.rows[0].conversation_id, opened.conversation.id);

    process.env.LLM_API_KEY = "llm-test";
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const gateway: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "claude-haiku-5-5", choices: [{ message: { role: "assistant", content: "Drafted a note to Acme." } }], usage: {} });
    };
    await sendMessage(
      owner,
      { conversationId: opened.conversation.id, message: "Draft that note to Acme", model: "claude-haiku-5-5", reasoning: "low", webSearch: false },
      () => undefined,
      { deadline: Date.now() + 60_000, fetchImpl: gateway },
    );
    const sent = requests[0].messages;
    assert.doesNotMatch(sent[0].content, /brief is ready/, "the brief chat doesn't send the model to get_daily_brief again");
    const briefAt = sent.findIndex((message) => message.role === "assistant" && message.content === body);
    assert.ok(briefAt > 0, "the brief is replayed to the model");
    assert.equal(sent[briefAt - 1].role, "user");
    assert.match(sent[briefAt - 1].content, /morning brief/);
    assert.equal(sent.at(-1)!.content, "Draft that note to Acme");

    const after = await getConversation(owner, opened.conversation.id);
    assert.deepEqual(after.messages.map((message) => message.role), ["assistant", "user", "assistant"]);
    assert.equal(after.conversation.title, "Brief, Tue 3 Nov");
  });

  it("treats a rebuilt brief with new text as unread again and leaves the old chat in history", async () => {
    const owner = await createUser("brief-rewrite@orbit.test", "Mark Ridgeon");
    await withActor(owner, (db) => insertMemory(db, owner, "personal", { kind: "preference", title: "Prefers short emails", body: "Mark keeps first emails short." }, "learning"));
    let text = "### What Orbit learned\n- You prefer short emails.";
    const gateway: typeof fetch = async () =>
      Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ brief: text }) }, finish_reason: "stop" }] });
    const rebuild = () => runUnit(owner, "brief", { trigger: "manual", rebuildBrief: true, deadline: Date.now() + 60_000, fetchImpl: gateway });

    assert.deepEqual(await rebuild(), { brief: true });
    const unread = await unreadBrief(owner);
    assert.ok(unread);
    const first = await openBrief(owner, unread.id);
    assert.equal(first.messages[0].content, text);

    await rebuild();
    assert.equal(await unreadBrief(owner), null, "the same text stays read");

    text = "### What Orbit learned\n- You prefer short emails, and Acme replied.";
    await rebuild();
    const again = await unreadBrief(owner);
    assert.equal(again?.id, unread.id, "new text is unread again");
    assert.notEqual(briefKey(again!), briefKey(unread), "a long-lived tab sees the rebuilt brief as new");
    const second = await openBrief(owner, unread.id);
    assert.notEqual(second.conversation.id, first.conversation.id);
    assert.equal(second.messages[0].content, text);
    assert.equal((await listConversations(owner)).length, 2, "the earlier brief stays in chat history");
  });
});

describe("Review follow-ups", () => {
  it("counts every unfiled conversation, not just the first 50", async () => {
    const owner = await createUser("capture-many@orbit.test", "Mark Ridgeon");
    for (let index = 0; index < 55; index += 1) await addImport(owner, "unfiled", `Call ${index}`);
    const status = await captureStatus(owner);
    assert.equal(status.waiting, 55);
    assert.equal(status.fresh, 55);
    assert.equal((await listToFile(owner)).unfiled.length, 50, "the page lists the latest 50");
  });

  it("counts people met in SQL the same way the Capture list does", async () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    const owner = await createUser("mark@people-count.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@people-count.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const known = (await createCompany(owner, { name: "Known Co", domain: "known-people.test" })).body.company.id;
    await createContact(owner, { firstName: "Kim", email: "kim@known-people.test", companyId: known });
    await getAdminPool().query("insert into crm.hidden_attendees (workspace_id, user_id, email) values ($1, $2, 'hidden@outside-people.test')", [
      owner.workspaceId,
      owner.userId,
    ]);
    await addMeeting(owner, "evt-mixed", [
      "colleague@people-count.test",
      "kim@known-people.test",
      "hidden@outside-people.test",
      "Ada@Outside-People.test",
      "friend@gmail.com",
      "not an email",
    ]);
    const earliest = new Date(Date.now() - 5 * DAY_MS);
    await addMeeting(owner, "evt-ada-again", "ada@outside-people.test", earliest);
    const listed = await listToFile(owner);
    assert.deepEqual(listed.people.map((person) => person.email).sort(), ["ada@outside-people.test", "friend@gmail.com"]);
    assert.equal(listed.people.find((person) => person.email === "ada@outside-people.test")?.firstSeenAt, earliest.toISOString());
    const status = await captureStatus(owner);
    assert.equal(status.waiting, listed.unfiled.length + listed.people.length);
  });

  it("treats a company as active when an activity was logged only on one of its people", async () => {
    const owner = await createUser("quiet-contact@orbit.test", "Mark Ridgeon");
    const company = (await createCompany(owner, { name: "Contact Only Co", domain: "contact-only.test" })).body.company.id;
    const contact = (await createContact(owner, { firstName: "Cara", email: "cara@contact-only.test", companyId: company })).body.contact.id;
    await getAdminPool().query(
      "insert into crm.activities (workspace_id, type, title, occurred_at, contact_id, actor_user_id) values ($1, 'call', 'Rang Cara', now() - interval '2 days', $2, $3)",
      [owner.workspaceId, contact, owner.userId],
    );
    const quiet = await listCompanies(owner, { quiet: true });
    assert.equal(quiet.data.some((item) => item.id === company), false);

    const logged = await createActivity(owner, { type: "note", body: "Spoke to Cara", contactId: contact, companyId: null });
    assert.equal(logged.body.activity.companyId, company, "a new activity on a contact is also filed on their company");
  });

  it("only opens the brief by itself when the dock has no chat, and keys it by when it was written", () => {
    assert.equal(opensBriefOnExpand({ pending: true, busy: false, working: false, messages: 0 }), true);
    assert.equal(opensBriefOnExpand({ pending: true, busy: false, working: false, messages: 3 }), false, "an open chat isn't replaced");
    assert.equal(opensBriefOnExpand({ pending: true, busy: true, working: false, messages: 0 }), false);
    assert.equal(opensBriefOnExpand({ pending: false, busy: false, working: false, messages: 0 }), false);
    const first = { id: "b1", createdAt: "2026-11-03T05:00:00.000Z" };
    const rebuilt = { id: "b1", createdAt: "2026-11-03T09:00:00.000Z" };
    assert.equal(pendingBrief(first, briefKey(first)), null);
    assert.equal(pendingBrief(rebuilt, briefKey(first)), rebuilt);
  });

  it("filters the activity log by an agent", async () => {
    const owner = await createUser("agent-log@orbit.test", "Mark Ridgeon");
    const { actor: bot } = await createAgent(owner.workspaceId, ["crm:read", "activities:write"], "Grok Bot");
    const company = (await createCompany(owner, { name: "Agent Log Co", domain: "agent-log.test" })).body.company.id;
    await createActivity(bot, { type: "research", title: "Found a hiring post", companyId: company });
    await createActivity(owner, { type: "note", body: "My note", companyId: company });
    assert.deepEqual(await listActivityAgents(owner), [{ id: bot.agentId, name: "Grok Bot" }]);
    const query = activityQueryFromSearchParams(new URLSearchParams({ actor_agent_id: bot.agentId }));
    const byBot = await listActivities(owner, query);
    assert.deepEqual(byBot.data.map((activity) => activity.title), ["Found a hiring post"]);
    assert.equal(byBot.data[0].actorName, "Grok Bot");
  });

  it("doesn't learn from Orbit's own brief as if the user wrote it", async () => {
    const owner = await createUser("brief-learn@orbit.test", "Mark Ridgeon");
    const body = "### Accounts to act on\n- Zephyr Labs is hiring. Mention the pilot.";
    const id = (
      await getAdminPool().query<{ id: string }>(
        "insert into crm.daily_briefs (workspace_id, user_id, day, body) values ($1, $2, '2026-11-04', $3) returning id",
        [owner.workspaceId, owner.userId, body],
      )
    ).rows[0].id;
    const opened = await openBrief(owner, id);
    await getAdminPool().query(
      "insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, 'user', 'Always copy Priya on pilot emails')",
      [opened.conversation.id, owner.workspaceId, owner.userId],
    );
    const seen: string[] = [];
    const gateway: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      seen.push(request.messages.map((message) => message.content).join("\n"));
      return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ add: [], update: [], archive: [] }) }, finish_reason: "stop" }] });
    };
    await runUnit(owner, "personal", { trigger: "manual", deadline: Date.now() + 60_000, fetchImpl: gateway });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /Always copy Priya on pilot emails/);
    assert.doesNotMatch(seen[0], /Zephyr Labs/);
  });
});
