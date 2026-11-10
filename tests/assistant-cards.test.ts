import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { decideActions, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { ACTION_ALTERNATIVES, describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { rememberNote } from "@/lib/learning/memories";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function outlook() {
  const calls: Call[] = [];
  let drafts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, url: url.replace(GRAPH, ""), body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/createReply") || url.endsWith("/createReplyAll")) {
      drafts += 1;
      return Response.json({ id: `draft-${drafts}`, subject: "RE: Pilot", body: { contentType: "html", content: "<html><body></body></html>" } }, { status: 201 });
    }
    if (method === "POST" && url.endsWith("/me/messages")) {
      drafts += 1;
      return Response.json({ id: `draft-${drafts}`, subject: "Pilot" }, { status: 201 });
    }
    if (url.endsWith("/send")) return new Response(null, { status: 202 });
    if (method === "PATCH") return Response.json({ id: "draft" });
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
              subject: "Pilot",
              bodyPreview: "Shall we start?",
              body: { contentType: "text", content: "Shall we start?" },
              from: { emailAddress: { name: "Andrew Sanaghan", address: "andrew@pulse.test" } },
              toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
              ccRecipients: [{ emailAddress: { name: "Ola", address: "ola@pulse.test" } }],
              receivedDateTime: "2026-10-19T09:00:00Z",
              isRead: true,
            },
          ],
      "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
    });
  };
  return { fetchImpl, calls };
}

function recipientsOf(calls: Call[]) {
  const patch = calls.filter((call) => call.method === "PATCH").at(-1)?.body as
    | { toRecipients?: { emailAddress: { address: string } }[]; ccRecipients?: { emailAddress: { address: string } }[]; bccRecipients?: { emailAddress: { address: string } }[] }
    | undefined;
  const list = (value?: { emailAddress: { address: string } }[]) => (value ?? []).map((item) => item.emailAddress.address);
  return { to: list(patch?.toRecipients), cc: list(patch?.ccRecipients), bcc: list(patch?.bccRecipients) };
}

describe("assistant approval cards", () => {
  let owner: UserActor;
  let other: UserActor;
  let messageId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("cards@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: outlook().fetchImpl });
    messageId = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-1'")).rows[0].id;
    const created = await createWorkspace(owner, { name: "Mark Ridgeon" });
    other = { ...owner, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  });

  after(async () => {
    await getPool().end();
  });

  it("shows every recipient and the sender on a draft card, including the reply's own people", async () => {
    const args = { replyToEmailId: messageId, replyAll: true, cc: ["sam@pulse.test"], body: "Hi both,\n\nMonday works.\n\nMark" };
    const card = describeAction("save_email_draft", args, await recordNames(owner, [args], ["save_email_draft"]));
    assert.ok(card.lines.includes("To: andrew@pulse.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Cc: ola@pulse.test, sam@pulse.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("From: mark@eclipse.test"), card.lines.join("\n"));

    const contact = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme.test" })).body.contact;
    const fresh = { contactId: contact.id, to: ["sam@acme.test"], cc: ["ola@acme.test"], subject: "Intro", body: "Hi Jane" };
    const freshCard = describeAction("save_email_draft", fresh, await recordNames(owner, [fresh], ["save_email_draft"]));
    assert.ok(freshCard.lines.includes("To: Jane Doe <jane@acme.test>, sam@acme.test"), freshCard.lines.join("\n"));
    assert.ok(freshCard.lines.includes("Cc: ola@acme.test"), freshCard.lines.join("\n"));
  });

  it("shows a stored draft's Bcc, follow-up, reminder and schedule on the send card", async () => {
    const admin = getAdminPool();
    const sourceId = (await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
    const draftId = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_drafts (workspace_id, user_id, source_id, provider_draft_id, mode, subject, to_recipients, cc_recipients, bcc_recipients,
           remind_hours, send_at)
         values ($1, $2, $3, 'stored-draft', 'new', 'Stored', $4::jsonb, '[]'::jsonb, $5::jsonb, 48, now() + interval '2 days') returning id`,
        [owner.workspaceId, owner.userId, sourceId, JSON.stringify([{ address: "jane@acme.test", name: null }]), JSON.stringify([{ address: "boss@acme.test", name: null }])],
      )
    ).rows[0].id;
    const args = { draftId, body: "Hi Jane" };
    const card = describeAction("send_email", args, await recordNames(owner, [args], ["send_email"]));
    assert.ok(card.lines.includes("To: jane@acme.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Bcc: boss@acme.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Reminder: if no reply within 2 days"), card.lines.join("\n"));
    assert.ok(card.lines.some((line) => /^It was scheduled for .+ \(London time\)\. Approving sends it now instead\.$/.test(line)), card.lines.join("\n"));

    const asked = { draftId, body: "Hi Jane", remindAfterDays: 5 };
    const askedCard = describeAction("send_email", asked, await recordNames(owner, [asked], ["send_email"]));
    assert.ok(askedCard.lines.includes("Reminder: if no reply within 5 days"), askedCard.lines.join("\n"));

    const original = globalThis.fetch;
    const { fetchImpl, calls } = outlook();
    globalThis.fetch = fetchImpl;
    try {
      const sent = (await runTool(owner, "send_email", args)) as Record<string, unknown>;
      assert.equal(sent.error, undefined, String(sent.error));
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(recipientsOf(calls), { to: ["jane@acme.test"], cc: [], bcc: ["boss@acme.test"] });
    assert.ok(calls.some((call) => call.method === "POST" && call.url === "/me/messages/stored-draft/send"));

    const withFollowUp = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_drafts (workspace_id, user_id, source_id, provider_draft_id, mode, subject, to_recipients, cc_recipients, bcc_recipients,
           follow_up_days, follow_up_body)
         values ($1, $2, $3, 'stored-follow-up', 'new', 'Stored', $4::jsonb, '[]'::jsonb, '[]'::jsonb, 3, 'Just checking this landed.') returning id`,
        [owner.workspaceId, owner.userId, sourceId, JSON.stringify([{ address: "jane@acme.test", name: null }])],
      )
    ).rows[0].id;
    const followUpArgs = { draftId: withFollowUp, body: "Hi Jane" };
    const followUpCard = describeAction("send_email", followUpArgs, await recordNames(owner, [followUpArgs], ["send_email"]));
    assert.ok(followUpCard.lines.includes("Follow-up after 3 working days if no reply:"), followUpCard.lines.join("\n"));
    assert.ok(followUpCard.lines.includes("Just checking this landed."), followUpCard.lines.join("\n"));
    assert.ok(!followUpCard.lines.some((line) => line.startsWith("Reminder:")), followUpCard.lines.join("\n"));
    await admin.query("delete from crm.mail_drafts where id = $1", [withFollowUp]);

    const storedReply = (
      await admin.query<{ id: string }>(
        `insert into crm.mail_drafts (workspace_id, user_id, source_id, provider_draft_id, mode, reply_to, subject, to_recipients, cc_recipients, bcc_recipients)
         values ($1, $2, $3, 'stored-reply', 'reply', $4, 'RE: Pilot', $5::jsonb, '[]'::jsonb, '[]'::jsonb) returning id`,
        [owner.workspaceId, owner.userId, sourceId, messageId, JSON.stringify([{ address: "andrew@pulse.test", name: null }])],
      )
    ).rows[0].id;
    const replyArgs = { draftId: storedReply, body: "Monday works." };
    assert.equal(describeAction("send_email", replyArgs, await recordNames(owner, [replyArgs], ["send_email"])).title, "Send reply: RE: Pilot");
    await admin.query("delete from crm.mail_drafts where id = $1", [storedReply]);
  });

  it("sends only what the draft card showed when the user chooses Send now", async () => {
    const stray = {
      replyToEmailId: messageId,
      cc: ["sam@pulse.test"],
      body: "Hi Andrew,\n\nMonday works.\n\nMark",
      followUp: { afterDays: 2 },
      remindAfterDays: 3,
      sendAt: "2030-01-01T09:00",
      draftId: "00000000-0000-4000-8000-000000000000",
    };
    assert.deepEqual(ACTION_ALTERNATIVES.save_email_draft.args(stray), { replyToEmailId: messageId, cc: ["sam@pulse.test"], body: stray.body });

    process.env.LLM_API_KEY = "llm-test";
    const replies = [
      { tool_calls: [{ id: "call_cards_draft", type: "function", function: { name: "save_email_draft", arguments: JSON.stringify(stray) } }] },
      { content: "Sent it." },
    ];
    const model: typeof fetch = async () =>
      Response.json({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "", ...replies.shift() } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const events: AssistantEvent[] = [];
    const original = globalThis.fetch;
    const { fetchImpl, calls } = outlook();
    globalThis.fetch = fetchImpl;
    try {
      await sendMessage(owner, { message: "Reply to Andrew", model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false }, (event) => events.push(event), {
        deadline: Date.now() + 60_000,
        fetchImpl: model,
      });
      const proposed = events.filter((event): event is Extract<AssistantEvent, { type: "actions" }> => event.type === "actions").at(-1)!;
      const shown = proposed.actions[0].lines;
      assert.ok(shown.includes("To: andrew@pulse.test"), shown.join("\n"));
      assert.ok(shown.includes("Cc: sam@pulse.test"), shown.join("\n"));
      assert.ok(!shown.some((line) => /Follow-up|Reminder|Sends /.test(line)), shown.join("\n"));
      const conversationId = (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation.id;
      await decideActions(owner, { conversationId, decisions: [{ id: "call_cards_draft", approve: true, variant: "send" }] }, () => undefined, {
        deadline: Date.now() + 60_000,
        fetchImpl: model,
      });
    } finally {
      globalThis.fetch = original;
      delete process.env.LLM_API_KEY;
    }
    assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/send")));
    assert.deepEqual(recipientsOf(calls), { to: ["andrew@pulse.test"], cc: ["sam@pulse.test"], bcc: [] });
    const admin = getAdminPool();
    assert.equal((await admin.query("select 1 from crm.mail_reminders where user_id = $1", [owner.userId])).rowCount, 0);
    assert.equal((await admin.query("select 1 from crm.mail_drafts where user_id = $1 and send_at is not null", [owner.userId])).rowCount, 0);
  });

  it("names each meeting guest with the address the invite goes to", async () => {
    const ola = (await createContact(owner, { firstName: "Ola", lastName: "Smith", email: "ola@acme.test" })).body.contact;
    const jane = (await getAdminPool().query<{ id: string }>("select id from crm.contacts where normalized_email = 'jane@acme.test'")).rows[0].id;
    const args = {
      title: "Pilot kick off",
      startLocal: "2030-01-07T10:00",
      durationMinutes: 30,
      attendees: [{ email: "Jane@Acme.test", name: "Jane Doe" }, { email: "sam@acme.test" }, { email: "jane@acme.test", name: "Again" }, { email: "mark@eclipse.test", name: "Me" }],
      contactIds: [jane, ola.id],
    };
    const card = describeAction("create_meeting_invite", args, await recordNames(owner, [args], ["create_meeting_invite"]));
    assert.ok(card.lines.includes("Guests: Jane Doe <jane@acme.test>, sam@acme.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Not invited: Ola Smith <ola@acme.test>"), card.lines.join("\n"));

    const broken = { ...args, attendees: [{ email: "not an address" }], contactIds: [] };
    const brokenCard = describeAction("create_meeting_invite", broken, await recordNames(owner, [broken], ["create_meeting_invite"]));
    assert.ok(brokenCard.lines.includes("Guests: “not an address” isn't a valid email address."), brokenCard.lines.join("\n"));
  });

  it("shows a forgotten note's real title and scope, warns about team notes and refuses ones from another workspace", async () => {
    const mine = await rememberNote(owner, { title: "Prefers short emails", body: "Mark prefers short emails." }, "manual");
    const team = await rememberNote(owner, { title: "Pilot pricing", body: "Pilots cost £2,000.", shared: true }, "manual");
    const elsewhere = await rememberNote(other, { title: "Coaching rates", body: "Coaching is £300 an hour.", shared: true }, "manual");

    const mineArgs = { memoryId: mine.id, title: "Something the model made up" };
    assert.deepEqual(describeAction("forget", mineArgs, await recordNames(owner, [mineArgs], ["forget"])), {
      title: "Forget a note",
      lines: ["Prefers short emails", "Your note"],
    });
    const teamArgs = { forgetId: team.id, title: "Old note" };
    assert.deepEqual(describeAction("remember", teamArgs, await recordNames(owner, [teamArgs], ["remember"])), {
      title: "Forget a note",
      lines: ["Pilot pricing", "Team note", "This is a team note. Archiving it removes it for everyone."],
    });
    const elsewhereArgs = { forgetId: elsewhere.id };
    const elsewhereCard = describeAction("remember", elsewhereArgs, await recordNames(owner, [elsewhereArgs], ["remember"]));
    assert.deepEqual(elsewhereCard.lines, ["Coaching rates", "Team note", "That team note belongs to Mark Ridgeon. Switch to Mark Ridgeon to forget it. This will be refused."]);

    assert.deepEqual(await runTool(owner, "remember", elsewhereArgs), { error: "That team note belongs to Mark Ridgeon. Switch to Mark Ridgeon to forget it." });
    const admin = getAdminPool();
    assert.equal((await admin.query("select 1 from crm.memories where id = $1 and archived_at is null", [elsewhere.id])).rowCount, 1);
    assert.deepEqual(await runTool(owner, "remember", teamArgs), { forgotten: "Pilot pricing" });
    assert.deepEqual(await runTool(owner, "forget", { memoryId: mine.id }), { forgotten: "Prefers short emails" });
    assert.deepEqual(await runTool(owner, "remember", teamArgs), { error: "That note isn't in Orbit's memory, or it was already forgotten." });
    const gone = describeAction("remember", teamArgs, await recordNames(owner, [teamArgs], ["remember"]));
    assert.deepEqual(gone.lines, ["That note isn't in Orbit's memory, or it was already forgotten. This will be refused."]);
  });
});
