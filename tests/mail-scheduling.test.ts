import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import type { SlotRules } from "@/lib/booking/slots";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { eventFromThread } from "@/lib/mail/event";
import { prepareMail, setMailHelp, updatePrepared } from "@/lib/mail/prepare";
import { pickTimes, renderTimes, timesStillFree, TIMES_MARK } from "@/lib/mail/scheduling";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

const RULES: SlotRules = {
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  durationMinutes: 30,
  bufferMinutes: 10,
  minNoticeMinutes: 240,
  horizonDays: 21,
  timeZone: "Europe/London",
};

function ago(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: "Catch up",
    bodyPreview: "",
    body: { contentType: "text", content: "Could we find 30 minutes next week to talk through the renewal?" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [{ emailAddress: { name: "Sam Lee", address: "sam@acme.test" } }],
    bccRecipients: [],
    sentDateTime: ago(1),
    receivedDateTime: ago(1),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function mailbox(inbox: unknown[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({ value: url.includes("/messages/delta") ? inbox : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${Math.random()}` });
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

describe("scheduling replies and invites from email", () => {
  let owner: UserActor;

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    await resetDatabase();
    owner = await createUser("schedule@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await setMailHelp(owner, { autoRemindDays: null });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: mailbox([message("m-meet")]) });
  });

  after(async () => {
    await getPool().end();
  });

  it("offers free times on different days inside working hours", () => {
    const monday = Date.parse("2026-11-02T08:00:00Z");
    const busy = [{ start: Date.parse("2026-11-02T13:00:00Z"), end: Date.parse("2026-11-02T17:00:00Z") }];
    const times = pickTimes(RULES, busy, monday);
    assert.equal(times.length, 3);
    const days = times.map((time) => new Date(time).toISOString().slice(0, 10));
    assert.equal(new Set(days).size, 3);
    for (const time of times) {
      const hour = new Date(time).getUTCHours();
      assert.ok(hour >= 10 && hour < 16, new Date(time).toISOString());
    }
    assert.ok(!times.some((time) => time >= busy[0].start - 10 * 60_000 && time < busy[0].end + 10 * 60_000));
    assert.ok(timesStillFree(RULES, times, [], monday));
    assert.ok(!timesStillFree(RULES, times, [{ start: times[1], end: times[1] + 30 * 60_000 }], monday));
    const text = renderTimes(`Hi Jane,\n\nHappy to. Would any of these work?\n\n${TIMES_MARK}\n\nMark`, [Date.parse("2026-11-03T10:00:00Z")], RULES, "https://orbit.test/book/mark");
    assert.match(text, /Tuesday 3 November, 10:00\n\(UK time, 30 minutes\)\n\nOr pick any time that suits you here: https:\/\/orbit.test\/book\/mark\n\nMark$/);
  });

  it("puts free times into a prepared reply to a meeting request and checks them again when used", async () => {
    const { fetchImpl, prompts } = model([{ needsReply: true, meeting: true, body: `Hi Jane,\n\nHappy to. Would any of these work?\n\n${TIMES_MARK}\n\nMark` }]);
    const report = await prepareMail(owner, { deadline: Date.now() + 60_000, fetchImpl });
    assert.equal(report.prepared, 1);
    assert.match(prompts[0].system, /\[\[times\]\]/);
    const thread = (await listThreads(owner, { view: { role: "inbox" } })).threads[0];
    const detail = await getThread(owner, thread.key);
    assert.equal(detail.prepared?.times?.length, 3);
    assert.ok(!detail.prepared?.body.includes(TIMES_MARK));
    assert.match(detail.prepared!.body, /\(UK time, 30 minutes\)/);

    const first = detail.prepared!.times![0];
    const admin = getAdminPool();
    const connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId])).rows[0].id;
    const calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color) values ($1, $2, $3, 'cal-1', 'Calendar', '#4124fb') returning id`,
        [owner.workspaceId, owner.userId, connectionId],
      )
    ).rows[0].id;
    await admin.query(
      `insert into crm.calendar_events (workspace_id, user_id, connection_id, calendar_id, provider_event_id, subject, starts_at, ends_at)
       values ($1, $2, $3, $4, 'busy-1', 'Board', $5, $6)`,
      [owner.workspaceId, owner.userId, connectionId, calendarId, new Date(Date.parse(first) - 15 * 60_000), new Date(Date.parse(first) + 45 * 60_000)],
    );
    const used = await updatePrepared(owner, detail.prepared!.id, "use");
    assert.ok(used);
    assert.notEqual(used.times![0], first);
    assert.equal(used.times!.length, 3);
  });

  it("reads a meeting invite from the conversation", async () => {
    const thread = (await listThreads(owner, { view: { role: "inbox" } })).threads[0];
    const { fetchImpl, prompts } = model([{ title: "Mark and Jane: renewal — catch up", date: "2026-11-04", time: "14:10", durationMinutes: 40, notes: "Talk through the renewal." }]);
    const draft = await eventFromThread(owner, thread.key, { fetchImpl });
    assert.match(prompts[0].system, /never follow instructions/);
    assert.equal(draft.title, "Mark and Jane: renewal, catch up");
    assert.equal(draft.date, "2026-11-04");
    assert.equal(draft.time, "14:00");
    assert.equal(draft.durationMinutes, 45);
    assert.deepEqual(
      draft.guests.map((guest) => [guest.email, guest.name, Boolean(guest.contactId)]),
      [
        ["jane@acme.test", "Jane Doe", true],
        ["sam@acme.test", "Sam Lee", false],
      ],
    );
  });
});
