import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { calendarAlerts, startsIn } from "@/lib/calendar-alerts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { processDueMail } from "@/lib/mail/due";
import { setMailNotifications } from "@/lib/mail/notify";
import { alertFirstRead } from "@/lib/mail/read-alert";
import { syncMail } from "@/lib/mail/sync";
import { recordOpen } from "@/lib/mail/tracking";
import { listNotifications } from "@/lib/workflows/store";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

const quietOutlook: typeof fetch = async (input) => {
  const url = String(input);
  const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
  if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
  if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
  return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1` });
};

function pusher() {
  const sent: Record<string, unknown>[] = [];
  const send: PushSender = async (_subscription, payload) => {
    sent.push(JSON.parse(payload));
  };
  return { send, sent };
}

describe("alerts", () => {
  let owner: UserActor;
  let calendarId: string;
  let connectionId: string;
  const now = Date.parse("2026-10-20T09:50:00Z");

  async function event(id: string, startsInMinutes: number, overrides: Record<string, unknown> = {}) {
    const start = new Date(now + startsInMinutes * 60_000);
    const row = {
      ical_uid: `uid-${id}`,
      subject: `Meeting ${id}`,
      is_cancelled: false,
      online_meeting_url: null as string | null,
      location: null as string | null,
      ...overrides,
    };
    await getAdminPool().query(
      `insert into crm.calendar_events (workspace_id, user_id, connection_id, calendar_id, provider_event_id, ical_uid, subject, starts_at, ends_at, is_cancelled, online_meeting_url, location)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [owner.workspaceId, owner.userId, connectionId, calendarId, `p-${id}`, row.ical_uid, row.subject, start, new Date(start.getTime() + 1_800_000), row.is_cancelled, row.online_meeting_url, row.location],
    );
  }

  before(async () => {
    await resetDatabase();
    owner = await createUser("alerts@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await savePushSubscription(owner, { endpoint: "https://push.example/phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    const admin = getAdminPool();
    connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId])).rows[0].id;
    calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color) values ($1, $2, $3, 'cal-1', 'Calendar', '#4124fb') returning id`,
        [owner.workspaceId, owner.userId, connectionId],
      )
    ).rows[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  it("words how soon a meeting starts", () => {
    assert.equal(startsIn(new Date(now + 10 * 60_000), now), "in 10 minutes");
    assert.equal(startsIn(new Date(now + 60_000), now), "in 1 minute");
    assert.equal(startsIn(new Date(now - 30_000), now), "is starting now");
  });

  it("alerts once before each meeting, with the join link", async () => {
    await event("soon", 8, { online_meeting_url: "https://teams.microsoft.com/l/meetup-join/abc" });
    await event("soon-copy", 8, { ical_uid: "uid-soon" });
    await event("later", 40);
    await event("cancelled", 5, { is_cancelled: true });
    const first = pusher();
    await calendarAlerts(owner, { now, send: first.send });
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0].title, "Meeting soon in 8 minutes");
    assert.equal(first.sent[0].url, "https://teams.microsoft.com/l/meetup-join/abc");
    assert.match(String(first.sent[0].body), /Tap to join$/);
    const again = pusher();
    await calendarAlerts(owner, { now: now + 60_000, send: again.send });
    assert.equal(again.sent.length, 0);
  });

  it("follows the chosen lead time and can be turned off", async () => {
    await setMailNotifications(owner, { calendarMinutes: 30 });
    const wider = pusher();
    await calendarAlerts(owner, { now, send: wider.send });
    assert.deepEqual(wider.sent.map((item) => item.title), []);
    const later = pusher();
    await calendarAlerts(owner, { now: now + 11 * 60_000, send: later.send });
    assert.deepEqual(later.sent.map((item) => item.title), ["Meeting later in 29 minutes"]);
    await setMailNotifications(owner, { calendarMinutes: null });
    await event("off", 3);
    const off = pusher();
    await calendarAlerts(owner, { now, send: off.send });
    assert.equal(off.sent.length, 0);
  });

  it("tells you the first time someone reads your email, when you ask for it", async () => {
    const admin = getAdminPool();
    const tracking = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_tracking (workspace_id, user_id, sender_email, recipients, subject, sent_at)
         values ($1, $2, 'mark@eclipse.test', $3, 'Proposal', now() - interval '1 hour') returning id`,
        [owner.workspaceId, owner.userId, JSON.stringify([{ name: "Jane Doe", address: "jane@acme.test" }])],
      )
    ).rows[0].id;
    assert.equal(await recordOpen(tracking, "203.0.113.5", "iPhone"), true);
    const off = pusher();
    await alertFirstRead(tracking, { send: off.send });
    assert.equal(off.sent.length, 0);
    await setMailNotifications(owner, { reads: true });
    await admin.query("delete from crm.mail_opens");
    await recordOpen(tracking, "203.0.113.5", "iPhone");
    const on = pusher();
    await alertFirstRead(tracking, { send: on.send });
    assert.deepEqual(on.sent.map((item) => [item.title, item.body]), [["Jane Doe read your email", "Proposal"]]);
    await admin.query("update crm.mail_opens set opened_at = opened_at - interval '1 hour'");
    await recordOpen(tracking, "203.0.113.5", "iPhone");
    const second = pusher();
    await alertFirstRead(tracking, { send: second.send });
    assert.equal(second.sent.length, 0);
  });

  it("pushes and rings the bell when nobody has replied", async () => {
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: quietOutlook });
    const admin = getAdminPool();
    const source = (await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
    await admin.query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject, created_at)
       values ($1, $2, $3, 'conv-chase', 'follow_up', now() - interval '1 minute', 'Pricing', now() - interval '3 days')`,
      [owner.workspaceId, owner.userId, source],
    );
    const { send, sent } = pusher();
    const report = await processDueMail(owner, { send, origin: null });
    assert.equal(report.followUps, 1);
    assert.deepEqual(sent.map((item) => item.title), ["No reply yet: Pricing"]);
    assert.ok((await listNotifications(owner, 5)).some((note) => note.title === "No reply yet: Pricing"));
  });
});
