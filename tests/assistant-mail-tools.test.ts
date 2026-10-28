import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { prepareAttachment, sweepEmailAttachments } from "@/lib/crm/email-attachments";
import { listEmailTemplates } from "@/lib/crm/email-templates";
import { saveMailbox } from "@/lib/crm/inbox";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listKnowledge } from "@/lib/knowledge/store";
import { listScheduledDrafts, readDraftInput, saveMailDraft, scheduleMailDraft, sendForAgent, sendMailDraft, threadDrafts } from "@/lib/mail/compose";
import { processDueMail } from "@/lib/mail/due";
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
  const unsendable = new Set<string>();
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
    if (url.endsWith("/send")) {
      const id = decodeURIComponent(url.match(/\/me\/messages\/([^/]+)\/send$/)?.[1] ?? "");
      if (unsendable.has(id)) return Response.json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, { status: 404 });
      return new Response(null, { status: 202 });
    }
    if (method === "PATCH") return Response.json({ id: "x" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && url.startsWith(GRAPH)) return graphRead(url);
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, objects, unsendable };
}

function postedFiles(calls: Call[], providerDraft?: string) {
  return calls
    .filter((call) => call.method === "POST" && call.url.endsWith("/attachments") && (!providerDraft || call.url.endsWith(`/${providerDraft}/attachments`)))
    .map((call) => call.body as { name: string; contentBytes: string });
}

async function draftFiles(draftId: string) {
  return (await getAdminPool().query<{ attachments: string[] }>("select attachments from crm.mail_drafts where id = $1", [draftId])).rows[0]?.attachments ?? null;
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
      { storedFiles: "replace", origin: null, fetchImpl: env.fetchImpl },
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

  it("keeps a saved draft's Knowledge file in Orbit, shows it and the recipients on the send card, and attaches it once when sent", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const args = { to: ["jane@acme.test"], subject: "Our deck", body: "Hi Jane,\n\nThe deck is attached.\n\nMark", attachmentIds: [deckId] };
    const card = describeAction("save_email_draft", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("Attachments: Eclipse deck"));
    assert.ok(card.lines.includes("The files stay in Orbit and are attached when Orbit sends it."));
    const result = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", args))) as { saved: boolean; draftId: string; attachments: string[] };
    assert.equal(result.saved, true);
    assert.deepEqual(result.attachments, ["Eclipse deck.pdf"]);
    assert.deepEqual(postedFiles(env.calls), []);
    assert.ok(!graphCalls(env.calls).some((call) => call.endsWith("/send")));
    const stored = await draftFiles(result.draftId);
    assert.equal(stored?.length, 1);
    const admin = getAdminPool();
    assert.equal((await admin.query("select 1 from crm.email_attachments where id = $1", [stored![0]])).rowCount, 1);

    const sendArgs = { draftId: result.draftId, body: args.body };
    const sendCard = describeAction("send_email", sendArgs, await recordNames(owner, [sendArgs]));
    assert.equal(sendCard.title, "Send email: Our deck");
    assert.ok(sendCard.lines.includes("To: jane@acme.test"), sendCard.lines.join("\n"));
    assert.ok(sendCard.lines.includes("Attachments: Eclipse deck.pdf"));
    env.calls.length = 0;
    const sent = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", sendArgs))) as { sent: boolean; to: string[] };
    assert.equal(sent.sent, true);
    assert.deepEqual(sent.to, ["jane@acme.test"]);
    const posted = postedFiles(env.calls);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].name, "Eclipse deck.pdf");
    assert.deepEqual(new Uint8Array(Buffer.from(posted[0].contentBytes, "base64")), DECK);
    assert.ok(graphCalls(env.calls).some((call) => call.endsWith("/send")));
    assert.equal((await admin.query("select 1 from crm.email_attachments where id = $1", [stored![0]])).rowCount, 0);

    const link = (await admin.query<{ id: string }>("insert into crm.knowledge_items (workspace_id, scope, kind, title, source_url, status) values ($1, 'eclipse', 'link', 'Pricing page', 'https://eclipse.test/pricing', 'ready') returning id", [owner.workspaceId])).rows[0].id;
    const refused = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { ...args, attachmentIds: [link] }))) as { error: string };
    assert.match(refused.error, /Pricing page is a link or text in Knowledge, not a file/);
    const empty = (
      await admin.query<{ id: string }>(
        `insert into crm.knowledge_items (workspace_id, scope, kind, title, file_path, mime_type, size_bytes, status, created_by_user_id)
         values ($1, 'eclipse', 'file', 'Blank form', $2, 'application/pdf', 10, 'ready', $3) returning id`,
        [owner.workspaceId, `${owner.workspaceId}/blank/Blank.pdf`, owner.userId],
      )
    ).rows[0].id;
    env.objects.set(`knowledge/${owner.workspaceId}/blank/Blank.pdf`, new Uint8Array());
    const blank = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { ...args, attachmentIds: [empty] }))) as { error: string };
    assert.equal(blank.error, "Blank form is an empty file in Knowledge, so it can't be attached.");
  });

  it("schedules an email with sendAt, shows the time and files on the card, and attaches them when it sends", async () => {
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
    assert.deepEqual(postedFiles(env.calls), []);
    const providerDraft = `draft-${draftCount}`;
    const admin = getAdminPool();
    const row = (await admin.query<{ send_at: Date }>("select send_at from crm.mail_drafts where id = $1", [result.draftId])).rows[0];
    assert.equal(Math.round(row.send_at.getTime() / 60_000), Math.floor(at.getTime() / 60_000));
    assert.equal((await draftFiles(result.draftId))?.length, 1);

    await admin.query("update crm.mail_drafts set send_at = now() - interval '1 minute' where id = $1", [result.draftId]);
    env.calls.length = 0;
    const report = await processDueMail(owner, { fetchImpl: env.fetchImpl, origin: null });
    assert.equal(report.sent, 1);
    assert.deepEqual(postedFiles(env.calls, providerDraft).map((file) => file.name), ["Eclipse deck.pdf"]);
    assert.ok(graphCalls(env.calls).includes(`POST /me/messages/${providerDraft}/send`));
    assert.equal(await draftFiles(result.draftId), null);

    const past = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", { ...args, sendAt: "2020-01-01T09:00" }))) as { error: string };
    assert.equal(past.error, "sendAt has to be in the future.");
  });

  it("shows when a sent email was opened, with a note about automatic opens", async () => {
    const admin = getAdminPool();
    const tracking = (await admin.query<{ id: string }>("insert into crm.mail_tracking (workspace_id, user_id, sender_email, sent_at) values ($1, $2, 'mark@eclipse.test', now()) returning id", [owner.workspaceId, owner.userId])).rows[0].id;
    await admin.query("update crm.mail_messages set tracking_id = $2 where id = $1", [sentEmail, tracking]);
    const unopened = (await runTool(owner, "get_email_thread", { emailId: firstEmail })) as { messages: { id: string; opens: unknown[] | null }[]; readTracking?: string };
    assert.deepEqual(unopened.messages.find((message) => message.id === sentEmail)?.opens, []);
    assert.equal(unopened.readTracking, undefined);
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
    const tooMany = { itemIds: Array.from({ length: 51 }, () => randomUUID()) };
    assert.deepEqual(await runTool(owner, "remove_knowledge", tooMany), { error: "Remove up to 50 items at a time." });
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

  it("sends a draft by draftId to its saved recipients plus anyone added, and shows the merged list on the card", async () => {
    const env = world();
    const bob = (await createContact(owner, { firstName: "Bob", lastName: "Stone", email: "bob@acme.test" })).body.contact.id;
    const saved = (await withFetch(env.fetchImpl, () =>
      runTool(owner, "save_email_draft", { to: ["jane@acme.test"], cc: ["ola@acme.test"], subject: "Pricing", body: "Hi Jane,\n\nPricing below.\n\nMark" }),
    )) as { draftId: string };
    const args = { draftId: saved.draftId, contactId: bob, cc: ["carol@acme.test", "jane@acme.test"], body: "Hi Jane,\n\nPricing below.\n\nMark" };
    const card = describeAction("send_email", args, await recordNames(owner, [args]));
    assert.equal(card.title, "Send email: Pricing");
    assert.ok(card.lines.includes("To: jane@acme.test, bob@acme.test"), card.lines.join("\n"));
    assert.ok(card.lines.includes("Cc: ola@acme.test, carol@acme.test"), card.lines.join("\n"));
    env.calls.length = 0;
    const sent = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", args))) as { sent: boolean; to: string[]; cc: string[]; subject: string };
    assert.equal(sent.sent, true);
    assert.deepEqual(sent.to, ["jane@acme.test", "bob@acme.test"]);
    assert.deepEqual(sent.cc, ["ola@acme.test", "carol@acme.test"]);
    assert.equal(sent.subject, "Pricing");
    const patched = env.calls.find((call) => call.method === "PATCH")!.body as { toRecipients: { emailAddress: { address: string } }[]; ccRecipients: { emailAddress: { address: string } }[] };
    assert.deepEqual(patched.toRecipients.map((item) => item.emailAddress.address), ["jane@acme.test", "bob@acme.test"]);
    assert.deepEqual(patched.ccRecipients.map((item) => item.emailAddress.address), ["ola@acme.test", "carol@acme.test"]);
  });

  it("keeps a scheduled draft in Scheduled with the error when sending it now fails", async () => {
    const env = world();
    const prepared = await prepareAttachment(owner, { name: "Quote.pdf", size: 4, contentType: "application/pdf" }, env.fetchImpl);
    const draft = await scheduleMailDraft(
      owner,
      {
        ...readDraftInput({ mode: "new", sourceId, to: ["jane@acme.test"], subject: "Quote", body: "Hi Jane, the quote is attached." }),
        attachments: [prepared.id],
        sendAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      },
      { storedFiles: "replace", origin: null, fetchImpl: env.fetchImpl },
    );
    const failed = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", { draftId: draft.id, body: "Hi Jane, the quote is attached." }))) as { error: string };
    assert.equal(failed.error, "Quote.pdf didn't finish uploading. Attach it again.");
    const listed = (await listScheduledDrafts(owner)).find((item) => item.id === draft.id);
    assert.equal(listed?.sendError, "Quote.pdf didn't finish uploading. Attach it again.");
    assert.deepEqual(listed?.attachments, [{ id: prepared.id, name: "Quote.pdf", size: 4, contentType: "application/pdf" }]);
    assert.deepEqual(await draftFiles(draft.id), [prepared.id]);
    await getAdminPool().query("delete from crm.mail_drafts where id = $1", [draft.id]);
  });

  it("lists, changes and cancels a scheduled email, keeps its files, and refuses once it is sending or sent", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const first = new Date(Date.now() + 2 * 24 * 3_600_000);
    const later = new Date(Date.now() + 3 * 24 * 3_600_000);
    const scheduled = (await withFetch(env.fetchImpl, () =>
      runTool(owner, "send_email", { to: ["jane@acme.test"], subject: "Renewal", body: "Hi Jane,\n\nThe renewal.\n\nMark", sendAt: londonInput(first), attachmentIds: [deckId] }),
    )) as { draftId: string };
    const draftId = scheduled.draftId;
    const listed = (await runTool(owner, "list_scheduled_emails", {})) as { scheduled: { id: string; to: string[]; subject: string; sendAt: string; attachments: string[]; didNotSend: string | null }[] };
    const entry = listed.scheduled.find((item) => item.id === draftId)!;
    assert.deepEqual([entry.to, entry.subject, entry.attachments, entry.didNotSend], [["jane@acme.test"], "Renewal", ["Eclipse deck.pdf"], null]);

    const change = { draftId, sendAt: londonInput(later), subject: "Renewal terms", cc: ["ola@acme.test"], body: "Hi Jane,\n\nThe renewal terms.\n\nMark" };
    const card = describeAction("change_scheduled_email", change, await recordNames(owner, [change], ["change_scheduled_email"]));
    assert.equal(card.title, "Change scheduled email: Renewal");
    assert.equal(card.lines[0], "To: jane@acme.test");
    assert.match(card.lines[1], /^Due: \w{3} \d{1,2} \w{3}, \d{2}:\d{2} \(London time\)$/);
    assert.match(card.lines[2], /^Now sends: \w{3} \d{1,2} \w{3}, \d{2}:\d{2} \(London time\)$/);
    assert.deepEqual(card.lines.slice(3), ["New subject: Renewal terms", "New Cc: ola@acme.test", "Files stay attached: Eclipse deck.pdf", "New message:", change.body]);
    env.calls.length = 0;
    const changed = (await withFetch(env.fetchImpl, () => runTool(owner, "change_scheduled_email", change))) as { changed: boolean; id: string; subject: string; cc: string[]; attachments: string[]; sendAt: string };
    assert.equal(changed.changed, true);
    assert.deepEqual([changed.id, changed.subject, changed.cc, changed.attachments], [draftId, "Renewal terms", ["ola@acme.test"], ["Eclipse deck.pdf"]]);
    const patched = env.calls.find((call) => call.method === "PATCH")!.body as { subject: string };
    assert.equal(patched.subject, "Renewal terms");
    assert.ok(!graphCalls(env.calls).some((call) => call.endsWith("/send")));
    const admin = getAdminPool();
    const row = (await admin.query<{ send_at: Date; body: string }>("select send_at, body from crm.mail_drafts where id = $1", [draftId])).rows[0];
    assert.equal(Math.round(row.send_at.getTime() / 60_000), Math.floor(later.getTime() / 60_000));
    assert.equal(row.body, change.body);
    assert.equal((await draftFiles(draftId))?.length, 1);
    assert.equal(((await runTool(owner, "change_scheduled_email", { draftId })) as { error: string }).error, "Say what to change: sendAt, subject, body, to, cc or bcc.");

    await admin.query("update crm.mail_drafts set send_at = null where id = $1", [draftId]);
    const sending = "That email isn't waiting to send any more. Either it's sending now (check Sent in Mail) or it was unscheduled and is in Drafts.";
    assert.equal(((await withFetch(env.fetchImpl, () => runTool(owner, "change_scheduled_email", change))) as { error: string }).error, sending);
    assert.equal(((await runTool(owner, "cancel_scheduled_email", { draftId })) as { error: string }).error, sending);
    const refusedCard = describeAction("cancel_scheduled_email", { draftId }, await recordNames(owner, [{ draftId }], ["cancel_scheduled_email"]));
    assert.equal(refusedCard.lines[0], "This email isn't scheduled any more, so this will be refused.");

    await admin.query("update crm.mail_drafts set send_at = $2 where id = $1", [draftId, later]);
    const cancelCard = describeAction("cancel_scheduled_email", { draftId }, await recordNames(owner, [{ draftId }], ["cancel_scheduled_email"]));
    assert.equal(cancelCard.title, "Cancel scheduled email: Renewal terms");
    assert.equal(cancelCard.lines[0], "To: jane@acme.test");
    assert.match(cancelCard.lines[1], /^Due: /);
    assert.equal(cancelCard.lines[2], "It stays in Drafts, so you can send it or change it later.");
    const cancelled = (await runTool(owner, "cancel_scheduled_email", { draftId })) as { cancelled: boolean; kept: string; draftId: string };
    assert.deepEqual([cancelled.cancelled, cancelled.kept, cancelled.draftId], [true, "in Drafts", draftId]);
    const kept = (await admin.query<{ send_at: Date | null }>("select send_at from crm.mail_drafts where id = $1", [draftId])).rows[0];
    assert.equal(kept.send_at, null);
    assert.ok(!(await listScheduledDrafts(owner)).some((item) => item.id === draftId));
    assert.equal((await draftFiles(draftId))?.length, 1);

    await admin.query("delete from crm.mail_drafts where id = $1", [draftId]);
    const gone = "That scheduled email isn't in Orbit Mail any more. It has probably been sent or discarded, so check Sent in Mail.";
    assert.equal(((await runTool(owner, "cancel_scheduled_email", { draftId })) as { error: string }).error, gone);
    assert.equal(((await withFetch(env.fetchImpl, () => runTool(owner, "change_scheduled_email", change))) as { error: string }).error, gone);
  });

  it("reattaches a saved draft's files when Outlook has lost the draft", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const body = "Hi Jane,\n\nThe deck again.\n\nMark";
    const saved = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { to: ["jane@acme.test"], subject: "Deck again", body, attachmentIds: [deckId] }))) as { draftId: string };
    const lost = `draft-${draftCount}`;
    env.unsendable.add(lost);
    env.calls.length = 0;
    const sent = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", { draftId: saved.draftId, body }))) as { sent: boolean };
    assert.equal(sent.sent, true);
    const fresh = `draft-${draftCount}`;
    assert.notEqual(fresh, lost);
    assert.deepEqual(postedFiles(env.calls, fresh).map((file) => file.name), ["Eclipse deck.pdf"]);
    assert.ok(graphCalls(env.calls).includes(`POST /me/messages/${fresh}/send`));
  });

  it("keeps a saved draft's files when it's sent from a different account", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const admin = getAdminPool();
    const account = (
      await admin.query<{ id: string }>(
        `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, access_token, access_token_expires_at, can_send)
         values ($1, $2, 'microsoft', 'mark@consulting.test', 'connected', $3, $4, now() + interval '1 hour', true) returning id`,
        [owner.workspaceId, owner.userId, encryptSecret("acct-refresh"), encryptSecret("acct-access")],
      )
    ).rows[0].id;
    await admin.query("insert into crm.mail_sources (workspace_id, user_id, account_id, email) values ($1, $2, $3, 'mark@consulting.test')", [owner.workspaceId, owner.userId, account]);
    const body = "Hi Jane,\n\nThe deck from my consulting address.\n\nMark";
    const saved = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { to: ["jane@acme.test"], subject: "Deck", body, attachmentIds: [deckId] }))) as { draftId: string };
    const original = `draft-${draftCount}`;
    const args = { draftId: saved.draftId, from: "mark@consulting.test", body };
    const card = describeAction("send_email", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("From: mark@consulting.test"));
    assert.ok(card.lines.includes("Attachments: Eclipse deck.pdf"));
    env.calls.length = 0;
    const sent = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", args))) as { sent: boolean };
    assert.equal(sent.sent, true);
    const moved = `draft-${draftCount}`;
    assert.notEqual(moved, original);
    assert.ok(graphCalls(env.calls).includes(`DELETE /me/messages/${original}`));
    assert.deepEqual(postedFiles(env.calls, moved).map((file) => file.name), ["Eclipse deck.pdf"]);
    assert.ok(graphCalls(env.calls).includes(`POST /me/messages/${moved}/send`));
  });

  it("shows a draft's stored files when it's opened in compose, and sends only the files compose still lists", async () => {
    const env = world();
    env.objects.set(`knowledge/${owner.workspaceId}/deck/Eclipse-deck.pdf`, DECK);
    const body = "Hi Jane,\n\nTwo files attached.\n\nMark";
    const open = async (draftId: string) => {
      const threadKey = (await getAdminPool().query<{ thread_key: string }>("select thread_key from crm.mail_drafts where id = $1", [draftId])).rows[0].thread_key;
      const { drafts } = await withActor(owner, (db) => threadDrafts(db, owner, sourceId, threadKey));
      return drafts.find((item) => item.id === draftId)!;
    };
    const twoFiles = async () => {
      const saved = (await withFetch(env.fetchImpl, () => runTool(owner, "save_email_draft", { to: ["jane@acme.test"], subject: "Two files", body, attachmentIds: [deckId] }))) as { draftId: string };
      const deck = (await open(saved.draftId)).attachments![0];
      const notes = await prepareAttachment(owner, { name: "Notes.txt", size: 3, contentType: "text/plain" }, env.fetchImpl);
      env.objects.set(`email-attachments/${notes.id}`, new Uint8Array([1, 2, 3]));
      const input = readDraftInput({ id: saved.draftId, mode: "new", sourceId, to: ["jane@acme.test"], subject: "Two files", body });
      await saveMailDraft(owner, { ...input, attachments: [deck.id, notes.id] }, { origin: null, fetchImpl: env.fetchImpl, storedFiles: "replace" });
      return { draftId: saved.draftId, input, deck, notes };
    };

    const first = await twoFiles();
    assert.deepEqual((await open(first.draftId)).attachments, [
      { id: first.deck.id, name: "Eclipse deck.pdf", size: DECK.byteLength, contentType: "application/pdf" },
      { id: first.notes.id, name: "Notes.txt", size: 3, contentType: "text/plain" },
    ]);
    await saveMailDraft(owner, { ...first.input, attachments: [first.notes.id] }, { origin: null, fetchImpl: env.fetchImpl, storedFiles: "replace" });
    assert.deepEqual((await open(first.draftId)).attachments?.map((file) => file.name), ["Notes.txt"]);
    await saveMailDraft(owner, { ...first.input, attachments: [first.deck.id, first.notes.id] }, { origin: null, fetchImpl: env.fetchImpl, storedFiles: "replace" });
    env.calls.length = 0;
    await sendMailDraft(owner, { ...first.input, attachments: [first.notes.id] }, { origin: null, fetchImpl: env.fetchImpl, storedFiles: "replace" });
    assert.deepEqual(postedFiles(env.calls).map((file) => file.name), ["Notes.txt"]);

    const second = await twoFiles();
    env.calls.length = 0;
    const sent = (await withFetch(env.fetchImpl, () => runTool(owner, "send_email", { draftId: second.draftId, body }))) as { sent: boolean };
    assert.equal(sent.sent, true);
    assert.deepEqual(postedFiles(env.calls).map((file) => file.name), ["Eclipse deck.pdf", "Notes.txt"]);
  });
});
