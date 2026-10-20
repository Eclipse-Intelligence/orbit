import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { askMail, draftWithAi, stripQuoted, summariseThread } from "@/lib/mail/ai";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: "conv-renewal",
    subject: "Renewal pricing",
    bodyPreview: "",
    body: { contentType: "text", content: "Can we agree the renewal at £12,000 by Friday?\n\nOn Mon, Mark wrote:\n> old quoted text" },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: "2026-10-01T09:00:00Z",
    receivedDateTime: "2026-10-01T09:00:05Z",
    isRead: true,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function mailbox(state: { inbox: unknown[]; sent: unknown[] }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    return Response.json({ value: folder ? (pages[folder] ?? []) : [], "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
}

function model(replies: unknown[]) {
  const prompts: { system: string; user: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push({ system: body.messages[0].content, user: body.messages[1].content });
    const reply = replies.shift();
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, prompts };
}

describe("mail AI", () => {
  let owner: UserActor;
  let renewal: string;
  let latestId: string;

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    await resetDatabase();
    owner = await createUser("ai@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test", jobTitle: "CFO" });
    await syncMail(owner, {
      budgetMs: 30_000,
      fetchImpl: mailbox({
        inbox: [
          message("m-1"),
          message("m-2", { conversationId: "conv-hi", subject: "Hi", body: { contentType: "text", content: "Thanks!" }, receivedDateTime: "2026-09-01T09:00:00Z" }),
        ],
        sent: [
          message("s-2", {
            from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
            toRecipients: [{ emailAddress: { name: "Jane Doe", address: "jane@acme.test" } }],
            body: { contentType: "text", content: "Thanks Jane. Let me check with the team and come back to you." },
            receivedDateTime: "2026-09-30T09:00:00Z",
          }),
          message("s-1", {
            conversationId: "conv-old",
            subject: "Catch up",
            from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
            body: { contentType: "text", content: "Hi Sam,\n\nGreat to catch up today. I'll send the deck over tomorrow.\n\nCheers,\nMark" },
            receivedDateTime: "2026-09-02T09:00:00Z",
          }),
        ],
      }),
    });
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    renewal = inbox.threads.find((thread) => thread.subject === "Renewal pricing")!.key;
    latestId = inbox.threads.find((thread) => thread.subject === "Renewal pricing")!.latestId;
  });

  after(async () => {
    delete process.env.LLM_API_KEY;
    await getPool().end();
  });

  it("drops quoted history from emails", () => {
    assert.equal(stripQuoted("Sounds good.\n\nOn Tue, 1 Oct 2026, Jane wrote:\n> earlier"), "Sounds good.");
    assert.equal(stripQuoted("Yes\n\nFrom: Jane Doe <jane@acme.test>\nSent: Monday"), "Yes");
    assert.equal(stripQuoted("No quotes here"), "No quotes here");
  });

  it("summarises a conversation once and reuses it until new mail arrives", async () => {
    const first = model([{ summary: "Jane wants to agree the renewal at £12,000 \u2014 by Friday.", todo: "Reply to Jane about the renewal" }]);
    const summary = await summariseThread(owner, renewal, { fetchImpl: first.fetchImpl });
    assert.deepEqual(summary, { summary: "Jane wants to agree the renewal at £12,000, by Friday.", todo: "Reply to Jane about the renewal" });
    assert.ok(first.prompts[0].user.includes("£12,000"));
    assert.ok(!first.prompts[0].user.includes("old quoted text"));
    const again = model([]);
    assert.deepEqual(await summariseThread(owner, renewal, { fetchImpl: again.fetchImpl }), summary);
    assert.equal(again.prompts.length, 0);
  });

  it("skips summaries for a single short email", async () => {
    const inbox = await listThreads(owner, { view: { role: "inbox" } });
    const short = inbox.threads.find((thread) => thread.subject === "Hi")!.key;
    const fake = model([]);
    assert.equal(await summariseThread(owner, short, { fetchImpl: fake.fetchImpl }), null);
    assert.equal(fake.prompts.length, 0);
  });

  it("drafts a reply with the thread, what the CRM knows and the user's own voice", async () => {
    const fake = model([{ body: "Hi Jane,\n\nYes, £12,000 works \u2014 I'll confirm by Friday.\n\nMark" }]);
    const result = await draftWithAi(
      owner,
      { mode: "reply", messageId: latestId, to: [{ address: "jane@acme.test", name: "Jane Doe" }], subject: "RE: Renewal pricing", instruction: "yes, agree", current: "" },
      { fetchImpl: fake.fetchImpl },
    );
    assert.equal(result.body, "Hi Jane,\n\nYes, £12,000 works, I'll confirm by Friday.\n\nMark");
    const prompt = fake.prompts[0];
    assert.ok(prompt.system.includes("You write emails as Mark Ridgeon"));
    assert.ok(prompt.user.includes("Instruction: yes, agree"));
    assert.ok(prompt.user.includes("Jane Doe <jane@acme.test>, CFO"));
    assert.ok(prompt.user.includes("I'll send the deck over tomorrow"));
    assert.ok(prompt.user.includes("Can we agree the renewal"));
  });

  it("answers a question from the right emails and links them", async () => {
    const fake = model([
      { queries: ["renewal price", "renewal OR pricing"], from: "jane", after: null, before: null },
      { answer: "Jane asked to agree the renewal at £12,000 by Friday.", sources: [1, 9] },
    ]);
    const answer = await askMail(owner, { question: "What price did Jane want for the renewal?" }, { fetchImpl: fake.fetchImpl });
    assert.equal(answer.answer, "Jane asked to agree the renewal at £12,000 by Friday.");
    assert.deepEqual(answer.sources.map((source) => [source.key, source.from]), [[renewal, "Jane Doe"]]);
    assert.ok(fake.prompts[1].user.includes("[1] From: Jane Doe"));
  });

  it("says so when nothing matches", async () => {
    const fake = model([{ queries: ["zebra migration"], from: null, after: null, before: null }]);
    const answer = await askMail(owner, { question: "Any news on zebras?" }, { fetchImpl: fake.fetchImpl });
    assert.equal(answer.sources.length, 0);
    assert.match(answer.answer, /couldn't find/);
    assert.equal(fake.prompts.length, 1);
  });
});
