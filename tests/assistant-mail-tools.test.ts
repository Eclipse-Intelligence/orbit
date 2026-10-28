import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { prepareAttachment, sweepEmailAttachments } from "@/lib/crm/email-attachments";
import { listEmailTemplates } from "@/lib/crm/email-templates";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listKnowledge } from "@/lib/knowledge/store";
import { readDraftInput, scheduleMailDraft, sendForAgent } from "@/lib/mail/compose";
import { syncMail } from "@/lib/mail/sync";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SUPABASE = "https://project.supabase.test";
const DECK = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);

type Call = { method: string; url: string; body: unknown };

let draftCount = 0;

function inboxMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: "conv-pilot",
    subject: "Pilot",
    bodyPreview: "Notes attached",
    body: { contentType: "text", content: "Notes attached." },
    from: { emailAddress: { name: "Jane Doe", address: "jane@acme.test" } },
    toRecipients: [{ emailAddress: { name: "Mark", address: "mark@eclipse.test" } }],
    receivedDateTime: "2026-10-20T09:00:00Z",
    sentDateTime: "2026-10-20T09:00:00Z",
    isRead: true,
    hasAttachments: true,
    ...overrides,
  };
}

const INBOX = [
  inboxMessage("m-1"),
  inboxMessage("m-2", {
    subject: "RE: Pilot",
    from: { emailAddress: { name: "Mark", address: "mark@eclipse.test" } },
    toRecipients: [{ emailAddress: { name: "Jane Doe", address: "jane@acme.test" } }],
    receivedDateTime: "2026-10-21T09:00:00Z",
    sentDateTime: "2026-10-21T09:00:00Z",
    hasAttachments: false,
  }),
];

function graphRead(url: string) {
  const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
  if (named) return named[1] === "inbox" ? Response.json({ id: "f-inbox" }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
  if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }] });
  const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
  if (folder) {
    const value = url.includes("token=") ? [] : INBOX;
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=1` });
  }
  if (url.includes("/me/messages/m-1/attachments?")) {
    return Response.json({ value: [{ id: "att-1", name: "Pilot notes.txt", contentType: "text/plain", size: 40, isInline: false }] });
  }
  if (url.includes("/me/messages/m-1/attachments/att-1/")) return new Response("The pilot starts on Monday with three markets.");
  return Response.json({ value: [] });
}

function world() {
  const objects = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = init?.body;
    let body: unknown = null;
    if (typeof raw === "string") {
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
    } else if (raw instanceof Blob) {
      body = new Uint8Array(await raw.arrayBuffer());
    }
    calls.push({ method, url, body });
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: "bucket" });
    const sign = url.match(/\/storage\/v1\/object\/upload\/sign\/email-attachments\/(.+)$/);
    if (sign) return Response.json({ url: `/object/upload/sign/email-attachments/${sign[1]}?token=signed` });
    const object = url.match(/\/storage\/v1\/object\/(email-attachments|knowledge)\/(.+)$/);
    if (object && method === "GET") {
      const bytes = objects.get(`${object[1]}/${object[2]}`);
      return bytes ? new Response(Buffer.from(bytes)) : Response.json({ message: "Object not found" }, { status: 404 });
    }
    if (object && method === "POST") {
      objects.set(`${object[1]}/${object[2]}`, body as Uint8Array);
      return Response.json({ Key: object[2] });
    }
    if (url === `${SUPABASE}/storage/v1/object/email-attachments` && method === "DELETE") {
      for (const path of (body as { prefixes: string[] }).prefixes) objects.delete(`email-attachments/${path}`);
      return Response.json([]);
    }
    if (method === "POST" && url === `${GRAPH}/me/messages`) {
      draftCount += 1;
      return Response.json({ id: `draft-${draftCount}`, conversationId: `conv-${draftCount}`, subject: "" }, { status: 201 });
    }
    if (url.endsWith("/attachments") && method === "POST") return Response.json({ id: "att" }, { status: 201 });
    if (url.endsWith("/send")) return new Response(null, { status: 202 });
    if (method === "PATCH") return Response.json({ id: "x" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && url.startsWith(GRAPH)) return graphRead(url);
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, objects };
}

function graphCalls(calls: Call[]) {
  return calls.filter((call) => call.url.startsWith(GRAPH)).map((call) => `${call.method} ${call.url.replace(GRAPH, "")}`);
}

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function londonInput(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

describe("assistant mail tools", () => {
  let owner: UserActor;
  let sourceId: string;
  let deckId: string;
  let firstEmail: string;
  let sentEmail: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mailtools@orbit.test", "Mark Ridgeon");
    await saveMailbox(owner, {
      email: "mark@eclipse.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await syncMail(owner, { budgetMs: 30_000, fetchImpl: world().fetchImpl });
    const admin = getAdminPool();
    sourceId = (await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [owner.userId])).rows[0].id;
    const ids = Object.fromEntries((await admin.query<{ id: string; provider_message_id: string }>("select id, provider_message_id from crm.mail_messages")).rows.map((row) => [row.provider_message_id, row.id]));
    firstEmail = ids["m-1"];
    sentEmail = ids["m-2"];
    deckId = (
      await admin.query<{ id: string }>(
        `insert into crm.knowledge_items (workspace_id, scope, kind, title, file_path, mime_type, size_bytes, status, created_by_user_id)
         values ($1, 'eclipse', 'file', 'Eclipse deck', $2, 'application/pdf', $3, 'ready', $4) returning id`,
        [owner.workspaceId, `${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK.byteLength, owner.userId],
      )
    ).rows[0].id;
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

  it("keeps a draft's attachments when the assistant sends it by draftId", async () => {
    const env = world();
    const prepared = await prepareAttachment(owner, { name: "Terms.pdf", size: 4, contentType: "application/pdf" }, env.fetchImpl);
    env.objects.set(`email-attachments/${prepared.id}`, new Uint8Array([1, 2, 3, 4]));
    const draft = await scheduleMailDraft(
      owner,
      {
        ...readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Terms", body: "Hi Jane, terms attached." }),
        attachments: [prepared.id],
        sendAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(),
      },
      { origin: null, fetchImpl: env.fetchImpl },
    );
    await getAdminPool().query("update crm.email_attachments set created_at = now() - interval '2 days'");
    assert.equal(await sweepEmailAttachments(env.fetchImpl), 0);
    assert.ok(env.objects.has(`email-attachments/${prepared.id}`));
    const providerDraft = `draft-${draftCount}`;
    const args = { draftId: draft.id, to: ["jane@acme.test"], subject: "Terms", body: "Hi Jane, terms attached." };
    assert.ok(describeAction("send_email", args, await recordNames(owner, [args])).lines.includes("Attachments: Terms.pdf"));
    env.calls.length = 0;
    await sendForAgent(owner, args, { origin: null, fetchImpl: env.fetchImpl, saveSent: async () => undefined });
    const graph = graphCalls(env.calls);
    assert.ok(graph.includes(`POST /me/messages/${providerDraft}/attachments`), graph.join("\n"));
    assert.ok(graph.includes(`POST /me/messages/${providerDraft}/send`));
    assert.ok(!graph.includes("POST /me/messages"));
    const attached = env.calls.find((call) => call.url.endsWith(`/${providerDraft}/attachments`))!.body as { name: string };
    assert.equal(attached.name, "Terms.pdf");
    const admin = getAdminPool();
    assert.equal((await admin.query("select 1 from crm.email_attachments where id = $1", [prepared.id])).rowCount, 0);
    assert.equal((await admin.query("select 1 from crm.mail_drafts where id = $1", [draft.id])).rowCount, 0);
  });

  it("saves a draft with a Knowledge file attached in Outlook and returns its id", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const args = { to: ["jane@acme.test"], subject: "Our deck", body: "Hi Jane,\n\nThe deck is attached.\n\nMark", attachmentIds: [deckId] };
    const card = describeAction("save_email_draft", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("Attachments: Eclipse deck"));
    const result = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", args))) as { saved: boolean; draftId: string; attachments: string[] };
    assert.equal(result.saved, true);
    assert.deepEqual(result.attachments, ["Eclipse deck.pdf"]);
    const posted = env.calls.find((call) => call.url.endsWith(`/draft-${draftCount}/attachments`))!.body as { name: string; contentBytes: string };
    assert.equal(posted.name, "Eclipse deck.pdf");
    assert.deepEqual(new Uint8Array(Buffer.from(posted.contentBytes, "base64")), DECK);
    assert.ok(!graphCalls(env.calls).some((call) => call.endsWith("/send")));
    const admin = getAdminPool();
    assert.equal((await admin.query("select 1 from crm.mail_drafts where id = $1 and user_id = $2", [result.draftId, owner.userId])).rowCount, 1);
    assert.equal((await admin.query("select 1 from crm.email_attachments")).rowCount, 0);

    const link = (await admin.query<{ id: string }>("insert into crm.knowledge_items (workspace_id, scope, kind, title, source_url, status) values ($1, 'eclipse', 'link', 'Pricing page', 'https://eclipse.test/pricing', 'ready') returning id", [owner.workspaceId])).rows[0].id;
    const refused = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { ...args, attachmentIds: [link] }))) as { error: string };
    assert.match(refused.error, /Pricing page is a link or text in Knowledge, not a file/);
  });

  it("schedules an email with sendAt and shows the time and files on the card", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const at = new Date(Date.now() + 2 * 24 * 3_600_000);
    const args = { to: ["jane@acme.test"], subject: "Follow up", body: "Hi Jane,\n\nFollowing up.\n\nMark", sendAt: londonInput(at), attachmentIds: [deckId] };
    const card = describeAction("send_email", args, await recordNames(owner, [args]));
    assert.equal(card.title, "Schedule email: Follow up");
    assert.ok(card.lines.some((line) => /^Sends \w{3} \d{1,2} \w{3}, \d{2}:\d{2} \(London time\)$/.test(line)), card.lines.join("\n"));
    assert.ok(card.lines.includes("Attachments: Eclipse deck"));
    assert.ok(card.lines.includes("Scheduled in Orbit Mail when you approve."));
    const result = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", args))) as { scheduled: boolean; sent: boolean; draftId: string };
    assert.equal(result.scheduled, true);
    assert.equal(result.sent, false);
    const graph = graphCalls(env.calls);
    assert.ok(!graph.some((call) => call.endsWith("/send")));
    assert.ok(graph.includes(`POST /me/messages/draft-${draftCount}/attachments`));
    const row = (await getAdminPool().query<{ send_at: Date }>("select send_at from crm.mail_drafts where id = $1", [result.draftId])).rows[0];
    assert.equal(Math.round(row.send_at.getTime() / 60_000), Math.floor(at.getTime() / 60_000));

    const past = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", { ...args, sendAt: "2020-01-01T09:00" }))) as { error: string };
    assert.equal(past.error, "sendAt has to be in the future.");
  });

  it("shows when a sent email was opened, with a note about automatic opens", async () => {
    const admin = getAdminPool();
    const tracking = (await admin.query<{ id: string }>("insert into crm.mail_tracking (workspace_id, user_id, sender_email, sent_at) values ($1, $2, 'mark@eclipse.test', now()) returning id", [owner.workspaceId, owner.userId])).rows[0].id;
    await admin.query("update crm.mail_messages set tracking_id = $2 where id = $1", [sentEmail, tracking]);
    await admin.query("insert into crm.mail_opens (tracking_id, workspace_id, user_id, opened_at, agent) values ($1, $2, $3, '2026-10-21T10:15:00Z', 'iPhone'), ($1, $2, $3, '2026-10-21T09:01:00Z', null)", [tracking, owner.workspaceId, owner.userId]);
    const thread = (await runTool(owner, "get_email_thread", { emailId: firstEmail })) as { messages: { id: string; opens: { at: string; device: string | null }[] | null }[]; readTracking: string };
    assert.equal(thread.messages.find((message) => message.id === firstEmail)?.opens, null);
    assert.deepEqual(thread.messages.find((message) => message.id === sentEmail)?.opens, [
      { at: "2026-10-21T10:15:00.000Z", device: "iPhone" },
      { at: "2026-10-21T09:01:00.000Z", device: null },
    ]);
    assert.match(thread.readTracking, /security scanners/i);
    const search = (await runTool(owner, "search_email", { query: "pilot" })) as { emails: { id: string; opens: { count: number } | null }[]; readTracking?: string };
    assert.equal(search.emails.find((email) => email.id === sentEmail)?.opens?.count, 2);
    assert.ok(search.readTracking);
  });

  it("adds an email attachment to Knowledge and removes Knowledge items", async () => {
    const env = world();
    const company = (await createCompany(owner, { name: "Acme", domain: "acme.test" })).body.company;
    const listed = (await withFetch(env.fetchImpl, () => runTool(owner, "list_email_attachments", { emailId: firstEmail }))) as { attachments: { name: string }[] };
    assert.deepEqual(listed.attachments.map((item) => item.name), ["Pilot notes.txt"]);
    const args = { emailId: firstEmail, attachment: "Pilot notes.txt", companyId: company.id };
    assert.deepEqual(describeAction("add_email_attachment_to_knowledge", args, await recordNames(owner, [args])), {
      title: "Add to Knowledge for Acme",
      lines: ["File: Pilot notes.txt", "From the email: Pilot"],
    });
    const added = (await withFetch(env.fetchImpl, () => runTool(owner, "add_email_attachment_to_knowledge", args))) as { added: boolean; item: { id: string; title: string } };
    assert.equal(added.added, true);
    assert.equal(added.item.title, "Pilot notes");
    const again = (await withFetch(env.fetchImpl, () => runTool(owner, "add_email_attachment_to_knowledge", { emailId: firstEmail, companyId: company.id }))) as { added: boolean };
    assert.equal(again.added, false);
    const audit = await getAdminPool().query<{ source: string }>("select source from crm.audit_events where event_type = 'knowledge.added' and entity_id = $1", [added.item.id]);
    assert.equal(audit.rows[0].source, "assistant");

    const removeArgs = { itemIds: [added.item.id] };
    assert.equal(describeAction("remove_knowledge", removeArgs, await recordNames(owner, [removeArgs])).title, "Remove from Knowledge: Pilot notes");
    const removed = (await runTool(owner, "remove_knowledge", removeArgs)) as { removed: number };
    assert.equal(removed.removed, 1);
    assert.ok(!(await listKnowledge(owner, { companyId: company.id })).some((item) => item.id === added.item.id));
  });

  it("creates, updates and archives email templates with an audit trail", async () => {
    const created = (await runTool(owner, "save_email_template", { name: "Pilot follow up", subject: "Pilot", body: "Hi {{first_name}},\n\nHow is the pilot going?", tags: ["pilot"] })) as { template: { id: string } };
    const id = created.template.id;
    assert.equal(describeAction("save_email_template", { id, subject: "Pilot check in" }, await recordNames(owner, [{ id }])).title, "Update template: Pilot follow up");
    const updated = (await runTool(owner, "save_email_template", { id, subject: "Pilot check in" })) as { template: { subject: string; body: string } };
    assert.equal(updated.template.subject, "Pilot check in");
    assert.match(updated.template.body, /How is the pilot going/);
    assert.equal(describeAction("archive_email_template", { templateId: id }, await recordNames(owner, [{ templateId: id }])).title, "Archive template: Pilot follow up");
    await runTool(owner, "archive_email_template", { templateId: id });
    assert.equal((await listEmailTemplates(owner)).length, 0);
    const events = await getAdminPool().query<{ event_type: string; source: string }>("select event_type, source from crm.audit_events where entity_id = $1 order by created_at, event_type", [id]);
    assert.deepEqual(events.rows.map((row) => row.event_type).sort(), ["email_template.archived", "email_template.created", "email_template.updated"]);
    assert.ok(events.rows.every((row) => row.source === "assistant"));
  });
});
