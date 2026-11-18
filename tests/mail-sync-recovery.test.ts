import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { fetchMicrosoftDelta, GraphMailError, GraphOutOfTime, lookupPurged, retryWaitMs, updateMicrosoftMessage } from "@/lib/mail/microsoft";
import { folderRetryAt, screenSyncOptions, syncMail, syncNotifiedMailboxes } from "@/lib/mail/sync";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent", archive: "f-archive", junkemail: "f-junk" };

type Handler = (url: string, method: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function message(id: string) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: `Hello ${id}`,
    bodyPreview: "Quick question",
    body: { contentType: "html", content: "<p>Quick question</p>" },
    from: { emailAddress: { name: `Sender ${id}`, address: `${id}@client.test` } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: new Date(Date.now() - 60_000).toISOString(),
    receivedDateTime: new Date(Date.now() - 30_000).toISOString(),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

function delta(folder: string, token: string) {
  return `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
}

function denied() {
  return Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } }, { status: 403 });
}

function outlook(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const custom = await handler(url, method, init);
    if (custom) return custom;
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return FOLDERS[named[1]] ? Response.json({ id: FOLDERS[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({
        value: Object.entries(FOLDERS).map(([name, id]) => ({ id, displayName: name, childFolderCount: 0, totalItemCount: 0, unreadItemCount: 0 })),
      });
    }
    if (/\/me\/messages\/[^/?]+\?\$select=id,parentFolderId$/.test(url)) return Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
    const folderDelta = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/);
    if (folderDelta) return Response.json({ value: [], "@odata.deltaLink": delta(decodeURIComponent(folderDelta[1]), "quiet") });
    return Response.json({ value: [] });
  };
  const deltaCalls = (folder: string) => calls.filter((call) => call.includes(`/mailFolders/${folder}/messages/delta`));
  return { fetchImpl, calls, deltaCalls };
}

async function folder(providerId: string) {
  const rows = await getAdminPool().query<{ sync_link: string | null; failures: number; retry_at: Date | null; last_error: string | null }>(
    "select sync_link, failures, retry_at, last_error from crm.mail_folders where provider_folder_id = $1",
    [providerId],
  );
  return rows.rows[0];
}

async function source() {
  const rows = await getAdminPool().query<{ id: string; last_error: string | null; last_synced_at: Date | null; locked_until: Date | null; retry_at: Date | null }>(
    "select id, last_error, last_synced_at, locked_until, retry_at from crm.mail_sources",
  );
  return rows.rows[0];
}

async function stored(providerId: string) {
  return (await getAdminPool().query("select 1 from crm.mail_messages where provider_message_id = $1", [providerId])).rowCount;
}

describe("mail sync recovers from a folder, a mailbox or Microsoft going wrong", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("recovery@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const report = await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(report.errors, []);
  });

  beforeEach(async () => {
    const admin = getAdminPool();
    await admin.query(
      `update crm.mail_folders set sync_state = 'live', sync_link = $1 || provider_folder_id || '/messages/delta?$deltatoken=quiet',
         failures = 0, retry_at = null, last_error = null, last_synced_at = now()
       where sync_state <> 'skipped'`,
      [`${GRAPH}/me/mailFolders/`],
    );
    await admin.query("update crm.mail_sources set last_error = null, retry_at = null, locked_until = null");
  });

  after(async () => {
    await getPool().end();
  });

  useServerlessPool();

  it("drops an email Outlook purged out of reach and moves the folder on, instead of failing on it every time", async () => {
    await getAdminPool().query("update crm.mail_folders set sync_state = 'live'");
    await syncMail(owner, {
      budgetMs: 30_000,
      backfill: false,
      fetchImpl: outlook((url) => (url === delta("f-junk", "quiet") ? Response.json({ value: [message("j-1")], "@odata.deltaLink": delta("f-junk", "j1") }) : undefined)).fetchImpl,
    });
    assert.equal(await stored("j-1"), 1);
    const box = outlook((url) => {
      if (url === delta("f-junk", "j1")) return Response.json({ value: [{ id: "j-1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta("f-junk", "j2") });
      if (url.includes("/me/messages/j-1?")) return denied();
      return undefined;
    });
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.equal(report.removed, 1);
    assert.equal(await stored("j-1"), 0);
    assert.equal((await folder("f-junk")).sync_link, delta("f-junk", "j2"));
  });

  it("still treats a refused lookup that needs a reconnect as a mailbox problem", async () => {
    await getAdminPool().query("update crm.mail_folders set sync_link = $1 where provider_folder_id = 'f-junk'", [delta("f-junk", "k1")]);
    const box = outlook((url) => {
      if (url === delta("f-junk", "k1")) return Response.json({ value: [{ id: "k-1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta("f-junk", "k2") });
      if (url.includes("/me/messages/k-1?")) return Response.json({ error: { code: "Authorization_RequestDenied", message: "Insufficient privileges." } }, { status: 403 });
      return undefined;
    });
    await getAdminPool().query("insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id) select workspace_id, user_id, source_id, id, 'k-1' from crm.mail_folders where provider_folder_id = 'f-junk'");
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.equal(report.reconnect.length, 1);
    assert.equal(await stored("k-1"), 1, "nothing is deleted on a permission problem");
    assert.equal((await folder("f-junk")).sync_link, delta("f-junk", "k1"));
    await getAdminPool().query("update crm.mail_folders set sync_link = $1 where provider_folder_id = 'f-junk'", [delta("f-junk", "quiet")]);
    await getAdminPool().query("update crm.mail_sources set last_error = null");
  });

  it("keeps syncing the other folders when one keeps failing, then backs off from it until it recovers", async () => {
    const admin = getAdminPool();
    let archiveFails = true;
    const box = () =>
      outlook((url) => {
        if (url === delta("f-archive", "quiet") && archiveFails) return denied();
        if (url === delta("f-inbox", "quiet")) return Response.json({ value: [message(`i-${Date.now()}`)], "@odata.deltaLink": delta("f-inbox", "quiet") });
        return undefined;
      });

    const first = box();
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: first.fetchImpl });
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /access denied/);
    assert.deepEqual(report.reconnect, []);
    assert.ok(report.stored >= 1, "the inbox still syncs");
    assert.equal(first.deltaCalls("f-junk").length, 1, "the folders after the failing one still sync");
    const afterFirst = await source();
    assert.equal(afterFirst.last_error, null, "one folder doesn't fail the mailbox");
    assert.ok(afterFirst.last_synced_at && Date.now() - new Date(afterFirst.last_synced_at).getTime() < 60_000);
    assert.equal(afterFirst.locked_until, null);
    const once = await folder("f-archive");
    assert.equal(once.failures, 1);
    assert.equal(once.retry_at, null, "a single failure is tried again on the next sync");
    assert.match(once.last_error ?? "", /access denied/);

    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box().fetchImpl });
    const twice = await folder("f-archive");
    assert.equal(twice.failures, 2);
    assert.ok(twice.retry_at && new Date(twice.retry_at).getTime() > Date.now() + 30_000);

    const waiting = box();
    const quiet = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: waiting.fetchImpl });
    assert.deepEqual(quiet.errors, []);
    assert.equal(waiting.deltaCalls("f-archive").length, 0, "a folder that keeps failing isn't asked again until its wait is over");
    assert.equal(waiting.deltaCalls("f-inbox").length, 1);

    archiveFails = false;
    await admin.query("update crm.mail_folders set retry_at = now() - interval '1 second' where provider_folder_id = 'f-archive'");
    const recovered = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box().fetchImpl });
    assert.deepEqual(recovered.errors, []);
    assert.deepEqual(await folder("f-archive"), { sync_link: delta("f-archive", "quiet"), failures: 0, retry_at: null, last_error: null });
  });

  it("waits longer after each failure, up to half an hour, and never more than two minutes for the inbox, sent, drafts or Snoozed", () => {
    const now = 1_000_000;
    assert.equal(folderRetryAt(1, "archive", now), null);
    assert.equal(folderRetryAt(2, "archive", now)?.getTime(), now + 60_000);
    assert.equal(folderRetryAt(3, "archive", now)?.getTime(), now + 120_000);
    assert.equal(folderRetryAt(20, "other", now)?.getTime(), now + 30 * 60_000);
    for (const role of ["inbox", "sent", "drafts", "snoozed"] as const) {
      assert.equal(folderRetryAt(1, role, now), null, role);
      assert.equal(folderRetryAt(2, role, now)?.getTime(), now + 60_000, role);
      assert.equal(folderRetryAt(20, role, now)?.getTime(), now + 2 * 60_000, role);
    }
  });

  it("counts a refused lookup as purged only for a 404, or ErrorAccessDenied while the mailbox has mail access", () => {
    const graphError = (status: number, code: string) => new GraphMailError("x", status, code);
    const cases: [string, unknown, boolean | null, boolean][] = [
      ["404", graphError(404, "ErrorItemNotFound"), null, true],
      ["404 without mail access", graphError(404, "ErrorItemNotFound"), false, true],
      ["ErrorAccessDenied with mail access", graphError(403, "ErrorAccessDenied Access is denied."), true, true],
      ["ErrorAccessDenied with unknown scopes", graphError(403, "ErrorAccessDenied Access is denied."), null, true],
      ["ErrorAccessDenied without mail access", graphError(403, "ErrorAccessDenied Access is denied."), false, false],
      ["another 403 code", graphError(403, "ErrorQuotaExceeded"), true, false],
      ["a 403 with no code", graphError(403, ""), true, false],
      ["an auth 403", graphError(403, "Authorization_RequestDenied Insufficient privileges."), true, false],
      ["a consent 403", graphError(403, "consent_required"), true, false],
      ["401", graphError(401, "InvalidAuthenticationToken"), true, false],
      ["429", new GraphMailError("x", 429, "TooManyRequests", 1_000), true, false],
      ["500", graphError(500, "ErrorInternalServerError"), true, false],
      ["502", graphError(502, ""), true, false],
      ["503", graphError(503, "ServiceUnavailable"), true, false],
      ["504", graphError(504, ""), true, false],
      ["a network error", new TypeError("fetch failed"), true, false],
    ];
    for (const [name, error, mailScope, purged] of cases) assert.equal(lookupPurged(error, mailScope), purged, name);
  });

  it("keeps the email and the folder's place when the lookup is refused because the mailbox lacks mail access", async () => {
    const admin = getAdminPool();
    const mailbox = (await admin.query<{ connection_id: string; workspace_id: string; user_id: string }>("select connection_id, workspace_id, user_id from crm.mail_sources")).rows[0];
    const scoped = await admin.query("update crm.integration_state set granted_scopes = 'Mail.Read offline_access' where connection_id = $1 and source = 'calendar'", [mailbox.connection_id]);
    if (!scoped.rowCount) {
      await admin.query(
        "insert into crm.integration_state (workspace_id, source, connection_id, user_id, granted_scopes) values ($1, 'calendar', $2, $3, 'Mail.Read offline_access')",
        [mailbox.workspace_id, mailbox.connection_id, mailbox.user_id],
      );
    }
    try {
      await admin.query("update crm.mail_folders set sync_link = $1 where provider_folder_id = 'f-junk'", [delta("f-junk", "s1")]);
      await admin.query("insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id) select workspace_id, user_id, source_id, id, 's-1' from crm.mail_folders where provider_folder_id = 'f-junk'");
      const box = outlook((url) => {
        if (url === delta("f-junk", "s1")) return Response.json({ value: [{ id: "s-1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta("f-junk", "s2") });
        if (url.includes("/me/messages/s-1?")) return denied();
        return undefined;
      });
      const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
      assert.deepEqual(report.reconnect, ["Reconnect mark@eclipse.test in Settings › Email and allow every permission."]);
      assert.equal(await stored("s-1"), 1);
      assert.equal((await folder("f-junk")).sync_link, delta("f-junk", "s1"));
    } finally {
      await admin.query("update crm.integration_state set granted_scopes = null where connection_id = $1", [mailbox.connection_id]);
    }
  });

  it("keeps the email and the folder's place when a lookup fails for any other reason, and backs the folder off", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set sync_link = $1 where provider_folder_id = 'f-junk'", [delta("f-junk", "u1")]);
    await admin.query("insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id) select workspace_id, user_id, source_id, id, 'u-1' from crm.mail_folders where provider_folder_id = 'f-junk'");
    const box = outlook((url) => {
      if (url === delta("f-junk", "u1")) return Response.json({ value: [{ id: "u-1", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta("f-junk", "u2") });
      if (url.includes("/me/messages/u-1?")) return Response.json({ error: { code: "ErrorQuotaExceeded", message: "Over quota." } }, { status: 403 });
      return undefined;
    });
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.reconnect, []);
    assert.equal(report.errors.length, 1);
    assert.equal(await stored("u-1"), 1);
    const junk = await folder("f-junk");
    assert.equal(junk.sync_link, delta("f-junk", "u1"));
    assert.equal(junk.failures, 1);
  });

  it("syncs a backed-off inbox for a webhook or a manual Refresh, and not for anything else", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set failures = 5, retry_at = now() + interval '2 minutes' where provider_folder_id = 'f-inbox'");
    const regular = outlook();
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: regular.fetchImpl });
    assert.equal(regular.deltaCalls("f-inbox").length, 0);

    assert.equal(screenSyncOptions({ manual: true }).ignoreFolderWaits, true);
    assert.equal(screenSyncOptions({}).ignoreFolderWaits, false);
    assert.equal(screenSyncOptions(null).ignoreFolderWaits, false);
    await admin.query("update crm.mail_sources set last_full_synced_at = now() - interval '3 minutes'");
    const refresh = outlook();
    await syncMail(owner, { ...screenSyncOptions({ manual: true }), fetchImpl: refresh.fetchImpl });
    assert.equal(refresh.deltaCalls("f-inbox").length, 1);

    await admin.query("update crm.mail_folders set failures = 5, retry_at = now() + interval '2 minutes' where provider_folder_id = 'f-inbox'");
    const notified = outlook((url) => (url === delta("f-inbox", "quiet") ? Response.json({ value: [message("webhook-1")], "@odata.deltaLink": delta("f-inbox", "quiet") }) : undefined));
    const result = await syncNotifiedMailboxes(owner, [(await source()).id], { deadline: Date.now() + 30_000, fetchImpl: notified.fetchImpl });
    assert.equal(notified.deltaCalls("f-inbox").length, 1);
    assert.equal(result.stored, 1);
    assert.equal(await stored("webhook-1"), 1);
  });

  it("waits for the sync holding a webhook's mailbox, then syncs it, and stops for one waiting out throttling", async () => {
    const admin = getAdminPool();
    const id = (await source()).id;
    await admin.query("update crm.mail_sources set locked_until = now() + interval '5 minutes'");
    const held = outlook();
    const release = setTimeout(() => void admin.query("update crm.mail_sources set locked_until = null"), 50);
    const reached = await syncNotifiedMailboxes(owner, [id], { deadline: Date.now() + 30_000, fetchImpl: held.fetchImpl, pollMs: 300 });
    clearTimeout(release);
    assert.deepEqual(reached.unreached, []);
    assert.equal(held.deltaCalls("f-inbox").length, 1, "synced once the lock was free");

    await admin.query("update crm.mail_sources set locked_until = null, retry_at = now() + interval '5 minutes'");
    const throttled = outlook();
    const started = Date.now();
    const waiting = await syncNotifiedMailboxes(owner, [id], { deadline: Date.now() + 30_000, fetchImpl: throttled.fetchImpl, pollMs: 2_000 });
    assert.deepEqual(waiting.unreached, []);
    assert.equal(throttled.calls.length, 0);
    assert.ok(Date.now() - started < 1_500, "no retry for a mailbox that is deliberately waiting");
    await admin.query("update crm.mail_sources set retry_at = null");
  });

  it("keeps a mailbox it never reached pending instead of dropping it", async () => {
    const id = (await source()).id;
    const box = outlook();
    const result = await syncNotifiedMailboxes(owner, [id], { deadline: Date.now() - 1, fetchImpl: box.fetchImpl, pollMs: 10 });
    assert.deepEqual(result.unreached, [id]);
    assert.equal(box.calls.length, 0);
  });

  it("never retries a read that timed out, but retries a quick network failure", async () => {
    let timeouts = 0;
    const hanging: typeof fetch = async () => {
      timeouts += 1;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await assert.rejects(fetchMicrosoftDelta(delta("f-inbox", "x"), "access", hanging), (error) => error instanceof Error && error.name === "TimeoutError");
    assert.equal(timeouts, 1);

    let drops = 0;
    const flaky: typeof fetch = async () => {
      drops += 1;
      if (drops === 1) throw new TypeError("fetch failed");
      return Response.json({ value: [], "@odata.deltaLink": delta("f-inbox", "y") });
    };
    const page = await fetchMicrosoftDelta(delta("f-inbox", "x"), "access", flaky);
    assert.equal(drops, 2);
    assert.equal(page.deltaLink, delta("f-inbox", "y"));
  });

  it("stops the mailbox, not just the folder, when the connection is rejected", async () => {
    const box = outlook((url) =>
      url === delta("f-sent", "quiet") ? Response.json({ error: { code: "InvalidAuthenticationToken", message: "Expired" } }, { status: 401 }) : undefined,
    );
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.reconnect, ["Reconnect mark@eclipse.test in Settings › Email."]);
    assert.equal(box.deltaCalls("f-archive").length, 0);
    assert.equal((await folder("f-sent")).failures, 0, "a mailbox problem isn't held against the folder");
    assert.ok((await source()).last_error);
    await getAdminPool().query("update crm.mail_sources set last_error = null");
  });

  it("tries a read again when Microsoft has a passing server error", async () => {
    let failures = 0;
    const box = outlook((url) => {
      if (url !== delta("f-inbox", "quiet")) return undefined;
      if (failures < 1) {
        failures += 1;
        return new Response("<html>Bad Gateway</html>", { status: 502 });
      }
      return Response.json({ value: [message("after-502")], "@odata.deltaLink": delta("f-inbox", "quiet") });
    });
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.errors, []);
    assert.equal(box.deltaCalls("f-inbox").length, 2);
    assert.equal(await stored("after-502"), 1);
  });

  it("never sends a change twice after a server error", async () => {
    const box = outlook((_url, method) => (method === "PATCH" ? new Response("<html>Bad Gateway</html>", { status: 502 }) : undefined));
    await assert.rejects(updateMicrosoftMessage("access", "m-1", { isRead: true }, box.fetchImpl), (error) => error instanceof GraphMailError && error.status === 502);
    assert.equal(box.calls.filter((call) => call.startsWith("PATCH")).length, 1);
  });

  it("leaves a throttled mailbox alone for as long as Microsoft asks, without waiting in the request", async () => {
    const admin = getAdminPool();
    const box = outlook((url) =>
      url === delta("f-inbox", "quiet")
        ? Response.json({ error: { code: "ApplicationThrottled", message: "Too many requests." } }, { status: 429, headers: { "retry-after": "120" } })
        : undefined,
    );
    const started = Date.now();
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.ok(Date.now() - started < 5_000, "it doesn't sit out a long wait inside the request");
    assert.equal(report.errors.length, 1);
    assert.equal(box.deltaCalls("f-inbox").length, 1);
    assert.equal(box.deltaCalls("f-sent").length, 0, "the rest of a throttled mailbox waits too");
    const throttled = await source();
    const wait = new Date(throttled.retry_at!).getTime() - Date.now();
    assert.ok(wait > 100_000 && wait <= 120_000, `waits as long as asked, not ${wait}ms`);
    assert.equal((await folder("f-inbox")).failures, 0);

    const later = outlook();
    const skipped = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: later.fetchImpl });
    assert.deepEqual(skipped.waiting, [throttled.id]);
    assert.equal(skipped.sources, 0);
    assert.equal(later.calls.length, 0, "no calls go to Microsoft while it asked Orbit to wait");

    await admin.query("update crm.mail_sources set retry_at = now() - interval '1 second', last_error = null");
    const resumed = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: outlook().fetchImpl });
    assert.deepEqual(resumed.errors, []);
    assert.equal((await source()).retry_at, null);
  });

  it("parses a Retry-After date as well as seconds", () => {
    const at = new Date(Date.now() + 3_000).toUTCString();
    const wait = retryWaitMs({ headers: new Headers({ "retry-after": at }) }, 0);
    assert.ok(wait !== null && wait > 1_000 && wait <= 3_000, `${wait}`);
    assert.equal(retryWaitMs({ headers: new Headers({ "retry-after": new Date(Date.now() + 60_000).toUTCString() }) }, 0), null);
  });

  it("ends within its budget when Microsoft stops answering, and frees the mailbox", async () => {
    const box = outlook((url, _method, init) => {
      if (url !== delta("f-sent", "quiet")) return undefined;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    });
    const started = Date.now();
    const report = await syncMail(owner, { budgetMs: 3_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started}ms`);
    assert.deepEqual(report.errors, []);
    assert.equal(box.deltaCalls("f-sent").length, 1);
    const after = await source();
    assert.equal(after.locked_until, null);
    assert.equal((await folder("f-sent")).failures, 0, "running out of time isn't a folder failure");
  });

  it("gives up on a read at the deadline rather than at the thirty second timeout", async () => {
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const started = Date.now();
    await assert.rejects(fetchMicrosoftDelta(delta("f-inbox", "x"), "access", hanging, { deadline: Date.now() + 1_500 }), GraphOutOfTime);
    assert.ok(Date.now() - started < 3_000);
  });

  it("reports a mailbox another sync is holding so the webhook can try it again", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_sources set locked_until = now() + interval '5 minutes'");
    const box = outlook();
    const report = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    assert.deepEqual(report.busy, [(await source()).id]);
    assert.equal(report.sources, 0);
    assert.equal(box.calls.length, 0);
    await admin.query("update crm.mail_sources set locked_until = null");
  });

  it("syncs only the mailboxes it was asked for", async () => {
    const box = outlook();
    const none = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl, sourceIds: ["00000000-0000-0000-0000-000000000000"] });
    assert.equal(none.sources, 0);
    assert.equal(box.calls.length, 0);
    const one = await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl, sourceIds: [(await source()).id] });
    assert.equal(one.sources, 1);
    assert.deepEqual(one.synced, [(await source()).id]);
    assert.deepEqual(none.synced, []);
  });

  it("gets to the folders it reached least recently first, after the inbox, sent and drafts", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.mail_folders set last_synced_at = now() where provider_folder_id = 'f-archive'");
    await admin.query("update crm.mail_folders set last_synced_at = now() - interval '1 day' where provider_folder_id = 'f-junk'");
    const box = outlook();
    await syncMail(owner, { budgetMs: 30_000, backfill: false, fetchImpl: box.fetchImpl });
    const order = box.calls.filter((call) => call.includes("/messages/delta")).map((call) => call.match(/mailFolders\/([^/]+)\//)?.[1]);
    assert.deepEqual(order, ["f-inbox", "f-sent", "f-junk", "f-archive"]);
  });
});
