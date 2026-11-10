import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { flagReconnect, flagSyncProblems, readReconnects, reconnectAccounts, clearReconnects } from "@/components/mail/reconnect-store";
import { calendarConnectError, connectCalendarAccount, disconnectCalendarAccount, SAME_AS_PRIMARY } from "@/lib/crm/calendar-accounts";
import { CrmError } from "@/lib/crm/errors";
import { currentToken, disconnectMailbox, saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { graphReconnect, listMailboxes } from "@/lib/mail/accounts";
import { applyMailAction } from "@/lib/mail/actions";
import { saveMailDraft } from "@/lib/mail/compose";
import { fromFallback, RECONNECT_NEEDED, removalText } from "@/lib/mail/mailboxes";
import { GraphMailError, reconnectProblem } from "@/lib/mail/microsoft";
import { mailSourceToken, syncProblems } from "@/lib/mail/sync";
import { mailNav } from "@/lib/mail/threads";
import type { ComposeAccount, MailNav } from "@/lib/mail/view";
import { finishMicrosoftConnect, startMicrosoftConnect } from "@/lib/microsoft/connect-flow";
import {
  APP_NEEDS_ATTENTION,
  MicrosoftError,
  MicrosoftTokenError,
  microsoftProblem,
  microsoftAuthorizationUrl,
  microsoftErrorText,
  readMicrosoftState,
  sanitizeMicrosoftError,
  signMicrosoftState,
} from "@/lib/microsoft/oauth";
import { callErrorText } from "@/lib/microsoft/calls";
import { createGraphEvent, fetchCalendarView } from "@/lib/microsoft/calendar";
import { transcriptErrorText } from "@/lib/microsoft/transcripts";
import { createUser, resetDatabase } from "./helpers";

const MAIN = "mark@geteclipse.co";
const EXTRA = "mark@markridgeon.com";
const IDENTITY = "mark@ridgeon.me";
const GRAPH = "https://graph.microsoft.com/v1.0";
const HOUR = 3_600_000;

function oauth(email: string, scope = "Calendars.ReadWrite User.Read Mail.Send Mail.ReadWrite") {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: `${email}-access`, refresh_token: `${email}-refresh`, expires_in: 3600, scope });
    if (url.startsWith(`${GRAPH}/me?`)) return Response.json({ mail: email, userPrincipalName: email, displayName: "Mark" });
    throw new Error(`Unexpected ${url}`);
  };
  return fetchImpl;
}

type Rows = { main: string[]; accounts: string[]; sources: string[]; identities: string[]; messages: number };

async function rows(actor: UserActor): Promise<Rows> {
  const admin = getAdminPool();
  const read = async (sql: string) => (await admin.query<{ value: string }>(sql, [actor.userId])).rows.map((row) => row.value).sort();
  return {
    main: await read("select email as value from crm.mailbox_connections where user_id = $1"),
    accounts: await read("select email as value from crm.calendar_accounts where user_id = $1"),
    sources: await read("select email as value from crm.mail_sources where user_id = $1"),
    identities: await read("select email as value from crm.send_identities where user_id = $1"),
    messages: Number((await admin.query("select count(*) from crm.mail_messages where user_id = $1", [actor.userId])).rows[0].count),
  };
}

async function setUp(email: string) {
  const owner = await createUser(email, "Mark Ridgeon");
  await saveMailbox(owner, { email: MAIN, refreshToken: "main-refresh", accessToken: "main-access", expiresAt: new Date(Date.now() + HOUR).toISOString() });
  const account = await connectCalendarAccount(owner, { origin: "https://orbit.test", code: "a", purpose: "send_account" }, oauth(EXTRA));
  const admin = getAdminPool();
  const main = await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId]);
  const mainSource = await admin.query<{ id: string }>(
    "insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id",
    [owner.workspaceId, owner.userId, main.rows[0].id, MAIN],
  );
  const extraSource = await admin.query<{ id: string }>(
    "insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, $4) returning id",
    [owner.workspaceId, owner.userId, account.id, EXTRA],
  );
  const folder = await admin.query<{ id: string }>(
    `insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role, synced_count, total_count)
     values ($1, $2, $3, 'f-inbox', 'Inbox', 'inbox', 2, 2) returning id`,
    [owner.workspaceId, owner.userId, extraSource.rows[0].id],
  );
  for (const id of ["m-1", "m-2"]) {
    await admin.query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject, received_at)
       values ($1, $2, $3, $4, $5, 'conv-1', 'Hello', now())`,
      [owner.workspaceId, owner.userId, extraSource.rows[0].id, folder.rows[0].id, id],
    );
  }
  const identity = await admin.query<{ id: string }>(
    `insert into crm.send_identities (workspace_id, user_id, source_id, email, smtp_host, smtp_port, username, password_cipher)
     values ($1, $2, $3, $4, 'smtp.test', 587, $4, 'cipher') returning id`,
    [owner.workspaceId, owner.userId, extraSource.rows[0].id, IDENTITY],
  );
  await admin.query(
    `insert into crm.mail_drafts (workspace_id, user_id, source_id, provider_draft_id, mode, body, send_at)
     values ($1, $2, $3, 'draft-a', 'new', 'Hi', null), ($1, $2, $3, 'draft-b', 'new', 'Later', now() + interval '1 day')`,
    [owner.workspaceId, owner.userId, extraSource.rows[0].id],
  );
  return { owner, accountId: account.id, mainSourceId: mainSource.rows[0].id, extraSourceId: extraSource.rows[0].id, identityId: identity.rows[0].id };
}

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("reconnecting Microsoft never swaps or deletes an account", () => {
  let setup: Awaited<ReturnType<typeof setUp>>;
  let before_: Rows;

  before(async () => {
    process.env.MICROSOFT_CLIENT_ID = "client";
    process.env.MICROSOFT_CLIENT_SECRET = "secret";
    await resetDatabase();
    setup = await setUp("reconnect@orbit.test");
    before_ = await rows(setup.owner);
    assert.deepEqual(before_, { main: [MAIN], accounts: [EXTRA], sources: [MAIN, EXTRA], identities: [IDENTITY], messages: 2 });
  });

  it("asks Microsoft for the account being reconnected and remembers it in the signed state", () => {
    const state = signMicrosoftState("user-1", "workspace-1", 1_000, "mailbox", { hint: MAIN });
    assert.deepEqual(readMicrosoftState(state, 1_000), { userId: "user-1", workspaceId: "workspace-1", purpose: "mailbox", hint: MAIN, back: "email" });
    const url = microsoftAuthorizationUrl("https://orbit.test", state, { purpose: "mailbox", loginHint: MAIN });
    assert.equal(url.searchParams.get("login_hint"), MAIN);
    assert.equal(url.searchParams.get("prompt"), "select_account");
    const extra = readMicrosoftState(signMicrosoftState("user-1", "workspace-1", 1_000, "send_account", { hint: EXTRA, back: "email" }), 1_000);
    assert.equal(extra?.back, "email");
    assert.equal(readMicrosoftState(signMicrosoftState("user-1", "workspace-1", 1_000, "calendar_account"), 1_000)?.back, "calendars");
  });

  it("refuses a main reconnect signed in as another account and leaves every row alone", async () => {
    const tokens = { refreshToken: "other-refresh", accessToken: "other-access", expiresAt: new Date(Date.now() + HOUR).toISOString() };
    await assert.rejects(saveMailbox(setup.owner, { email: EXTRA, ...tokens, expected: MAIN }), (error: unknown) => {
      assert.ok(error instanceof CrmError);
      assert.equal(error.message, `You signed in as ${EXTRA}. Sign in as ${MAIN} to reconnect it.`);
      assert.equal(error.details?.add, null);
      return true;
    });
    await assert.rejects(saveMailbox(setup.owner, { email: "someone@else.test", ...tokens }), (error: unknown) => {
      assert.ok(error instanceof CrmError);
      assert.match(error.message, /Sign in as mark@geteclipse\.co/);
      assert.equal(error.details?.add, "someone@else.test");
      return true;
    });
    assert.deepEqual(await rows(setup.owner), before_);
    const stored = await getAdminPool().query<{ refresh_token: string }>("select refresh_token from crm.mailbox_connections where user_id = $1", [setup.owner.userId]);
    assert.notEqual(stored.rows[0].refresh_token, null);
  });

  it("reconnects the main account in place when the same account signs in", async () => {
    await saveMailbox(setup.owner, { email: MAIN.toUpperCase(), refreshToken: "new", accessToken: "new", expiresAt: new Date(Date.now() + HOUR).toISOString(), expected: MAIN });
    assert.deepEqual(await rows(setup.owner), before_);
  });

  it("refuses an extra-account reconnect signed in as a different or the main account", async () => {
    await assert.rejects(
      connectCalendarAccount(setup.owner, { origin: "https://orbit.test", code: "b", purpose: "send_account", expected: EXTRA }, oauth("new@else.test")),
      (error: unknown) => {
        assert.ok(error instanceof CrmError);
        assert.equal(error.message, `You signed in as new@else.test. Sign in as ${EXTRA} to reconnect it.`);
        assert.equal(error.details?.add, "new@else.test");
        return true;
      },
    );
    await assert.rejects(
      connectCalendarAccount(setup.owner, { origin: "https://orbit.test", code: "c", purpose: "send_account", expected: EXTRA }, oauth(MAIN)),
      (error: unknown) => error instanceof CrmError && error.details?.add === null && /Sign in as mark@markridgeon\.com/.test(error.message),
    );
    await assert.rejects(connectCalendarAccount(setup.owner, { origin: "https://orbit.test", code: "d", purpose: "send_account" }, oauth(MAIN)), new RegExp(SAME_AS_PRIMARY));
    assert.deepEqual(await rows(setup.owner), before_);
  });

  it("reconnects an extra account in place, keeping its mail and sending addresses", async () => {
    const again = await connectCalendarAccount(setup.owner, { origin: "https://orbit.test", code: "e", purpose: "send_account", expected: EXTRA }, oauth(EXTRA));
    assert.equal(again.id, setup.accountId);
    assert.deepEqual(await rows(setup.owner), before_);
  });

  it("refuses to make an extra account the main one without deleting it", async () => {
    const fresh = await createUser("fresh@orbit.test", "Fresh");
    await connectCalendarAccount(fresh, { origin: "https://orbit.test", code: "f", purpose: "send_account" }, oauth("fresh@extra.test"));
    await assert.rejects(
      saveMailbox(fresh, { email: "fresh@extra.test", refreshToken: "r", accessToken: "a", expiresAt: new Date(Date.now() + HOUR).toISOString() }),
      /already connected as another account/,
    );
    const state = await rows(fresh);
    assert.deepEqual(state.main, []);
    assert.deepEqual(state.accounts, ["fresh@extra.test"]);
  });

  it("lists every Microsoft mailbox with its own reconnect link and what removing it deletes", async () => {
    const mailboxes = await listMailboxes(setup.owner);
    assert.deepEqual(
      mailboxes.map((mailbox) => [mailbox.kind, mailbox.email, mailbox.reconnectHref]),
      [
        ["main", MAIN, `/api/microsoft/connect?hint=${encodeURIComponent(MAIN)}`],
        ["account", EXTRA, `/api/microsoft/connect?purpose=send_account&hint=${encodeURIComponent(EXTRA)}&from=email`],
      ],
    );
    const extra = mailboxes[1];
    assert.deepEqual(extra.removes, { emails: 2, drafts: 1, scheduled: 1, addresses: [IDENTITY] });
    assert.equal(
      removalText(extra.removes),
      `Orbit deletes its copy of 2 emails, 1 draft, 1 scheduled email, its calendars and the sending address ${IDENTITY}. The scheduled email won't be sent. Nothing changes in Outlook.`,
    );
    assert.match(mailboxes[0].email, /geteclipse/);
  });

  it("only removes an account with mail when the removal is confirmed for that account", async () => {
    await assert.rejects(disconnectCalendarAccount(setup.owner, setup.accountId), /Confirm removing mark@markridgeon\.com\. Its mail and sending addresses will be deleted/);
    await assert.rejects(disconnectCalendarAccount(setup.owner, setup.accountId, { email: MAIN }), /Confirm removing/);
    assert.deepEqual(await rows(setup.owner), before_);
    await disconnectCalendarAccount(setup.owner, setup.accountId, { email: EXTRA });
    assert.deepEqual(await rows(setup.owner), { main: [MAIN], accounts: [], sources: [MAIN], identities: [], messages: 0 });
  });
});

describe("one reconnect notice per account", () => {
  let setup: Awaited<ReturnType<typeof setUp>>;

  before(async () => {
    setup = await setUp("notice@orbit.test");
  });

  beforeEach(() => clearReconnects());

  it("turns Microsoft refusals into a reconnect error that names the account and links to its own reconnect", async () => {
    const denied: typeof fetch = async () => Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 });
    const thread = `${setup.extraSourceId}|conv-1`;
    const plain = await applyMailAction(setup.owner, { thread, action: "archive" }, denied).then(
      () => null,
      (problem: unknown) => problem,
    );
    assert.ok(plain instanceof CrmError);
    assert.equal(plain.code, "mail_action_failed");
    assert.equal(plain.message, "Outlook refused that change (access denied).");
    await getAdminPool().query("update crm.calendar_accounts set granted_scopes = 'openid User.Read Calendars.Read' where id = $1", [setup.accountId]);
    const missing = await applyMailAction(setup.owner, { thread, action: "archive" }, denied).then(
      () => null,
      (problem: unknown) => problem,
    );
    assert.ok(missing instanceof CrmError);
    assert.equal(missing.code, RECONNECT_NEEDED);
    const refused: typeof fetch = async () => Response.json({ error: { code: "InvalidAuthenticationToken", message: "Token expired." } }, { status: 401 });
    const error = await applyMailAction(setup.owner, { thread, action: "archive" }, refused).then(
      () => null,
      (problem: unknown) => problem,
    );
    assert.ok(error instanceof CrmError);
    assert.equal(error.code, RECONNECT_NEEDED);
    assert.match(error.message, /^Reconnect mark@markridgeon\.com in Settings › Email\.$/);
    assert.deepEqual(error.details?.reconnect, {
      sourceId: setup.extraSourceId,
      email: EXTRA,
      href: `/api/microsoft/connect?purpose=send_account&hint=${encodeURIComponent(EXTRA)}&from=email`,
    });
  });

  it("names a disconnected account instead of pointing at Settings in general", async () => {
    await getAdminPool().query("update crm.calendar_accounts set status = 'disconnected' where id = $1", [setup.accountId]);
    await assert.rejects(mailSourceToken(setup.owner, setup.extraSourceId), (error: unknown) => {
      assert.ok(error instanceof CrmError);
      assert.equal(error.code, RECONNECT_NEEDED);
      assert.equal(error.message, `Reconnect ${EXTRA} in Settings › Email.`);
      return true;
    });
    const nav = await mailNav(setup.owner);
    const extra = nav.accounts.find((account) => account.email === EXTRA)!;
    assert.equal(extra.needsReconnect, true);
    assert.match(extra.reconnectHref ?? "", /purpose=send_account/);
    assert.equal(nav.accounts.find((account) => account.email === MAIN)?.needsReconnect, false);
    await getAdminPool().query("update crm.calendar_accounts set status = 'connected' where id = $1", [setup.accountId]);
  });

  it("shows one notice per account however many actions fail, and keeps other failures for their own message", () => {
    const accounts: MailNav["accounts"] = [
      { id: "s-main", email: MAIN, unread: 0, connected: true, needsReconnect: false, reconnectHref: "/main" },
      { id: "s-extra", email: EXTRA, unread: 0, connected: true, needsReconnect: false, reconnectHref: "/extra" },
    ];
    const failure = (sourceId: string | null) => Object.assign(new Error("Reconnect"), { reconnect: { sourceId, email: null, href: null } });
    assert.equal(flagReconnect(failure("s-extra")), true);
    assert.equal(flagReconnect(failure(null), { sourceId: "s-extra" }), true);
    assert.equal(flagReconnect(failure(null)), false);
    assert.equal(flagReconnect(failure("s-extra")), true);
    assert.equal(flagReconnect(new Error("Outlook no longer has that email.")), false);
    assert.equal(readReconnects().flags.length, 1);
    assert.deepEqual(reconnectAccounts(accounts, readReconnects().flags), [{ key: "s-extra", email: EXTRA, href: "/extra" }]);

    const others = flagSyncProblems(
      [
        `Reconnect ${MAIN} in Settings › Email.`,
        "Reconnect amark@geteclipse.co in Settings › Email.",
        "Mail didn't refresh. Retrying.",
      ],
      accounts,
    );
    assert.deepEqual(others, ["Reconnect amark@geteclipse.co in Settings › Email.", "Mail didn't refresh. Retrying."]);
    assert.deepEqual(
      reconnectAccounts(accounts, readReconnects().flags).map((item) => item.email),
      [MAIN, EXTRA],
    );
    assert.deepEqual(syncProblems({ paused: false, errors: ["x", "y"], reconnect: [`Reconnect ${MAIN} in Settings › Email.`, `Reconnect ${MAIN} in Settings › Email.`] }), [
      `Reconnect ${MAIN} in Settings › Email.`,
    ]);
  });
});

describe("the composer never keeps a From address that has gone", () => {
  const accounts: ComposeAccount[] = [
    { id: "s-main", email: MAIN, signature: null, default: true },
    { id: "s-extra", email: EXTRA, signature: null },
    { id: "smtp:i-1", email: IDENTITY, signature: null, sourceId: "s-extra", identityId: "i-1" },
  ];

  it("falls back to the default address for a new email and to the same mailbox for a reply", () => {
    assert.equal(fromFallback(accounts, null)?.email, MAIN);
    assert.equal(fromFallback(accounts, "s-extra")?.email, EXTRA);
    assert.equal(fromFallback(accounts, "s-gone")?.email, MAIN);
    assert.equal(fromFallback([], null), null);
    const branded = accounts.map((item) => (item.identityId ? { ...item, here: true } : item));
    assert.equal(fromFallback(branded, "s-extra")?.email, IDENTITY);
  });

  it("saves a draft whose sending address was removed without failing", async () => {
    const setup = await setUp("draft@orbit.test");
    await getAdminPool().query("update crm.calendar_accounts set access_token_expires_at = now() + interval '1 hour' where id = $1", [setup.accountId]);
    await getAdminPool().query("delete from crm.send_identities where id = $1", [setup.identityId]);
    let drafts = 0;
    const graph: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url === `${GRAPH}/me/messages`) {
        drafts += 1;
        return Response.json({ id: `draft-${drafts}`, conversationId: `conv-${drafts}`, subject: "" }, { status: 201 });
      }
      return Response.json({});
    };
    const saved = await saveMailDraft(
      setup.owner,
      {
        id: null,
        mode: "new",
        messageId: null,
        sourceId: setup.extraSourceId,
        identityId: setup.identityId,
        to: [{ address: "jane@acme.test", name: null }],
        cc: [],
        bcc: [],
        subject: "Hello",
        body: "Hi",
        signature: false,
        remindHours: null,
      },
      { origin: null, fetchImpl: graph, storedFiles: "keep" },
    );
    assert.equal(saved.sourceId, setup.extraSourceId);
    assert.equal(saved.identityId, null);
  });
});

describe("the connect and callback flow", () => {
  const PERSON = "aaaaaaaa-1111-2222-3333-444444444444";

  function microsoft(email: string, options: { id?: string; upn?: string; inbox?: boolean } = {}) {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: `${email}-access`, refresh_token: `${email}-refresh`, expires_in: 3600, scope: "Mail.ReadWrite Mail.Send User.Read Calendars.ReadWrite" });
      }
      if (url.startsWith(`${GRAPH}/me?`)) return Response.json({ id: options.id ?? null, mail: email, userPrincipalName: options.upn ?? email, displayName: "Mark" });
      if (url.startsWith(`${GRAPH}/me/mailFolders/inbox/messages`)) return Response.json({ value: [] });
      return Response.json({ value: [] });
    };
    return fetchImpl;
  }

  it("asks for the stored main address whatever the link says", async () => {
    const owner = await createUser("flow-hint@orbit.test", "Mark");
    await saveMailbox(owner, { email: MAIN, refreshToken: "r", accessToken: "a", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const started = await startMicrosoftConnect(owner, new URLSearchParams({ hint: EXTRA }), "https://orbit.test", 1_000);
    assert.equal(started.url.searchParams.get("login_hint"), MAIN);
    assert.equal(started.url.searchParams.get("prompt"), "select_account");
    assert.equal(readMicrosoftState(started.state, 1_000)?.hint, MAIN);
    const extra = await startMicrosoftConnect(owner, new URLSearchParams({ purpose: "send_account", hint: EXTRA, from: "email" }), "https://orbit.test", 1_000);
    assert.equal(extra.url.searchParams.get("login_hint"), EXTRA);
    assert.deepEqual(readMicrosoftState(extra.state, 1_000), { userId: owner.userId, workspaceId: owner.workspaceId, purpose: "send_account", hint: EXTRA, back: "email" });
  });

  it("refuses another account through the callback, then reconnects after Disconnect and clears the stale error", async () => {
    const setup = await setUp("flow-callback@orbit.test");
    const state = { userId: setup.owner.userId, workspaceId: setup.owner.workspaceId, purpose: "mailbox" as const, hint: MAIN, back: "email" as const };
    const before = await rows(setup.owner);
    const refused = await finishMicrosoftConnect(setup.owner, state, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft("someone@new.test"));
    assert.equal(refused.error, `You signed in as someone@new.test. Sign in as ${MAIN} to reconnect it.`);
    assert.equal(refused.add, "someone@new.test");
    assert.deepEqual(await rows(setup.owner), before);

    await getAdminPool().query("update crm.mail_sources set last_error = $2 where id = $1", [setup.mainSourceId, `Reconnect ${MAIN} in Settings › Email.`]);
    await disconnectMailbox(setup.owner);
    assert.equal((await listMailboxes(setup.owner))[0].connected, false);
    const reconnected = await finishMicrosoftConnect(setup.owner, state, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft(MAIN, { id: PERSON }));
    assert.deepEqual(reconnected, {});
    const main = (await listMailboxes(setup.owner))[0];
    assert.equal(main.connected, true);
    assert.equal(main.needsReconnect, false);
    assert.equal(main.problem, null);
    assert.deepEqual(await rows(setup.owner), before);
  });

  it("matches on the Microsoft account id, so a changed address still reconnects and a reused one doesn't", async () => {
    const owner = await createUser("flow-id@orbit.test", "Mark");
    const state = { userId: owner.userId, workspaceId: owner.workspaceId, purpose: "mailbox" as const, hint: null, back: "email" as const };
    assert.deepEqual(await finishMicrosoftConnect(owner, state, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft("old@tenant.test", { id: PERSON })), {});
    const renamed = await finishMicrosoftConnect(owner, { ...state, hint: "old@tenant.test" }, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft("new@tenant.test", { id: PERSON }));
    assert.deepEqual(renamed, {});
    assert.deepEqual((await rows(owner)).main, ["new@tenant.test"]);
    const reused = await finishMicrosoftConnect(owner, { ...state, hint: "new@tenant.test" }, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft("new@tenant.test", { id: "bbbbbbbb-1111-2222-3333-444444444444" }));
    assert.match(reused.error ?? "", /Sign in as new@tenant\.test to reconnect it/);

    const older = await createUser("flow-upn@orbit.test", "Mark");
    await saveMailbox(older, { email: "alias@tenant.test", refreshToken: "r", accessToken: "a", expiresAt: new Date(Date.now() + HOUR).toISOString() });
    const byUpn = await finishMicrosoftConnect(
      older,
      { ...state, userId: older.userId, workspaceId: older.workspaceId, hint: "alias@tenant.test" },
      new URLSearchParams({ code: "c" }),
      "https://orbit.test",
      microsoft("primary@tenant.test", { upn: "alias@tenant.test" }),
    );
    assert.deepEqual(byUpn, {});
  });

  it("says sign in to add it when the address offered with Add as another account isn't used", async () => {
    const setup = await setUp("flow-add@orbit.test");
    const state = { userId: setup.owner.userId, workspaceId: setup.owner.workspaceId, purpose: "send_account" as const, hint: "new@other.test", back: "email" as const };
    const outcome = await finishMicrosoftConnect(setup.owner, state, new URLSearchParams({ code: "c" }), "https://orbit.test", microsoft("third@other.test"));
    assert.equal(outcome.error, "You signed in as third@other.test. Sign in as new@other.test to add it.");
  });
});

describe("what counts as needing a reconnect", () => {
  it("never passes Microsoft's own error text through", () => {
    const realConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const raw = "AADSTS90002: Tenant 'f00' not found. Trace ID: 1c2d Correlation ID: 3e4f Timestamp: 2026-11-10 09:00:00Z";
      assert.equal(sanitizeMicrosoftError(raw), "Couldn't reach Microsoft. Try again.");
      assert.equal(sanitizeMicrosoftError("ErrorAccessDenied: Access is denied.", "Couldn't send the email. Try again."), "Couldn't send the email. Try again.");
      assert.equal(new MicrosoftTokenError("AADSTS50126: Error validating credentials. Trace ID: 1c2d").message, "Couldn't connect Microsoft. Try again.");
      assert.equal(sanitizeMicrosoftError("Reconnect Microsoft in Settings › Email to send attachments over 3 MB."), "Reconnect Microsoft in Settings › Email to send attachments over 3 MB.");
      assert.ok(logged.some((line) => line.includes("AADSTS90002")));
      assert.equal(microsoftErrorText(new Error("fetch failed"), "Couldn't sync the calendar. Try again."), "Couldn't sync the calendar. Try again.");
      assert.equal(microsoftErrorText(new Error("invalid_grant AADSTS700082: expired")), "Microsoft rejected the mailbox connection. Connect it again.");
    } finally {
      console.error = realConsoleError;
    }
  });

  it("tests Microsoft's message for a signed-out session, never its error code", async () => {
    const realConsoleError = console.error;
    console.error = () => {};
    try {
      assert.equal(microsoftProblem("The operation timed out.", "Couldn't sync the calendar. Try again.", "ErrorTimeoutExpired"), "Couldn't sync the calendar. Try again.");
      assert.equal(microsoftProblem("AADSTS700082: The refresh token has expired.", "x"), "Microsoft rejected the mailbox connection. Connect it again.");
      assert.equal(microsoftProblem("", "x", "invalid_grant"), "Microsoft rejected the mailbox connection. Connect it again.");
      const timeout = (async () => Response.json({ error: { code: "ErrorTimeoutExpired", message: "The operation timed out." } }, { status: 504 })) as typeof fetch;
      const failure = await fetchCalendarView("token", { start: new Date(), end: new Date() }, { fetchImpl: timeout }).then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof Error);
      assert.doesNotMatch(failure.message, /rejected the mailbox connection|connect it again/i);
    } finally {
      console.error = realConsoleError;
    }
  });

  it("tells the assistant why Microsoft refused a new meeting, so it doesn't retry the same one", async () => {
    const realConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const refused = (async () => Response.json({ error: { code: "ErrorInvalidRequest", message: "The start time must be before the end time." } }, { status: 400 })) as typeof fetch;
      const failure = await createGraphEvent("token", { subject: "Call" } as Parameters<typeof createGraphEvent>[1], { fetchImpl: refused }).then(() => null, (error: unknown) => error);
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, "Microsoft refused the meeting: The start time must be before the end time. Change it rather than trying again.");
      assert.doesNotMatch(failure.message, /Try again/);
      assert.ok(logged.some((line) => line.includes("start time must be before")));
    } finally {
      console.error = realConsoleError;
    }
  });

  it("keeps the reconnect instruction when the saved connection can't be read", async () => {
    const failure = await currentToken({ refreshTokenCipher: "not-a-real-cipher", accessTokenCipher: null, accessTokenExpiresAt: null }, fetch).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof MicrosoftError);
    const reconnect = /could not read the saved Microsoft connection/;
    assert.match(microsoftErrorText(failure, "Couldn't sync the calendar. Try again."), reconnect);
    assert.match(callErrorText(failure, "Couldn't sync Teams calls. Try again."), reconnect);
    assert.match(transcriptErrorText(failure, "Couldn't sync Teams transcripts. Try again."), reconnect);
    assert.equal(reconnectProblem(failure, MAIN), `Reconnect ${MAIN} in Settings › Email.`);
  });

  it("separates expired sign-ins, Orbit's own app and other refusals", () => {
    const expired = new MicrosoftTokenError("invalid_grant AADSTS700082: The refresh token has expired due to inactivity.");
    assert.match(reconnectProblem(expired, MAIN) ?? "", /^Reconnect mark@geteclipse\.co in Settings › Email\.$/);

    for (const detail of ["invalid_client AADSTS7000222: The provided client secret keys for app are expired.", "AADSTS7000215: Invalid client secret provided."]) {
      const app = new MicrosoftTokenError(detail);
      assert.equal(reconnectProblem(app, MAIN), null);
      assert.equal(app.message, APP_NEEDS_ATTENTION);
      assert.equal(sanitizeMicrosoftError(detail), APP_NEEDS_ATTENTION);
      assert.equal(calendarConnectError(detail), APP_NEEDS_ATTENTION);
      assert.equal(graphReconnect(app, null), null);
    }

    const folder = new GraphMailError("Outlook didn't let Orbit read that (access denied).", 403, "ErrorAccessDenied Access is denied. Check credentials and try again.");
    assert.equal(reconnectProblem(folder, MAIN), null);
    assert.equal(reconnectProblem(folder, MAIN, true), null);
    assert.match(reconnectProblem(folder, MAIN, false) ?? "", /allow every permission/);
    assert.match(reconnectProblem(new GraphMailError("x", 403, "Authorization_RequestDenied Insufficient privileges"), MAIN) ?? "", /allow every permission/);
    assert.match(reconnectProblem(new GraphMailError("x", 403, "AADSTS65001 consent_required"), MAIN) ?? "", /Ask your Microsoft admin/);
    assert.equal(reconnectProblem(new GraphMailError("x", 401, "InvalidAuthenticationToken"), MAIN), `Reconnect ${MAIN} in Settings › Email.`);
    assert.equal(reconnectProblem(new GraphMailError("x", 500, "ServiceUnavailable"), MAIN), null);
    assert.equal(graphReconnect(folder, { id: "s", email: MAIN, main: true, scopes: "Mail.Send User.Read" })?.code, RECONNECT_NEEDED);
    assert.equal(graphReconnect(folder, { id: "s", email: MAIN, main: true, scopes: "Mail.ReadWrite Mail.Send" }), null);
  });
});
