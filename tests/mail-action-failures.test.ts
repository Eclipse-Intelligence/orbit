import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { ACTION_BUDGET_MS, applyMailAction, moveMessages } from "@/lib/mail/actions";
import { MOVE_UNCONFIRMED, retryWaitMs } from "@/lib/mail/microsoft";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };

const CONVERSATIONS: Record<string, string[]> = {
  "conv-lost": ["lost-1"],
  "conv-gone": ["gone-1"],
  "conv-unconfirmed": ["unconfirmed-1"],
  "conv-deleted": ["deleted-1"],
  "conv-partial": ["partial-1", "partial-2", "partial-3"],
  "conv-deadline": ["deadline-1"],
  "conv-read": ["read-1", "read-2"],
  "conv-many": ["many-1", "many-2"],
};

function message(id: string, conversationId: string, index: number) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId,
    subject: "Private subject line",
    bodyPreview: "Hello",
    body: { contentType: "text", content: "Hello" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: `2026-10-0${index + 1}T09:00:00Z`,
    receivedDateTime: `2026-10-0${index + 1}T09:00:05Z`,
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

type Handler = (url: string, method: string, attempt: number) => Response | undefined;

function outlook(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const where = new Map<string, string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const custom = handler(url, method, calls.filter((call) => call === `${method} ${url}`).length);
    if (custom) return custom;
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method === "POST" && url.endsWith("/move")) {
      const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
      where.set(id, FOLDERS[destination] ?? destination);
      return Response.json({ id, parentFolderId: where.get(id) }, { status: 201 });
    }
    if (method === "PATCH") return Response.json({ id });
    if (/\/me\/messages\/[^/?]+\?\$select=id,parentFolderId$/.test(url)) return Response.json({ id, parentFolderId: where.get(id) ?? "f-inbox" });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: Object.entries(FOLDERS).map(([name, folder]) => ({ id: folder, displayName: name, childFolderCount: 0, totalItemCount: 0 })) });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const value =
      folder === "f-inbox" && !url.includes("token=")
        ? Object.entries(CONVERSATIONS).flatMap(([conversation, ids]) => ids.map((item, index) => message(item, conversation, index)))
        : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=done` });
  };
  const moves = (id: string) => calls.filter((call) => call === `POST ${GRAPH}/me/messages/${id}/move`).length;
  return { fetchImpl, calls, moves };
}

function serverError(status = 503) {
  return Response.json({ error: { code: "ServiceUnavailable", message: "Try again later." } }, { status, headers: { "retry-after": "0" } });
}

function notFound() {
  return Response.json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } }, { status: 404 });
}

describe("mail action failures", () => {
  let owner: UserActor;
  let sourceId: string;
  let logged: unknown[][];
  const original = console.error;

  const thread = (conversation: string) => `${sourceId}|${conversation}`;
  const roleOf = async (providerId: string) => {
    const result = await getAdminPool().query<{ role: string }>(
      "select f.role from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = $1",
      [providerId],
    );
    return result.rows[0]?.role ?? null;
  };

  before(async () => {
    await resetDatabase();
    owner = await createUser("mail-failures@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(report.errors, []);
    sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources")).rows[0].id;
  });

  beforeEach(() => {
    logged = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
  });

  afterEach(() => {
    console.error = original;
  });

  after(async () => {
    await getPool().end();
  });

  useServerlessPool();

  it("records the right folder when Microsoft moved the email but lost the answer", async () => {
    const box = outlook((url, method, attempt) => (method === "POST" && url.endsWith("/lost-1/move") && attempt === 1 ? serverError() : undefined));
    const result = await applyMailAction(owner, { thread: thread("conv-lost"), action: "archive", view: { role: "inbox" } }, box.fetchImpl);
    assert.deepEqual(result, { changed: 1, failed: 0, problem: null });
    assert.equal(box.moves("lost-1"), 2);
    assert.equal(await roleOf("lost-1"), "archive");
  });

  it("checks where the email is when the repeated move can't find it, instead of saying it's gone", async () => {
    const box = outlook((url, method, attempt) => {
      if (method !== "POST" || !url.endsWith("/gone-1/move")) return undefined;
      return attempt === 1 ? serverError(502) : notFound();
    });
    const base = box.fetchImpl;
    const archived: typeof fetch = async (input, init) =>
      /\/gone-1\?\$select=id,parentFolderId$/.test(String(input)) ? Response.json({ id: "gone-1", parentFolderId: "f-archive" }) : base(input, init);
    const result = await applyMailAction(owner, { thread: thread("conv-gone"), action: "archive", view: { role: "inbox" } }, archived);
    assert.deepEqual(result, { changed: 1, failed: 0, problem: null });
    assert.equal(await roleOf("gone-1"), "archive");

    const lost = outlook((url, method, attempt) => {
      if (method === "POST" && url.endsWith("/unconfirmed-1/move")) return attempt === 1 ? serverError(504) : notFound();
      if (/\/unconfirmed-1\?\$select=id,parentFolderId$/.test(url)) return notFound();
      return undefined;
    });
    await assert.rejects(
      () => applyMailAction(owner, { thread: thread("conv-unconfirmed"), action: "archive", view: { role: "inbox" } }, lost.fetchImpl),
      (error: Error) => error.message === MOVE_UNCONFIRMED && !/no longer in Outlook/.test(error.message),
    );
    assert.equal(await roleOf("unconfirmed-1"), "inbox");

    const deleted = outlook((url, method) => (method === "POST" && url.endsWith("/deleted-1/move") ? notFound() : undefined));
    await assert.rejects(
      () => applyMailAction(owner, { thread: thread("conv-deleted"), action: "archive", view: { role: "inbox" } }, deleted.fetchImpl),
      /That email is no longer in Outlook\./,
    );
    assert.equal(deleted.moves("deleted-1"), 1, "a plain 404 is not repeated");
  });

  it("keeps what moved when one email in the conversation fails, and logs Microsoft's answer without the email's details", async () => {
    const box = outlook((url, method) => (method === "POST" && url.endsWith("/partial-2/move") ? serverError(500) : undefined));
    const result = await applyMailAction(owner, { thread: thread("conv-partial"), action: "archive", view: { role: "inbox" } }, box.fetchImpl);
    assert.equal(result.changed, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.problem, "Try again later.");
    assert.equal(box.moves("partial-2"), 3, "a server error is tried three times");
    assert.deepEqual([await roleOf("partial-1"), await roleOf("partial-2"), await roleOf("partial-3")], ["archive", "inbox", "archive"]);
    const entries = logged.filter((entry) => entry[0] === "Mail action failed in Microsoft");
    assert.deepEqual(entries, [["Mail action failed in Microsoft", { action: "archive", mailbox: sourceId, status: 500, code: "ServiceUnavailable" }]]);
    const text = JSON.stringify(logged);
    assert.ok(!text.includes("Private subject line") && !text.includes("jane@acme.test") && !text.includes("mark@eclipse.test"));
  });

  it("repeats a read change after a server error", async () => {
    const box = outlook((url, method, attempt) => (method === "PATCH" && url.includes("/read-1?") && attempt === 1 ? serverError(502) : undefined));
    const result = await applyMailAction(owner, { thread: thread("conv-read"), action: "read", view: { role: "inbox" } }, box.fetchImpl);
    assert.deepEqual(result, { changed: 2, failed: 0, problem: null });
    assert.equal(box.calls.filter((call) => call.startsWith("PATCH") && call.includes("/read-1?")).length, 2);
  });

  it("stops repeating before the request runs out of time", async () => {
    assert.equal(retryWaitMs({ headers: new Headers({ "retry-after": "5" }) }, 0), 5_000);
    assert.equal(retryWaitMs({ headers: new Headers({ "retry-after": "6" }) }, 0), null, "never waits more than five seconds");
    const route = readFileSync("app/api/mail/actions/route.ts", "utf8");
    const limit = Number(route.match(/export const maxDuration = (\d+);/)?.[1]);
    assert.ok(ACTION_BUDGET_MS + 15_000 <= limit * 1000, "the action budget leaves time to save before the route's limit");

    const slow = outlook((url, method) =>
      method === "POST" && url.endsWith("/deadline-1/move")
        ? Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503, headers: { "retry-after": "2" } })
        : undefined,
    );
    const started = Date.now();
    await assert.rejects(() =>
      applyMailAction(owner, { thread: thread("conv-deadline"), action: "archive", view: { role: "inbox" } }, slow.fetchImpl, { deadline: started + 4_000 }),
    );
    assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started}ms`);
    assert.equal(slow.moves("deadline-1"), 2, "the second wait would pass the deadline, so it stops");
    assert.equal(await roleOf("deadline-1"), "inbox");
  });

  it("logs each failed move when moving several emails", async () => {
    const box = outlook((url, method) => (method === "POST" && url.endsWith("/many-2/move") ? Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied for jane@acme.test" } }, { status: 403 }) : undefined));
    const rows = await getAdminPool().query<{ id: string; provider_message_id: string; thread_key: string }>(
      "select id, provider_message_id, thread_key from crm.mail_messages where thread_key = 'conv-many' order by provider_message_id",
    );
    const result = await moveMessages(
      owner,
      sourceId,
      rows.rows.map((row) => ({ id: row.id, providerMessageId: row.provider_message_id, threadKey: row.thread_key })),
      "trash",
      box.fetchImpl,
    );
    assert.equal(result.moved.length, 1);
    assert.ok(result.error);
    assert.deepEqual(
      logged.filter((entry) => entry[0] === "Mail action failed in Microsoft"),
      [["Mail action failed in Microsoft", { action: "trash", mailbox: sourceId, status: 403, code: "ErrorAccessDenied" }]],
    );
    assert.ok(!JSON.stringify(logged).includes("jane@acme.test"));
  });
});
