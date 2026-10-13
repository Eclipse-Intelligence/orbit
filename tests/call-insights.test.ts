import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import {
  acceptActionItem,
  dismissActionItem,
  dueAtForDay,
  getInsightsForActivities,
  getInsightTranscript,
  resolveDueDate,
  summariseCall,
  transcriptToText,
} from "@/lib/crm/call-insights";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { extractJson } from "@/lib/llm";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-llm-key";
  delete process.env.LLM_MODEL;
  delete process.env.LLM_API_BASE_URL;
});

after(async () => {
  await getPool().end();
});

const VTT = `WEBVTT

0f6f1c3e-1/12-0
00:00:01.000 --> 00:00:03.500
<v Mark Ridgeon>Hi Jane, thanks for making time.</v>

0f6f1c3e-1/13-0
00:00:03.500 --> 00:00:05.000
<v Mark Ridgeon>Shall we go through the quote?</v>

0f6f1c3e-2/1-0
00:00:05.000 --> 00:00:09.000
<v Jane Doe>Yes. I&#39;ll send the signed order form by Friday &amp; loop in finance.</v>

0f6f1c3e-3/1-0
00:00:09.000 --> 00:00:11.000
<v Mark Ridgeon>Great, I&apos;ll send the revised quote tomorrow.</v>
`;

type Reply = { status?: number; content?: string; body?: unknown } | Error;

function gateway(replies: Reply[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (reply.body !== undefined) return Response.json(reply.body, { status: reply.status ?? 200 });
    return Response.json(
      {
        model: "claude-haiku-5-5",
        choices: [{ message: { role: "assistant", content: reply.content ?? "" }, finish_reason: "stop" }],
      },
      { status: reply.status ?? 200 },
    );
  };
  return { fetchImpl, requests };
}

const GOOD = {
  summary: "Mark and Jane reviewed the Acme quote. Jane is ready to sign once finance is involved.",
  keyPoints: ["Jane is happy with the quote", "- Finance needs to approve"],
  actionItems: [
    { title: "Send the revised quote", owner: "me", dueDate: "2026-10-16" },
    { title: "Jane to send the signed order form", owner: "them", dueDate: "Friday" },
    { title: "Book a follow-up", owner: null, dueDate: null },
  ],
};

async function setup(email: string) {
  const owner = await createUser(email, "Mark Ridgeon");
  const company = await createCompany(owner, {
    name: `Acme ${email}`,
    domain: `${email.split("@")[0]}.acme.test`,
  });
  const contact = await createContact(owner, {
    companyId: company.body.company.id,
    firstName: "Jane",
    lastName: "Doe",
    jobTitle: "Buyer",
  });
  const call = await createActivity(owner, {
    type: "call",
    title: "Call with Jane Doe",
    body: "Outgoing call · 11 s",
    contactId: contact.body.contact.id,
    companyId: company.body.company.id,
    occurredAt: "2026-10-15T13:00:00.000Z",
  });
  return {
    owner,
    companyId: company.body.company.id,
    contactId: contact.body.contact.id,
    callId: call.body.activity.id,
  };
}

async function readyInsight(owner: UserActor, callId: string) {
  const { fetchImpl } = gateway([{ content: "```json\n" + JSON.stringify(GOOD) + "\n```" }]);
  return summariseCall(owner, callId, VTT, { source: "manual", fetchImpl });
}

describe("call insights", () => {
  it("turns Teams VTT into compact speaker lines and passes plain text through", () => {
    assert.equal(
      transcriptToText(VTT),
      [
        "Mark Ridgeon: Hi Jane, thanks for making time. Shall we go through the quote?",
        "Jane Doe: Yes. I'll send the signed order form by Friday & loop in finance.",
        "Mark Ridgeon: Great, I'll send the revised quote tomorrow.",
      ].join("\n"),
    );
    assert.equal(
      transcriptToText("WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nNo speaker here\r\n\r\n00:00:02.000 --> 00:00:03.000\r\n<v.loud Raj>Hello</v>\r\n"),
      "No speaker here\nRaj: Hello",
    );
    assert.equal(transcriptToText("  Me: hello\nThem: hi there  \n"), "Me: hello\nThem: hi there");
  });

  it("parses JSON wrapped in code fences or prose", () => {
    assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go: {"a": {"b": 2}} Thanks.'), { a: { b: 2 } });
    assert.throws(() => extractJson("no json at all"));
  });

  it("resolves relative due dates against the London call date", () => {
    const thursday = "2026-10-15T13:00:00.000Z";
    assert.equal(resolveDueDate("2026-10-20", thursday), "2026-10-20");
    assert.equal(resolveDueDate("2026-02-30", thursday), null);
    assert.equal(resolveDueDate("tomorrow", thursday), "2026-10-16");
    assert.equal(resolveDueDate("Friday", thursday), "2026-10-16");
    assert.equal(resolveDueDate("by next Thursday", thursday), "2026-10-22");
    assert.equal(resolveDueDate("next week", thursday), "2026-10-19");
    assert.equal(resolveDueDate("end of the week", thursday), "2026-10-16");
    assert.equal(resolveDueDate("in 3 days", thursday), "2026-10-18");
    assert.equal(resolveDueDate("end of month", thursday), "2026-10-31");
    assert.equal(resolveDueDate("soon", thursday), null);
    assert.equal(resolveDueDate("tomorrow", "2026-10-15T23:30:00.000Z"), "2026-10-17");
    assert.equal(dueAtForDay("2026-10-16"), "2026-10-16T08:00:00.000Z");
    assert.equal(dueAtForDay("2026-10-26"), "2026-10-26T09:00:00.000Z");
  });

  it("summarises a pasted transcript through the gateway", async () => {
    const { owner, callId, contactId, companyId } = await setup("summary@example.com");
    const { fetchImpl, requests } = gateway([
      { content: "```json\n" + JSON.stringify(GOOD) + "\n```" },
    ]);
    const insight = await summariseCall(owner, callId, VTT, { source: "manual", fetchImpl });
    assert.equal(insight.status, "ready");
    assert.equal(insight.error, null);
    assert.equal(insight.summary, GOOD.summary);
    assert.deepEqual(insight.keyPoints, ["Jane is happy with the quote", "Finance needs to approve"]);
    assert.equal(insight.contactId, contactId);
    assert.equal(insight.companyId, companyId);
    assert.equal(insight.model, "claude-haiku-5-5");
    assert.equal(insight.source, "manual");
    assert.deepEqual(
      insight.actionItems.map(({ title, owner: who, dueDate, status, taskId }) => ({
        title,
        owner: who,
        dueDate,
        status,
        taskId,
      })),
      [
        { title: "Send the revised quote", owner: "me", dueDate: "2026-10-16", status: "suggested", taskId: null },
        { title: "Jane to send the signed order form", owner: "them", dueDate: "2026-10-16", status: "suggested", taskId: null },
        { title: "Book a follow-up", owner: null, dueDate: null, status: "suggested", taskId: null },
      ],
    );

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, "https://api.llmapi.ai/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-llm-key");
    assert.equal(request.body.model, "claude-haiku-5-5");
    assert.equal(request.body.max_tokens, 4000);
    assert.equal("temperature" in request.body, false);
    const messages = request.body.messages as { role: string; content: string }[];
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /British English/);
    assert.match(messages[1].content, /Thursday, 15 October 2026 \(2026-10-15\), London time/);
    assert.match(messages[1].content, /"me"\): Mark Ridgeon/);
    assert.match(messages[1].content, /Jane Doe \(Buyer\) at Acme/);
    assert.match(messages[1].content, /Jane Doe: Yes\. I'll send the signed order form/);

    const again = await summariseCall(owner, callId, VTT, { fetchImpl });
    assert.equal(again.id, insight.id);
    assert.equal(requests.length, 1);
    await assert.rejects(
      summariseCall(owner, callId, "Something else entirely", { fetchImpl }),
      /already has a transcript/,
    );
    assert.equal(await getInsightTranscript(owner, insight.id), transcriptToText(VTT));
    const listed = await getInsightsForActivities(owner, [callId, "not-a-uuid"]);
    assert.equal(listed[callId]?.id, insight.id);
    assert.equal(listed[callId]?.transcriptLength, transcriptToText(VTT).length);
  });

  it("retries invalid JSON once, then stores the failure", async () => {
    const { owner, callId } = await setup("invalid@example.com");
    const failing = gateway([{ content: "Sorry, I cannot do that." }]);
    const failed = await summariseCall(owner, callId, "Me: hello\nThem: bye", {
      fetchImpl: failing.fetchImpl,
    });
    assert.equal(failing.requests.length, 2);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /did not return JSON/);
    assert.equal(failed.summary, null);
    const stored = await getInsightsForActivities(owner, [callId]);
    assert.equal(stored[callId]?.status, "failed");

    const recovering = gateway([
      { content: '{"summary": 3}' },
      { content: JSON.stringify(GOOD) },
    ]);
    const ready = await summariseCall(owner, callId, "", { fetchImpl: recovering.fetchImpl });
    assert.equal(recovering.requests.length, 2);
    assert.equal(ready.id, failed.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.error, null);
    assert.equal(ready.actionItems.length, 3);
  });

  it("retries a gateway 5xx once and reports gateway errors and a missing key", async () => {
    const { owner, callId } = await setup("gateway@example.com");
    const flaky = gateway([
      { status: 502, body: { error: { message: "upstream unavailable" } } },
      { content: JSON.stringify(GOOD) },
    ]);
    const ready = await summariseCall(owner, callId, "Me: hello", { fetchImpl: flaky.fetchImpl });
    assert.equal(flaky.requests.length, 2);
    assert.equal(ready.status, "ready");

    const second = await setup("gateway-two@example.com");
    const denied = gateway([{ status: 401, body: { error: { message: "invalid api key" } } }]);
    const failed = await summariseCall(second.owner, second.callId, "Me: hello", {
      fetchImpl: denied.fetchImpl,
    });
    assert.equal(denied.requests.length, 1);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /returned 401: invalid api key/);

    const third = await setup("gateway-three@example.com");
    const offline = gateway([new TypeError("fetch failed")]);
    const unreachable = await summariseCall(third.owner, third.callId, "Me: hello", {
      fetchImpl: offline.fetchImpl,
    });
    assert.equal(offline.requests.length, 2);
    assert.match(unreachable.error ?? "", /Could not reach the LLM gateway/);

    const fourth = await setup("gateway-four@example.com");
    delete process.env.LLM_API_KEY;
    const unused = gateway([{ content: JSON.stringify(GOOD) }]);
    const missing = await summariseCall(fourth.owner, fourth.callId, "Me: hello", {
      fetchImpl: unused.fetchImpl,
    });
    assert.equal(unused.requests.length, 0);
    assert.equal(missing.status, "failed");
    assert.equal(missing.error, "Set LLM_API_KEY to summarise calls.");
  });

  it("accepts a suggested action as a next action exactly once", async () => {
    const { owner, callId, contactId, companyId } = await setup("accept@example.com");
    const insight = await readyInsight(owner, callId);
    const item = insight.actionItems[0];
    const accepted = await acceptActionItem(owner, insight.id, item.id);
    assert.ok(accepted.task);
    assert.equal(accepted.task.title, "Send the revised quote");
    assert.equal(accepted.task.contactId, contactId);
    assert.equal(accepted.task.companyId, companyId);
    assert.equal(accepted.task.dueAt, "2026-10-16T08:00:00.000Z");
    assert.match(accepted.task.description ?? "", /From the call on 15 Oct 2026: Call with Jane Doe/);
    const saved = accepted.insight.actionItems.find((entry) => entry.id === item.id);
    assert.equal(saved?.status, "accepted");
    assert.equal(saved?.taskId, accepted.task.id);

    const repeat = await acceptActionItem(owner, insight.id, item.id);
    assert.equal(repeat.task, null);
    assert.equal(
      repeat.insight.actionItems.find((entry) => entry.id === item.id)?.taskId,
      accepted.task.id,
    );
    const tasks = await listTasks(owner, { companyId, view: "none" });
    assert.equal(tasks.data.filter((task) => task.title === "Send the revised quote").length, 1);

    const undated = insight.actionItems[2];
    const noDate = await acceptActionItem(owner, insight.id, undated.id, { title: "Book a follow-up call" });
    assert.equal(noDate.task?.dueAt, null);
    assert.equal(noDate.task?.title, "Book a follow-up call");

    await assert.rejects(
      acceptActionItem(owner, insight.id, "missing-item"),
      /Suggested action not found/,
    );
  });

  it("dismisses a suggested action idempotently and leaves accepted ones alone", async () => {
    const { owner, callId, companyId } = await setup("dismiss@example.com");
    const insight = await readyInsight(owner, callId);
    const [first, second] = insight.actionItems;
    const dismissed = await dismissActionItem(owner, insight.id, second.id);
    assert.equal(dismissed.actionItems.find((entry) => entry.id === second.id)?.status, "dismissed");
    const again = await dismissActionItem(owner, insight.id, second.id);
    assert.equal(again.actionItems.find((entry) => entry.id === second.id)?.status, "dismissed");
    await acceptActionItem(owner, insight.id, first.id);
    const kept = await dismissActionItem(owner, insight.id, first.id);
    assert.equal(kept.actionItems.find((entry) => entry.id === first.id)?.status, "accepted");
    const tasks = await listTasks(owner, { companyId, view: "none" });
    assert.equal(tasks.data.length, 1);
  });

  it("keeps insights inside the workspace", async () => {
    const { owner, callId } = await setup("isolation@example.com");
    const insight = await readyInsight(owner, callId);
    const other = await createUser("intruder@example.com", "Intruder");
    const { fetchImpl, requests } = gateway([{ content: JSON.stringify(GOOD) }]);
    await assert.rejects(summariseCall(other, callId, "Me: hi", { fetchImpl }), /Call not found/);
    assert.equal(requests.length, 0);
    await assert.rejects(
      acceptActionItem(other, insight.id, insight.actionItems[0].id),
      /Call summary not found/,
    );
    await assert.rejects(
      dismissActionItem(other, insight.id, insight.actionItems[0].id),
      /Call summary not found/,
    );
    await assert.rejects(getInsightTranscript(other, insight.id), /Call summary not found/);
    assert.deepEqual(await getInsightsForActivities(other, [callId]), {});
    assert.deepEqual(
      await queryAsUser(other.userId, "select id from crm.call_insights"),
      [],
    );
    await assert.rejects(
      queryAsUser(owner.userId, "update crm.call_insights set transcript = 'changed'"),
      /permission denied/,
    );
    await assert.rejects(
      queryAsUser(owner.userId, "delete from crm.call_insights"),
      /permission denied/,
    );
    await assert.rejects(
      queryAsUser(
        other.userId,
        `insert into crm.call_insights (workspace_id, activity_id, source, transcript)
         values ($1, $2, 'manual', 'x')`,
        [owner.workspaceId, callId],
      ),
      /row-level security/,
    );

    const reader = await createAgent(owner.workspaceId, ["crm:read"]);
    await assert.rejects(summariseCall(reader.actor, callId, "Me: hi", { fetchImpl }), /activities:write/);
    await assert.rejects(
      acceptActionItem(reader.actor, insight.id, insight.actionItems[0].id),
      /tasks:write/,
    );
    const agent = await createAgent(owner.workspaceId, ["crm:read", "tasks:write"]);
    const accepted = await acceptActionItem(agent.actor, insight.id, insight.actionItems[1].id);
    assert.equal(accepted.task?.createdByAgentId, agent.actor.agentId);
  });

  it("only summarises calls", async () => {
    const { owner, contactId } = await setup("notes@example.com");
    const note = await createActivity(owner, {
      type: "note",
      body: "Not a call",
      contactId,
    });
    const { fetchImpl, requests } = gateway([{ content: JSON.stringify(GOOD) }]);
    await assert.rejects(
      summariseCall(owner, note.body.activity.id, "Me: hi", { fetchImpl }),
      /Only calls can be summarised/,
    );
    await assert.rejects(summariseCall(owner, "not-a-uuid", "Me: hi", { fetchImpl }), /Call not found/);
    assert.equal(requests.length, 0);
    const rows = await getAdminPool().query("select count(*)::int as total from crm.call_insights where activity_id = $1", [
      note.body.activity.id,
    ]);
    assert.equal(rows.rows[0].total, 0);
  });
});
