import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { ALREADY_SENDING, DRAFT_GONE, REPLACED_SENT, SENT_ALREADY, STILL_SAVING, deleteDraftMessage, discardMailDraft, readDraftInput, saveMailDraft, sendMailDraft } from "@/lib/mail/compose";
import type { CrmError } from "@/lib/crm/errors";
import { ignoreUnknownMail, setThreadFiling } from "@/lib/mail/filing";
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
    const asked = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (asked && state.missing?.has(asked)) return Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
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

  it("turns markdown into real formatting so no symbols reach the recipient", () => {
    const html = composeEmailHtml({
      body: "## Next steps\n**Pricing** is *agreed*. See [the terms](https://example.com/terms) and [Acme](/companies/123).\nKeep 2 * 3 * 4, snake_case_name and a ** pair.",
    });
    assert.ok(html.includes("<strong>Next steps</strong><br>"));
    assert.ok(html.includes("<strong>Pricing</strong> is <em>agreed</em>."));
    assert.ok(composeEmailHtml({ body: "***Both*** and **see *this***" }).includes("<strong><em>Both</em></strong> and"));
    assert.ok(html.includes('<a href="https://example.com/terms">the terms</a> and Acme.'));
    assert.ok(html.includes("Keep 2 * 3 * 4, snake_case_name and a ** pair."));
    assert.ok(!/\*\*Pricing|\]\(|##/.test(html));
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
    const first = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    const draftId = `draft-${draftCount}`;
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["POST /me/messages/m-1/createReply", `PATCH /me/messages/${draftId}`]);
    const patch = calls[1].body as { subject: string; body: { content: string }; toRecipients: unknown[] };
    assert.equal(patch.subject, "RE: Renewal pricing");
    assert.deepEqual(patch.toRecipients, [{ emailAddress: { address: "jane@acme.test" } }]);
    assert.ok(patch.body.content.includes("Hi Jane"));
    const tracking = trackingIdIn(patch.body.content);
    assert.ok(tracking && tracking !== OLD_PIXEL);

    const second = await saveMailDraft(owner, { ...input, id: first.id, body: "Hi Jane, updated" }, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
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
    const first = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    const oldDraft = `draft-${draftCount}`;
    const gone = outlook({ ...state, missing: new Set([oldDraft]) });
    const again = await saveMailDraft(owner, { ...input, id: first.id, body: "FYI, see below" }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: gone.fetchImpl });
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
      { storedFiles: "replace", origin: ORIGIN, fetchImpl },
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
    const draft = await saveMailDraft(owner, input, { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    assert.equal(draft.mode, "new");
    assert.equal(draft.sourceId, sourceId);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["POST /me/messages", `PATCH /me/messages/draft-${draftCount}`]);
    const html = (calls[1].body as { body: { content: string } }).body.content;
    assert.ok(html.startsWith('<div style="font-family:Aptos'));
    assert.ok(trackingIdIn(html));
    await assert.rejects(
      () => sendMailDraft(owner, { ...input, id: draft.id, subject: "" }, { storedFiles: "replace", origin: ORIGIN, fetchImpl }),
      /Add a subject/,
    );
    const send = outlook(state);
    await sendMailDraft(owner, { ...input, id: draft.id }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: send.fetchImpl });
    assert.deepEqual(send.calls.map((call) => call.method), ["POST"]);
    assert.ok(send.calls[0].url.endsWith("/send"));

    const kept = await saveMailDraft(owner, { ...input, subject: "Second" }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: outlook(state).fetchImpl });
    const goneDraft = `draft-${draftCount}`;
    const resend = outlook({ ...state, missing: new Set([goneDraft]) });
    await sendMailDraft(owner, { ...input, id: kept.id, subject: "Second" }, { storedFiles: "replace", origin: ORIGIN, fetchImpl: resend.fetchImpl });
    assert.deepEqual(resend.calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "").split("?")[0]}`), [
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
    await saveMailDraft(owner, readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Hi Jane, sure.", replaces: ids["outside-1"] }), { storedFiles: "replace", origin: ORIGIN, fetchImpl });
    assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/me/messages/outside-1")));
    assert.equal((await admin.query("select 1 from crm.mail_messages where id = $1", [ids["outside-1"]])).rows.length, 0);

    const removal = outlook(state);
    await deleteDraftMessage(owner, ids["outside-2"], removal.fetchImpl);
    assert.deepEqual(removal.calls.map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`), ["DELETE /me/messages/outside-2"]);
    await assert.rejects(() => deleteDraftMessage(owner, jane, outlook(state).fetchImpl), /already gone/);
    state.drafts = [];
  });

  const outsideDraft = async (id: string) => {
    state.drafts = [message(id, { isDraft: true, subject: "Re: Renewal pricing", from: { emailAddress: { address: "mark@eclipse.test" } }, body: { contentType: "text", content: "Sounds good." } })];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    state.drafts = [];
    return (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = $1", [id])).rows[0].id;
  };
  const sendsIn = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/send")).length;
  const replacing = (outside: string) => readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Sounds good.", replaces: outside, sendKey: randomUUID() });
  const failing = (box: ReturnType<typeof outlook>, method: string, status: number): typeof fetch => async (input, init) => {
    if ((init?.method ?? "GET") === method) {
      box.calls.push({ method, url: String(input), body: null });
      return Response.json({ error: { code: "ServiceUnavailable", message: "Try again later." } }, { status });
    }
    return box.fetchImpl(input, init);
  };
  const sendOptions = (fetchImpl: typeof fetch) => ({ storedFiles: "replace" as const, origin: ORIGIN, fetchImpl });

  it("sends a draft made outside Orbit once, and refuses a second send of it from another composer", async () => {
    const outside = await outsideDraft("outside-3");
    const input = replacing(outside);
    const first = outlook(state);
    await sendMailDraft(owner, input, sendOptions(first.fetchImpl));
    assert.equal(sendsIn(first.calls), 1);
    const second = outlook(state);
    await assert.rejects(() => sendMailDraft(owner, { ...input, sendKey: randomUUID() }, sendOptions(second.fetchImpl)), { message: REPLACED_SENT });
    assert.equal(sendsIn(second.calls), 0);
  });

  const failures: { name: string; fail: (box: ReturnType<typeof outlook>) => { fetchImpl: typeof fetch; extra: Record<string, unknown> }; fix: Record<string, unknown> }[] = [
    { name: "the draft update", fail: (box) => ({ fetchImpl: failing(box, "PATCH", 503), extra: {} }), fix: {} },
    { name: "loading attachments", fail: (box) => ({ fetchImpl: box.fetchImpl, extra: { attachments: [randomUUID()] } }), fix: { attachments: [] } },
    { name: "the sending address", fail: (box) => ({ fetchImpl: box.fetchImpl, extra: { identityId: randomUUID() } }), fix: { identityId: null } },
  ];
  const storedDrafts = async () => Number((await getAdminPool().query<{ count: string }>("select count(*) from crm.mail_drafts where user_id = $1", [owner.userId])).rows[0].count);

  for (const failure of failures) {
    for (const replaced of [true, false]) {
      it(`retries ${replaced ? "an Outlook draft" : "a reply"} after ${failure.name} failed, with the same send key and draft, and sends it once`, async () => {
        const outside = replaced ? await outsideDraft(`outside-${failure.name.replace(/\s+/g, "-")}`) : null;
        const before = await storedDrafts();
        const input = outside ? replacing(outside) : readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Sounds good.", sendKey: randomUUID() });
        const broken = outlook(state);
        const { fetchImpl, extra } = failure.fail(broken);
        let draftId: string | null = null;
        await assert.rejects(() => sendMailDraft(owner, { ...input, ...extra }, sendOptions(fetchImpl)), (error: CrmError) => {
          assert.equal(error.details?.maybeSent, undefined);
          draftId = (error.details?.draftId as string | undefined) ?? null;
          return true;
        });
        assert.ok(draftId);
        assert.equal(sendsIn(broken.calls), 0);
        const retry = outlook(state);
        await sendMailDraft(owner, { ...input, ...failure.fix, id: draftId }, sendOptions(retry.fetchImpl));
        assert.equal(sendsIn(retry.calls), 1);
        assert.equal(retry.calls.filter((call) => /createReply|\/me\/messages$/.test(call.url) && call.method === "POST").length, 0);
        assert.equal(await storedDrafts(), before);
      });
    }
  }

  it("refuses a stale tab's save and send once another tab sent the Outlook draft it replaces", async () => {
    const outside = await outsideDraft("outside-stale");
    const saved = await saveMailDraft(owner, replacing(outside), sendOptions(outlook(state).fetchImpl));
    const other = outlook(state);
    await sendMailDraft(owner, replacing(outside), sendOptions(other.fetchImpl));
    assert.equal(sendsIn(other.calls), 1);
    const stale = outlook(state);
    await assert.rejects(() => saveMailDraft(owner, { ...replacing(outside), id: saved.id }, sendOptions(stale.fetchImpl)), { message: REPLACED_SENT });
    await assert.rejects(() => sendMailDraft(owner, { ...replacing(outside), id: saved.id }, sendOptions(stale.fetchImpl)), { message: REPLACED_SENT });
    assert.equal(sendsIn(stale.calls), 0);
    assert.equal(stale.calls.filter((call) => call.method === "POST").length, 0);
  });

  it("keeps an Outlook draft claimed when Orbit has to remake its own draft, so it never sends twice", async () => {
    const outside = await outsideDraft("outside-remade");
    const logged = console.error;
    console.error = () => undefined;
    try {
      const saved = await saveMailDraft(owner, replacing(outside), sendOptions(failing(outlook(state), "DELETE", 500)));
      const provider = (await getAdminPool().query<{ provider_draft_id: string }>("select provider_draft_id from crm.mail_drafts where id = $1", [saved.id])).rows[0].provider_draft_id;
      const remade = outlook({ ...state, missing: new Set([provider]) });
      await sendMailDraft(owner, { ...readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Sounds good." }), id: saved.id }, sendOptions(remade.fetchImpl));
      assert.equal(sendsIn(remade.calls), 1);
      const again = outlook(state);
      await assert.rejects(() => sendMailDraft(owner, replacing(outside), sendOptions(again.fetchImpl)), { message: REPLACED_SENT });
      assert.equal(sendsIn(again.calls), 0);
    } finally {
      console.error = logged;
    }
  });

  it("keeps a claim while its draft waits more than a week, and clears only old keys with no draft", async () => {
    const outside = await outsideDraft("outside-week");
    const saved = await saveMailDraft(owner, replacing(outside), sendOptions(outlook(state).fetchImpl));
    const admin = getAdminPool();
    await admin.query("update crm.mail_send_keys set created_at = now() - interval '8 days' where user_id = $1", [owner.userId]);
    const old = randomUUID();
    await admin.query(
      "insert into crm.mail_send_keys (user_id, workspace_id, key, sent_at, created_at) values ($1, $2, $3, now() - interval '8 days', now() - interval '9 days')",
      [owner.userId, owner.workspaceId, old],
    );
    const box = outlook(state);
    await sendMailDraft(owner, { ...replacing(outside), id: saved.id }, sendOptions(box.fetchImpl));
    assert.equal(sendsIn(box.calls), 1);
    assert.equal((await admin.query("select 1 from crm.mail_send_keys where key = $1", [old])).rowCount, 0);
    const again = outlook(state);
    await assert.rejects(() => sendMailDraft(owner, replacing(outside), sendOptions(again.fetchImpl)), { message: REPLACED_SENT });
    assert.equal(sendsIn(again.calls), 0);
  });

  it("sends an Outlook draft once when it was deleted in Outlook before Send", async () => {
    const outside = await outsideDraft("outside-deleted");
    await getAdminPool().query("delete from crm.mail_messages where id = $1", [outside]);
    const box = outlook(state);
    await sendMailDraft(owner, replacing(outside), sendOptions(box.fetchImpl));
    assert.equal(sendsIn(box.calls), 1);
  });

  it("sends an Outlook draft once from two tabs, whether they send together or one saved first", async () => {
    const outside = await outsideDraft("outside-tabs");
    const box = outlook(state);
    const results = await Promise.allSettled([sendMailDraft(owner, replacing(outside), sendOptions(box.fetchImpl)), sendMailDraft(owner, replacing(outside), sendOptions(box.fetchImpl))]);
    assert.equal(sendsIn(box.calls), 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) if (result.status === "rejected") assert.ok([ALREADY_SENDING, REPLACED_SENT, STILL_SAVING].includes(result.reason.message));

    const saved = await outsideDraft("outside-saved");
    const editing = outlook(state);
    const draft = await saveMailDraft(owner, replacing(saved), sendOptions(editing.fetchImpl));
    const other = outlook(state);
    await sendMailDraft(owner, replacing(saved), sendOptions(other.fetchImpl));
    assert.equal(sendsIn(other.calls), 1);
    assert.equal(other.calls.filter((call) => /createReply/.test(call.url)).length, 0);
    await assert.rejects(() => sendMailDraft(owner, { ...replacing(saved), id: draft.id }, sendOptions(outlook(state).fetchImpl)), { message: REPLACED_SENT });
  });

  it("never sends an Outlook draft again when Outlook wouldn't delete it", async () => {
    const outside = await outsideDraft("outside-stuck");
    const box = outlook(state);
    const logged = console.error;
    const problems: unknown[] = [];
    console.error = (...args: unknown[]) => void problems.push(args[0]);
    try {
      await sendMailDraft(owner, replacing(outside), sendOptions(failing(box, "DELETE", 500)));
      assert.equal(sendsIn(box.calls), 1);
      assert.ok(problems.includes("Outlook didn't delete the draft Orbit replaced"));
      assert.equal((await getAdminPool().query("select 1 from crm.mail_messages where id = $1", [outside])).rowCount, 1);
      const again = outlook(state);
      await assert.rejects(() => sendMailDraft(owner, replacing(outside), sendOptions(again.fetchImpl)), { message: REPLACED_SENT });
      assert.equal(sendsIn(again.calls), 0);
    } finally {
      console.error = logged;
    }
  });

  const plainReply = (sendKey: string) => readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Plain reply.", sendKey });

  it("refuses the reopened card's autosave when the send went through but its answer was lost", async () => {
    const before = await storedDrafts();
    const saved = await saveMailDraft(owner, plainReply(randomUUID()), sendOptions(outlook(state).fetchImpl));
    const sendKey = randomUUID();
    const box = outlook(state);
    await sendMailDraft(owner, { ...plainReply(sendKey), id: saved.id }, sendOptions(box.fetchImpl));
    assert.equal(sendsIn(box.calls), 1);
    await assert.rejects(() => saveMailDraft(owner, { ...plainReply(sendKey), id: saved.id }, sendOptions(box.fetchImpl)), { message: SENT_ALREADY });
    assert.deepEqual(await sendMailDraft(owner, { ...plainReply(sendKey), id: saved.id }, sendOptions(box.fetchImpl)), { warning: null });
    assert.equal(sendsIn(box.calls), 1);
    assert.equal(await storedDrafts(), before);
  });

  it("never makes a sendable copy in a second tab once the first tab sent the Orbit draft", async () => {
    const before = await storedDrafts();
    const saved = await saveMailDraft(owner, plainReply(randomUUID()), sendOptions(outlook(state).fetchImpl));
    const box = outlook(state);
    await sendMailDraft(owner, { ...plainReply(randomUUID()), id: saved.id }, sendOptions(box.fetchImpl));
    const late = randomUUID();
    await assert.rejects(() => sendMailDraft(owner, { ...plainReply(late), id: saved.id }, sendOptions(box.fetchImpl)), (error: CrmError) => {
      assert.equal(error.message, DRAFT_GONE);
      assert.equal(error.details?.draftId, undefined);
      return true;
    });
    await assert.rejects(() => saveMailDraft(owner, { ...plainReply(late), id: saved.id, body: "Edited in the card." }, sendOptions(box.fetchImpl)), { message: DRAFT_GONE });
    assert.equal(sendsIn(box.calls), 1);
    assert.equal(await storedDrafts(), before);
  });

  it("continues the draft a killed send made, then sends it once the hold runs out", async () => {
    const before = await storedDrafts();
    const sendKey = randomUUID();
    const killed = await saveMailDraft(owner, plainReply(randomUUID()), sendOptions(outlook(state).fetchImpl));
    const admin = getAdminPool();
    await admin.query("update crm.mail_drafts set sending_at = now() where id = $1", [killed.id]);
    await admin.query("insert into crm.mail_send_keys (user_id, workspace_id, key, draft_id) values ($1, $2, $3, $4)", [owner.userId, owner.workspaceId, sendKey, killed.id]);
    const box = outlook(state);
    const autosaved = await saveMailDraft(owner, { ...plainReply(sendKey), body: "Plain reply, edited." }, sendOptions(box.fetchImpl));
    assert.equal(autosaved.id, killed.id);
    assert.equal(await storedDrafts(), before + 1);
    await assert.rejects(() => sendMailDraft(owner, { ...plainReply(sendKey), id: killed.id }, sendOptions(box.fetchImpl)), { message: ALREADY_SENDING });
    await admin.query("update crm.mail_drafts set sending_at = now() - interval '11 minutes' where id = $1", [killed.id]);
    await sendMailDraft(owner, { ...plainReply(sendKey), id: killed.id }, sendOptions(box.fetchImpl));
    assert.equal(sendsIn(box.calls), 1);
    assert.equal(await storedDrafts(), before);
  });

  it("says Still saving to a same-key retry after a killed send of an Outlook draft, then sends it once", async () => {
    const outside = await outsideDraft("outside-killed");
    const sendKey = randomUUID();
    const admin = getAdminPool();
    await admin.query("insert into crm.mail_send_keys (user_id, workspace_id, key) values ($1, $2, reverse($3::text)::uuid), ($1, $2, $4)", [owner.userId, owner.workspaceId, outside, sendKey]);
    const box = outlook(state);
    const input = { ...replacing(outside), sendKey };
    await assert.rejects(() => sendMailDraft(owner, input, sendOptions(box.fetchImpl)), { message: STILL_SAVING });
    await assert.rejects(() => saveMailDraft(owner, input, sendOptions(box.fetchImpl)), { message: STILL_SAVING });
    await admin.query("update crm.mail_send_keys set created_at = now() - interval '11 minutes' where user_id = $1 and key in (reverse($2::text)::uuid, $3)", [owner.userId, outside, sendKey]);
    await sendMailDraft(owner, input, sendOptions(box.fetchImpl));
    assert.equal(sendsIn(box.calls), 1);
  });

  it("refuses a second tab while Orbit remakes the draft the first tab is sending", async () => {
    const outside = await outsideDraft("outside-remaking");
    const saved = await saveMailDraft(owner, replacing(outside), sendOptions(outlook(state).fetchImpl));
    const provider = (await getAdminPool().query<{ provider_draft_id: string }>("select provider_draft_id from crm.mail_drafts where id = $1", [saved.id])).rows[0].provider_draft_id;
    const first = outlook({ ...state, missing: new Set([provider]) });
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((done) => (reached = done));
    let open: () => void = () => undefined;
    const gate = new Promise<void>((done) => (open = done));
    const gated: typeof fetch = async (input, init) => {
      if (/createReply$/.test(String(input))) {
        reached();
        await gate;
      }
      return first.fetchImpl(input, init);
    };
    const sending = sendMailDraft(owner, { ...replacing(outside), id: saved.id }, sendOptions(gated));
    await atGate;
    const second = outlook(state);
    await assert.rejects(() => sendMailDraft(owner, replacing(outside), sendOptions(second.fetchImpl)), { message: ALREADY_SENDING });
    open();
    await sending;
    assert.equal(sendsIn(first.calls) + sendsIn(second.calls), 1);
  });

  it("keeps a sent claim past a week while the Outlook draft is still there, and tries the delete only when it matters", async () => {
    const outside = await outsideDraft("outside-lingering");
    const logged = console.error;
    console.error = () => undefined;
    try {
      const stuck = outlook(state);
      const saved = await saveMailDraft(owner, replacing(outside), sendOptions(failing(stuck, "DELETE", 500)));
      await saveMailDraft(owner, { ...replacing(outside), id: saved.id, body: "Sounds good, edited." }, sendOptions(failing(stuck, "DELETE", 500)));
      assert.equal(stuck.calls.filter((call) => call.method === "DELETE").length, 1);
      await sendMailDraft(owner, { ...replacing(outside), id: saved.id }, sendOptions(failing(stuck, "DELETE", 500)));
      assert.equal(stuck.calls.filter((call) => call.method === "DELETE").length, 2);
      const admin = getAdminPool();
      await admin.query("update crm.mail_send_keys set sent_at = now() - interval '8 days', created_at = now() - interval '9 days' where user_id = $1 and key = reverse($2::text)::uuid", [owner.userId, outside]);
      await sendMailDraft(owner, plainReply(randomUUID()), sendOptions(outlook(state).fetchImpl));
      assert.equal((await admin.query("select 1 from crm.mail_send_keys where user_id = $1 and key = reverse($2::text)::uuid", [owner.userId, outside])).rowCount, 1);
      const again = outlook(state);
      await assert.rejects(() => sendMailDraft(owner, replacing(outside), sendOptions(failing(again, "DELETE", 500))), { message: REPLACED_SENT });
      assert.equal(sendsIn(again.calls), 0);
    } finally {
      console.error = logged;
    }
  });

  it("leaves read images out when read statuses are off", async () => {
    await setReadStatuses(owner, false);
    const { fetchImpl, calls } = outlook(state);
    const draft = await saveMailDraft(owner, readDraftInput({ mode: "reply", messageId: jane, to: ["jane@acme.test"], body: "Quiet" }), { storedFiles: "replace",
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

  it("logs a reply once, only in the workspaces its conversation is filed in", async () => {
    const admin = getAdminPool();
    const created = await createWorkspace(owner, { name: "Mark Ridgeon" });
    const other: UserActor = { ...owner, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    await createContact(other, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    const loggedIn = async (body: string) =>
      (
        await admin.query<{ workspace_id: string }>("select workspace_id from crm.activities where type = 'email' and body = $1 order by workspace_id", [body])
      ).rows.map((row) => row.workspace_id);
    const reply = async (body: string, internetMessageId: string | null = null, more: { mode?: "reply" | "forward"; cc?: string[] } = {}) => {
      const graph = outlook(state);
      const fetchImpl: typeof fetch = async (input, init) =>
        String(input).endsWith("?$select=internetMessageId") ? Response.json({ internetMessageId }) : graph.fetchImpl(input, init);
      const result = await sendMailDraft(owner, readDraftInput({ mode: more.mode ?? "reply", messageId: jane, to: ["jane@acme.test"], cc: more.cc ?? [], body }), {
        storedFiles: "replace",
        origin: ORIGIN,
        fetchImpl,
      });
      assert.equal(result.warning, null);
    };

    await setThreadFiling(owner, thread, [other.workspaceId]);
    await reply("Filed in the other workspace.");
    assert.deepEqual(await loggedIn("Filed in the other workspace."), [other.workspaceId]);
    await reply("Forwarded from here.", null, { mode: "forward" });
    assert.deepEqual(await loggedIn("Forwarded from here."), [owner.workspaceId]);

    await setThreadFiling(owner, thread, [owner.workspaceId, other.workspaceId]);
    await reply("Filed in both workspaces.", "<both-1@mail.test>");
    const both = [owner.workspaceId, other.workspaceId].sort();
    assert.deepEqual(await loggedIn("Filed in both workspaces."), both);

    state.sent = [
      message("sent-both", {
        internetMessageId: "<both-1@mail.test>",
        subject: "RE: Renewal pricing",
        from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
        toRecipients: [{ emailAddress: { name: "Jane Doe", address: "jane@acme.test" } }],
        ccRecipients: [],
        body: { contentType: "text", content: "Filed in both workspaces." },
        sentDateTime: "2026-10-03T09:00:00Z",
        receivedDateTime: "2026-10-03T09:00:00Z",
      }),
    ];
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook(state).fetchImpl });
    const copies = await admin.query<{ workspace_id: string }>(
      "select workspace_id from crm.activities where type = 'email' and metadata->>'internetMessageId' = '<both-1@mail.test>' order by workspace_id",
    );
    assert.deepEqual(copies.rows.map((row) => row.workspace_id), both);

    await ignoreUnknownMail(owner, thread);
    await reply("Sent on an ignored conversation.");
    assert.deepEqual(await loggedIn("Sent on an ignored conversation."), []);

    await admin.query("delete from crm.mail_thread_routes where user_id = $1", [owner.userId]);
    await admin.query("update crm.contacts set archived_at = now() where normalized_email = 'jane@acme.test'");
    await admin.query("update crm.companies set archived_at = now() where domain = 'acme.test'");
    await createContact(owner, { firstName: "Ola", lastName: "Berg", email: "ola@berg-studio.test" });
    await reply("Sent on a conversation only in Capture.", null, { cc: ["ola@berg-studio.test"] });
    assert.deepEqual(await loggedIn("Sent on a conversation only in Capture."), []);
  });
});
