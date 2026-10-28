import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { deleteConversation, getConversation, history, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { discardChatFiles, prepareChatFile, readChatFile, sweepChatFiles } from "@/lib/assistant/files";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import { sweepEmailAttachments } from "@/lib/crm/email-attachments";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

const SUPABASE = "https://project.supabase.test";

type Call = { method: string; url: string };

function storage() {
  const objects = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: "bucket" });
    const sign = url.match(/\/storage\/v1\/object\/upload\/sign\/(email-attachments|knowledge)\/(.+)$/);
    if (sign) return Response.json({ url: `/object/upload/sign/${sign[1]}/${sign[2]}?token=signed` });
    const object = url.match(/\/storage\/v1\/object\/(email-attachments|knowledge)\/(.+)$/);
    if (object && method === "GET") {
      const bytes = objects.get(`${object[1]}/${decodeURIComponent(object[2])}`);
      return bytes ? new Response(Buffer.from(bytes)) : Response.json({ message: "Object not found" }, { status: 404 });
    }
    if (object && method === "POST") {
      objects.set(`${object[1]}/${decodeURIComponent(object[2])}`, new Uint8Array(await (init?.body as Blob).arrayBuffer()));
      return Response.json({ Key: object[2] });
    }
    const bucket = url.match(/\/storage\/v1\/object\/(email-attachments|knowledge)$/);
    if (bucket && method === "DELETE") {
      for (const path of (JSON.parse(String(init?.body)) as { prefixes: string[] }).prefixes) objects.delete(`${bucket[1]}/${path}`);
      return Response.json([]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls, objects };
}

function gateway(replies: string[]) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      model: "claude-sonnet-5-5",
      choices: [{ message: { role: "assistant", content: replies.shift() ?? "Done." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
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

const deadline = () => Date.now() + 120_000;

describe("chat files", () => {
  let owner: UserActor;
  let other: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("chatfiles@orbit.test", "Mark Ridgeon");
    other = await createUser("chatfiles-other@orbit.test", "Jane Doe");
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.LLM_API_KEY = "test-key";
    resetStorageBucketCache();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.LLM_API_KEY;
  });

  after(async () => {
    await getPool().end();
  });

  async function upload(env: ReturnType<typeof storage>, name: string, bytes: Uint8Array, contentType: string, actor = owner) {
    const prepared = await prepareChatFile(actor, { name, size: bytes.byteLength, contentType }, env.fetchImpl);
    env.objects.set(`email-attachments/chat/${prepared.id}`, bytes);
    return prepared.id;
  }

  async function sendWith(actor: UserActor, message: string, files: string[], replies = ["Got it."]) {
    const fake = gateway(replies);
    const events: AssistantEvent[] = [];
    await sendMessage(actor, { message, model: "claude-sonnet-5-5", reasoning: "medium", webSearch: false, files }, (event) => events.push(event), {
      deadline: deadline(),
      fetchImpl: fake.fetchImpl,
    });
    const conversation = (events.find((event) => event.type === "conversation") as Extract<AssistantEvent, { type: "conversation" }>).conversation;
    return { conversation, requests: fake.requests, events };
  }

  it("prepares a signed upload in private storage and refuses empty and oversized files", async () => {
    const env = storage();
    const prepared = await prepareChatFile(owner, { name: "Brief.pdf", size: 2048, contentType: "application/pdf" }, env.fetchImpl);
    assert.match(prepared.uploadUrl, new RegExp(`^${SUPABASE}/storage/v1/object/upload/sign/email-attachments/chat/${prepared.id}\\?token=signed$`));
    const row = (await getAdminPool().query("select user_id, name, content_type, size, message_id from crm.chat_files where id = $1", [prepared.id])).rows[0];
    assert.deepEqual(row, { user_id: owner.userId, name: "Brief.pdf", content_type: "application/pdf", size: 2048, message_id: null });
    await assert.rejects(prepareChatFile(owner, { name: "Huge.zip", size: 26 * 1024 * 1024 }, env.fetchImpl), /Huge\.zip is 26 MB\. Files can be up to 25 MB/);
    await assert.rejects(prepareChatFile(owner, { name: "Blank.txt", size: 0 }, env.fetchImpl), /Blank\.txt is empty/);
    await discardChatFiles(owner, [prepared.id], env.fetchImpl);
    assert.equal((await getAdminPool().query("select 1 from crm.chat_files where id = $1", [prepared.id])).rowCount, 0);
  });

  it("puts the files on the message, tells the model about them and keeps them in the history", async () => {
    const env = storage();
    const brief = await upload(env, "Brief.txt", new TextEncoder().encode("The pilot covers three markets."), "text/plain");
    const photo = await upload(env, "Whiteboard.png", new Uint8Array([137, 80, 78, 71]), "image/png");
    const { conversation, requests, events } = await sendWith(owner, "What does the brief say?", [brief, photo]);
    const sent = requests[0].messages.at(-1)!;
    assert.equal(sent.role, "user");
    assert.match(sent.content, /^What does the brief say\?\n\n\[Orbit note: the user attached these files/);
    assert.ok(sent.content.includes(`- Brief.txt (text/plain, 1 KB, chat file id ${brief})`), sent.content);
    assert.ok(sent.content.includes(`- Whiteboard.png (image/png, 1 KB, chat file id ${photo}, an image you can't see)`), sent.content);
    const user = (events.find((event) => event.type === "user") as Extract<AssistantEvent, { type: "user" }>).message;
    assert.deepEqual(user.files.map((file) => file.name), ["Brief.txt", "Whiteboard.png"]);
    const saved = await getConversation(owner, conversation.id);
    assert.equal(saved.messages[0].content, "What does the brief say?");
    assert.deepEqual(saved.messages[0].files.map((file) => file.id), [brief, photo]);
    const rows = await getAdminPool().query<{ conversation_id: string; message_id: string }>("select conversation_id, message_id from crm.chat_files where id = any($1::uuid[])", [[brief, photo]]);
    assert.ok(rows.rows.every((row) => row.conversation_id === conversation.id && row.message_id === saved.messages[0].id));

    await assert.rejects(sendWith(owner, "Again", [brief]), /A file has expired\. Attach it again\./);

    const only = await upload(env, "Notes.md", new TextEncoder().encode("# Notes"), "text/markdown");
    const alone = await sendWith(owner, "", [only]);
    assert.equal(alone.conversation.title, "Notes.md");
    assert.match(alone.requests[0].messages.at(-1)!.content, /^\[Orbit note: the user attached this file/);
  });

  it("reads a long file in parts and keeps the text so it's only extracted once", async () => {
    const env = storage();
    const text = Array.from({ length: 3_000 }, (_, index) => `Line ${index}: the rollout plan covers pricing, markets and the launch date.`).join("\n");
    assert.ok(text.length > 200_000);
    const id = await upload(env, "Plan.txt", new TextEncoder().encode(text), "text/plain");
    const first = await readChatFile(owner, id, 0, env.fetchImpl);
    assert.equal(first.offset, 0);
    assert.equal(first.characters, text.length);
    assert.equal(first.text, text.slice(0, 100_000));
    assert.equal(first.nextOffset, 100_000);
    const reads = env.calls.filter((call) => call.method === "GET").length;
    const second = await readChatFile(owner, id, first.nextOffset!, env.fetchImpl);
    const third = await readChatFile(owner, id, second.nextOffset!, env.fetchImpl);
    assert.equal(first.text + second.text + third.text, text);
    assert.equal(third.nextOffset, null);
    assert.equal(env.calls.filter((call) => call.method === "GET").length, reads);

    const tool = (await withFetch(env.fetchImpl, () => runTool(owner, "read_chat_file", { fileId: id, offset: 200_000 }))) as { notice: string; text: string; nextOffset: number | null };
    assert.match(tool.notice, /outside Orbit/);
    assert.equal(tool.text, text.slice(200_000));

    const photo = await upload(env, "Logo.png", new Uint8Array([1, 2, 3]), "image/png");
    const image = (await withFetch(env.fetchImpl, () => runTool(owner, "read_chat_file", { fileId: photo }))) as { image: boolean; text: null; note: string };
    assert.equal(image.image, true);
    assert.equal(image.text, null);
    assert.match(image.note, /can't pass images to the model yet/);
    const zip = await upload(env, "Bundle.zip", new Uint8Array([80, 75, 3, 4]), "application/zip");
    const unreadable = (await withFetch(env.fetchImpl, () => runTool(owner, "read_chat_file", { fileId: zip }))) as { error: string };
    assert.match(unreadable.error, /Orbit can't read text from Bundle\.zip\. PDF, Word/);
  });

  it("keeps another person's chat files out of reach", async () => {
    const env = storage();
    const id = await upload(env, "Private.txt", new TextEncoder().encode("Salary notes."), "text/plain");
    assert.deepEqual(await queryAsUser(other.userId, "select id from crm.chat_files"), []);
    assert.equal((await queryAsUser(owner.userId, "select id from crm.chat_files where id = $1", [id])).length, 1);
    const read = (await withFetch(env.fetchImpl, () => runTool(other, "read_chat_file", { fileId: id }))) as { error: string };
    assert.match(read.error, /That file isn't in your chats/);
    const email = (await withFetch(env.fetchImpl, () => runTool(other, "send_email", { to: ["x@acme.test"], subject: "Hi", body: "Hi", attachmentIds: [id] }))) as { error: string };
    assert.match(email.error, /isn't in Knowledge, on the draft or in your chats/);
    const filed = (await withFetch(env.fetchImpl, () => runTool(other, "add_to_knowledge", { chatFileId: id, eclipse: true }))) as { error: string };
    assert.match(filed.error, /That file isn't in your chats/);
    await assert.rejects(sendWith(other, "Read this", [id]), /A file has expired/);
    const names = await recordNames(other, [{ fileId: id }]);
    assert.equal(names.get(id), undefined);
    await discardChatFiles(other, [id], env.fetchImpl);
    assert.equal((await getAdminPool().query("select 1 from crm.chat_files where id = $1", [id])).rowCount, 1);
  });

  it("adds a chat file to Knowledge as a file, once, with a card that names it", async () => {
    const env = storage();
    const company = (await createCompany(owner, { name: "Acme", domain: "acme-chat.test" })).body.company;
    const bytes = new TextEncoder().encode("Acme's pricing is £40,000 a year.");
    const id = await upload(env, "Acme pricing.txt", bytes, "text/plain");
    const args = { chatFileId: id, companyId: company.id };
    assert.deepEqual(describeAction("add_to_knowledge", args, await recordNames(owner, [args])), {
      title: "Add to Knowledge for Acme",
      lines: ["File: Acme pricing.txt", "Everyone in the workspace can see Knowledge."],
    });
    const added = (await withFetch(env.fetchImpl, () => runTool(owner, "add_to_knowledge", args))) as { added: boolean; item: { id: string; title: string; kind: string; companyId: string } };
    assert.equal(added.added, true);
    assert.equal(added.item.title, "Acme pricing");
    assert.equal(added.item.kind, "file");
    assert.equal(added.item.companyId, company.id);
    const item = (await getAdminPool().query<{ file_path: string; status: string; mime_type: string }>("select file_path, status, mime_type from crm.knowledge_items where id = $1", [added.item.id])).rows[0];
    assert.equal(item.status, "pending");
    assert.equal(item.mime_type, "text/plain");
    assert.deepEqual(env.objects.get(`knowledge/${item.file_path}`), bytes);
    const audit = await getAdminPool().query<{ source: string }>("select source from crm.audit_events where event_type = 'knowledge.added' and entity_id = $1", [added.item.id]);
    assert.equal(audit.rows[0].source, "assistant");
    const again = (await withFetch(env.fetchImpl, () => runTool(owner, "add_to_knowledge", args))) as { added: boolean; alreadyThere: boolean; item: { id: string } };
    assert.equal(again.alreadyThere, true);
    assert.equal(again.item.id, added.item.id);
    assert.ok(env.objects.has(`email-attachments/chat/${id}`));

    const photo = await upload(env, "Logo.png", new Uint8Array([1, 2, 3]), "image/png");
    const refused = (await withFetch(env.fetchImpl, () => runTool(owner, "add_to_knowledge", { chatFileId: photo, eclipse: true }))) as { error: string };
    assert.match(refused.error, /Knowledge can't read Logo\.png/);
    const missing = describeAction("add_to_knowledge", { chatFileId: "00000000-0000-4000-8000-000000000009", eclipse: true }, new Map());
    const both = (await withFetch(env.fetchImpl, () => runTool(owner, "add_to_knowledge", { chatFileId: id, urls: ["https://acme-chat.test"], companyId: company.id }))) as { error: string };
    assert.match(both.error, /one at a time/);
    assert.deepEqual(missing.lines[0], "File: A file Orbit can't find");
  });

  it("sweeps unsent files after a day but keeps files a conversation still has", async () => {
    const env = storage();
    const kept = await upload(env, "Kept.txt", new TextEncoder().encode("Keep me."), "text/plain");
    const unsent = await upload(env, "Unsent.txt", new TextEncoder().encode("Forget me."), "text/plain");
    const fresh = await upload(env, "Fresh.txt", new TextEncoder().encode("Too new."), "text/plain");
    await sendWith(owner, "Here you go", [kept]);
    await getAdminPool().query("update crm.chat_files set created_at = now() - interval '3 days' where id = any($1::uuid[])", [[kept, unsent]]);
    assert.equal(await sweepEmailAttachments(env.fetchImpl), 0);
    assert.ok(await sweepChatFiles(env.fetchImpl) >= 1);
    const left = (await getAdminPool().query<{ id: string }>("select id from crm.chat_files where id = any($1::uuid[])", [[kept, unsent, fresh]])).rows.map((row) => row.id);
    assert.deepEqual(left.sort(), [kept, fresh].sort());
    assert.ok(env.objects.has(`email-attachments/chat/${kept}`));
    assert.ok(!env.objects.has(`email-attachments/chat/${unsent}`));
  });

  it("deletes a conversation's files with it, and the sweep catches files whose conversation went another way", async () => {
    const env = storage();
    const first = await upload(env, "One.txt", new TextEncoder().encode("One."), "text/plain");
    const second = await upload(env, "Two.txt", new TextEncoder().encode("Two."), "text/plain");
    const { conversation } = await sendWith(owner, "Two files", [first, second]);
    await assert.rejects(deleteConversation(other, conversation.id, env.fetchImpl), /Conversation not found/);
    await deleteConversation(owner, conversation.id, env.fetchImpl);
    assert.equal((await getAdminPool().query("select 1 from crm.chat_files where id = any($1::uuid[])", [[first, second]])).rowCount, 0);
    assert.ok(!env.objects.has(`email-attachments/chat/${first}`));
    assert.ok(!env.objects.has(`email-attachments/chat/${second}`));

    const orphan = await upload(env, "Orphan.txt", new TextEncoder().encode("Orphan."), "text/plain");
    const cascade = await sendWith(owner, "One more", [orphan]);
    await getAdminPool().query("delete from crm.assistant_conversations where id = $1", [cascade.conversation.id]);
    const row = (await getAdminPool().query<{ conversation_id: string | null; message_id: string | null }>("select conversation_id, message_id from crm.chat_files where id = $1", [orphan])).rows[0];
    assert.deepEqual(row, { conversation_id: null, message_id: null });
    await getAdminPool().query("update crm.chat_files set created_at = now() - interval '2 days' where id = $1", [orphan]);
    await sweepChatFiles(env.fetchImpl);
    assert.equal((await getAdminPool().query("select 1 from crm.chat_files where id = $1", [orphan])).rowCount, 0);
  });

  it("leaves rows built without files alone in the history", () => {
    const rows = [{ id: "1", role: "user" as const, content: "Hi", tool_calls: null, tool_call_id: null, tool_name: null, actions: null, sources: null, provider_state: null, created_at: new Date() }];
    assert.deepEqual(history(rows), [{ role: "user", content: "Hi" }]);
  });
});
