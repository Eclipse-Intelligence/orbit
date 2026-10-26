import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getConversation, history, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { APPROVAL_NOTE, EXTERNAL_NOTICE, dropStrayNulls, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

function outlook() {
  const calls: { method: string; url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, url: url.replace(GRAPH, ""), body: String(init?.body ?? "") });
    if (url.endsWith("/createReply") || url.endsWith("/createReplyAll")) return Response.json({ id: "draft-1", subject: "RE: Pulse", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
    if (method === "POST" && url.endsWith("/me/messages")) return Response.json({ id: "draft-2", subject: "Pulse" }, { status: 201 });
    if (method === "PATCH" || method === "POST") return Response.json({ id: "m-1" });
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
              isRead: false,
            },
          ],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
    });
  };
  return { fetchImpl, calls };
}

function londonIn(days: number) {
  const at = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

type Row = Parameters<typeof history>[0][number];

function row(role: Row["role"], content: string, extra: Partial<Row> = {}): Row {
  return { id: crypto.randomUUID(), role, content, tool_calls: null, tool_call_id: null, tool_name: null, actions: null, sources: null, provider_state: null, created_at: new Date(), ...extra };
}

describe("assistant safety and limits", () => {
  let owner: UserActor;
  let messageId: string;
  const realFetch = globalThis.fetch;

  before(async () => {
    await resetDatabase();
    owner = await createUser("safety@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    messageId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    delete process.env.LLM_API_KEY;
    await getPool().end();
  });

  it("tells the model which tools need approval and points workflow builders at the guide", async () => {
    const definitions = toolDefinitions();
    const send = definitions.find((tool) => tool.function.name === "send_email")!;
    const search = definitions.find((tool) => tool.function.name === "search_email")!;
    assert.ok(send.function.description.endsWith(APPROVAL_NOTE));
    assert.ok(!search.function.description.includes(APPROVAL_NOTE));
    const create = definitions.find((tool) => tool.function.name === "create_workflow")!;
    assert.match(create.function.description, /workflow_guide/);
    assert.ok(create.function.description.length < 2_000);
    const guide = (await runTool(owner, "workflow_guide", {})) as { guide: string };
    assert.ok(guide.guide.length > 1_000);
    assert.ok(definitions.some((tool) => tool.function.name === "get_capture"));
    assert.ok(!definitions.some((tool) => tool.function.name === "get_inbox"));
  });

  it("drops nulls the model sends for optional fields, but keeps them where null means clear", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        dueAt: { type: "string", description: "When it's due, or null to clear it." },
        attendees: { type: "array", items: { type: "object", properties: { email: { type: "string" }, name: { type: "string" } } } },
      },
    };
    assert.deepEqual(dropStrayNulls({ title: null, dueAt: null, attendees: [{ email: "a@b.c", name: null }] }, schema), {
      dueAt: null,
      attendees: [{ email: "a@b.c" }],
    });
  });

  it("marks outside content so the model treats it as information", async () => {
    const found = (await runTool(owner, "search_email", { query: "Pulse" })) as { notice?: string };
    assert.equal(found.notice, EXTERNAL_NOTICE);
    const tags = (await runTool(owner, "list_tags", {})) as { notice?: string };
    assert.equal(tags.notice, undefined);
  });

  it("marks a conversation read, and sets a reminder if nobody replies", async () => {
    const { fetchImpl, calls } = outlook();
    globalThis.fetch = fetchImpl;
    try {
      const read = (await runTool(owner, "mail_action", { emailIds: [messageId, messageId], action: "read", summary: "Mark Pulse read" })) as { changed: number };
      assert.equal(read.changed, 1);
      assert.ok(calls.some((call) => call.method === "PATCH" && call.body.includes('"isRead":true')));
      const stored = await getAdminPool().query<{ is_read: boolean }>("select is_read from crm.mail_messages where id = $1", [messageId]);
      assert.equal(stored.rows[0].is_read, true);

      const missing = (await runTool(owner, "mail_action", { emailIds: [messageId], action: "remind_if_no_reply", summary: "Nudge" })) as { error?: string };
      assert.match(missing.error ?? "", /Give until/);
      const reminded = (await runTool(owner, "mail_action", { emailIds: [messageId], action: "remind_if_no_reply", until: londonIn(3), summary: "Nudge" })) as { changed: number };
      assert.equal(reminded.changed, 1);
      await runTool(owner, "mail_action", { emailIds: [messageId], action: "remind_if_no_reply", until: londonIn(5), summary: "Nudge later" });
      const reminders = await getAdminPool().query<{ state: string; due_at: Date }>(
        "select state, due_at from crm.mail_reminders where user_id = $1 and kind = 'follow_up' order by created_at",
        [owner.userId],
      );
      assert.deepEqual(reminders.rows.map((reminder) => reminder.state), ["done", "waiting"]);
      assert.ok(Math.abs(reminders.rows[1].due_at.getTime() - (Date.now() + 5 * 86_400_000)) < 120_000);

      const unknown = (await runTool(owner, "mail_action", { emailIds: ["00000000-0000-0000-0000-000000000000"], action: "archive", summary: "Archive" })) as { error?: string };
      assert.ok(unknown.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sets a reminder when an email it sends gets no reply", async () => {
    const { fetchImpl, calls } = outlook();
    globalThis.fetch = fetchImpl;
    try {
      await getAdminPool().query("update crm.mail_reminders set state = 'done' where user_id = $1", [owner.userId]);
      const sent = (await runTool(owner, "send_email", { replyToEmailId: messageId, body: "Hi Andrew,\n\nAny thoughts?\n\nMark", remindAfterDays: 2 })) as { error?: string };
      assert.equal(sent.error, undefined);
      assert.ok(calls.some((call) => call.url.endsWith("/send")));
      const reminders = await getAdminPool().query<{ due_at: Date }>("select due_at from crm.mail_reminders where user_id = $1 and kind = 'follow_up' and state = 'waiting'", [owner.userId]);
      assert.equal(reminders.rows.length, 1);
      assert.ok(Math.abs(reminders.rows[0].due_at.getTime() - (Date.now() + 2 * 86_400_000)) < 120_000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps long histories inside the budget and clips old tool results", () => {
    const big = "x".repeat(10_000);
    const rows: Row[] = [
      row("user", "First question"),
      row("assistant", "", { tool_calls: [{ id: "t1", type: "function", function: { name: "search_email", arguments: "{}" } }] }),
      row("tool", big, { tool_call_id: "t1", tool_name: "search_email" }),
      row("assistant", "First answer"),
      row("user", "Second question"),
      row("assistant", "", { tool_calls: [{ id: "t2", type: "function", function: { name: "search_email", arguments: "{}" } }] }),
      row("tool", big, { tool_call_id: "t2", tool_name: "search_email" }),
    ];
    const full = history(rows);
    const old = full[2] as { content: string };
    const current = full[6] as { content: string };
    assert.ok(old.content.length < 5_000);
    assert.match(old.content, /Cut \d[\d,]* characters/);
    assert.equal(current.content, big);

    const trimmed = history(rows, 12_000);
    assert.equal(trimmed[0].role, "user");
    assert.match(String(trimmed[0].content), /^\(Earlier parts of this conversation were left out/);
    assert.match(String(trimmed[0].content), /Second question$/);
    assert.equal(trimmed.length, 3);
  });

  it("retries the model once when the gateway is briefly unavailable", async () => {
    process.env.LLM_API_KEY = "llm-test";
    let attempts = 0;
    const flaky: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) return new Response("busy", { status: 503 });
      return Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "Here you go." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Hello", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: Date.now() + 120_000, fetchImpl: flaky });
    assert.equal(attempts, 2);
    assert.ok(events.some((event) => event.type === "message" && event.message.content === "Here you go."));
  });

  it("saves a failed turn as a reply so the conversation still makes sense", async () => {
    process.env.LLM_API_KEY = "llm-test";
    const broken: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    const events: AssistantEvent[] = [];
    await sendMessage(owner, { message: "Hello again", model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), { deadline: Date.now() + 120_000, fetchImpl: broken });
    const conversationId = (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
    const saved = await getConversation(owner, conversationId);
    assert.deepEqual(saved.messages.map((message) => message.role), ["user", "assistant"]);
    assert.match(saved.messages[1].content, /^I couldn't finish that\. The LLM gateway returned 400/);
  });
});
