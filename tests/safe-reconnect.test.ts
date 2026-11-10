import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { flagReconnect, flagSyncProblems, readReconnects, reconnectAccounts, clearReconnects } from "@/components/mail/reconnect-store";
import { connectCalendarAccount, disconnectCalendarAccount, SAME_AS_PRIMARY } from "@/lib/crm/calendar-accounts";
import { CrmError } from "@/lib/crm/errors";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listMailboxes } from "@/lib/mail/accounts";
import { applyMailAction } from "@/lib/mail/actions";
import { saveMailDraft } from "@/lib/mail/compose";
import { fromFallback, RECONNECT_NEEDED, removalText } from "@/lib/mail/mailboxes";
import { mailSourceToken, syncProblems } from "@/lib/mail/sync";
import { mailNav } from "@/lib/mail/threads";
import type { ComposeAccount, MailNav } from "@/lib/mail/view";
import { microsoftAuthorizationUrl, readMicrosoftState, signMicrosoftState } from "@/lib/microsoft/oauth";
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
    assert.deepEqual(extra.removes, { emails: 2, addresses: [IDENTITY] });
    assert.equal(removalText(extra.removes), `Orbit deletes its copy of 2 emails, its calendars and the sending address ${IDENTITY}. Nothing changes in Outlook.`);
  });

  it("only removes an account with mail when the removal is confirmed for that account", async () => {
    await assert.rejects(disconnectCalendarAccount(setup.owner, setup.accountId), /Confirm removing mark@markridgeon\.com first/);
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
    const refused: typeof fetch = async () => Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 });
    await getAdminPool().query("update crm.calendar_accounts set access_token_expires_at = now() + interval '1 hour' where id = $1", [setup.accountId]);
    const thread = `${setup.extraSourceId}|conv-1`;
    const error = await applyMailAction(setup.owner, { thread, action: "archive" }, refused).then(
      () => null,
      (problem: unknown) => problem,
    );
    assert.ok(error instanceof CrmError);
    assert.equal(error.code, RECONNECT_NEEDED);
    assert.match(error.message, /^Reconnect mark@markridgeon\.com in Settings › Email/);
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
      assert.equal(error.message, `Reconnect ${EXTRA} in Settings › Email. It isn't connected to Orbit any more.`);
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
    assert.equal(flagReconnect(failure("s-extra")), true);
    assert.equal(flagReconnect(new Error("Outlook no longer has that email.")), false);
    assert.equal(readReconnects().flags.length, 1);
    assert.deepEqual(reconnectAccounts(accounts, readReconnects().flags), [{ key: "s-extra", email: EXTRA, href: "/extra" }]);

    const others = flagSyncProblems(
      [`Reconnect ${MAIN} in Settings › Email. Microsoft has signed Orbit out of it.`, "Mail didn't refresh. Orbit will try again shortly."],
      accounts,
    );
    assert.deepEqual(others, ["Mail didn't refresh. Orbit will try again shortly."]);
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
