import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import {
  acceptActionItem,
  dismissActionItem,
  getInsightsForActivities,
  getInsightTranscript,
  getInsightTranscriptPage,
  TRANSCRIPT_PAGE_LENGTH,
  judgeCallSentiment,
  splitTranscript,
  withTranscriptHint,
  resolveDueDate,
  summariseCall,
  transcriptToText,
} from "@/lib/crm/call-insights";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { summarisePendingImports, summariseImport } from "@/lib/crm/conversations";
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
  return summariseCall(owner, callId, VTT, { source: "manual", fetchImpl, autoAccept: false });
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
      insight.actionItems.map(({ title, owner: who, dueDate, status }) => ({
        title,
        owner: who,
        dueDate,
        status,
      })),
      [
        { title: "Send the revised quote", owner: "me", dueDate: "2026-10-16", status: "accepted" },
        { title: "Jane to send the signed order form", owner: "them", dueDate: "2026-10-16", status: "suggested" },
        { title: "Book a follow-up", owner: null, dueDate: null, status: "suggested" },
      ],
    );
    const autoTasks = await getAdminPool().query<{ title: string; contact_id: string | null }>(
      "select title, contact_id from crm.tasks where id = any($1::uuid[]) order by title",
      [insight.actionItems.map((item) => item.taskId).filter(Boolean)],
    );
    assert.deepEqual(
      autoTasks.rows.map((row) => row.title),
      ["Send the revised quote"],
    );
    assert.ok(autoTasks.rows.every((row) => row.contact_id === contactId));

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
    assert.equal(failed.error, "The AI gave an unusable answer. Try again.");
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
    assert.equal(failed.error, "The AI rejected the key.");
    assert.doesNotMatch(failed.error ?? "", /invalid api key|401/);

    const third = await setup("gateway-three@example.com");
    const offline = gateway([new TypeError("fetch failed")]);
    const unreachable = await summariseCall(third.owner, third.callId, "Me: hello", {
      fetchImpl: offline.fetchImpl,
    });
    assert.equal(offline.requests.length, 2);
    assert.equal(unreachable.error, "Couldn't reach the AI. Try again.");

    const fourth = await setup("gateway-four@example.com");
    delete process.env.LLM_API_KEY;
    const unused = gateway([{ content: JSON.stringify(GOOD) }]);
    const missing = await summariseCall(fourth.owner, fourth.callId, "Me: hello", {
      fetchImpl: unused.fetchImpl,
    });
    assert.equal(unused.requests.length, 0);
    assert.equal(missing.status, "failed");
    assert.equal(missing.error, "AI isn't set up.");
  });

  it("accepts a suggested action as a task exactly once", async () => {
    const { owner, callId, contactId, companyId } = await setup("accept@example.com");
    const insight = await readyInsight(owner, callId);
    const item = insight.actionItems[0];
    const accepted = await acceptActionItem(owner, insight.id, item.id);
    assert.ok(accepted.task);
    assert.equal(accepted.task.title, "Send the revised quote");
    assert.equal(accepted.task.contactId, contactId);
    assert.equal(accepted.task.companyId, companyId);
    assert.equal(accepted.task.dueAt, "2026-10-15T23:00:00.000Z");
    assert.equal(accepted.task.dueDate, "2026-10-16");
    assert.equal(accepted.task.dueHasTime, false);
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
      /Only calls and meetings can be summarised/,
    );
    await assert.rejects(summariseCall(owner, "not-a-uuid", "Me: hi", { fetchImpl }), /Call not found/);
    assert.equal(requests.length, 0);
    const rows = await getAdminPool().query("select count(*)::int as total from crm.call_insights where activity_id = $1", [
      note.body.activity.id,
    ]);
    assert.equal(rows.rows[0].total, 0);
  });

  describe("whole transcripts", () => {
    function longTranscript(lines: number) {
      return Array.from(
        { length: lines },
        (_, index) => `${index % 2 ? "Jane Doe" : "Mark Ridgeon"}: marker-${index}-end ${"word ".repeat(40).trim()}`,
      ).join("\n");
    }

    function routed(noteLength: number, failOnPart?: number, shrink = false) {
      const calls: { system: string; user: string }[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { role: string; content: string }[] };
        const system = body.messages[0].content;
        const user = body.messages[1].content;
        calls.push({ system, user });
        let content: string;
        if (/one part of a long call transcript/.test(system)) {
          const part = /^Part (\d+) of/m.exec(user)?.[1];
          if (failOnPart !== undefined && Number(part) === failOnPart) {
            return Response.json({ error: { message: "bad" } }, { status: 400 });
          }
          const length = shrink ? Math.min(noteLength, Math.floor(user.length / 2)) : noteLength;
          content = JSON.stringify({ notes: `Notes on part ${part}. ${"n".repeat(length)}` });
        } else if (/judge how a client relationship stands/.test(system)) {
          content = JSON.stringify({ health: "watch", healthReason: "Finance still has to approve." });
        } else {
          content = JSON.stringify(GOOD);
        }
        return Response.json({
          model: "claude-haiku-5-5",
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        });
      };
      return { fetchImpl, calls };
    }

    const isPart = (call: { system: string }) => /one part of a long call transcript/.test(call.system);

    it("stores a pasted transcript longer than the old limits and summarises every part of it", async () => {
      const { owner, callId } = await setup("whole@example.com");
      const text = longTranscript(5500);
      assert.ok(text.length > 1_200_000);
      const { fetchImpl, calls } = routed(20);
      const insight = await summariseCall(owner, callId, text, { source: "manual", fetchImpl, autoAccept: false });
      assert.equal(insight.status, "ready");
      assert.equal(insight.transcriptLength, text.length);
      assert.equal(await getInsightTranscript(owner, insight.id), text);
      const parts = calls.filter(isPart);
      assert.ok(parts.length >= 9);
      const sent = parts.map((call) => call.user).join("\n");
      for (let index = 0; index < 5500; index += 1) {
        assert.ok(sent.includes(`marker-${index}-end`), `line ${index} reached the model`);
      }
      for (const call of parts) assert.ok(call.user.length < 150_000);
      const final = calls[calls.length - 1];
      assert.ok(!isPart(final));
      assert.match(final.system, /notes, in order, from consecutive parts/);
      assert.match(final.user, new RegExp(`Part ${parts.length} of ${parts.length}:`));
      assert.ok(!final.user.includes("marker-"));
    });

    it("keeps one call for a transcript that fits the window", async () => {
      const { owner, callId } = await setup("fits@example.com");
      const text = longTranscript(400);
      const { fetchImpl, calls } = routed(20);
      const insight = await summariseCall(owner, callId, text, { fetchImpl, autoAccept: false });
      assert.equal(insight.status, "ready");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].user.includes(text));
    });

    it("condenses notes again when they are still too long for one pass", async () => {
      const { owner, callId } = await setup("condense@example.com");
      const text = longTranscript(1500);
      const { fetchImpl, calls } = routed(60_000, undefined, true);
      const insight = await summariseCall(owner, callId, text, { fetchImpl, autoAccept: false });
      assert.equal(insight.status, "ready");
      const final = calls[calls.length - 1];
      assert.ok(!isPart(final));
      assert.ok(final.user.length < 150_000);
      assert.ok(calls.filter(isPart).length > 3);
    });

    it("fails rather than save a summary when the notes cannot be brought down to one pass", async () => {
      const { owner, callId } = await setup("nocondense@example.com");
      const { fetchImpl } = routed(150_000);
      const insight = await summariseCall(owner, callId, longTranscript(1500), { fetchImpl, autoAccept: false });
      assert.equal(insight.status, "failed");
      assert.equal(insight.summary, null);
    });

    it("retries a long call that ran out of time on a later run instead of failing it for good", async () => {
      const { owner, callId, contactId, companyId } = await setup("deadline@example.com");
      const text = longTranscript(1500);
      const admin = getAdminPool();
      const imported = await admin.query<{ id: string }>(
        `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, status, activity_id, contact_id, company_id, transcript)
         values ($1, $2, 'granola', 'deadline-note', 'meeting', 'filed', $3, $4, $5, $6) returning id`,
        [owner.workspaceId, owner.userId, callId, contactId, companyId, text],
      );
      const slow = routed(20);
      const hurried = await summariseImport(owner, imported.rows[0].id, { fetchImpl: slow.fetchImpl, deadline: Date.now() + 3000 });
      assert.equal(hurried?.status, "pending");
      assert.equal(hurried?.error, null);
      assert.equal(slow.calls.length, 0);
      assert.equal(await summarisePendingImports(owner, { fetchImpl: slow.fetchImpl }), 0);
      await admin.query(
        `begin;
         alter table crm.call_insights disable trigger call_insights_set_updated_at;
         update crm.call_insights set updated_at = now() - interval '10 minutes' where activity_id = '${callId}';
         alter table crm.call_insights enable trigger call_insights_set_updated_at;
         commit`,
      );
      const later = routed(20);
      assert.equal(await summarisePendingImports(owner, { fetchImpl: later.fetchImpl, deadline: Date.now() + 120_000 }), 1);
      const [insight] = Object.values(await getInsightsForActivities(owner, [callId]));
      assert.equal(insight.status, "ready");
      assert.equal(await getInsightTranscript(owner, insight.id), text);
    });

    it("runs at most three part calls at a time", async () => {
      const { owner, callId } = await setup("pool@example.com");
      let running = 0;
      let peak = 0;
      const inner = routed(20).fetchImpl;
      const fetchImpl: typeof fetch = async (input, init) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await inner(input, init);
        } finally {
          running -= 1;
        }
      };
      const insight = await summariseCall(owner, callId, longTranscript(5500), { fetchImpl, autoAccept: false });
      assert.equal(insight.status, "ready");
      assert.equal(peak, 3);
    });

    it("asks for a notes reply that fits a small part", async () => {
      const { owner, callId } = await setup("tokens@example.com");
      const seen: number[] = [];
      const inner = routed(20).fetchImpl;
      const fetchImpl: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: { content: string }[] };
        if (/one part of a long call transcript/.test(body.messages[0].content)) seen.push(body.max_tokens);
        return inner(input, init);
      };
      await summariseCall(owner, callId, longTranscript(1500), { fetchImpl, autoAccept: false });
      assert.ok(seen.length >= 3);
      assert.ok(seen.every((tokens) => tokens === 4_000));
    });

    describe("progress across runs", () => {
      async function importFor(owner: UserActor, callId: string, contactId: string, companyId: string, text: string, key: string) {
        const result = await getAdminPool().query<{ id: string }>(
          `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, status, activity_id, contact_id, company_id, transcript)
           values ($1, $2, 'granola', $3, 'meeting', 'filed', $4, $5, $6, $7) returning id`,
          [owner.workspaceId, owner.userId, key, callId, contactId, companyId, text],
        );
        return result.rows[0].id;
      }

      async function makeStale(callId: string) {
        await getAdminPool().query(
          `begin;
           alter table crm.call_insights disable trigger call_insights_set_updated_at;
           update crm.call_insights set updated_at = now() - interval '10 minutes' where activity_id = '${callId}';
           alter table crm.call_insights enable trigger call_insights_set_updated_at;
           commit`,
        );
      }

      async function attemptsOf(importId: string) {
        const result = await getAdminPool().query<{ attempts: number }>("select attempts from crm.conversation_imports where id = $1", [importId]);
        return result.rows[0].attempts;
      }

      async function savedNotes(callId: string) {
        const result = await getAdminPool().query<{ part_notes: { hash: string; levels: (string | null)[][] } | null; status: string }>(
          "select part_notes, status from crm.call_insights where activity_id = $1",
          [callId],
        );
        return result.rows[0];
      }

      function slowGateway(secondsPerCall: number) {
        const inner = routed(20);
        const realNow = Date.now;
        let skew = 0;
        const fetchImpl: typeof fetch = async (input, init) => {
          skew += secondsPerCall * 1000;
          return inner.fetchImpl(input, init);
        };
        return {
          calls: inner.calls,
          fetchImpl,
          withClock: async <T,>(run: (deadline: number) => Promise<T>) => {
            const start = realNow();
            Date.now = () => realNow() + skew;
            try {
              return await run(start + 25_000);
            } finally {
              Date.now = realNow;
              skew = 0;
            }
          },
        };
      }

      it("summarises a many-part call over several short runs, saving progress and reading every line once", async () => {
        const { owner, callId, contactId, companyId } = await setup("progress@example.com");
        const text = longTranscript(2200);
        const total = splitTranscript(text, 40_000).length;
        assert.ok(total >= 12);
        const importId = await importFor(owner, callId, contactId, companyId, text, "progress-note");
        const gateway = slowGateway(4);
        let runs = 0;
        let previous = 0;
        for (;;) {
          runs += 1;
          assert.ok(runs <= 10, "finishes in a bounded number of runs");
          const insight = await gateway.withClock((deadline) => summariseImport(owner, importId, { fetchImpl: gateway.fetchImpl, deadline }));
          if (insight?.status === "ready") break;
          assert.equal(insight?.status, "pending");
          const saved = await savedNotes(callId);
          const done = (saved.part_notes?.levels[0] ?? []).filter((note) => note !== null).length;
          assert.ok(done > previous, "each run saves new notes");
          previous = done;
          assert.ok((await attemptsOf(importId)) < 3);
          await makeStale(callId);
        }
        assert.ok(runs >= 2);
        const partCalls = gateway.calls.filter(isPart);
        assert.equal(partCalls.length, total);
        const sent = partCalls.map((call) => call.user).join("\n");
        for (let index = 0; index < 2200; index += 1) {
          assert.equal(sent.split(`marker-${index}-end`).length - 1, 1, `line ${index} reached a part call exactly once`);
        }
        const final = gateway.calls[gateway.calls.length - 1];
        assert.ok(!isPart(final));
        assert.match(final.user, new RegExp(`Part ${total} of ${total}:`));
        const saved = await savedNotes(callId);
        assert.equal(saved.status, "ready");
        assert.equal(saved.part_notes, null);
        assert.equal(await attemptsOf(importId), 1);
      });

      it("discards saved notes when the transcript changes", async () => {
        const { owner, callId, contactId, companyId } = await setup("changed@example.com");
        const text = longTranscript(1500);
        const importId = await importFor(owner, callId, contactId, companyId, text, "changed-note");
        const gateway = slowGateway(4);
        const first = await gateway.withClock((deadline) => summariseImport(owner, importId, { fetchImpl: gateway.fetchImpl, deadline }));
        assert.equal(first?.status, "pending");
        const before = (await savedNotes(callId)).part_notes;
        assert.ok(before);
        const edited = text.replace("marker-0-end", "marker-0-edited");
        await getAdminPool().query(
          `begin;
           alter table crm.call_insights disable trigger call_insights_set_updated_at;
           update crm.call_insights set transcript = $1, updated_at = now() - interval '10 minutes' where activity_id = $2;
           alter table crm.call_insights enable trigger call_insights_set_updated_at;
           commit`.replace("$1", `'${edited}'`).replace("$2", `'${callId}'`),
        );
        const again = routed(20);
        const done = await summariseImport(owner, importId, { fetchImpl: again.fetchImpl, deadline: Date.now() + 120_000 });
        assert.equal(done?.status, "ready");
        assert.equal(again.calls.filter(isPart).length, splitTranscript(edited, 40_000).length);
        assert.ok(again.calls.some((call) => call.user.includes("marker-0-edited")));
      });

      it("still spends an attempt on a run that saves nothing, so a broken call stops", async () => {
        const { owner, callId, contactId, companyId } = await setup("noprogress@example.com");
        const importId = await importFor(owner, callId, contactId, companyId, longTranscript(1500), "noprogress-note");
        const idle = routed(20);
        for (let run = 1; run <= 3; run += 1) {
          const insight = await summariseImport(owner, importId, { fetchImpl: idle.fetchImpl, deadline: Date.now() + 3000 });
          assert.equal(insight?.status, "pending");
          assert.equal(await attemptsOf(importId), run);
          await makeStale(callId);
        }
        assert.equal(idle.calls.length, 0);
        assert.equal(await summarisePendingImports(owner, { fetchImpl: idle.fetchImpl, deadline: Date.now() + 120_000 }), 0);
        assert.equal(idle.calls.length, 0);
      });
    });

    it("never saves a summary of only part of the call", async () => {
      const { owner, callId } = await setup("partial@example.com");
      const text = longTranscript(1500);
      const { fetchImpl, calls } = routed(20, 2);
      const insight = await summariseCall(owner, callId, text, { fetchImpl, autoAccept: false });
      assert.equal(insight.status, "failed");
      assert.equal(insight.summary, null);
      assert.ok(calls.every(isPart));
      const retry = routed(20);
      const again = await summariseCall(owner, callId, "", { fetchImpl: retry.fetchImpl, autoAccept: false });
      assert.equal(again.status, "ready");
      assert.equal(await getInsightTranscript(owner, again.id), text);
    });

    it("judges the sentiment of a long call from its summary without reading the parts again", async () => {
      const { owner, callId } = await setup("sentiment@example.com");
      const text = longTranscript(1500);
      const first = routed(20);
      const insight = await summariseCall(owner, callId, text, { fetchImpl: first.fetchImpl, autoAccept: false });
      assert.equal(insight.sentiment, null);
      const judging = routed(20);
      const judged = await judgeCallSentiment(owner, callId, { fetchImpl: judging.fetchImpl });
      assert.equal(judged.id, insight.id);
      assert.equal(judged.sentiment, "watch");
      assert.equal(judging.calls.length, 1);
      assert.ok(!isPart(judging.calls[0]));
      assert.ok(!judging.calls[0].user.includes("marker-"));
      assert.match(judging.calls[0].user, new RegExp(GOOD.summary.slice(0, 20)));
      assert.match(judging.calls[0].user, /Send the revised quote/);
    });

    it("splits on line boundaries and loses nothing", () => {
      const text = longTranscript(3000);
      const parts = splitTranscript(text, 50_000);
      assert.ok(parts.every((part) => part.length <= 50_000));
      assert.equal(parts.join("\n"), text);
      const oneLine = "x".repeat(130_001);
      assert.equal(splitTranscript(oneLine, 50_000).join(""), oneLine);
      const emoji = "😀".repeat(30_000);
      const cut = splitTranscript(emoji, 50_001);
      assert.equal(cut.join(""), emoji);
      assert.ok(cut.every((part) => !/[\ud800-\udbff]$/.test(part)));
    });

    it("pages the whole transcript with no gaps or overlaps", async () => {
      const { owner, callId } = await setup("paging@example.com");
      const text = `${longTranscript(1200)}\n😀 ${"y".repeat(150_000)}\nMark Ridgeon: last line`;
      const { fetchImpl } = routed(20);
      const insight = await summariseCall(owner, callId, text, { fetchImpl, autoAccept: false });
      const total = Array.from(text).length;
      assert.equal(insight.transcriptLength, total);
      let offset = 0;
      let joined = "";
      let pages = 0;
      for (;;) {
        const page = await getInsightTranscriptPage(owner, insight.id, offset);
        assert.equal(page.offset, offset);
        assert.equal(page.totalLength, total);
        assert.ok(Array.from(page.text).length <= TRANSCRIPT_PAGE_LENGTH);
        assert.ok(page.text.length > 0);
        joined += page.text;
        pages += 1;
        if (page.nextOffset === null) break;
        assert.equal(page.nextOffset, offset + Array.from(page.text).length);
        assert.ok(page.text.endsWith("\n") || page.text.length >= TRANSCRIPT_PAGE_LENGTH - 10_000 || !page.text.includes("\n"));
        offset = page.nextOffset;
      }
      assert.ok(pages >= 4);
      assert.equal(joined, text);
      const past = await getInsightTranscriptPage(owner, insight.id, total + 10);
      assert.deepEqual([past.text, past.nextOffset], ["", null]);
      const first = await getInsightTranscriptPage(owner, insight.id);
      assert.equal(first.offset, 0);
    });

    it("returns empty text for an offset past the end, however large", async () => {
      const { owner, callId } = await setup("hugeoffset@example.com");
      const insight = await readyInsight(owner, callId);
      for (const offset of [2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER, 1e30]) {
        const page = await getInsightTranscriptPage(owner, insight.id, offset);
        assert.equal(page.text, "");
        assert.equal(page.nextOffset, null);
        assert.equal(page.totalLength, insight.transcriptLength);
      }
    });

    it("keeps a page inside its limit after JSON escaping, however many quotes and line breaks it holds", async () => {
      const { owner, callId } = await setup("escaping@example.com");
      const text = Array.from({ length: 60_000 }, (_, index) => `A: "q${index}"`).join("\n");
      const { fetchImpl } = routed(20);
      const insight = await summariseCall(owner, callId, text, { fetchImpl, autoAccept: false });
      let offset = 0;
      let joined = "";
      for (;;) {
        const page = await getInsightTranscriptPage(owner, insight.id, offset);
        assert.ok(JSON.stringify(page.text).length - 2 <= TRANSCRIPT_PAGE_LENGTH);
        joined += page.text;
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      assert.equal(joined, text);
    });

    it("hints that the transcript can be pulled", () => {
      const hinted = withTranscriptHint({ id: "a", transcriptLength: 42 });
      assert.deepEqual(hinted.transcript, { length: 42, tool: "get_call_transcript" });
    });

    it("refuses a transcript page from another workspace", async () => {
      const { owner, callId } = await setup("pageowner@example.com");
      const insight = await readyInsight(owner, callId);
      const other = await createUser("pagenosy@example.com", "Nosy");
      await assert.rejects(getInsightTranscriptPage(other, insight.id), /Call summary not found/);
      await assert.rejects(getInsightTranscriptPage(owner, "not-a-uuid"), /Call summary not found/);
      const noScope = await createAgent(owner.workspaceId, ["tasks:write"]);
      await assert.rejects(getInsightTranscriptPage(noScope.actor, insight.id), /crm:read/);
    });
  });
});
