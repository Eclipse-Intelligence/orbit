import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { watchSyncSignals } from "@/lib/docs/live/client";
import { memoryHub } from "@/lib/docs/live/transport";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { syncMail } from "@/lib/mail/sync";
import { createSignalMerge, HOLD_POLL_MS } from "@/lib/signal-merge";
import { readSyncOrigin, SYNC_ORIGIN_HEADER } from "@/lib/sync-origin";
import { signalSynced } from "@/lib/sync-signals";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: "Preview",
    body: { contentType: "text", content: "Body" },
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
    ...overrides,
  };
}

type Page = { value: unknown[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

function mailbox(pages: Record<string, Page | (() => Promise<Response> | Response)>) {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", drafts: "f-drafts", deleteditems: "f-trash", junkemail: "f-junk" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 3, unreadItemCount: 2 }] });
    }
    const delta = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/);
    const key = delta && !url.includes("token=") ? `start:${delta[1]}` : url;
    const page = pages[key];
    if (!page) return Response.json({ value: [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${delta?.[1] ?? "x"}/messages/delta?$deltatoken=done` });
    return typeof page === "function" ? page() : Response.json(page);
  };
  return fetchImpl;
}

const inboxDelta = (token: string) => `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=${token}`;

describe("mail load", () => {
  useServerlessPool();

  let owner: UserActor;
  let sent: LiveMessage[] = [];

  before(async () => {
    await resetDatabase();
    owner = await createUser("load@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    setLiveTesting(null);
    mock.timers.reset();
  });

  after(async () => {
    await getPool().end();
  });

  function capture() {
    sent = [];
    setLiveTesting({
      batch: async (messages) => void sent.push(...messages),
      sink: async () => {},
      wait: async () => {},
    });
  }

  function mailSignals() {
    return sent.filter((item) => (item.payload as { kind: string }).kind === "mail").length;
  }

  async function storedCount() {
    const result = await getAdminPool().query<{ stored: number; counted: number }>(
      `select (select coalesce(sum(synced_count), 0)::int from crm.mail_folders where role = 'inbox') as stored,
              (select count(*)::int from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id where f.role = 'inbox') as counted`,
    );
    return result.rows[0];
  }

  it("ignores a signal from the same client and honours one from another", async () => {
    const hub = memoryHub();
    setLiveTesting({
      batch: async (messages) => void messages.forEach((item) => hub.publish(item.topic, item.event, item.payload)),
      sink: async () => {},
    });
    const heard: string[] = [];
    const close = await watchSyncSignals(hub.transport(), { userId: owner.userId, workspaceId: null, origin: FIRST }, (kind) => heard.push(kind), () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await signalSynced(owner.userId, "mail", FIRST);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(heard, []);
    await signalSynced(owner.userId, "mail", SECOND);
    await signalSynced(owner.userId, "mail");
    await signalSynced(owner.userId, "calendar", FIRST);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(heard, ["mail", "mail"]);
    close();
  });

  it("reads only well formed client ids from the request header", () => {
    assert.equal(readSyncOrigin(new Headers({ [SYNC_ORIGIN_HEADER]: FIRST.toUpperCase() })), FIRST);
    assert.equal(readSyncOrigin(new Headers({ [SYNC_ORIGIN_HEADER]: "not an id" })), null);
    assert.equal(readSyncOrigin(new Headers()), null);
  });

  it("merges signals into one reload, waits for moves in flight and caps the wait", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let reloads = 0;
    let moving = false;
    const merge = createSignalMerge({ settleMs: 2_000, maxWaitMs: 5_000, hold: () => moving }, () => (reloads += 1));
    merge.request();
    mock.timers.tick(1_500);
    merge.request();
    mock.timers.tick(1_500);
    merge.request();
    assert.equal(reloads, 0);
    mock.timers.tick(2_000);
    assert.equal(reloads, 1);

    for (let index = 0; index < 3; index += 1) {
      merge.request();
      mock.timers.tick(1_500);
    }
    assert.equal(reloads, 1);
    mock.timers.tick(1_500);
    assert.equal(reloads, 2);

    moving = true;
    merge.request();
    mock.timers.tick(2_000 + HOLD_POLL_MS * 4);
    assert.equal(reloads, 2);
    moving = false;
    mock.timers.tick(HOLD_POLL_MS);
    assert.equal(reloads, 3);
    mock.timers.tick(60_000);
    assert.equal(reloads, 3);
    merge.cancel();
  });

  it("keeps synced_count right after a sync adds and removes messages, and signals only real changes", async () => {
    capture();
    const first = await syncMail(owner, {
      budgetMs: 30_000,
      announce: true,
      fetchImpl: mailbox({
        "start:f-inbox": {
          value: [message("m-3"), message("m-2")],
          "@odata.nextLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=page2`,
        },
        [`${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=page2`]: { value: [message("m-1")], "@odata.deltaLink": inboxDelta("one") },
      }),
    });
    assert.deepEqual(first.errors, []);
    assert.deepEqual(await storedCount(), { stored: 3, counted: 3 });
    assert.equal(mailSignals(), 1);

    capture();
    const echo = await syncMail(owner, {
      budgetMs: 30_000,
      backfill: false,
      announce: true,
      fetchImpl: mailbox({
        [inboxDelta("one")]: async () => {
          await getAdminPool().query("update crm.mail_messages set is_read = true where provider_message_id = 'm-2'");
          return Response.json({ value: [message("m-2", { isRead: true })], "@odata.deltaLink": inboxDelta("two") });
        },
      }),
    });
    assert.deepEqual(echo.errors, []);
    assert.equal(echo.changed, 0);
    assert.equal(mailSignals(), 0);
    assert.deepEqual(await storedCount(), { stored: 3, counted: 3 });

    capture();
    const changed = await syncMail(owner, {
      budgetMs: 30_000,
      backfill: false,
      announce: true,
      fetchImpl: mailbox({
        [inboxDelta("two")]: {
          value: [message("m-2", { isRead: true, subject: "Edited" }), { id: "m-1", "@removed": { reason: "deleted" } }, message("m-4"), message("m-5")],
          "@odata.deltaLink": inboxDelta("three"),
        },
      }),
    });
    assert.deepEqual(changed.errors, []);
    assert.equal(changed.changed, 4);
    assert.deepEqual(await storedCount(), { stored: 4, counted: 4 });
    assert.equal(mailSignals(), 1);

    capture();
    await syncMail(owner, { budgetMs: 30_000, backfill: false, announce: true, fetchImpl: mailbox({}) });
    assert.deepEqual(await storedCount(), { stored: 4, counted: 4 });
    assert.equal(mailSignals(), 0);
  });

  it("counts a backfill page by page and recounts when the walk ends", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set sync_state = 'pending', sync_link = null, synced_count = 0 where role = 'inbox'");
    await admin.query("delete from crm.mail_messages");
    const report = await syncMail(owner, {
      budgetMs: 30_000,
      fetchImpl: mailbox({
        "start:f-inbox": {
          value: [message("p-1"), message("p-2")],
          "@odata.nextLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=again`,
        },
        [`${GRAPH}/me/mailFolders/f-inbox/messages/delta?$skiptoken=again`]: () =>
          Response.json({ error: { code: "ApplicationThrottled", message: "Slow down" } }, { status: 429, headers: { "retry-after": "1" } }),
      }),
    });
    assert.ok(report.stored >= 2);
    assert.deepEqual(await storedCount(), { stored: 2, counted: 2 });
  });
});
