import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { listActivities } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import {
  counterpartEmails,
  fileInboundMessages,
  getMailbox,
  listInbox,
  saveMailbox,
  syncMailbox,
} from "@/lib/crm/inbox";
import { listTasks } from "@/lib/crm/tasks";
import { originFrom, readMicrosoftState, signMicrosoftState } from "@/lib/microsoft/oauth";
import type { GraphInboxMessage } from "@/lib/microsoft/oauth";
import { getPool } from "@/lib/db/pool";
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
        receivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
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
    const stranger = messages.find((message) => message.subject === "Newsletter");
    assert.equal(stranger?.contactId, null);
    assert.equal(stranger?.companyId, null);

    const activities = await listActivities(owner, { companyId: company.body.company.id });
    assert.equal(activities.total, 3);
    const tasks = await listTasks(owner, { companyId: company.body.company.id });
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
        receivedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
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
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/token")) {
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
    const mailbox = await getMailbox(owner);
    assert.equal(mailbox?.status, "connected");
    assert.equal(mailbox?.lastError, null);
    assert.ok(mailbox?.lastSyncedAt);
    const [message] = await listInbox(owner);
    assert.equal(message?.subject, "Intro");
    assert.equal(message?.contactName, "Bea");
  });
});
