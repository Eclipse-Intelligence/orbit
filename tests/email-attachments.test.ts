import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { createContact } from "@/lib/crm/contacts";
import { discardAttachments, prepareAttachment, sweepEmailAttachments } from "@/lib/crm/email-attachments";
import { saveMailbox, sendContactEmail } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { LARGE_ATTACHMENT_RECONNECT } from "@/lib/microsoft/oauth";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, resetDatabase } from "./helpers";

const SUPABASE = "https://project.supabase.test";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function world(options: { draftDenied?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body;
    const body = typeof raw === "string" ? (raw ? JSON.parse(raw) : null) : raw instanceof Uint8Array ? raw.byteLength : null;
    calls.push({ method, url, headers, body });
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: "email-attachments" });
    const sign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
    if (sign) return Response.json({ url: `/object/upload/sign/email-attachments/${sign[1]}?token=signed` });
    const read = url.match(/\/storage\/v1\/object\/email-attachments\/(.+)$/);
    if (read && method === "GET") {
      const bytes = objects.get(read[1]);
      return bytes ? new Response(Buffer.from(bytes)) : Response.json({ message: "Object not found" }, { status: 404 });
    }
    if (url === `${SUPABASE}/storage/v1/object/email-attachments` && method === "DELETE") {
      for (const path of (body as { prefixes: string[] }).prefixes) objects.delete(path);
      return Response.json([]);
    }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") return new Response(null, { status: 202 });
    if (url === "https://graph.microsoft.com/v1.0/me/messages") {
      return options.draftDenied ? Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 }) : Response.json({ id: "draft-1" });
    }
    if (url.endsWith("/attachments/createUploadSession")) return Response.json({ uploadUrl: "https://outlook.office.test/upload/1" });
    if (url === "https://outlook.office.test/upload/1") return new Response(null, { status: 200 });
    if (url.endsWith("/attachments") || url.endsWith("/send")) return new Response(null, { status: 202 });
    if (url.includes("/me/messages/draft-1") && method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, objects };
}

describe("email attachments", () => {
  let owner: UserActor;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("attach@orbit.test", "Mark Ridgeon");
    contactId = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@attach.test" })).body.contact.id;
    await saveMailbox(owner, {
      email: "mark@attach.test",
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    resetStorageBucketCache();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  after(async () => {
    await getPool().end();
  });

  async function attach(env: ReturnType<typeof world>, name: string, size: number) {
    const prepared = await prepareAttachment(owner, { name, size, contentType: "application/pdf" }, env.fetchImpl);
    assert.match(prepared.uploadUrl, /^https:\/\/project\.supabase\.test\/storage\/v1\/object\/upload\/sign\/email-attachments\/.+\?token=signed$/);
    env.objects.set(prepared.id, new Uint8Array(size).fill(7));
    return prepared.id;
  }

  it("sends small files inline, logs their names and removes the stored copies", async () => {
    const env = world();
    const id = await attach(env, "Proposal.pdf", 2048);
    assert.equal(env.calls[0].headers.apikey, "sb_secret_test");
    assert.equal(env.calls[0].headers.authorization, undefined);

    await sendContactEmail(owner, contactId, { subject: "Proposal", body: "Attached.", attachments: [id] }, env.fetchImpl);
    const sent = env.calls.find((call) => call.url.endsWith("/me/sendMail"))!;
    const attachment = (sent.body as { message: { attachments: { name: string; contentBytes: string }[] } }).message.attachments[0];
    assert.equal(attachment.name, "Proposal.pdf");
    assert.equal(Buffer.from(attachment.contentBytes, "base64").byteLength, 2048);
    assert.equal(env.objects.size, 0);
    const rows = await getAdminPool().query("select 1 from crm.email_attachments");
    assert.equal(rows.rowCount, 0);
    const [activity] = (await listActivities(owner, { contactId })).data;
    assert.deepEqual(activity.metadata.attachments, [{ name: "Proposal.pdf", size: 2048 }]);
  });

  it("uploads large files through a draft and an upload session", async () => {
    const env = world();
    const big = await attach(env, "Deck.pdf", 4 * 1024 * 1024);
    const small = await attach(env, "Notes.txt", 10);
    await sendContactEmail(owner, contactId, { subject: "Deck", body: "Here it is.", attachments: [big, small] }, env.fetchImpl);
    const graph = env.calls.filter((call) => call.url.includes("graph.microsoft.com") || call.url.includes("outlook.office.test"));
    assert.deepEqual(
      graph.map((call) => `${call.method} ${call.url.replace("https://graph.microsoft.com/v1.0", "")}`),
      [
        "POST /me/messages",
        "POST /me/messages/draft-1/attachments/createUploadSession",
        "PUT https://outlook.office.test/upload/1",
        "PUT https://outlook.office.test/upload/1",
        "POST /me/messages/draft-1/attachments",
        "POST /me/messages/draft-1/send",
      ],
    );
    const puts = graph.filter((call) => call.method === "PUT");
    assert.equal(puts[0].headers["content-range"], "bytes 0-3276799/4194304");
    assert.equal(puts[1].headers["content-range"], "bytes 3276800-4194303/4194304");
  });

  it("asks to reconnect when Microsoft refuses drafts, and keeps the files for another try", async () => {
    const env = world({ draftDenied: true });
    const big = await attach(env, "Deck.pdf", 4 * 1024 * 1024);
    await assert.rejects(
      sendContactEmail(owner, contactId, { subject: "Deck", body: "Here it is.", attachments: [big] }, env.fetchImpl),
      (error: Error) => error.message === LARGE_ATTACHMENT_RECONNECT,
    );
    assert.equal(env.objects.size, 1);
    await discardAttachments(owner, [big], env.fetchImpl);
    assert.equal(env.objects.size, 0);
  });

  it("refuses files that are too big, never finished uploading, or belong to someone else", async () => {
    const env = world();
    await assert.rejects(prepareAttachment(owner, { name: "Huge.zip", size: 26 * 1024 * 1024 }, env.fetchImpl), /up to 25.0 MB in total|up to 25 MB/);
    const pending = await prepareAttachment(owner, { name: "Half.pdf", size: 100 }, env.fetchImpl);
    await assert.rejects(
      sendContactEmail(owner, contactId, { subject: "Half", body: "Hm.", attachments: [pending.id] }, env.fetchImpl),
      /Half\.pdf didn't finish uploading/,
    );

    const other = await createUser("attach-other@orbit.test", "Someone Else");
    const theirs = await prepareAttachment(other, { name: "Theirs.pdf", size: 10 }, env.fetchImpl);
    env.objects.set(theirs.id, new Uint8Array(10));
    await assert.rejects(
      sendContactEmail(owner, contactId, { subject: "Theirs", body: "No.", attachments: [theirs.id] }, env.fetchImpl),
      /has expired/,
    );

    await getAdminPool().query("update crm.email_attachments set created_at = now() - interval '2 days'");
    assert.equal(await sweepEmailAttachments(env.fetchImpl), 2);
    assert.equal(env.objects.size, 0);
  });
});
