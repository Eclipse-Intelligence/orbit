import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { listMailAttachments, openMailAttachment } from "@/lib/mail/attachments";
import { syncMail } from "@/lib/mail/sync";
import { listThreads } from "@/lib/mail/threads";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/me/messages/m-1/attachments/att-1/$value")) return new Response("PDFDATA", { headers: { "content-type": "application/pdf" } });
  if (url.includes("/me/messages/m-1/attachments")) {
    return Response.json({
      value: [
        { id: "att-1", name: "Proposal.pdf", contentType: "application/pdf", size: 52_000, isInline: false },
        { id: "att-2", name: "logo.png", contentType: "image/png", size: 4_000, isInline: true },
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
            subject: "Proposal",
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

describe("mail attachments", () => {
  let owner: UserActor;
  let messageId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("attach@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, { email: "mark@eclipse.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl });
    messageId = (await listThreads(owner, { view: { role: "inbox" } })).threads[0].latestId;
  });

  after(async () => {
    await getPool().end();
  });

  it("lists real attachments and leaves out inline images", async () => {
    const items = await listMailAttachments(owner, messageId, fetchImpl);
    assert.deepEqual(items.map((item) => [item.name, item.size]), [["Proposal.pdf", 52_000]]);
  });

  it("streams an attachment and refuses unknown ones", async () => {
    const { item, body } = await openMailAttachment(owner, messageId, "att-1", fetchImpl);
    assert.equal(item.name, "Proposal.pdf");
    assert.equal(await new Response(body).text(), "PDFDATA");
    await assert.rejects(() => openMailAttachment(owner, messageId, "att-9", fetchImpl), /Attachment not found/);
    await assert.rejects(() => listMailAttachments(owner, "not-a-uuid", fetchImpl), /Email not found/);
  });
});
