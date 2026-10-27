import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { summariseCall } from "@/lib/crm/call-insights";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { backfillCalls } from "@/lib/knowledge/calls";
import { addMailAttachmentToKnowledge } from "@/lib/knowledge/attachments";
import { archiveKnowledge, listKnowledge, readKnowledge } from "@/lib/knowledge/store";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

const mail: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/me/messages/m-1/attachments/att-1/$value")) return new Response("Acme wants 40 seats from March.\n\nBudget is 120,000 pounds.", { headers: { "content-type": "text/plain" } });
  if (url.includes("/me/messages/m-1/attachments/att-2/$value")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  if (url.includes("/me/messages/m-1/attachments")) {
    return Response.json({
      value: [
        { id: "att-1", name: "Requirements.txt", contentType: "text/plain", size: 60, isInline: false },
        { id: "att-2", name: "photo.png", contentType: "image/png", size: 3, isInline: false },
      ],
    });
  }
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
            subject: "Requirements",
            bodyPreview: "Attached",
            body: { contentType: "text", content: "Attached" },
            from: { emailAddress: { name: "Jane", address: "jane@acme.test" } },
            toRecipients: [],
            receivedDateTime: "2026-10-01T09:00:00Z",
            isRead: true,
            hasAttachments: true,
          },
        ],
    "@odata.deltaLink": `${GRAPH}/me/mailFolders/f-inbox/messages/delta?$deltatoken=1`,
  });
};

describe("knowledge sources", () => {
  let owner: UserActor;
  let acme: string;
  let jane: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("sources@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme Sources", domain: "acme-sources.test" })).body.company.id;
    jane = (await createContact(owner, { companyId: acme, firstName: "Jane", lastName: "Doe" })).body.contact.id;
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-llm-key";
    delete process.env.LLM_API_BASE_URL;
  });

  after(async () => {
    await getPool().end();
  });

  it("adds a summarised call's transcript to its company's Knowledge once", async () => {
    const call = await createActivity(owner, { type: "call", title: "Pricing call", contactId: jane, companyId: acme, occurredAt: "2026-10-15T13:00:00.000Z" });
    const fetchImpl: typeof fetch = async () =>
      Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ summary: "Jane agreed the pricing.", keyPoints: [], actionItems: [] }) }, finish_reason: "stop" }] });
    const insight = await summariseCall(owner, call.body.activity.id, "Mark: Shall we agree the price?\nJane: Yes, 40 seats.", { source: "manual", fetchImpl, autoAccept: false });
    assert.equal(insight.status, "ready");
    const items = await listKnowledge(owner, { companyId: acme });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "transcript");
    assert.equal(items[0].title, "Pricing call · 15 Oct 2026");
    assert.equal(items[0].status, "pending");
    const read = await readKnowledge(owner, items[0].id);
    assert.match(read.text, /^Call with Jane Doe on 15 Oct 2026\.\n\nSummary:\nJane agreed the pricing\.\n\nTranscript:\n/);
    assert.match(read.text, /40 seats/);

    await summariseCall(owner, call.body.activity.id, "", { source: "manual", fetchImpl, autoAccept: false });
    assert.equal((await listKnowledge(owner, { companyId: acme })).length, 1);
  });

  it("backfills calls summarised before Knowledge, and doesn't bring back removed ones", async () => {
    const call = await createActivity(owner, { type: "meeting", title: "Kick-off", contactId: jane, companyId: acme, occurredAt: "2026-09-01T10:00:00.000Z" });
    await getAdminPool().query(
      `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, status, summary)
       values ($1, $2, $3, $4, 'manual', 'Jane: We start in September.', 'ready', 'Kick-off went well.')`,
      [owner.workspaceId, call.body.activity.id, jane, acme],
    );
    const added = await backfillCalls(owner, acme);
    assert.equal(added.length, 1);
    assert.deepEqual(await backfillCalls(owner, acme), []);
    const item = (await listKnowledge(owner, { companyId: acme })).find((entry) => entry.id === added[0])!;
    assert.equal(item.title, "Kick-off · 1 Sept 2026");
    assert.match((await readKnowledge(owner, item.id)).text, /^Meeting with Jane Doe on 1 Sept 2026\./);
    await archiveKnowledge(owner, item.id);
    assert.deepEqual(await backfillCalls(owner, acme), []);
  });

  it("adds an email attachment's text to a company or Eclipse when asked", async () => {
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: mail });
    const messageId = (await listThreads(owner, { view: { role: "inbox" } })).threads[0].latestId;

    const added = await addMailAttachmentToKnowledge(owner, messageId, "att-1", { companyId: acme }, mail);
    assert.equal(added.created, true);
    assert.equal(added.item.kind, "attachment");
    assert.equal(added.item.title, "Requirements");
    assert.match((await readKnowledge(owner, added.item.id)).text, /40 seats from March/);

    const again = await addMailAttachmentToKnowledge(owner, messageId, "att-1", { companyId: acme }, mail);
    assert.equal(again.created, false);
    const eclipse = await addMailAttachmentToKnowledge(owner, messageId, "att-1", { eclipse: true }, mail);
    assert.equal(eclipse.created, true);
    assert.equal(eclipse.item.scope, "eclipse");

    await assert.rejects(addMailAttachmentToKnowledge(owner, messageId, "att-2", { companyId: acme }, mail), /can't read text from photo\.png/);
    await assert.rejects(addMailAttachmentToKnowledge(owner, messageId, "att-9", { companyId: acme }, mail), /Attachment not found/);
  });
});
