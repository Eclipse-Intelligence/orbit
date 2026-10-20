import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { setSenderSplit } from "@/lib/mail/split";
import { syncMail } from "@/lib/mail/sync";
import { listThreads, mailNav, mailUnreadCount } from "@/lib/mail/threads";
import { mailViewParam, readMailView } from "@/lib/mail/view";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function message(id: string, from: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: "Hello",
    body: { contentType: "text", content: "Hello there" },
    from: { emailAddress: { name: from.split("@")[0], address: from } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: "2026-10-01T09:00:00Z",
    receivedDateTime: "2026-10-01T09:00:05Z",
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

function mailbox(state: { inbox: Record<string, unknown>[]; sent: Record<string, unknown>[]; classified: Record<string, string> }) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders/f-inbox/messages?$select=id,inferenceClassification`)) {
      return Response.json({ value: Object.entries(state.classified).map(([id, value]) => ({ id, inferenceClassification: value })) });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    return Response.json({ value: folder ? (pages[folder] ?? []) : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
  return { fetchImpl, calls };
}

describe("split inbox", () => {
  let owner: UserActor;
  const subjects = async (split: "important" | "other" | "news" | "calendar") =>
    (await listThreads(owner, { view: { role: "inbox", split } })).threads.map((thread) => thread.subject).sort();

  before(async () => {
    await resetDatabase();
    owner = await createUser("split@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" });
    const state = {
      inbox: [
        message("contact", "jane@acme.test", { inferenceClassification: "other" }),
        message("newsletter", "news@brand.test", { inferenceClassification: "focused" }),
        message("receipt", "receipts@shop.test"),
        message("cold", "sales@vendor.test", { inferenceClassification: "other" }),
        message("person", "sam@initech.test", { inferenceClassification: "focused" }),
        message("invite", "lena@globex.test", { subject: "Accepted: Q4 planning", inferenceClassification: "focused" }),
        message("replied", "tom@vendor.test", { inferenceClassification: "other" }),
        message("legacy", "ola@acme.test"),
      ],
      sent: [message("sent-reply", "mark@eclipse.test", { conversationId: "conv-replied", isRead: true })],
      classified: { legacy: "other" } as Record<string, string>,
    };
    const first = mailbox(state);
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: first.fetchImpl });
    const second = mailbox(state);
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: second.fetchImpl });
    assert.ok(second.calls.some((url) => url.includes("inferenceClassification")));
    const third = mailbox(state);
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: third.fetchImpl });
    assert.ok(!third.calls.some((url) => url.includes("$select=id,inferenceClassification")));
  });

  after(async () => {
    await getPool().end();
  });

  it("reads and writes split views in the URL", () => {
    assert.deepEqual(readMailView("inbox:news"), { role: "inbox", split: "news" });
    assert.deepEqual(readMailView("inbox:junk"), { role: "inbox", split: null });
    assert.equal(mailViewParam({ role: "inbox", split: "calendar" }), "inbox:calendar");
    assert.equal(mailViewParam({ role: "inbox" }), "inbox");
  });

  it("sorts the inbox into Important, Other, News and Calendar", async () => {
    assert.deepEqual(await subjects("important"), ["Subject contact", "Subject person", "Subject replied"]);
    assert.deepEqual(await subjects("other"), ["Subject cold", "Subject legacy"]);
    assert.deepEqual(await subjects("news"), ["Subject newsletter", "Subject receipt"]);
    assert.deepEqual(await subjects("calendar"), ["Accepted: Q4 planning"]);
    const all = await listThreads(owner, { view: { role: "inbox" } });
    assert.equal(all.threads.length, 8);
    assert.equal(all.threads.find((thread) => thread.subject === "Subject cold")?.split, "other");
    assert.equal((await listThreads(owner, { view: { role: "sent" } })).threads[0]?.split ?? null, null);
  });

  it("counts each split and badges only Important", async () => {
    const nav = await mailNav(owner);
    const totals = Object.fromEntries(nav.splits.map((row) => [row.split, [row.total, row.unread]]));
    assert.deepEqual(totals, { important: [3, 3], other: [2, 2], news: [2, 2], calendar: [1, 1] });
    assert.equal(await mailUnreadCount(owner), 3);
  });

  it("learns where a sender belongs, with the address beating the domain", async () => {
    await setSenderSplit(owner, "@vendor.test", "news");
    assert.deepEqual(await subjects("news"), ["Subject cold", "Subject newsletter", "Subject receipt", "Subject replied"]);
    await setSenderSplit(owner, "tom@vendor.test", "important");
    assert.ok((await subjects("important")).includes("Subject replied"));
    await setSenderSplit(owner, "@vendor.test", null);
    assert.deepEqual(await subjects("other"), ["Subject cold", "Subject legacy"]);
    await assert.rejects(() => setSenderSplit(owner, "not an address", "news"), /email address or @domain/);
  });
});
