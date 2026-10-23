import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { deleteDraftMessage, discardMailDraft, readDraftInput, saveMailDraft, sendMailDraft } from "@/lib/mail/compose";
import { composeEmailHtml, imageMarkers, trackingIdIn } from "@/lib/mail/html";
import { attachToDraft } from "@/lib/microsoft/oauth";
import { syncMail } from "@/lib/mail/sync";
import { getThread, listThreads } from "@/lib/mail/threads";
import { addressHash, noteViewerAddress, readerAgent, recordOpen, setReadStatuses } from "@/lib/mail/tracking";
import { replyDefaults } from "@/lib/mail/view";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ORIGIN = "https://orbit.test";
const OLD_PIXEL = "11111111-2222-4333-8444-555555555555";

let draftCount = 0;

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "Can we talk about the renewal price?",
    body: { contentType: "html", content: "<p>Can we talk about the renewal price?</p>" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [{ emailAddress: { name: "Ola", address: "ola@acme.test" } }],
    bccRecipients: [],
    sentDateTime: "2026-10-01T09:00:00Z",
    receivedDateTime: "2026-10-01T09:00:05Z",
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: `https://outlook.office.com/mail/${id}`,
    ...overrides,
  };
}

function outlook(state: { inbox: unknown[]; sent: unknown[]; drafts: unknown[]; missing?: Set<string> }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
      if (state.missing?.has(id)) return Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
      if (method === "POST" && url === `${GRAPH}/me/messages`) {
        draftCount += 1;
        return Response.json({ id: `draft-${draftCount}`, conversationId: `conv-new-${draftCount}`, subject: "" }, { status: 201 });
      }
      if (/\/(createReply|createReplyAll|createForward)$/.test(url)) {
        draftCount += 1;
        return Response.json(
          {
            id: `draft-${draftCount}`,
            subject: url.endsWith("createForward") ? "FW: Renewal pricing" : "RE: Renewal pricing",
            body: {
              contentType: "html",
              content: `<html><head></head><body dir="ltr"><div id="quote">Jane wrote<img src="${ORIGIN}/api/mail/open/${OLD_PIXEL}"></div></body></html>`,
            },
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id });
    }
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: [
          { id: "f-inbox", displayName: "Inbox", childFolderCount: 0 },
          { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 },
          { id: "f-drafts", displayName: "Drafts", childFolderCount: 0 },
        ],
      });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent, "f-drafts": state.drafts };
    const value = folder ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=${Date.now()}${Math.random()}` });
  };
  return { fetchImpl, calls };
}

describe("mail replies and read statuses", () => {
  let owner: UserActor;
  let jane: string;
  let thread: string;
  const state = { inbox: [message("m-1")], sent: [] as unknown[], drafts: [] as unknown[] };

  before(async () => {
    await resetDatabase();
    owner = await createUser("compose@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    thread = inbox.threads[0].key;
    jane = inbox.threads[0].latestId;
  });

  after(async () => {
    await getPool().end();
  });

  it("works out who a reply goes to", () => {
    const original = {
      from: { name: "Jane", address: "jane@acme.test" },
      to: [{ name: "Mark", address: "mark@eclipse.test" }, { name: "Sam", address: "sam@acme.test" }],
      cc: [{ name: "Ola", address: "ola@acme.test" }, { name: "Me", address: "MARK@eclipse.test" }],
    };
    const own = ["mark@eclipse.test"];
    assert.deepEqual(replyDefaults("reply", original, "Renewal", own), { to: [original.from], cc: [], subject: "RE: Renewal" });
    assert.deepEqual(replyDefaults("reply_all", original, "RE: Renewal", own), {
      to: [original.from, original.to[1]],
      cc: [original.cc[0]],
      subject: "RE: Renewal",
    });
    const mine = { from: { name: "Mark", address: "mark@eclipse.test" }, to: [original.from], cc: [] };
    assert.deepEqual(replyDefaults("reply", mine, "Renewal", own).to, [original.from]);
    assert.deepEqual(replyDefaults("forward", original, "Renewal", own), { to: [], cc: [], subject: "FW: Renewal" });
  });

  it("writes the reply above the quote, drops old read images and adds a new one", () => {
    const html = composeEmailHtml({
      body: "Hi Jane,\n\nSee https://example.com/terms.\nThanks",
      signature: "Mark <CEO>",
      pixel: `${ORIGIN}/api/mail/open/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      quote: `<html><body dir="ltr"><div>quoted<img src="${ORIGIN}/api/mail/open/${OLD_PIXEL}"></div></body></html>`,
    });
    assert.ok(html.startsWith('<html><body dir="ltr"><div style="font-family:Aptos'));
    assert.ok(html.includes('<p style="margin:0 0 1em 0">Hi Jane,</p>'));
    assert.ok(html.includes('<a href="https://example.com/terms">https://example.com/terms</a>.<br>Thanks'));
    assert.ok(html.includes("Mark &lt;CEO&gt;"));
    assert.equal(trackingIdIn(html), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.ok(!html.includes(OLD_PIXEL));
    assert.ok(html.endsWith("<div>quoted</div></body></html>"));
  });

  it("puts pasted or dropped images in the email where the marker is", async () => {
    const body = "Hi Jane,\n\nHere it is:\n[Image: CleanShot <1>.png]\n\n[Image: Missing.png]";
    assert.deepEqual(imageMarkers(body), ["CleanShot <1>.png", "Missing.png"]);
    const html = composeEmailHtml({ body, inline: { "CleanShot <1>.png": "image1@orbit" } });
    assert.ok(html.includes('<img src="cid:image1@orbit" alt="CleanShot &lt;1&gt;.png"'));
    assert.ok(html.includes("[Image: Missing.png]"));
    assert.ok(!composeEmailHtml({ body }).includes("<img"));
    const posted: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "a" }, { status: 201 });
    };
    await attachToDraft(
      "token",
      `${GRAPH}/me/messages/d-1`,
      [
        { name: "CleanShot <1>.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]), contentId: "image1@orbit" },
        { name: "Terms.pdf", contentType: "application/pdf", bytes: new Uint8Array([4]) },
      ],
      fetchImpl,
    );
    assert.equal(posted[0].isInline, true);
    assert.equal(posted[0].contentId, "image1@orbit");
    assert.equal(posted[1].isInline, undefined);
  });

  it("checks addresses and modes before writing anything", () => {
    assert.throws(() => readDraftInput({ mode: "reply", messageId: jane, to: ["not an email"] }), /isn't an email address/);
    assert.throws(() => readDraftInput({ mode: "shout", messageId: jane }), /Choose reply/);
    const input = readDraftInput({ mode: "reply", messageId: jane, to: ["Jane@Acme.test", { address: "jane@acme.test", name: "Jane" }], body: "Hi" });
    assert.deepEqual(input.to, [{ address: "jane@acme.test", name: null }]);
  });

  it("saves a reply as an Outlook draft once, then updates it", async () => {
    const { fetchImpl, calls } = outlook(state);
    const input = readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], subject: "RE: Renewal pricing", body: "Hi Jane" });
    const first = await saveMailDraft(owner, input, { origin: ORIGIN, fetchImpl });
    const draftId = `draft-${draftCount}`;
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["POST /me/messages/m-1/createReply", `PATCH /me/messages/${draftId}`]);
    const patch = calls[1].body as { subject: string; body: { content: string }; toRecipients: unknown[] };
    assert.equal(patch.subject, "RE: Renewal pricing");
    assert.deepEqual(patch.toRecipients, [{ emailAddress: { address: "jane@acme.test" } }]);
    assert.ok(patch.body.content.includes("Hi Jane"));
    const tracking = trackingIdIn(patch.body.content);
    assert.ok(tracking && tracking !== OLD_PIXEL);

    const second = await saveMailDraft(owner, { ...input, id: first.id, body: "Hi Jane, updated" }, { origin: ORIGIN, fetchImpl });
    assert.equal(second.id, first.id);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].method, "PATCH");
    assert.equal(trackingIdIn((calls[2].body as { body: { content: string } }).body.content), tracking);

    state.drafts = [message(draftId, { isDraft: true, subject: "RE: Renewal pricing", from: { emailAddress: { address: "mark@eclipse.test" } } })];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const detail = await getThread(owner, thread);
    assert.deepEqual(detail.drafts.map((draft) => [draft.id, draft.body]), [[first.id, "Hi Jane, updated"]]);
    assert.ok(detail.messages.every((item) => !item.isDraft));

    const removed = outlook(state);
    await discardMailDraft(owner, first.id, removed.fetchImpl);
    assert.deepEqual(removed.calls.map((call) => call.method), ["DELETE"]);
    assert.equal((await getThread(owner, thread)).drafts.length, 0);
    state.drafts = [];
  });

  it("makes a new draft when the old one was deleted in Outlook", async () => {
    const input = readDraftInput({ mode: "forward", messageId: jane, to: ["sam@acme.test"], body: "FYI" });
    const first = await saveMailDraft(owner, input, { origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    const oldDraft = `draft-${draftCount}`;
    const gone = outlook({ ...state, missing: new Set([oldDraft]) });
    const again = await saveMailDraft(owner, { ...input, id: first.id, body: "FYI, see below" }, { origin: ORIGIN, fetchImpl: gone.fetchImpl });
    assert.notEqual(again.id, first.id);
    assert.deepEqual(gone.calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "").split("?")[0]}`), [
      `PATCH /me/messages/${oldDraft}`,
      "POST /me/messages/m-1/createForward",
      `PATCH /me/messages/draft-${draftCount}`,
    ]);
    await discardMailDraft(owner, again.id, outlook(state).fetchImpl);
  });

  it("sends, logs the reply on the contact and shows when it is read", async () => {
    const { fetchImpl, calls } = outlook(state);
    const result = await sendMailDraft(
      owner,
      readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], subject: "RE: Renewal pricing", body: "Deal. Sending terms." }),
      { origin: ORIGIN, fetchImpl },
    );
    assert.equal(result.warning, null);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "PATCH", "POST"]);
    assert.ok(calls[2].url.endsWith("/send"));
    const html = (calls[1].body as { body: { content: string } }).body.content;
    const tracking = trackingIdIn(html)!;

    const activities = await listActivities(owner, { limit: 10 });
    const logged = activities.data.find((item) => item.title === "RE: Renewal pricing");
    assert.equal(logged?.body, "Deal. Sending terms.");

    assert.equal(await recordOpen(tracking, "203.0.113.9", "Mozilla/5.0 (iPhone)"), false);
    const admin = getAdminPool();
    await admin.query("update crm.mail_tracking set sent_at = now() - interval '10 minutes' where id = $1", [tracking]);
    assert.equal(await recordOpen(tracking, "203.0.113.9", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), true);
    assert.equal(await recordOpen(tracking, "203.0.113.9", "Mozilla/5.0 (iPhone)"), false);
    await noteViewerAddress(owner, "198.51.100.7, 10.0.0.1");
    await admin.query("delete from crm.mail_opens where tracking_id = $1 and agent is null", [tracking]);
    await admin.query("update crm.mail_opens set opened_at = opened_at - interval '1 hour' where tracking_id = $1", [tracking]);
    assert.equal(await recordOpen(tracking, "198.51.100.7", "Mozilla/5.0"), false);
    assert.equal(await recordOpen("not-a-uuid", null, null), false);

    state.sent = [
      message("sent-1", {
        subject: "RE: Renewal pricing",
        from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
        toRecipients: [{ emailAddress: { name: "Jane Doe", address: "jane@acme.test" } }],
        body: { contentType: "html", content: html },
        receivedDateTime: "2026-10-02T09:00:00Z",
      }),
    ];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const sent = await listThreads(owner, { view: { role: "sent" } });
    assert.equal(sent.threads[0].reads?.count, 1);
    const detail = await getThread(owner, thread);
    const mine = detail.messages.find((item) => item.from?.address === "mark@eclipse.test");
    assert.deepEqual(mine?.opens?.map((open) => open.agent), ["iPhone"]);
    assert.ok(!mine?.html?.includes("/api/mail/open/"));
    assert.equal(detail.messages.find((item) => item.from?.address === "jane@acme.test")?.opens, null);
  });

  it("writes a new email as a draft and sends it from the chosen account", async () => {
    const sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
    assert.throws(() => readDraftInput({ mode: "new", to: ["sam@acme.test"] }), /Choose an account/);
    const { fetchImpl, calls } = outlook(state);
    const input = readDraftInput({ mode: "new", sourceId, to: ["sam@acme.test"], subject: "Intro", body: "Hi Sam" });
    const draft = await saveMailDraft(owner, input, { origin: ORIGIN, fetchImpl });
    assert.equal(draft.mode, "new");
    assert.equal(draft.sourceId, sourceId);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["POST /me/messages", `PATCH /me/messages/draft-${draftCount}`]);
    const html = (calls[1].body as { body: { content: string } }).body.content;
    assert.ok(html.startsWith('<div style="font-family:Aptos'));
    assert.ok(trackingIdIn(html));
    await assert.rejects(
      () => sendMailDraft(owner, { ...input, id: draft.id, subject: "" }, { origin: ORIGIN, fetchImpl }),
      /Add a subject/,
    );
    const send = outlook(state);
    await sendMailDraft(owner, { ...input, id: draft.id }, { origin: ORIGIN, fetchImpl: send.fetchImpl });
    assert.deepEqual(send.calls.map((call) => call.method), ["POST"]);
    assert.ok(send.calls[0].url.endsWith("/send"));

    const kept = await saveMailDraft(owner, { ...input, subject: "Second" }, { origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    const goneDraft = `draft-${draftCount}`;
    const resend = outlook({ ...state, missing: new Set([goneDraft]) });
    await sendMailDraft(owner, { ...input, id: kept.id, subject: "Second" }, { origin: ORIGIN, fetchImpl: resend.fetchImpl });
    assert.deepEqual(resend.calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "").split("?")[0]}`), [
      `POST /me/messages/${goneDraft}/send`,
      "POST /me/messages",
      `PATCH /me/messages/draft-${draftCount}`,
      `POST /me/messages/draft-${draftCount}/send`,
    ]);
  });

  it("replaces a draft made outside Orbit and can delete one", async () => {
    state.drafts = [
      message("outside-1", { isDraft: true, subject: "Re: Renewal pricing", from: { emailAddress: { address: "mark@eclipse.test" } }, body: { contentType: "text", content: "Hi Jane \u2014 sure." } }),
      message("outside-2", { isDraft: true, conversationId: "conv-other", subject: "Other", from: { emailAddress: { address: "mark@eclipse.test" } } }),
    ];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const admin = getAdminPool();
    const ids = Object.fromEntries(
      (await admin.query<{ id: string; provider_message_id: string }>("select id, provider_message_id from crm.mail_messages where is_draft")).rows.map((row) => [row.provider_message_id, row.id]),
    );
    const { fetchImpl, calls } = outlook(state);
    await saveMailDraft(owner, readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Hi Jane, sure.", replaces: ids["outside-1"] }), { origin: ORIGIN, fetchImpl });
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/me/messages/outside-1")));
    assert.equal((await admin.query("select 1 from crm.mail_messages where id = $1", [ids["outside-1"]])).rows.length, 0);

    const removal = outlook(state);
    await deleteDraftMessage(owner, ids["outside-2"], removal.fetchImpl);
    assert.deepEqual(removal.calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["DELETE /me/messages/outside-2"]);
    await assert.rejects(() => deleteDraftMessage(owner, jane, outlook(state).fetchImpl), /already gone/);
    state.drafts = [];
  });

  it("leaves read images out when read statuses are off", async () => {
    await setReadStatuses(owner, false);
    const { fetchImpl, calls } = outlook(state);
    const draft = await saveMailDraft(owner, readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Quiet" }), {
      origin: ORIGIN,
      fetchImpl,
    });
    assert.equal(trackingIdIn((calls[1].body as { body: { content: string } }).body.content), null);
    await discardMailDraft(owner, draft.id, outlook(state).fetchImpl);
    await setReadStatuses(owner, true);
  });

  it("names the app or device that opened an email", () => {
    assert.equal(readerAgent("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)"), "Gmail");
    assert.equal(readerAgent("Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)"), "Outlook");
    assert.equal(readerAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Mac");
    assert.equal(readerAgent(null), null);
    assert.equal(addressHash(" , "), null);
    assert.equal(addressHash("1.2.3.4, 5.6.7.8"), addressHash("1.2.3.4"));
  });
});
