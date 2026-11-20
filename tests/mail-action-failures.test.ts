import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { runCaptureAction } from "@/lib/crm/capture-actions";
import { ACTION_BUDGET_MS, applyMailAction, moveMessages } from "@/lib/mail/actions";
import { processDueMail, REMINDER_ATTEMPTS } from "@/lib/mail/due";
import { MOVE_CONFIRM_MS, MOVE_UNCONFIRMED, retryWaitMs } from "@/lib/mail/microsoft";
import { runPendingMailActions } from "@/lib/mail/pending";
import { takeMailRefusals } from "@/lib/mail/refusals";
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
  "conv-still": ["still-1"],
  "conv-elsewhere": ["elsewhere-1"],
  "conv-timeout": ["timeout-1"],
  "conv-dropped": ["dropped-1"],
  "conv-trash-timeout": ["trash-timeout-1"],
  "conv-capture-archive": ["capture-archive-1", "capture-archive-2"],
  "conv-capture-snooze": ["capture-snooze-1", "capture-snooze-2"],
  "conv-snoozed": ["snoozed-1", "snoozed-2"],
  "conv-snoozed-flag": ["flag-1", "flag-2"],
  "conv-late": ["late-1"],
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

type Handler = (url: string, method: string, attempt: number, moveTo: (id: string, folder: string) => void) => Response | Error | undefined;

function outlook(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const where = new Map<string, string>();
  const moveTo = (id: string, folder: string) => {
    where.set(id, folder);
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const custom = handler(url, method, calls.filter((call) => call === `${method} ${url}`).length, moveTo);
    if (custom instanceof Error) throw custom;
    if (custom) return custom;
    if (method === "POST" && url === `${GRAPH}/me/mailFolders`) return Response.json({ id: "f-snoozed", displayName: "Snoozed" }, { status: 201 });
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

  const addReminder = async (conversation: string) => {
    await getAdminPool().query(
      `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject, state)
       values ($1, $2, $3, $4, 'follow_up', now() - interval '1 hour', 'Follow up', 'due')`,
      [owner.workspaceId, owner.userId, sourceId, conversation],
    );
  };
  const reminderState = async (conversation: string, kind = "follow_up") => {
    const result = await getAdminPool().query<{ state: string }>(
      "select state from crm.mail_reminders where thread_key = $1 and kind = $2 order by created_at desc limit 1",
      [conversation, kind],
    );
    return result.rows[0]?.state ?? null;
  };

  const makeDue = async (conversation: string) => {
    await getAdminPool().query(
      "update crm.mail_reminders set due_at = now() - interval '1 minute' where kind = 'snooze' and thread_key = $1 and state = 'waiting'",
      [conversation],
    );
  };
  const snoozeReminder = async (conversation: string) => {
    const result = await getAdminPool().query<{ state: string; attempts: number }>(
      "select state, attempts from crm.mail_reminders where thread_key = $1 and kind = 'snooze' and state <> 'done' order by created_at desc limit 1",
      [conversation],
    );
    return result.rows[0] ?? null;
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

  it("checks where the email is when the repeated move can't find it, and counts it moved only when it is in the destination", async () => {
    const box = outlook((url, method, attempt, moveTo) => {
      if (method !== "POST" || !url.endsWith("/gone-1/move")) return undefined;
      if (attempt > 1) return notFound();
      moveTo("gone-1", "f-archive");
      return serverError(502);
    });
    const result = await applyMailAction(owner, { thread: thread("conv-gone"), action: "archive", view: { role: "inbox" } }, box.fetchImpl);
    assert.deepEqual(result, { changed: 1, failed: 0, problem: null });
    assert.equal(box.moves("gone-1"), 2);
    assert.equal(await roleOf("gone-1"), "archive");

    await addReminder("conv-still");
    const still = outlook((url, method, attempt) => (method === "POST" && url.endsWith("/still-1/move") ? (attempt === 1 ? serverError(503) : notFound()) : undefined));
    await assert.rejects(
      () => applyMailAction(owner, { thread: thread("conv-still"), action: "archive", view: { role: "inbox" } }, still.fetchImpl),
      (error: Error) => error.message === MOVE_UNCONFIRMED,
    );
    assert.equal(await roleOf("still-1"), "inbox", "an email still in the inbox is not counted as archived");
    assert.equal(await reminderState("conv-still"), "due", "no reminder is settled");

    const elsewhere = outlook((url, method, attempt, moveTo) => {
      if (method !== "POST" || !url.endsWith("/elsewhere-1/move")) return undefined;
      if (attempt > 1) return notFound();
      moveTo("elsewhere-1", "f-trash");
      return serverError(500);
    });
    await assert.rejects(
      () => applyMailAction(owner, { thread: thread("conv-elsewhere"), action: "archive", view: { role: "inbox" } }, elsewhere.fetchImpl),
      (error: Error) => error.message === MOVE_UNCONFIRMED,
    );
    assert.equal(await roleOf("elsewhere-1"), "inbox", "a folder other than the destination is not recorded");

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

  it("confirms a move whose answer timed out or never arrived, and records it only when it landed", async () => {
    const timedOut = outlook((url, method, _attempt, moveTo) => {
      if (method !== "POST" || !url.endsWith("/timeout-1/move")) return undefined;
      moveTo("timeout-1", "f-archive");
      return new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await applyMailAction(owner, { thread: thread("conv-timeout"), action: "archive", view: { role: "inbox" } }, timedOut.fetchImpl);
    assert.deepEqual(result, { changed: 1, failed: 0, problem: null });
    assert.equal(timedOut.moves("timeout-1"), 1, "a move without an answer is checked, not repeated");
    assert.equal(await roleOf("timeout-1"), "archive");

    const dropped = outlook((url, method) => (method === "POST" && url.endsWith("/dropped-1/move") ? new TypeError("fetch failed") : undefined));
    await assert.rejects(
      () => applyMailAction(owner, { thread: thread("conv-dropped"), action: "archive", view: { role: "inbox" } }, dropped.fetchImpl),
      (error: Error) => error.message === MOVE_UNCONFIRMED,
    );
    assert.equal(await roleOf("dropped-1"), "inbox");

    const row = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'trash-timeout-1'")).rows[0];
    const binned = outlook((url, method, _attempt, moveTo) => {
      if (method !== "POST" || !url.endsWith("/trash-timeout-1/move")) return undefined;
      moveTo("trash-timeout-1", "f-trash");
      return new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const moved = await moveMessages(owner, sourceId, [{ id: row.id, providerMessageId: "trash-timeout-1", threadKey: "conv-trash-timeout" }], "trash", binned.fetchImpl);
    assert.deepEqual(moved, { moved: [row.id], error: null, late: 0 });
    assert.equal(await roleOf("trash-timeout-1"), "trash");
  });

  it("never lets Capture or a returning snooze treat a partly failed change as done", async () => {
    const failing = (id: string) => outlook((url, method) => (method === "POST" && url.endsWith(`/${id}/move`) ? serverError(500) : undefined));
    const queued = await runCaptureAction(owner, { kind: "reply-done", thread: thread("conv-capture-archive") });
    assert.equal(queued.queued, true);
    await runPendingMailActions(owner, { fetchImpl: failing("capture-archive-2").fetchImpl });
    assert.deepEqual([await roleOf("capture-archive-1"), await roleOf("capture-archive-2")], ["archive", "inbox"]);
    const refusals = await takeMailRefusals(owner);
    assert.match(refusals[0]?.problem ?? "", /Couldn't change 1 email in this conversation\. Try again later\./);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    await runCaptureAction(owner, { kind: "reply-snooze", thread: thread("conv-capture-snooze"), until });
    await runPendingMailActions(owner, { fetchImpl: failing("capture-snooze-2").fetchImpl });
    assert.deepEqual([await roleOf("capture-snooze-1"), await roleOf("capture-snooze-2")], ["snoozed", "inbox"]);
    assert.match((await takeMailRefusals(owner))[0]?.problem ?? "", /Couldn't change 1 email in this conversation\./);

    await applyMailAction(owner, { thread: thread("conv-snoozed"), action: "snooze", view: { role: "inbox" }, until }, outlook().fetchImpl);
    await makeDue("conv-snoozed");
    const report = await processDueMail(owner, { fetchImpl: failing("snoozed-2").fetchImpl, origin: null });
    assert.equal(report.returned, 0);
    assert.equal(report.reminderErrors, 1);
    assert.deepEqual([await roleOf("snoozed-1"), await roleOf("snoozed-2")], ["inbox", "snoozed"]);
    assert.deepEqual(await snoozeReminder("conv-snoozed"), { state: "waiting", attempts: 1 }, "the reminder stays open to try again");

    await makeDue("conv-snoozed");
    const healthy = await processDueMail(owner, { fetchImpl: outlook().fetchImpl, origin: null });
    assert.equal(healthy.returned, 1);
    assert.deepEqual([await roleOf("snoozed-1"), await roleOf("snoozed-2")], ["inbox", "inbox"]);
    assert.equal((await snoozeReminder("conv-snoozed"))?.state, "due");
  });

  it("flags a returning snooze after five partly failed tries", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await applyMailAction(owner, { thread: thread("conv-snoozed-flag"), action: "snooze", view: { role: "inbox" }, until }, outlook().fetchImpl);
    const failing = outlook((url, method) => (method === "POST" && url.endsWith("/flag-2/move") ? serverError(500) : undefined));
    for (let attempt = 1; attempt <= REMINDER_ATTEMPTS; attempt += 1) {
      await makeDue("conv-snoozed-flag");
      const report = await processDueMail(owner, { fetchImpl: failing.fetchImpl, origin: null });
      assert.equal(report.returned, 0);
      const expected = attempt < REMINDER_ATTEMPTS ? "waiting" : "due";
      assert.deepEqual(await snoozeReminder("conv-snoozed-flag"), { state: expected, attempts: attempt });
    }
    assert.deepEqual([await roleOf("flag-1"), await roleOf("flag-2")], ["inbox", "snoozed"]);
    const alerts = await getAdminPool().query<{ count: number }>("select count(*)::int as count from crm.notifications where user_id = $1 and title like 'Still in Reminders:%'", [
      owner.userId,
    ]);
    assert.equal(alerts.rows[0].count, 1, "it tells you once, after the fifth try");
  });

  it("stops moving emails at the caller's deadline", async () => {
    const row = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'late-1'")).rows[0];
    const box = outlook();
    const result = await moveMessages(owner, sourceId, [{ id: row.id, providerMessageId: "late-1", threadKey: "conv-late" }], "archive", box.fetchImpl, {
      deadline: Date.now() + 500,
    });
    assert.deepEqual(result, { moved: [], error: null, late: 1 }, "an email time cut off is counted as late, not as Outlook refusing it");
    assert.equal(box.moves("late-1"), 0, "no move is started after the deadline");
    assert.equal(await roleOf("late-1"), "inbox");
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
    assert.ok(ACTION_BUDGET_MS + MOVE_CONFIRM_MS + 5_000 <= limit * 1000, "the action budget and a last move check leave time to save before the route's limit");

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
