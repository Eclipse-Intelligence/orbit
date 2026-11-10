import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { createWorkspace } from "@/lib/crm/workspaces";
import { saveMailbox, saveSignature, sendContactEmail } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { composeEmailHtml, trackingIdIn } from "@/lib/mail/html";
import { setMailNotifications } from "@/lib/mail/notify";
import { alertFirstRead } from "@/lib/mail/read-alert";
import { activityReads, recordOpen, setReadStatuses } from "@/lib/mail/tracking";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const ORIGIN = "https://orbit.test";

type Sent = { contentType: string; content: string; to: string };

function graph(status = 202) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://graph.microsoft.com/v1.0/me/sendMail");
    const message = JSON.parse(String(init?.body)).message as {
      body: { contentType: string; content: string };
      toRecipients: { emailAddress: { address: string } }[];
    };
    sent.push({ ...message.body, to: message.toRecipients[0].emailAddress.address });
    return status === 202 ? new Response(null, { status }) : Response.json({ error: { code: "ErrorInternalServerError", message: "Try later." } }, { status });
  };
  return { fetchImpl, sent };
}

function pusher() {
  const sent: Record<string, unknown>[] = [];
  const send: PushSender = async (_subscription, payload) => {
    sent.push(JSON.parse(payload));
  };
  return { send, sent };
}

async function trackingRows() {
  const result = await getAdminPool().query<{
    id: string;
    sent_at: Date | null;
    recipients: { name: string | null; address: string }[];
    subject: string | null;
    sender_email: string;
    activity_id: string | null;
  }>("select id, sent_at, recipients, subject, sender_email, activity_id from crm.mail_tracking order by created_at");
  return result.rows;
}

describe("read statuses on emails sent from a contact", () => {
  let owner: UserActor;
  let colleague: UserActor;
  let jane: string;
  let tom: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@orbit.test", "Mark Ridgeon");
    const sam = await createUser("sam@orbit.test", "Sam Colleague");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam.userId]);
    colleague = { ...sam, workspaceId: owner.workspaceId, role: "member" };
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@client.test" })).body.contact.id;
    tom = (await createContact(owner, { firstName: "Tom", lastName: "Reed", email: "tom@client.test" })).body.contact.id;
    await saveMailbox(owner, {
      email: "mark@geteclipse.co",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  after(async () => {
    await getPool().end();
  });

  it("tracks the send, puts the pixel in the HTML and marks it sent", async () => {
    const out = graph();
    await sendContactEmail(owner, jane, { subject: "Proposal", body: "Hi Jane,\n\nHere it is.", origin: ORIGIN }, out.fetchImpl);
    const [row] = await trackingRows();
    assert.ok(row);
    assert.equal(out.sent[0].contentType, "HTML");
    assert.match(out.sent[0].content, new RegExp(`<img src="${ORIGIN}/api/mail/open/${row.id}"`));
    assert.equal(trackingIdIn(out.sent[0].content), row.id);
    assert.ok(row.sent_at);
    assert.deepEqual(row.recipients, [{ name: "Jane Doe", address: "jane@client.test" }]);
    assert.equal(row.subject, "Proposal");
    assert.equal(row.sender_email, "mark@geteclipse.co");
    const activity = (await listActivities(owner, { contactId: jane, type: "email" })).data[0];
    assert.equal(row.activity_id, activity.id);
    assert.equal(activity.body, "Hi Jane,\n\nHere it is.");
    assert.equal(JSON.stringify(activity.metadata).includes(row.id), false);
    await getAdminPool().query("delete from crm.mail_tracking");
  });

  it("leaves no unsent row when Microsoft refuses the send", async () => {
    const out = graph(500);
    await assert.rejects(sendContactEmail(owner, jane, { subject: "Fails", body: "Hello", origin: ORIGIN }, out.fetchImpl));
    assert.equal(out.sent.length, 1);
    assert.match(out.sent[0].content, /\/api\/mail\/open\//);
    assert.deepEqual(await trackingRows(), []);
  });

  it("gives each bulk recipient their own tracker", async () => {
    const out = graph();
    for (const id of [jane, tom]) {
      await sendContactEmail(owner, id, { subject: "Update", body: "News for you.", origin: ORIGIN }, out.fetchImpl);
    }
    const rows = await trackingRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      out.sent.map((item) => [item.to, trackingIdIn(item.content)]),
      [
        ["jane@client.test", rows[0].id],
        ["tom@client.test", rows[1].id],
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.recipients[0].address),
      ["jane@client.test", "tom@client.test"],
    );
    assert.notEqual(rows[0].activity_id, rows[1].activity_id);
    await getAdminPool().query("delete from crm.mail_tracking");
  });

  it("adds no pixel and no row when read statuses are off or there is no public address", async () => {
    await setReadStatuses(owner, false);
    const off = graph();
    await sendContactEmail(owner, jane, { subject: "Untracked", body: "Hello", origin: ORIGIN }, off.fetchImpl);
    assert.doesNotMatch(off.sent[0].content, /api\/mail\/open|<img/);
    await setReadStatuses(owner, true);
    const local = graph();
    await sendContactEmail(owner, jane, { subject: "Local", body: "Hello", origin: null }, local.fetchImpl);
    assert.doesNotMatch(local.sent[0].content, /api\/mail\/open|<img/);
    assert.deepEqual(await trackingRows(), []);
  });

  it("shows an open on the activity to the sender only", async () => {
    await sendContactEmail(owner, jane, { subject: "Seen", body: "Hello", origin: ORIGIN }, graph().fetchImpl);
    const [row] = await trackingRows();
    await getAdminPool().query("update crm.mail_tracking set sent_at = now() - interval '1 hour' where id = $1", [row.id]);
    assert.equal(await recordOpen(row.id, "203.0.113.5", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), true);
    await getAdminPool().query("update crm.mail_opens set opened_at = opened_at - interval '10 minutes'");
    assert.equal(await recordOpen(row.id, "203.0.113.5", "Microsoft Outlook 16.0"), true);
    const activity = (await listActivities(owner, { contactId: jane, type: "email" })).data.find((item) => item.title === "Seen")!;

    const mine = await activityReads(owner, [activity.id]);
    assert.deepEqual(
      mine[activity.id].opens.map((open) => open.agent),
      ["Outlook", "iPhone"],
    );
    assert.deepEqual(mine[activity.id].recipients, [{ name: "Jane Doe", address: "jane@client.test" }]);
    assert.ok(mine[activity.id].sentAt);

    const seenByColleague = await listActivities(colleague, { contactId: jane, type: "email" });
    assert.ok(seenByColleague.data.some((item) => item.id === activity.id));
    assert.deepEqual(await activityReads(colleague, [activity.id]), {});
    assert.deepEqual(await queryAsUser(colleague.userId, "select id from crm.mail_tracking"), []);
    assert.deepEqual(await queryAsUser(colleague.userId, "select id from crm.mail_opens"), []);
    await getAdminPool().query("delete from crm.mail_tracking");
  });

  it("sends the first read alert as Mail does", async () => {
    await savePushSubscription(owner, { endpoint: "https://web.push.apple.com/phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await setMailNotifications(owner, { reads: true });
    await sendContactEmail(owner, jane, { subject: "Pricing", body: "Hello", origin: ORIGIN }, graph().fetchImpl);
    const [row] = await trackingRows();
    await getAdminPool().query("update crm.mail_tracking set sent_at = now() - interval '1 hour' where id = $1", [row.id]);
    assert.equal(await recordOpen(row.id, "203.0.113.9", "iPhone"), true);
    const first = pusher();
    await alertFirstRead(row.id, { send: first.send });
    assert.deepEqual(first.sent.map((item) => [item.title, item.body]), [["Jane Doe read your email", "Pricing"]]);
    await getAdminPool().query("delete from crm.mail_tracking");
  });

  it("keeps paragraphs, links, line breaks and the signature, and sends the text as written", async () => {
    await saveSignature(owner, "mark@geteclipse.co", "Mark Ridgeon\nFounder, Eclipse");
    const out = graph();
    await sendContactEmail(
      owner,
      jane,
      {
        subject: "Notes",
        body: "Hi Jane,\n\nThe deck is at https://eclipse.test/deck.\nCall me *today* if 2 < 3 & you can.\n\n# Mark",
        origin: null,
      },
      out.fetchImpl,
    );
    const html = out.sent[0].content;
    const paragraphs = html.match(/<p style="margin:0 0 1em 0">/g) ?? [];
    assert.equal(paragraphs.length, 4);
    assert.match(html, /<p style="margin:0 0 1em 0">Hi Jane,<\/p>/);
    assert.match(
      html,
      /The deck is at <a href="https:\/\/eclipse\.test\/deck">https:\/\/eclipse\.test\/deck<\/a>\.<br>Call me \*today\* if 2 &lt; 3 &amp; you can\.<\/p>/,
    );
    assert.match(html, /<p style="margin:0 0 1em 0"># Mark<\/p>/);
    assert.match(html, /<div style="color:#555"><p style="margin:0 0 1em 0">Mark Ridgeon<br>Founder, Eclipse<\/p><\/div>/);
    const unsigned = graph();
    await sendContactEmail(owner, jane, { subject: "Bare", body: "Hello", signature: false, origin: null }, unsigned.fetchImpl);
    assert.doesNotMatch(unsigned.sent[0].content, /Founder, Eclipse/);
  });

  it("shows the read status on a timeline in a second workspace", async () => {
    const created = await createWorkspace(owner, { name: "Mark Ridgeon" });
    const ridgeon: UserActor = { ...owner, workspaceId: created.id, workspaceName: "Mark Ridgeon" };
    const client = (await createContact(ridgeon, { firstName: "Rosa", lastName: "Lane", email: "rosa@consulting.test" })).body.contact.id;
    await sendContactEmail(ridgeon, client, { subject: "Consulting", body: "Hello Rosa", origin: ORIGIN }, graph().fetchImpl);
    const [row] = await trackingRows();
    await getAdminPool().query("update crm.mail_tracking set sent_at = now() - interval '1 hour' where id = $1", [row.id]);
    const stored = await getAdminPool().query<{ workspace_id: string }>("select workspace_id from crm.mail_tracking where id = $1", [row.id]);
    assert.notEqual(stored.rows[0].workspace_id, ridgeon.workspaceId);
    assert.equal(await recordOpen(row.id, "203.0.113.20", "Macintosh"), true);
    const activity = (await listActivities(ridgeon, { contactId: client, type: "email" })).data[0];
    const reads = await activityReads(ridgeon, [activity.id]);
    assert.deepEqual(
      reads[activity.id]?.opens.map((open) => open.agent),
      ["Mac"],
    );
    assert.deepEqual(await activityReads(colleague, [activity.id]), {});
    await getAdminPool().query("delete from crm.mail_tracking");
  });

  it("still sends, untracked, when the read status can't be started", async () => {
    const admin = getAdminPool();
    await admin.query("alter table crm.mail_tracking add constraint mail_tracking_refuse check (false) not valid");
    try {
      const out = graph();
      const result = await sendContactEmail(owner, jane, { subject: "Still goes", body: "Hello", origin: ORIGIN }, out.fetchImpl);
      assert.equal(result.warning, null);
      assert.equal(out.sent.length, 1);
      assert.doesNotMatch(out.sent[0].content, /api\/mail\/open/);
    } finally {
      await admin.query("alter table crm.mail_tracking drop constraint mail_tracking_refuse");
    }
    assert.deepEqual(await trackingRows(), []);
  });

  it("keeps the timeline entry when linking the read status fails", async () => {
    const admin = getAdminPool();
    await admin.query(`create or replace function public.refuse_tracking_link() returns trigger language plpgsql as $$
      begin raise exception 'link refused'; end $$`);
    await admin.query(
      "create trigger refuse_tracking_link before update of activity_id on crm.mail_tracking for each row when (new.activity_id is not null) execute function public.refuse_tracking_link()",
    );
    try {
      const result = await sendContactEmail(owner, jane, { subject: "Unlinked", body: "Hello", origin: ORIGIN }, graph().fetchImpl);
      assert.equal(result.warning, null);
    } finally {
      await admin.query("drop trigger refuse_tracking_link on crm.mail_tracking");
      await admin.query("drop function public.refuse_tracking_link()");
    }
    const activity = (await listActivities(owner, { contactId: jane, type: "email" })).data.find((item) => item.title === "Unlinked");
    assert.ok(activity);
    const [row] = await trackingRows();
    assert.ok(row.sent_at);
    assert.equal(row.activity_id, null);
    await admin.query("delete from crm.mail_tracking");
  });

  it("keeps the read status when Microsoft times out and the email may have gone", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await assert.rejects(sendContactEmail(owner, jane, { subject: "Maybe sent", body: "Hello", origin: ORIGIN }, fetchImpl));
    const [row] = await trackingRows();
    assert.ok(row?.sent_at);
    assert.equal(row.subject, "Maybe sent");
    assert.deepEqual(row.recipients, [{ name: "Jane Doe", address: "jane@client.test" }]);
    await getAdminPool().query("delete from crm.mail_tracking");
  });
});

describe("email HTML", () => {
  for (const plain of [false, true]) {
    it(`links URLs in angle brackets, quotes and with query strings${plain ? " in plain text" : ""}`, () => {
      const html = composeEmailHtml({
        body: 'See <https://eclipse.test/a?x=1&y=2> now, "https://eclipse.test/b" too and https://eclipse.test/c?x=1&z=2.',
        plain,
      });
      assert.ok(html.includes('See &lt;<a href="https://eclipse.test/a?x=1&amp;y=2">https://eclipse.test/a?x=1&amp;y=2</a>&gt; now'));
      assert.ok(html.includes('&quot;<a href="https://eclipse.test/b">https://eclipse.test/b</a>&quot; too'));
      assert.ok(html.includes('and <a href="https://eclipse.test/c?x=1&amp;z=2">https://eclipse.test/c?x=1&amp;z=2</a>.'));
      assert.doesNotMatch(html, /&gt"|&quot"|&gt<\/a>|&quot<\/a>/);
    });
  }

  it("keeps indentation, runs of spaces, tabs and blank lines in plain text", () => {
    const html = composeEmailHtml({ body: "Items:\n  - one\n\t- two\nA    B\n\n\n\nEnd", plain: true });
    assert.ok(html.includes("Items:<br>&nbsp;&nbsp;- one<br>&nbsp;&nbsp;&nbsp;&nbsp;- two<br>A&nbsp;&nbsp;&nbsp; B</p>"));
    assert.ok(html.includes('<p style="margin:0 0 1em 0"><br><br>End</p>'));
    assert.equal(composeEmailHtml({ body: "A    B" }).includes("&nbsp;"), false);
  });

  it("leaves the signature unformatted in plain text", () => {
    const html = composeEmailHtml({ body: "Hi", signature: "*Founder*\n# 1 agency", plain: true });
    assert.ok(html.includes('<div style="color:#555"><p style="margin:0 0 1em 0">*Founder*<br># 1 agency</p></div>'));
    assert.ok(composeEmailHtml({ body: "Hi", signature: "*Founder*" }).includes("<em>Founder</em>"));
  });
});
