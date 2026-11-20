import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { backoffMs, processAllPendingMail, queueMailAction, runPendingMailActions } from "@/lib/mail/pending";
import { takeMailRefusals } from "@/lib/mail/refusals";
import { syncMail } from "@/lib/mail/sync";
import { listThreads, mailNav, mailUnreadCount } from "@/lib/mail/threads";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", archive: "f-archive", deleteditems: "f-trash" };
const CONVERSATIONS = [
  "conv-success",
  "conv-503",
  "conv-429",
  "conv-refused",
  "conv-gone",
  "conv-reconnect",
  "conv-undo",
  "conv-blocked",
  "conv-hidden",
  "conv-cron",
  "conv-other",
  "conv-trash",
  "conv-origin",
  "conv-partial",
  "conv-late",
  "conv-mixed",
];

const EXTRA = ["conv-partial-2", "conv-partial-3", "conv-late-2", "conv-mixed-2"];

function message(id: string, conversationId: string) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId,
    subject: `Subject of ${conversationId}`,
    bodyPreview: "Hello",
    body: { contentType: "text", content: "Hello" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
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
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

const messageId = (conversation: string) => `${conversation}-1`;

type Handler = (url: string, method: string, attempt: number) => Response | Error | undefined;

function outlook(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const destinations: string[] = [];
  const where = new Map<string, string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const custom = handler(url, method, calls.filter((call) => call === `${method} ${url}`).length);
    if (custom instanceof Error) throw custom;
    if (custom) return custom;
    if (method === "POST" && url === `${GRAPH}/me/mailFolders`) return Response.json({ id: "f-snoozed", displayName: "Snoozed" }, { status: 201 });
    const id = decodeURIComponent(url.match(/\/me\/messages\/([^/?]+)/)?.[1] ?? "");
    if (method === "POST" && url.endsWith("/move")) {
      const destination = String((JSON.parse(String(init?.body)) as { destinationId: string }).destinationId);
      destinations.push(destination);
      where.set(id, FOLDERS[destination] ?? destination);
      return Response.json({ id, parentFolderId: where.get(id) }, { status: 201 });
    }
    if (/\/me\/messages\/[^/?]+\?\$select=id,parentFolderId$/.test(url)) return Response.json({ id, parentFolderId: where.get(id) ?? "f-inbox" });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: Object.entries(FOLDERS).map(([name, folder]) => ({ id: folder, displayName: name, childFolderCount: 0, totalItemCount: 0 })) });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const value =
      folder === "f-inbox" && !url.includes("token=")
        ? [...CONVERSATIONS.map((conversation) => message(messageId(conversation), conversation)), ...EXTRA.map((id) => message(id, id.replace(/-\d$/, "")))]
        : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder ?? "x"}/messages/delta?$deltatoken=done` });
  };
  const moves = (conversation: string) => calls.filter((call) => call === `POST ${GRAPH}/me/messages/${messageId(conversation)}/move`).length;
  return { fetchImpl, calls, destinations, moves };
}

const failMove = (conversation: string, response: () => Response, times = Infinity): Handler => {
  let used = 0;
  return (url, method) => {
    if (method !== "POST" || !url.endsWith(`/${messageId(conversation)}/move`) || used >= times) return undefined;
    used += 1;
    return response();
  };
};

const graphError = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message: `Outlook said ${code}.` } }, { status, headers: { "retry-after": "0", ...headers } });

describe("queued mail moves", () => {
  let owner: UserActor;
  let stranger: UserActor;
  let sourceId: string;
  const original = console.error;

  const thread = (conversation: string) => `${sourceId}|${conversation}`;
  const roleOf = async (conversation: string) => {
    const result = await getAdminPool().query<{ role: string }>(
      "select f.role from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = $1",
      [messageId(conversation)],
    );
    return result.rows[0]?.role ?? null;
  };
  const rows = async (conversation: string) =>
    (
      await getAdminPool().query<{
        action: string;
        attempts: number;
        refused_at: Date | null;
        problem: string | null;
        wait_ms: number;
        subject: string | null;
      }>(
        `select action, attempts, refused_at, problem, subject, extract(epoch from (next_attempt_at - now())) * 1000 as wait_ms
         from crm.mail_pending_actions where thread_key = $1 order by created_at, id`,
        [conversation],
      )
    ).rows;
  const makeDue = (conversation: string) =>
    getAdminPool().query("update crm.mail_pending_actions set next_attempt_at = now() where thread_key = $1 and refused_at is null", [conversation]);
  const inbox = async (actor = owner) => (await listThreads(actor, { view: { role: "inbox" } })).threads.map((item) => item.key);
  const archived = async () => (await listThreads(owner, { view: { role: "archive" } })).threads.map((item) => item.key);
  const drain = (fetchImpl: typeof fetch, actor = owner) => runPendingMailActions(actor, { deadline: Date.now() + 40_000, fetchImpl });

  before(async () => {
    await resetDatabase();
    owner = await createUser("mail-pending@orbit.test", "Mark Ridgeon");
    stranger = await createUser("mail-pending-stranger@orbit.test", "Someone Else");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(report.errors, []);
    sourceId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_sources")).rows[0].id;
    console.error = () => undefined;
  });

  after(async () => {
    console.error = original;
    await getPool().end();
  });

  useServerlessPool();

  it("queues without calling Microsoft, hides the thread at once, then moves it in the background", async () => {
    const box = outlook();
    await queueMailAction(owner, { thread: thread("conv-success"), action: "archive", view: { role: "inbox" } });
    assert.deepEqual(box.calls, []);
    assert.ok(!(await inbox()).includes(thread("conv-success")), "the inbox list leaves it out while the move is waiting");
    assert.equal(await roleOf("conv-success"), "inbox");
    assert.equal((await rows("conv-success"))[0].subject, "Subject of conv-success");

    assert.equal(await drain(box.fetchImpl), 1);
    assert.equal(await roleOf("conv-success"), "archive");
    assert.deepEqual(await rows("conv-success"), []);
    assert.ok((await archived()).includes(thread("conv-success")));
    assert.deepEqual(await takeMailRefusals(owner), []);
  });

  it("keeps the thread hidden and tries again later when Microsoft has a server error", async () => {
    const box = outlook(failMove("conv-503", () => graphError(503, "ServiceUnavailable")));
    await queueMailAction(owner, { thread: thread("conv-503"), action: "archive", view: { role: "inbox" } });
    await drain(box.fetchImpl);
    const [waiting] = await rows("conv-503");
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.refused_at, null);
    assert.ok(waiting.wait_ms > 2_000 && waiting.wait_ms <= 5_500, `waits about five seconds, not ${waiting.wait_ms}`);
    assert.ok(!(await inbox()).includes(thread("conv-503")), "a failed try never brings it back");
    assert.equal(await roleOf("conv-503"), "inbox");

    assert.equal(await drain(box.fetchImpl), 0, "nothing runs before the wait is over");
    await makeDue("conv-503");
    const healthy = outlook();
    await drain(healthy.fetchImpl);
    assert.equal(await roleOf("conv-503"), "archive");
    assert.deepEqual(await rows("conv-503"), []);
  });

  it("honours Retry-After on a 429 and backs off on later tries", async () => {
    const box = outlook(failMove("conv-429", () => graphError(429, "TooManyRequests", { "retry-after": "120" })));
    await queueMailAction(owner, { thread: thread("conv-429"), action: "archive", view: { role: "inbox" } });
    await drain(box.fetchImpl);
    const [waiting] = await rows("conv-429");
    assert.equal(waiting.attempts, 1);
    assert.ok(waiting.wait_ms > 100_000 && waiting.wait_ms <= 121_000, `waits the two minutes Microsoft asked for, not ${waiting.wait_ms}`);
    assert.ok(!(await inbox()).includes(thread("conv-429")));
    assert.deepEqual([1, 2, 3, 4, 9].map((attempt) => backoffMs(attempt, null)), [5_000, 15_000, 60_000, 300_000, 300_000]);
    assert.equal(backoffMs(1, 90_000), 90_000);
    await makeDue("conv-429");
    await drain(outlook().fetchImpl);
    assert.equal(await roleOf("conv-429"), "archive");
  });

  it("surfaces a definite refusal once, and shows the thread again", async () => {
    const box = outlook(failMove("conv-refused", () => graphError(403, "ErrorAccessDenied")));
    await queueMailAction(owner, { thread: thread("conv-refused"), action: "archive", view: { role: "inbox" } });
    assert.ok(!(await inbox()).includes(thread("conv-refused")));
    await drain(box.fetchImpl);
    const [refused] = await rows("conv-refused");
    assert.ok(refused.refused_at);
    assert.match(refused.problem ?? "", /Outlook refused that change/);
    assert.ok((await inbox()).includes(thread("conv-refused")), "a refused move no longer hides the thread");
    assert.equal(box.moves("conv-refused"), 1, "a refusal is not repeated");

    const shown = await takeMailRefusals(owner);
    assert.equal(shown.length, 1);
    assert.deepEqual({ action: shown[0].action, subject: shown[0].subject }, { action: "archive", subject: "Subject of conv-refused" });
    assert.match(shown[0].problem, /Outlook refused that change/);
    assert.deepEqual(await takeMailRefusals(owner), [], "the same refusal is never shown twice");
    assert.equal(await drain(outlook().fetchImpl), 0);
  });

  it("counts an email that is gone from Outlook as done", async () => {
    const box = outlook(failMove("conv-gone", () => graphError(404, "ErrorItemNotFound")));
    await queueMailAction(owner, { thread: thread("conv-gone"), action: "archive", view: { role: "inbox" } });
    await drain(box.fetchImpl);
    assert.deepEqual(await rows("conv-gone"), []);
    assert.deepEqual(await takeMailRefusals(owner), []);

    await getAdminPool().query("insert into crm.mail_pending_actions (workspace_id, user_id, source_id, thread_key, action) values ($1, $2, $3, 'conv-unknown', 'archive')", [
      owner.workspaceId,
      owner.userId,
      sourceId,
    ]);
    await drain(outlook().fetchImpl);
    assert.deepEqual(await rows("conv-unknown"), [], "a conversation that isn't in Mail is done too");
  });

  it("waits for a reconnect without counting tries or bringing the thread back", async () => {
    const box = outlook(failMove("conv-reconnect", () => graphError(401, "InvalidAuthenticationToken")));
    await queueMailAction(owner, { thread: thread("conv-reconnect"), action: "archive", view: { role: "inbox" } });
    await drain(box.fetchImpl);
    const [waiting] = await rows("conv-reconnect");
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.refused_at, null);
    assert.ok(waiting.wait_ms > 200_000, "it waits minutes, not seconds");
    assert.ok(!(await inbox()).includes(thread("conv-reconnect")));
    assert.deepEqual(await takeMailRefusals(owner), []);

    await makeDue("conv-reconnect");
    await drain(outlook().fetchImpl);
    assert.equal(await roleOf("conv-reconnect"), "archive");
  });

  it("runs a thread's moves in the order they were queued, so Undo puts it back", async () => {
    const box = outlook();
    await queueMailAction(owner, { thread: thread("conv-undo"), action: "archive", view: { role: "inbox" } });
    await queueMailAction(owner, { thread: thread("conv-undo"), action: "inbox", view: { role: "archive" } });
    assert.ok((await inbox()).includes(thread("conv-undo")), "with Undo queued last the thread belongs in the inbox again");
    await drain(box.fetchImpl);
    assert.deepEqual(box.destinations, ["archive", "inbox"]);
    assert.equal(await roleOf("conv-undo"), "inbox");
    assert.deepEqual(await rows("conv-undo"), []);

    const blocked = outlook(failMove("conv-blocked", () => graphError(503, "ServiceUnavailable"), 3));
    await queueMailAction(owner, { thread: thread("conv-blocked"), action: "archive", view: { role: "inbox" } });
    await queueMailAction(owner, { thread: thread("conv-blocked"), action: "inbox", view: { role: "archive" } });
    await drain(blocked.fetchImpl);
    assert.deepEqual((await rows("conv-blocked")).map((row) => row.action), ["archive", "inbox"], "a later move never jumps ahead of one that is waiting");
    assert.equal(blocked.moves("conv-blocked"), 3);
    await makeDue("conv-blocked");
    await drain(blocked.fetchImpl);
    assert.deepEqual(blocked.destinations, ["archive", "inbox"]);
    assert.equal(await roleOf("conv-blocked"), "inbox");
  });

  it("leaves a pending thread out of the lists and the unread counts", async () => {
    const before = await mailNav(owner);
    const unreadBefore = await mailUnreadCount(owner);
    await queueMailAction(owner, { thread: thread("conv-hidden"), action: "trash", view: { role: "inbox" } });
    const during = await mailNav(owner);
    assert.equal(during.unread, before.unread - 1);
    assert.equal((await mailUnreadCount(owner)) <= unreadBefore, true);
    const inboxFolder = (nav: typeof during) => nav.folders.find((folder) => folder.role === "inbox")!;
    assert.equal(inboxFolder(during).unread, inboxFolder(before).unread - 1);
    assert.ok(!(await inbox()).includes(thread("conv-hidden")));
    const found = await listThreads(owner, { query: "Subject of conv-hidden" });
    assert.ok(!found.threads.some((item) => item.key === thread("conv-hidden")), "search leaves it out too");

    await getAdminPool().query("update crm.mail_pending_actions set refused_at = now(), problem = 'No.' where thread_key = 'conv-hidden'");
    assert.equal((await mailNav(owner)).unread, before.unread, "a refused move counts again");
    assert.ok((await inbox()).includes(thread("conv-hidden")));
    await getAdminPool().query("delete from crm.mail_pending_actions where thread_key = 'conv-hidden'");
  });

  it("never lets one person see, queue against or run another person's moves", async () => {
    await queueMailAction(owner, { thread: thread("conv-other"), action: "archive", view: { role: "inbox" } });
    await assert.rejects(() => queueMailAction(stranger, { thread: thread("conv-other"), action: "archive" }), /Conversation not found/);
    const seen = await withActor(stranger, (db) => db.query("select id from crm.mail_pending_actions"));
    assert.equal(seen.rows.length, 0);
    const box = outlook();
    assert.equal(await drain(box.fetchImpl, stranger), 0);
    assert.deepEqual(box.calls, []);
    assert.deepEqual(await takeMailRefusals(stranger), []);
    assert.equal((await rows("conv-other")).length, 1, "the owner's move is still waiting");
    await getAdminPool().query("update crm.mail_pending_actions set refused_at = now(), problem = 'No.' where thread_key = 'conv-other'");
    assert.deepEqual(await takeMailRefusals(stranger), []);
    assert.equal((await takeMailRefusals(owner)).length, 1);
    await getAdminPool().query("delete from crm.mail_pending_actions where thread_key = 'conv-other'");
  });

  it("checks a move the way the immediate path does", async () => {
    await assert.rejects(() => queueMailAction(owner, { thread: thread("conv-trash"), action: "snooze", until: new Date(Date.now() + 1_000).toISOString() }), /at least a minute/);
    await assert.rejects(() => queueMailAction(owner, { thread: "nonsense", action: "archive" }), /Conversation not found/);
    await assert.rejects(() => queueMailAction(owner, { thread: thread("conv-trash"), action: "read" }), /Choose a mail action/);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await queueMailAction(owner, { thread: thread("conv-trash"), action: "snooze", view: { role: "inbox" }, until });
    await drain(outlook().fetchImpl);
    assert.equal(await roleOf("conv-trash"), "snoozed");
    const reminders = await getAdminPool().query("select 1 from crm.mail_reminders where thread_key = 'conv-trash' and kind = 'snooze' and state = 'waiting'");
    assert.equal(reminders.rows.length, 1);
  });

  it("is drained by the minute job for everyone with moves waiting", async () => {
    await queueMailAction(owner, { thread: thread("conv-cron"), action: "archive", view: { role: "inbox" } });
    const box = outlook();
    const users = await processAllPendingMail(Date.now() + 40_000, box.fetchImpl);
    assert.deepEqual(users, [{ userId: owner.userId, ran: 1 }]);
    assert.equal(await roleOf("conv-cron"), "archive");
    assert.deepEqual(await processAllPendingMail(Date.now() + 40_000, box.fetchImpl), [], "nobody is visited when nothing is due");

    await getAdminPool().query(
      "insert into crm.mail_pending_actions (workspace_id, user_id, source_id, thread_key, action, refused_at, problem, shown_at, created_at) values ($1, $2, $3, 'old', 'archive', now() - interval '4 days', 'No.', now(), now() - interval '5 days')",
      [owner.workspaceId, owner.userId, sourceId],
    );
    const cleaned = await processAllPendingMail(Date.now() + 40_000, box.fetchImpl);
    assert.equal(cleaned.length, 1);
    assert.deepEqual(await rows("old"), [], "old refusals are cleared");
  });

  it("signals the tab that queued a move with its own origin when the move finishes", async () => {
    const sent: LiveMessage[] = [];
    setLiveTesting({ batch: async (messages) => void sent.push(...messages), sink: async () => {}, wait: async () => {} });
    try {
      const tab = "11111111-2222-3333-4444-555555555555";
      await queueMailAction(owner, { thread: thread("conv-origin"), action: "archive", view: { role: "inbox" } }, tab);
      assert.equal((await getAdminPool().query("select origin from crm.mail_pending_actions where thread_key = 'conv-origin'")).rows[0].origin, tab);
      await drain(outlook().fetchImpl);
      for (let waited = 0; waited < 50 && !sent.some((item) => (item.payload as { kind: string }).kind === "mail"); waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const signals = sent.map((item) => item.payload as { kind: string; origin?: string }).filter((payload) => payload.kind === "mail");
      assert.deepEqual(signals, [{ kind: "mail", origin: tab }]);
    } finally {
      setLiveTesting(null);
    }
  });

  it("retries a partly moved thread when the failures were only temporary, and finishes it", async () => {
    const failing = (id: string, make: () => Response | Error, times: number): Handler => {
      let used = 0;
      return (url, method) => {
        if (method !== "POST" || !url.endsWith(`/${id}/move`) || used >= times) return undefined;
        used += 1;
        return make();
      };
    };
    const states = async (ids: string[]) =>
      (
        await getAdminPool().query<{ role: string }>(
          "select f.role from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where m.provider_message_id = any($1) order by m.provider_message_id",
          [ids],
        )
      ).rows.map((row) => row.role);

    const server = outlook(failing("conv-partial-2", () => graphError(503, "ServiceUnavailable"), 3));
    await queueMailAction(owner, { thread: thread("conv-partial"), action: "archive", view: { role: "inbox" } });
    await drain(server.fetchImpl);
    const [waiting] = await rows("conv-partial");
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.refused_at, null, "a server error is not Outlook refusing");
    assert.deepEqual(await states(["conv-partial-1", "conv-partial-2", "conv-partial-3"]), ["archive", "inbox", "archive"]);
    assert.ok(!(await inbox()).includes(thread("conv-partial")));
    assert.deepEqual(await takeMailRefusals(owner), []);
    await makeDue("conv-partial");
    await drain(outlook().fetchImpl);
    assert.deepEqual(await states(["conv-partial-1", "conv-partial-2", "conv-partial-3"]), ["archive", "archive", "archive"]);
    assert.deepEqual(await rows("conv-partial"), []);

    const slow = outlook(failing("conv-late-2", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), 1));
    await queueMailAction(owner, { thread: thread("conv-late"), action: "archive", view: { role: "inbox" } });
    await runPendingMailActions(owner, { deadline: Date.now() + 12_000, fetchImpl: slow.fetchImpl });
    assert.equal((await rows("conv-late"))[0]?.refused_at ?? null, null, "running out of time is not a refusal");
    assert.ok((await rows("conv-late")).length === 1 || (await roleOf("conv-late")) === "archive");
    await makeDue("conv-late");
    await drain(outlook().fetchImpl);
    assert.deepEqual(await states(["conv-late-1", "conv-late-2"]), ["archive", "archive"]);
    assert.deepEqual(await rows("conv-late"), []);

    const mixed = outlook(failing("conv-mixed-2", () => graphError(400, "ErrorInvalidRequest"), 10));
    await queueMailAction(owner, { thread: thread("conv-mixed"), action: "archive", view: { role: "inbox" } });
    await drain(mixed.fetchImpl);
    assert.ok((await rows("conv-mixed"))[0].refused_at, "a definite refusal of part of a thread is still shown");
  });
});
