import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { continueAfterCompanion, startAgentMailJob } from "@/lib/agent-mail/jobs";
import { OTHER_WORKSPACE_PLACEHOLDER, addressTakenMessage, agentMailboxView, saveAgentSenders, setUpAgentMailbox } from "@/lib/agent-mail/mailbox";
import { FETCHES_PER_MAILBOX, pollAgentMailboxes } from "@/lib/agent-mail/poll";
import { receiveAgentMail } from "@/lib/agent-mail/receive";
import { DEFAULT_ADDRESS } from "@/lib/agent-mail/senders";
import { applyCompanionResult } from "@/lib/assistant/chat";
import { companionForJob, finishCompanionJob, nextCompanionJob } from "@/lib/companion/jobs";
import { authenticateCompanion, createPairingCode, redeemPairing, type AuthenticatedCompanion } from "@/lib/companion/pairing";
import { CrmError } from "@/lib/crm/errors";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { MACHINE_MAIL_API, signPayload } from "@/lib/machinemail";
import { resetStorageBucketCache } from "@/lib/storage";
import type { CompanionResult } from "@/companion/src/protocol";
import { createUser, resetDatabase } from "./helpers";

const ECLIPSE_BOX = DEFAULT_ADDRESS;
const RIDGEON_BOX = "ridgeon@ai-mail.geteclipse.co";
const MARK_ECLIPSE = "mark@geteclipse.co";
const MARK_RIDGEON = "mark@ridgeon.me";

type Recorded = { method: string; url: string; body: Record<string, unknown> | null };

function secretFor(address: string) {
  return `whsec_${address.replace(/[^a-z0-9]/g, "")}`;
}

function fakeMachineMail() {
  const requests: Recorded[] = [];
  const threads = new Map<string, string>();
  let sent = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ method, url, body });
    assert.ok(url.startsWith(MACHINE_MAIL_API), `unexpected ${method} ${url}`);
    const path = url.slice(MACHINE_MAIL_API.length);
    if (method === "POST" && path === "/inboxes") return Response.json({ inbox_id: `${body?.username}@${body?.domain}` }, { status: 201 });
    if (method === "POST" && path === "/webhooks") {
      const address = (body?.inbox_ids as string[])[0];
      return Response.json(
        { webhook_id: `whk_${address.split("@")[0]}`, url: body?.url, event_types: body?.event_types, inbox_ids: body?.inbox_ids, secret: secretFor(address), enabled: true },
        { status: 201 },
      );
    }
    const reply = path.match(/^\/inboxes\/([^/]+)\/messages\/([^/]+)\/reply$/);
    if (method === "POST" && reply) {
      sent += 1;
      return Response.json({ message_id: `msg_out_${sent}`, thread_id: threads.get(decodeURIComponent(reply[2])) ?? "thd_unknown", timestamp: new Date().toISOString() }, { status: 201 });
    }
    return Response.json({ error: { message: `No route for ${method} ${path}` } }, { status: 404 });
  };
  const repliesFrom = (inbox: string) => requests.filter((request) => request.method === "POST" && request.url.includes(`/inboxes/${encodeURIComponent(inbox)}/messages/`) && request.url.endsWith("/reply"));
  return { fetchImpl, requests, threads, repliesFrom };
}

type Fake = ReturnType<typeof fakeMachineMail>;

let counter = 0;

function message(fake: Fake, inbox: string, from: string, subject: string) {
  counter += 1;
  const id = `msg_ws_${counter}`;
  const threadId = `thd_ws_${counter}`;
  fake.threads.set(id, threadId);
  const domain = from.split("@")[1];
  return {
    message_id: id,
    inbox_id: inbox,
    thread_id: threadId,
    labels: ["INBOX", "UNREAD"],
    timestamp: new Date().toISOString(),
    from,
    to: [inbox],
    subject,
    extracted_text: `Please look at ${subject}.`,
    direction: "inbound",
    attachments: [],
    trust_level: "verified",
    trust: {
      level: "verified",
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true },
      content: { text: `Please look at ${subject}.` },
      attachments: [],
      reasons: [],
    },
    authentication_results: { spf: "pass", spf_domain: domain, dkim: "pass", dkim_domain: domain, dmarc: "pass", dmarc_domain: domain },
  };
}

function signed(secret: string, raw: string, eventId: string) {
  const at = Math.floor(Date.now() / 1000);
  return new Headers({ "content-type": "application/json", "x-machinemail-signature": `t=${at},v1=${signPayload(secret, at, raw)}`, "x-machinemail-event-id": eventId });
}

function event(mail: ReturnType<typeof message>) {
  const eventId = `evt_ws_${mail.message_id}`;
  const raw = JSON.stringify({ type: "event", event_id: eventId, event_type: "message.received", data: { message: mail } });
  return { eventId, raw };
}

async function mailRow(messageId: string) {
  return (
    await getAdminPool().query<{ id: string; workspace_id: string; status: string; conversation_id: string | null; user_id: string | null }>(
      "select id, workspace_id, status, conversation_id, user_id from crm.agent_mail_messages where message_id = $1",
      [messageId],
    )
  ).rows[0];
}

function answer(text: string): CompanionResult {
  return { steps: [{ text, calls: [] }], results: {}, sources: [], model: "claude-fable-5-1", usage: null };
}

describe("agent mailboxes in several workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let mac: AuthenticatedCompanion;
  const fake = fakeMachineMail();

  before(async () => {
    process.env.MACHINE_MAIL_API_KEY = "mm_test_key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.SITE_URL = "https://orbit.test";
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.LLM_API_KEY;
    resetStorageBucketCache();
    await resetDatabase();
    const admin = getAdminPool();
    const mark = await createUser(MARK_ECLIPSE, "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    eclipse = { ...mark, workspaceName: "Eclipse" };
    const created = await admin.query<{ id: string }>("select private.create_workspace($1, 'Mark Ridgeon', null) as id", [mark.userId]);
    ridgeon = { ...mark, workspaceId: created.rows[0].id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const { code } = await createPairingCode(eclipse);
    const paired = await redeemPairing(code, "Mark's Mac");
    mac = await authenticateCompanion(new Request("https://orbit.test/api/companion/me", { headers: { authorization: `Bearer ${paired.token}` } }));
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("gives each workspace its own address and never lets one take another's", async () => {
    await setUpAgentMailbox(eclipse, { address: ECLIPSE_BOX }, fake.fetchImpl);
    const before = await agentMailboxView(ridgeon);
    assert.deepEqual([before.workspaceName, before.address, before.placeholder, before.setUp], ["Mark Ridgeon", "", OTHER_WORKSPACE_PLACEHOLDER, false]);

    const calls = fake.requests.length;
    await assert.rejects(
      setUpAgentMailbox(ridgeon, { address: ECLIPSE_BOX }, fake.fetchImpl),
      (error: unknown) => error instanceof CrmError && error.status === 409 && error.message === addressTakenMessage(ECLIPSE_BOX),
    );
    assert.equal(fake.requests.length, calls, "MachineMail is never asked about another workspace's address");

    await setUpAgentMailbox(ridgeon, { address: RIDGEON_BOX }, fake.fetchImpl);
    const views = await Promise.all([agentMailboxView(eclipse), agentMailboxView(ridgeon)]);
    assert.deepEqual(views.map((view) => [view.workspaceName, view.address, view.setUp]), [["Eclipse", ECLIPSE_BOX, true], ["Mark Ridgeon", RIDGEON_BOX, true]]);
    const hooks = fake.requests.filter((request) => request.method === "POST" && request.url.endsWith("/webhooks"));
    assert.deepEqual(hooks.map((request) => request.body?.url), ["https://orbit.test/api/machinemail/webhook", "https://orbit.test/api/machinemail/webhook"]);
  });

  it("keeps allowed senders per mailbox", async () => {
    await saveAgentSenders(ridgeon, [{ address: MARK_RIDGEON, userId: ridgeon.userId }]);
    await assert.rejects(saveAgentSenders(ridgeon, [{ address: ECLIPSE_BOX, userId: ridgeon.userId }]), /another workspace's agent mailbox/);
    const [ours, theirs] = await Promise.all([agentMailboxView(eclipse), agentMailboxView(ridgeon)]);
    assert.deepEqual(ours.senders.map((sender) => sender.address).sort(), [MARK_ECLIPSE, MARK_RIDGEON]);
    assert.deepEqual(theirs.senders.map((sender) => sender.address), [MARK_RIDGEON]);

    const ignored = message(fake, RIDGEON_BOX, MARK_ECLIPSE, "Not on this list");
    const sent = event(ignored);
    const result = await receiveAgentMail(signed(secretFor(RIDGEON_BOX), sent.raw, sent.eventId), sent.raw);
    assert.equal(result.job, undefined);
    assert.equal((await mailRow(ignored.message_id)).status, "ignored");
  });

  it("routes webhook deliveries by inbox and runs each job in its mailbox's workspace", async () => {
    const forged = message(fake, RIDGEON_BOX, MARK_RIDGEON, "Signed by the wrong mailbox");
    const forgedEvent = event(forged);
    const refused = await receiveAgentMail(signed(secretFor(ECLIPSE_BOX), forgedEvent.raw, forgedEvent.eventId), forgedEvent.raw);
    assert.equal(refused.status, 401);

    const toEclipse = message(fake, ECLIPSE_BOX, MARK_ECLIPSE, "Eclipse pipeline");
    const toRidgeon = message(fake, RIDGEON_BOX, MARK_RIDGEON, "Consultancy invoices");
    for (const mail of [toEclipse, toRidgeon]) {
      const sent = event(mail);
      const result = await receiveAgentMail(signed(secretFor(mail.inbox_id), sent.raw, sent.eventId), sent.raw);
      assert.ok(result.job, `${mail.inbox_id} starts a job`);
      assert.equal(result.job.workspaceId, mail.inbox_id === ECLIPSE_BOX ? eclipse.workspaceId : ridgeon.workspaceId);
      await startAgentMailJob(result.job, { fetchImpl: fake.fetchImpl });
    }

    const admin = getAdminPool();
    for (const [mail, workspace] of [[toEclipse, eclipse], [toRidgeon, ridgeon]] as const) {
      const row = await mailRow(mail.message_id);
      assert.equal(row.workspace_id, workspace.workspaceId);
      assert.equal(row.status, "working");
      const conversation = await admin.query<{ workspace_id: string }>("select workspace_id from crm.assistant_conversations where id = $1", [row.conversation_id]);
      assert.equal(conversation.rows[0].workspace_id, workspace.workspaceId);
      const job = await admin.query<{ workspace_id: string }>("select workspace_id from crm.ai_companion_jobs where agent_mail_id = $1", [row.id]);
      assert.equal(job.rows[0].workspace_id, workspace.workspaceId);
    }

    for (let round = 0; round < 2; round += 1) {
      const job = await nextCompanionJob(mac, 5_000);
      assert.ok(job, "Orbit Agent gets both jobs");
      const auth = await companionForJob(mac, job.id);
      await finishCompanionJob(auth, job.id, (actor, conversationId) => applyCompanionResult(actor, conversationId, answer("Done.")));
      await continueAfterCompanion(mac.actor, job.id, { fetchImpl: fake.fetchImpl });
    }
    assert.equal((await mailRow(toEclipse.message_id)).status, "replied");
    assert.equal((await mailRow(toRidgeon.message_id)).status, "replied");
    assert.equal(fake.repliesFrom(ECLIPSE_BOX).filter((request) => request.url.includes(toEclipse.message_id)).length, 1);
    assert.equal(fake.repliesFrom(RIDGEON_BOX).filter((request) => request.url.includes(toRidgeon.message_id)).length, 1);
    assert.deepEqual(fake.repliesFrom(RIDGEON_BOX)[0].body?.to, [MARK_RIDGEON]);
  });

  it("polls every mailbox, so a busy one never starves the other", async () => {
    const missed = new Map<string, ReturnType<typeof message>>();
    const busy = Array.from({ length: FETCHES_PER_MAILBOX + 2 }, (_, index) => message(fake, ECLIPSE_BOX, MARK_ECLIPSE, `Missed ${index}`));
    const quiet = message(fake, RIDGEON_BOX, MARK_RIDGEON, "Missed consultancy job");
    for (const mail of [...busy, quiet]) missed.set(mail.message_id, mail);
    const fetchImpl: typeof fetch = async (input) => {
      const parts = new URL(String(input)).pathname.split("/").map(decodeURIComponent);
      if (parts.at(-1) === "messages") {
        const inbox = parts.at(-2);
        return Response.json({ messages: [...missed.values()].filter((mail) => mail.inbox_id === inbox).map((mail) => ({ message_id: mail.message_id, labels: mail.labels, direction: "inbound" })) });
      }
      const found = missed.get(parts.at(-1) ?? "");
      return found ? Response.json(found) : Response.json({}, { status: 404 });
    };
    const started: { workspaceId: string }[] = [];
    const report = await pollAgentMailboxes({ fetchImpl, start: async (job) => void started.push(job) });
    assert.equal(report.failed, 0);
    assert.equal(report.stored, FETCHES_PER_MAILBOX + 1);
    assert.equal((await mailRow(quiet.message_id)).workspace_id, ridgeon.workspaceId);
    assert.equal(started.filter((job) => job.workspaceId === ridgeon.workspaceId).length, 1);
    assert.equal(started.filter((job) => job.workspaceId === eclipse.workspaceId).length, FETCHES_PER_MAILBOX);

    const failing: typeof fetch = async (input) => {
      const parts = new URL(String(input)).pathname.split("/").map(decodeURIComponent);
      if (parts.at(-2) === ECLIPSE_BOX) return Response.json({ error: { message: "Down" } }, { status: 500 });
      return fetchImpl(input);
    };
    const late = message(fake, RIDGEON_BOX, MARK_RIDGEON, "After the outage");
    missed.set(late.message_id, late);
    const second = await pollAgentMailboxes({ fetchImpl: failing, start: async (job) => void started.push(job) });
    assert.equal(second.failed, 1);
    assert.equal((await mailRow(late.message_id))?.workspace_id, ridgeon.workspaceId);
  });
});
