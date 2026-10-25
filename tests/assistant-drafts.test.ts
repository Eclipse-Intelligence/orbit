import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { systemPrompt } from "@/lib/assistant/prompt";
import { decideActions, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { describeAction, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { saveDraftForAgent, sendForAgent } from "@/lib/mail/compose";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function outlook() {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, url: url.replace(GRAPH, "") });
    if (url.endsWith("/createReply") || url.endsWith("/createReplyAll")) return Response.json({ id: "draft-1", subject: "RE: Pulse", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
    if (method === "POST" && url.endsWith("/me/messages")) return Response.json({ id: "draft-2", subject: "Pulse in ChatGPT" }, { status: 201 });
    if (method === "PATCH") return Response.json({ id: "draft-1" });
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    return Response.json({
      value: url.includes("token=")
        ? []
        : [
            {
              id: "m-1",
              conversationId: "conv-1",
              subject: "Pulse",
              bodyPreview: "Thanks for the call",
              body: { contentType: "text", content: "Thanks for the call." },
              from: { emailAddress: { name: "Andrew Sanaghan", address: "andrew@pulse.test" } },
              toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
              receivedDateTime: "2026-10-19T09:00:00Z",
              isRead: true,
            },
          ],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
    });
  };
  return { fetchImpl, calls };
}

describe("assistant drafts", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("drafts@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
  });

  after(async () => {
    await getPool().end();
  });

  it("offers a draft tool that needs approval and tells the assistant mail lives in Orbit", () => {
    const tool = toolDefinitions().find((item) => item.function.name === "save_email_draft");
    assert.ok(tool);
    assert.match(describeAction("save_email_draft", { subject: "Pulse in ChatGPT", to: ["andrew@pulse.test"], body: "Hi Andrew" }).lines.join("\n"), /Nothing is sent/);
    const prompt = systemPrompt(owner, { webSearch: false });
    assert.match(prompt, /call send_email with the finished email/);
    assert.match(prompt, /never say you can't send/);
    assert.match(describeAction("send_email", { replyToEmailId: "x", body: "Hi Andrew" }).lines.join("\n"), /To: the sender[\s\S]*Sends from Orbit Mail when you approve/);
    assert.equal(toolDefinitions().find((item) => item.function.name === "send_email") !== undefined, true);
    assert.match(prompt, /Never tell the user to paste an email into Outlook/);
    assert.ok(!/the Outlook inbox/.test(prompt));
  });

  it("saves a reply in the conversation and a new email, and sends neither", async () => {
    const messageId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
    const { fetchImpl, calls } = outlook();
    const reply = await saveDraftForAgent(owner, { replyTo: messageId, to: ["andrew@pulse.test"], body: "Hi Andrew,\n\nShall I run it?\n\nMark" }, { origin: null, fetchImpl });
    assert.match(reply.href, /^\/mail\?thread=/);
    assert.equal(reply.draft.mode, "reply");
    const fresh = await saveDraftForAgent(owner, { to: ["andrew@pulse.test"], subject: "Pulse in ChatGPT", body: "Hi Andrew" }, { origin: null, fetchImpl });
    assert.equal(fresh.href, "/mail?view=drafts");
    assert.equal(fresh.draft.subject, "Pulse in ChatGPT");
    assert.ok(!calls.some((call) => call.url.endsWith("/send")));
    const stored = await getAdminPool().query<{ count: number }>("select count(*)::int as count from crm.mail_drafts");
    assert.equal(stored.rows[0].count, 2);
    await assert.rejects(() => saveDraftForAgent(owner, { from: "someone@else.test", to: ["andrew@pulse.test"], subject: "x", body: "y" }, { origin: null, fetchImpl }), /You can't send from someone@else.test/);
  });

  it("sends a reply to the original sender once approved, and lists the addresses it can send from", async () => {
    const messageId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
    const { fetchImpl, calls } = outlook();
    const sent = await sendForAgent(owner, { replyTo: messageId, to: [], body: "Hi Andrew,\n\nYes, let's run it.\n\nMark" }, { origin: null, fetchImpl, saveSent: async () => undefined });
    assert.deepEqual(sent.to, ["andrew@pulse.test"]);
    assert.match(sent.href, /^\/mail\?thread=/);
    assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/send")));
    const listed = (await runTool(owner, "list_email_senders", {})) as { senders: { email: string; primary: boolean }[] };
    assert.deepEqual(listed.senders, [{ email: "mark@eclipse.test", primary: true }]);
  });

  it("offers Confirm and send on a draft, which sends it instead of saving it", async () => {
    process.env.LLM_API_KEY = "llm-test";
    const replies = [
      { tool_calls: [{ id: "call_draft", type: "function", function: { name: "save_email_draft", arguments: JSON.stringify({ to: ["andrew@pulse.test"], subject: "Pilot", body: "Hi Andrew,\n\nShall we start the pilot on Monday?\n\nMark" }) } }] },
      { content: "Sent it to Andrew." },
    ];
    const model: typeof fetch = async () =>
      Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "", ...replies.shift() } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Email Andrew about the pilot", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, (event) => events.push(event), { deadline: Date.now() + 60_000, fetchImpl: model });
    const proposed = events.filter((event): event is Extract<AssistantEvent, { type: "actions" }> => event.type === "actions").at(-1)!;
    assert.deepEqual(proposed.actions[0].alternative, { key: "send", label: "Confirm and send" });
    const conversationId = (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const { fetchImpl, calls } = outlook();
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const decided: AssistantEvent[] = [];
    try {
      await decideActions(owner, { conversationId, decisions: [{ id: "call_draft", approve: true, variant: "send" }] }, (event) => decided.push(event), { deadline: Date.now() + 60_000, fetchImpl: model });
    } finally {
      globalThis.fetch = original;
      delete process.env.LLM_API_KEY;
    }
    assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/send")));
    const final = decided.filter((event): event is Extract<AssistantEvent, { type: "actions" }> => event.type === "actions").at(-1)!.actions[0];
    assert.equal(final.status, "done");
    assert.equal(final.chose, "send");
    assert.equal(final.title, "Sent: Pilot");
    assert.ok(final.lines.includes("Sent from Orbit Mail instead of saving a draft."));
    const toolMessage = (await getAdminPool().query<{ content: string }>("select content from crm.assistant_messages where tool_call_id = 'call_draft'")).rows[0].content;
    assert.match(toolMessage, /"sent":true/);
    assert.match(toolMessage, /The user chose Confirm and send, so this ran send_email instead of save_email_draft/);
  });
});
