import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { listActivities } from "@/lib/crm/activities";
import { recordCommunication } from "@/lib/crm/communications";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import {
  counterpartEmails,
  fileInboundMessages,
  getMailbox,
  listInbox,
  saveMailbox,
  sendContactEmail,
  syncMailbox,
} from "@/lib/crm/inbox";
import { listTasks } from "@/lib/crm/tasks";
import {
  originFrom,
  readMicrosoftState,
  signMicrosoftState,
} from "@/lib/microsoft/oauth";
import type { GraphInboxMessage } from "@/lib/microsoft/oauth";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("microsoft inbox", () => {
  it("round-trips a mailbox secret and rejects a tampered oauth state", () => {
    const stored = encryptSecret("refresh-token");
    assert.equal(decryptSecret(stored), "refresh-token");
    const state = signMicrosoftState("user-1", "workspace-1", 1_000);
    assert.deepEqual(readMicrosoftState(state, 1_000), {
      userId: "user-1",
      workspaceId: "workspace-1",
      purpose: "mailbox",
    });
    assert.equal(readMicrosoftState(state, 1_000 + 11 * 60 * 1000), null);
    assert.equal(readMicrosoftState(`${state}x`, 1_000), null);
    const request = new Request("http://0.0.0.0:4173/api/microsoft/connect", {
      headers: { host: "localhost:4173" },
    });
    assert.equal(originFrom(request), "http://localhost:4173");
  });

  it("ignores the mailbox address when choosing who the email is with", () => {
    assert.deepEqual(
      counterpartEmails({
        mailboxEmail: "Founder@Example.com",
        fromEmail: "founder@example.com",
        toEmails: ["Ada@Harbor.test", "founder@example.com"],
        ccEmails: ["ada@harbor.test"],
      }),
      ["ada@harbor.test"],
    );
  });

  it("attaches a received email to the contact and skips it the next time", async () => {
    const owner = await createUser("inbox-owner@example.com", "Inbox Owner");
    const company = await createCompany(owner, {
      name: "Harbor Inbox",
      domain: "harbor-inbox.test",
    });
    const contact = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Ada",
      lastName: "Harbor",
      email: "ada@harbor-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@orbit.test",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const recent = new Date().toISOString();
    const filed = await fileInboundMessages(owner, [
      {
        providerMessageId: "msg-ada",
        subject: "Pilot",
        preview: "Can we start next week?",
        fromEmail: "Ada@Harbor-inbox.test",
        fromName: "Ada Harbor",
        receivedAt: recent,
      },
      {
        providerMessageId: "msg-old",
        subject: "Notes from March",
        preview: "Old thread",
        fromEmail: "ada@harbor-inbox.test",
        receivedAt: new Date(
          Date.now() - 10 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      {
        providerMessageId: "msg-stranger",
        subject: "Newsletter",
        preview: "Weekly",
        fromEmail: "news@unmatched.test",
        receivedAt: recent,
      },
      {
        providerMessageId: "msg-self",
        subject: "Re: Pilot",
        preview: "Sent from the mailbox",
        fromEmail: "owner@orbit.test",
        toEmails: ["ada@harbor-inbox.test"],
        receivedAt: recent,
      },
    ]);
    assert.equal(filed.attached, 3);
    assert.equal(filed.unattached, 1);
    assert.equal(filed.followUps, 1);

    const again = await fileInboundMessages(owner, [
      {
        providerMessageId: "msg-ada",
        subject: "Pilot",
        fromEmail: "ada@harbor-inbox.test",
        receivedAt: recent,
      },
    ]);
    assert.equal(again.skipped, 1);
    assert.equal(again.attached, 0);

    const messages = await listInbox(owner);
    const ada = messages.find((message) => message.subject === "Pilot");
    assert.equal(ada?.contactId, contact.body.contact.id);
    assert.equal(ada?.contactName, "Ada Harbor");
    assert.equal(ada?.companyId, company.body.company.id);
    const stranger = messages.find(
      (message) => message.subject === "Newsletter",
    );
    assert.equal(stranger?.contactId, null);
    assert.equal(stranger?.companyId, null);

    const activities = await listActivities(owner, {
      companyId: company.body.company.id,
    });
    assert.equal(activities.total, 3);
    const tasks = await listTasks(owner, {
      companyId: company.body.company.id,
    });
    assert.equal(tasks.total, 1);
    assert.match(tasks.data[0]?.title ?? "", /Ada Harbor/);
  });

  it("attaches a sender by company domain when no contact matches", async () => {
    const owner = await createUser("domain-inbox@example.com", "Domain Inbox");
    const company = await createCompany(owner, {
      name: "Domain Co",
      domain: "domain-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@domain-inbox.test",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const filed = await fileInboundMessages(owner, [
      {
        providerMessageId: "msg-domain",
        subject: "Hello",
        fromEmail: "sam@domain-inbox.test",
        receivedAt: new Date(
          Date.now() - 5 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ]);
    assert.equal(filed.attached, 1);
    assert.equal(filed.followUps, 0);
    const [message] = await listInbox(owner);
    assert.equal(message?.companyId, company.body.company.id);
    assert.equal(message?.contactId, null);
  });

  it("syncs graph messages with the stored mailbox token", async () => {
    const owner = await createUser("sync-inbox@example.com", "Sync Inbox");
    await createContact(owner, {
      firstName: "Bea",
      email: "bea@sync-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@sync-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const graph: GraphInboxMessage = {
      id: "graph-bea",
      subject: "Intro",
      bodyPreview: "Nice to meet you",
      receivedDateTime: new Date().toISOString(),
      from: { emailAddress: { address: "bea@sync-inbox.test", name: "Bea" } },
    };
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    let refreshBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/token")) {
        refreshBody = String(init?.body ?? "");
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        });
      }
      assert.match(url, /mailFolders\/inbox\/messages/);
      return Response.json({ value: [graph] });
    };
    const result = await syncMailbox(owner, fetchImpl);
    assert.equal(result.attached, 1);
    assert.equal(result.error, undefined);
    assert.match(refreshBody, /grant_type=refresh_token/);
    assert.doesNotMatch(refreshBody, /scope=/);
    const mailbox = await getMailbox(owner);
    assert.equal(mailbox?.status, "connected");
    assert.equal(mailbox?.lastError, null);
    assert.ok(mailbox?.lastSyncedAt);
    const [message] = await listInbox(owner);
    assert.equal(message?.subject, "Intro");
    assert.equal(message?.contactName, "Bea");
  });

  it("sends a contact email through the connected mailbox and files it", async () => {
    const owner = await createUser("send-inbox@example.com", "Send Inbox");
    const contact = await createContact(owner, {
      firstName: "Cara",
      email: "cara@send-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@send-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    let sentBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      assert.equal(
        String(input),
        "https://graph.microsoft.com/v1.0/me/sendMail",
      );
      sentBody = String(init?.body ?? "");
      return new Response(null, { status: 202 });
    };
    await sendContactEmail(
      owner,
      contact.body.contact.id,
      { subject: "Hello Cara", body: "Following up on the proposal." },
      fetchImpl,
    );
    assert.match(sentBody, /cara@send-inbox\.test/);
    assert.match(sentBody, /Hello Cara/);
    const activities = await listActivities(owner, {
      contactId: contact.body.contact.id,
    });
    assert.equal(activities.data[0]?.type, "email");
    assert.equal(activities.data[0]?.title, "Hello Cara");
  });

  it("tells the user to grant Mail.Send when Microsoft refuses the send", async () => {
    const owner = await createUser("send-denied@example.com", "Send Denied");
    const contact = await createContact(owner, {
      firstName: "Dara",
      email: "dara@send-denied.test",
    });
    await saveMailbox(owner, {
      email: "owner@send-denied.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const fetchImpl: typeof fetch = async () =>
      Response.json(
        { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
        { status: 403 },
      );
    await assert.rejects(
      () =>
        sendContactEmail(
          owner,
          contact.body.contact.id,
          {
            subject: "Hello",
            body: "Checking in.",
          },
          fetchImpl,
        ),
      /Mail\.Send/,
    );
  });

  it("refuses to send when the contact has no email", async () => {
    const owner = await createUser("send-empty@example.com", "Send Empty");
    const contact = await createContact(owner, {
      firstName: "No",
      lastName: "Mail",
    });
    await saveMailbox(owner, {
      email: "owner@send-empty.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await assert.rejects(
      () =>
        sendContactEmail(owner, contact.body.contact.id, {
          subject: "Hi",
          body: "Hello",
        }),
      /Add an email address/,
    );
  });

  it("catches up on a long gap oldest first without losing mail", async () => {
    const owner = await createUser("gap-inbox@example.com", "Gap Inbox");
    await saveMailbox(owner, {
      email: "owner@gap-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const start = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const all: GraphInboxMessage[] = Array.from({ length: 130 }, (_, index) => ({
      id: `gap-${index}`,
      subject: `Gap ${index}`,
      receivedDateTime: new Date(start + index * 60 * 60 * 1000).toISOString(),
      from: { emailAddress: { address: `sender${index}@gap.test` } },
    }));
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url.toString());
      assert.equal(url.searchParams.get("$orderby"), "receivedDateTime asc");
      const since = new Date(
        (url.searchParams.get("$filter") ?? "").replace("receivedDateTime ge ", ""),
      );
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const matching = all.filter(
        (message) => new Date(message.receivedDateTime!) >= since,
      );
      const page = matching.slice(skip, skip + 50);
      const next = new URL(url);
      next.searchParams.set("skip", String(skip + 50));
      return Response.json({
        value: page,
        ...(skip + 50 < matching.length
          ? { "@odata.nextLink": next.toString() }
          : {}),
      });
    };
    const stored = async () => {
      const result = await getAdminPool().query<{ total: number }>(
        `select count(*)::int as total from crm.email_messages m
         join crm.mailbox_connections box on box.id = m.connection_id
         where box.user_id = $1`,
        [owner.userId],
      );
      return result.rows[0]?.total ?? 0;
    };

    const first = await syncMailbox(owner, fetchImpl);
    assert.equal(first.error, undefined);
    assert.equal(first.unattached, 100);
    assert.equal(await stored(), 100);
    const partial = await getMailbox(owner);
    assert.equal(
      partial?.lastSyncedAt,
      new Date(start + 99 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString(),
    );

    const second = await syncMailbox(owner, fetchImpl);
    assert.equal(second.error, undefined);
    assert.equal(second.unattached, 30);
    assert.equal(second.skipped, 1);
    assert.equal(await stored(), 130);
    const caughtUp = await getMailbox(owner);
    assert.ok(
      Date.now() - new Date(caughtUp!.lastSyncedAt!).getTime() < 60 * 1000,
    );
    assert.equal(requested.length, 3);
  });

  it("keeps the sync window when Graph refuses ordering and the fetch is cut short", async () => {
    const owner = await createUser("unordered-inbox@example.com", "Unordered");
    await saveMailbox(owner, {
      email: "owner@unordered-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("$orderby")) {
        return Response.json(
          { error: { code: "InefficientFilter", message: "Too complex" } },
          { status: 400 },
        );
      }
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const next = new URL(url);
      next.searchParams.set("skip", String(skip + 50));
      return Response.json({
        value: Array.from({ length: 50 }, (_, index) => ({
          id: `unordered-${skip + index}`,
          receivedDateTime: new Date(
            Date.now() - (skip + index) * 60 * 1000,
          ).toISOString(),
          from: { emailAddress: { address: "someone@unordered.test" } },
        })),
        "@odata.nextLink": next.toString(),
      });
    };
    const before = Date.now();
    const result = await syncMailbox(owner, fetchImpl);
    assert.equal(result.error, undefined);
    assert.equal(result.unattached, 100);
    const mailbox = await getMailbox(owner);
    const synced = new Date(mailbox!.lastSyncedAt!).getTime();
    const window = before - 14 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000;
    assert.ok(Math.abs(synced - window) < 60 * 1000);
  });

  it("files a message once when two syncs race", async () => {
    const owner = await createUser("race-inbox@example.com", "Race Inbox");
    const company = await createCompany(owner, {
      name: "Race Co",
      domain: "race-inbox.test",
    });
    await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Rae",
      email: "rae@race-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@orbit-race.test",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const message = {
      providerMessageId: "msg-race",
      subject: "Contract",
      fromEmail: "rae@race-inbox.test",
      receivedAt: new Date().toISOString(),
    };
    const results = await Promise.all([
      fileInboundMessages(owner, [message]),
      fileInboundMessages(owner, [message]),
      fileInboundMessages(owner, [message]),
    ]);
    assert.equal(
      results.reduce((total, result) => total + result.attached, 0),
      1,
    );
    const activities = await listActivities(owner, {
      companyId: company.body.company.id,
    });
    assert.equal(activities.total, 1);
    const tasks = await listTasks(owner, {
      companyId: company.body.company.id,
    });
    assert.equal(tasks.total, 1);
  });

  it("attaches earlier unmatched mail once the contact exists", async () => {
    const owner = await createUser("later-inbox@example.com", "Later Inbox");
    await saveMailbox(owner, {
      email: "owner@later-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const filed = await fileInboundMessages(owner, [
      {
        providerMessageId: "msg-later",
        subject: "Intro from Lee",
        fromEmail: "lee@later.test",
        receivedAt: new Date().toISOString(),
      },
      {
        providerMessageId: "msg-gmail",
        subject: "Personal note",
        fromEmail: "someone@gmail.com",
        receivedAt: new Date().toISOString(),
      },
    ]);
    assert.equal(filed.unattached, 2);
    const company = await createCompany(owner, {
      name: "Later Co",
      domain: "later.test",
    });
    await createCompany(owner, { name: "Gmail", domain: "gmail.com" });
    const contact = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Lee",
      email: "lee@later.test",
    });
    const result = await syncMailbox(owner, async () =>
      Response.json({ value: [] }),
    );
    assert.equal(result.error, undefined);
    assert.equal(result.attached, 1);
    assert.equal(result.followUps, 0);
    const messages = await listInbox(owner);
    const lee = messages.find((message) => message.subject === "Intro from Lee");
    assert.equal(lee?.contactId, contact.body.contact.id);
    const personal = messages.find(
      (message) => message.subject === "Personal note",
    );
    assert.equal(personal?.companyId, null);
    const activities = await listActivities(owner, {
      contactId: contact.body.contact.id,
    });
    assert.equal(activities.total, 1);
    const tasks = await listTasks(owner, {
      companyId: company.body.company.id,
    });
    assert.equal(tasks.total, 0);
    const again = await syncMailbox(owner, async () =>
      Response.json({ value: [] }),
    );
    assert.equal(again.attached, 0);
  });

  it("asks for a reconnect instead of failing when stored tokens cannot be read", async () => {
    const owner = await createUser("cipher-inbox@example.com", "Cipher Inbox");
    const contact = await createContact(owner, {
      firstName: "Cy",
      email: "cy@cipher-inbox.test",
    });
    await saveMailbox(owner, {
      email: "owner@cipher-inbox.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await getAdminPool().query(
      `update crm.mailbox_connections
       set refresh_token = 'v1.AAAA.AAAA.AAAA', access_token = 'v1.AAAA.AAAA.AAAA'
       where user_id = $1`,
      [owner.userId],
    );
    const summary = await getMailbox(owner);
    assert.equal(summary?.status, "connected");
    const result = await syncMailbox(owner, async () => {
      throw new Error("should not reach Microsoft");
    });
    assert.match(result.error ?? "", /connect Microsoft again/);
    const after = await getMailbox(owner);
    assert.match(after?.lastError ?? "", /connect Microsoft again/);
    await assert.rejects(
      () =>
        sendContactEmail(
          owner,
          contact.body.contact.id,
          { subject: "Hi", body: "Hello" },
          async () => {
            throw new Error("should not reach Microsoft");
          },
        ),
      /connect Microsoft again/,
    );
  });

  it("reports an expired refresh token as a reconnect when sending", async () => {
    const owner = await createUser("expired-send@example.com", "Expired Send");
    const contact = await createContact(owner, {
      firstName: "Eve",
      email: "eve@expired-send.test",
    });
    await saveMailbox(owner, {
      email: "owner@expired-send.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    await assert.rejects(
      () =>
        sendContactEmail(
          owner,
          contact.body.contact.id,
          { subject: "Hi", body: "Hello" },
          async () =>
            Response.json(
              {
                error: "invalid_grant",
                error_description: "AADSTS700082: The refresh token has expired.",
              },
              { status: 400 },
            ),
        ),
      /Connect it again/,
    );
  });

  it("records a communication on the given company with its own contact", async () => {
    const owner = await createUser("comm-inbox@example.com", "Comm Inbox");
    const other = await createCompany(owner, {
      name: "Other Co",
      domain: "other-comm.test",
    });
    const mine = await createCompany(owner, {
      name: "Mine Co",
      domain: "mine-comm.test",
    });
    await createContact(owner, {
      companyId: other.body.company.id,
      firstName: "Oli",
      email: "oli@other-comm.test",
    });
    const mia = await createContact(owner, {
      companyId: mine.body.company.id,
      firstName: "Mia",
      email: "mia@mine-comm.test",
    });
    const filed = await recordCommunication(owner, {
      kind: "meeting",
      title: "Joint call",
      body: "Walked through the plan",
      occurredAt: new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      companyId: mine.body.company.id,
      participantEmails: ["oli@other-comm.test", "mia@mine-comm.test"],
    });
    assert.equal(filed.activity.companyId, mine.body.company.id);
    assert.equal(filed.activity.contactId, mia.body.contact.id);
    assert.equal(filed.suggested, false);

    await createCompany(owner, { name: "Gmail Inc", domain: "gmail.com" });
    const personal = await recordCommunication(owner, {
      kind: "email",
      title: "Hello",
      body: "From a personal address",
      participantEmails: ["someone@gmail.com", "new@other-comm.test"],
    });
    assert.equal(personal.company?.id, other.body.company.id);
  });
});
