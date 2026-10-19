import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { listActivities } from "@/lib/crm/activities";
import { connectCalendarAccount } from "@/lib/crm/calendar-accounts";
import { listCalendarGroups } from "@/lib/crm/calendars";
import { createContact } from "@/lib/crm/contacts";
import { listSenders, saveMailbox, saveSignature, sendContactEmail } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { microsoftAuthorizationUrl, SEND_ACCOUNT_SCOPES, signMicrosoftState } from "@/lib/microsoft/oauth";
import { createUser, resetDatabase } from "./helpers";

function oauth(scope: string, email: string) {
  const exchanged: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/oauth2/v2.0/token")) {
      exchanged.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: `${email}-access`, refresh_token: `${email}-refresh`, expires_in: 3600, scope });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ mail: email, userPrincipalName: email, displayName: "Mark" });
    throw new Error(`Unexpected ${url}`);
  };
  return { fetchImpl, exchanged };
}

function graph() {
  const sent: { token: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://graph.microsoft.com/v1.0/me/sendMail");
    const token = new Headers(init?.headers).get("authorization") ?? "";
    sent.push({ token, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 202 });
  };
  return { fetchImpl, sent };
}

describe("sending from other accounts", () => {
  let owner: UserActor;
  let contactId: string;

  before(async () => {
    process.env.MICROSOFT_CLIENT_ID = "client";
    process.env.MICROSOFT_CLIENT_SECRET = "secret";
    await resetDatabase();
    owner = await createUser("send-from@orbit.test", "Mark Ridgeon");
    contactId = (await createContact(owner, { firstName: "Jane", email: "jane@client.test" })).body.contact.id;
    await saveMailbox(owner, {
      email: "mark@geteclipse.co",
      refreshToken: "primary-refresh",
      accessToken: "primary-access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  after(async () => {
    await getPool().end();
  });

  it("asks Microsoft for send permission and records it on the account", async () => {
    const url = microsoftAuthorizationUrl("https://orbit.test", signMicrosoftState(owner.userId, owner.workspaceId, Date.now(), "send_account"), {
      purpose: "send_account",
      loginHint: "mark@markridgeon.com",
    });
    assert.equal(url.searchParams.get("scope"), SEND_ACCOUNT_SCOPES);
    assert.match(SEND_ACCOUNT_SCOPES, /Mail\.Send/);

    const calendarOnly = oauth("Calendars.Read User.Read", "mark@zeusvoice.com");
    const plain = await connectCalendarAccount(owner, { origin: "https://orbit.test", code: "a" }, calendarOnly.fetchImpl);
    assert.equal(plain.canSend, null);

    const allowed = oauth("Calendars.Read User.Read Mail.Send Mail.ReadWrite", "mark@markridgeon.com");
    const consultancy = await connectCalendarAccount(owner, { origin: "https://orbit.test", code: "b", purpose: "send_account" }, allowed.fetchImpl);
    assert.equal(consultancy.canSend, true);
    assert.equal(allowed.exchanged[0].get("scope"), SEND_ACCOUNT_SCOPES);

    const again = await connectCalendarAccount(owner, { origin: "https://orbit.test", code: "c" }, oauth("Calendars.Read User.Read", "mark@markridgeon.com").fetchImpl);
    assert.equal(again.id, consultancy.id);

    assert.deepEqual(
      (await listSenders(owner)).map((sender) => [sender.email, sender.primary]),
      [
        ["mark@geteclipse.co", true],
        ["mark@markridgeon.com", false],
      ],
    );
    const groups = await listCalendarGroups(owner);
    assert.deepEqual(
      groups.map((group) => [group.email, group.canSend]),
      [
        ["mark@geteclipse.co", true],
        ["mark@zeusvoice.com", false],
        ["mark@markridgeon.com", true],
      ],
    );
  });

  it("sends from the main mailbox by default and from a chosen account when asked", async () => {
    const senders = await listSenders(owner);
    const consultancy = senders.find((sender) => sender.email === "mark@markridgeon.com")!;
    const out = graph();

    await sendContactEmail(owner, contactId, { subject: "From Eclipse", body: "Hi" }, out.fetchImpl);
    await sendContactEmail(owner, contactId, { subject: "From consultancy", body: "Hi", from: consultancy.id }, out.fetchImpl);
    assert.deepEqual(
      out.sent.map((item) => item.token),
      ["Bearer primary-access", "Bearer mark@markridgeon.com-access"],
    );
    const emails = (await listActivities(owner, { contactId, type: "email" })).data;
    assert.deepEqual(
      emails.map((item) => [item.title, item.metadata.from]),
      [
        ["From consultancy", "mark@markridgeon.com"],
        ["From Eclipse", "mark@geteclipse.co"],
      ],
    );

    const zeus = (await listCalendarGroups(owner)).find((group) => group.email === "mark@zeusvoice.com")!;
    await assert.rejects(
      sendContactEmail(owner, contactId, { subject: "Nope", body: "Hi", from: zeus.id }, out.fetchImpl),
      /Allow sending for mark@zeusvoice\.com/,
    );
    const other = await createUser("someone@orbit.test", "Someone");
    await assert.rejects(
      sendContactEmail(other, contactId, { subject: "Nope", body: "Hi", from: consultancy.id }, out.fetchImpl),
      /isn't connected|not found/i,
    );
  });

  it("lets the assistant send from another address by name", async () => {
    const refused = (await runTool(owner, "send_email", { contactId, subject: "Hi", body: "Hi", from: "mark@zeusvoice.com" })) as { error: string };
    assert.match(refused.error, /You can't send from mark@zeusvoice\.com yet\. You can send from: mark@geteclipse\.co, mark@markridgeon\.com/);
    const listed = (await runTool(owner, "list_email_senders", {})) as { senders: { email: string }[] };
    assert.equal(listed.senders.length, 2);
  });

  it("adds each address's own signature below the message unless left off", async () => {
    assert.equal(await saveSignature(owner, "Mark@GetEclipse.co", "Mark Ridgeon  \r\nFounder, Eclipse\n"), "Mark Ridgeon\nFounder, Eclipse");
    await saveSignature(owner, "mark@markridgeon.com", "Mark Ridgeon\nIndependent consultant");
    await assert.rejects(saveSignature(owner, "someone@else.test", "Hi"), /address you send from/);

    const senders = await listSenders(owner);
    assert.deepEqual(
      senders.map((sender) => [sender.email, sender.signature]),
      [
        ["mark@geteclipse.co", "Mark Ridgeon\nFounder, Eclipse"],
        ["mark@markridgeon.com", "Mark Ridgeon\nIndependent consultant"],
      ],
    );
    const out = graph();
    const consultancy = senders.find((sender) => !sender.primary)!;
    await sendContactEmail(owner, contactId, { subject: "Signed", body: "Hello Jane" }, out.fetchImpl);
    await sendContactEmail(owner, contactId, { subject: "Consulting", body: "Hello Jane", from: consultancy.id }, out.fetchImpl);
    await sendContactEmail(owner, contactId, { subject: "Plain", body: "Hello Jane", signature: false }, out.fetchImpl);
    const bodies = out.sent.map((item) => (item.body.message as { body: { content: string } }).body.content);
    assert.deepEqual(bodies, [
      "Hello Jane\n\nMark Ridgeon\nFounder, Eclipse",
      "Hello Jane\n\nMark Ridgeon\nIndependent consultant",
      "Hello Jane",
    ]);
    const logged = (await listActivities(owner, { contactId, type: "email" })).data.find((item) => item.title === "Signed")!;
    assert.equal(logged.body, "Hello Jane");

    assert.equal(await saveSignature(owner, "mark@geteclipse.co", "   "), null);
    assert.equal((await listSenders(owner))[0].signature, null);
  });
});
