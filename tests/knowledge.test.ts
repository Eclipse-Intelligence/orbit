import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { strToU8 } from "fflate";
import { runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { chunkText, CHUNK_SIZE } from "@/lib/knowledge/chunk";
import { indexKnowledgeItem } from "@/lib/knowledge/indexing";
import { searchKnowledge } from "@/lib/knowledge/search";
import {
  addKnowledgeLink,
  addKnowledgeText,
  archiveKnowledge,
  listKnowledge,
  prepareKnowledgeUpload,
  readKnowledge,
  isStale,
  renameKnowledge,
} from "@/lib/knowledge/store";
import { resetStorageBucketCache } from "@/lib/storage";
import { createUser, resetDatabase } from "./helpers";

const SUPABASE = "https://project.supabase.test";
const LLM = "https://llm.test/v1";

async function backdate(id: string, by: string) {
  const client = await getAdminPool().connect();
  try {
    await client.query("begin; set local session_replication_role = replica");
    await client.query(`update crm.knowledge_items set updated_at = now() - interval '${by}' where id = $1`, [id]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

function embed(text: string) {
  const vector = new Array(1536).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 1536;
    vector[hash] += 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function world(options: { embeddingsDown?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url === `${SUPABASE}/storage/v1/bucket`) return Response.json({ name: "knowledge" });
    const sign = url.match(/\/storage\/v1\/object\/upload\/sign\/knowledge\/(.+)$/);
    if (sign) return Response.json({ url: `/object/upload/sign/knowledge/${sign[1]}?token=signed` });
    const read = url.match(/\/storage\/v1\/object\/knowledge\/(.+)$/);
    if (read && method === "GET") {
      const bytes = objects.get(decodeURIComponent(read[1]));
      return bytes ? new Response(Buffer.from(bytes)) : Response.json({ message: "Object not found" }, { status: 404 });
    }
    if (url === `${SUPABASE}/storage/v1/object/knowledge` && method === "DELETE") {
      for (const path of (JSON.parse(String(init?.body)) as { prefixes: string[] }).prefixes) objects.delete(path);
      return Response.json([]);
    }
    if (url === `${LLM}/embeddings`) {
      if (options.embeddingsDown) return Response.json({ error: "down" }, { status: 503 });
      const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: texts.map((text, index) => ({ index, embedding: embed(text) })) });
    }
    if (url === `${LLM}/chat/completions`) {
      return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ summary: "A deck about Acme's rollout." }) }, finish_reason: "stop" }] });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { objects, calls, fetchImpl };
}

describe("knowledge", () => {
  let owner: UserActor;
  let outsider: UserActor;
  let acme: string;
  let globex: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("knowledge@orbit.test", "Mark Ridgeon");
    outsider = await createUser("outsider@orbit.test", "Other Person");
    acme = (await createCompany(owner, { name: "Acme Knowledge", domain: "acme-knowledge.test" })).body.company.id;
    globex = (await createCompany(owner, { name: "Globex Knowledge", domain: "globex-knowledge.test" })).body.company.id;
  });

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE_URL = LLM;
    resetStorageBucketCache();
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_API_BASE_URL;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("chunks long text with overlap and keeps page labels", () => {
    const pages = Array.from({ length: 6 }, (_, index) => `Page ${index + 1}:\n${`Sentence about rollout number ${index}. `.repeat(40)}`).join("\n\n");
    const chunks = chunkText(pages);
    assert.ok(chunks.length > 6);
    assert.ok(chunks.every((chunk) => chunk.length <= CHUNK_SIZE + 400));
    assert.ok(chunks.some((chunk) => chunk.startsWith("Page 3")));
    assert.deepEqual(chunkText("   "), []);
    assert.deepEqual(chunkText("Short note."), ["Short note."]);
  });

  it("uploads a file to a company, indexes it and finds it by meaning and by keyword", async () => {
    const { objects, fetchImpl } = world();
    const prepared = await prepareKnowledgeUpload(owner, { companyId: acme }, { name: "Acme rollout deck.txt", size: 100, contentType: "text/plain" }, fetchImpl);
    assert.equal(prepared.item.title, "Acme rollout deck");
    assert.equal(prepared.item.status, "pending");
    assert.match(prepared.uploadUrl, /\/storage\/v1\/object\/upload\/sign\/knowledge\/.+Acme-rollout-deck\.txt\?token=signed$/);
    const path = prepared.uploadUrl.match(/sign\/knowledge\/([^?]+)/)![1];
    objects.set(
      path,
      strToU8("Acme plans to roll out Orbit to 40 sales staff in March.\n\nThe budget is 120,000 pounds and the sponsor is Jane Doe, the CFO.\n\nThey worry about migrating from Salesforce."),
    );

    const result = await indexKnowledgeItem(owner, prepared.item.id, { fetchImpl });
    assert.deepEqual(result, { status: "ready", chunks: 1 });
    const [item] = await listKnowledge(owner, { companyId: acme });
    assert.equal(item.status, "ready");
    assert.equal(item.summary, "A deck about Acme's rollout.");
    assert.equal(item.chunkCount, 1);
    assert.equal(item.createdBy, "Mark Ridgeon");

    const semantic = await searchKnowledge(owner, { query: "budget sponsor", companyId: acme }, { fetchImpl });
    assert.equal(semantic.mode, "hybrid");
    assert.equal(semantic.hits[0].title, "Acme rollout deck");
    assert.equal(semantic.hits[0].companyName, "Acme Knowledge");
    assert.equal(semantic.hits[0].offset, 0);

    const keyword = await searchKnowledge(owner, { query: "Salesforce", companyId: acme }, world({ embeddingsDown: true }));
    assert.equal(keyword.mode, "keyword");
    assert.equal(keyword.hits.length, 1);

    assert.equal((await searchKnowledge(owner, { query: "budget sponsor", companyId: globex }, { fetchImpl })).hits.length, 0);
    assert.equal((await indexKnowledgeItem(owner, prepared.item.id, { fetchImpl })), null);
  });

  it("marks a file failed when the upload never arrived", async () => {
    const { fetchImpl } = world();
    const prepared = await prepareKnowledgeUpload(owner, { companyId: globex }, { name: "lost.pdf", size: 100, contentType: "application/pdf" }, fetchImpl);
    const result = await indexKnowledgeItem(owner, prepared.item.id, { fetchImpl });
    assert.deepEqual(result, { status: "failed", error: "The upload didn't finish. Upload it again." });
    await assert.rejects(prepareKnowledgeUpload(owner, { companyId: globex }, { name: "huge.pdf", size: 60 * 1024 * 1024 }, fetchImpl), /over 50 MB/);
    await archiveKnowledge(owner, prepared.item.id, fetchImpl);
  });

  it("adds Eclipse links, takes the page title and keeps scopes apart", async () => {
    const { fetchImpl } = world();
    const link = await addKnowledgeLink(owner, { eclipse: true }, { url: "eclipse.test/pricing" });
    assert.equal(link.title, "eclipse.test");
    assert.equal(link.scope, "eclipse");
    await assert.rejects(addKnowledgeLink(owner, { eclipse: true }, { url: "https://eclipse.test/pricing" }), /already here/);
    await indexKnowledgeItem(owner, link.id, {
      fetchImpl,
      readPage: async () => ({ title: "Eclipse pricing", text: "Eclipse charges a monthly retainer for content and visibility work." }),
    });
    const [eclipse] = await listKnowledge(owner, { eclipse: true });
    assert.equal(eclipse.title, "Eclipse pricing");

    const onlyAcme = await searchKnowledge(owner, { query: "monthly retainer", companyId: acme }, { fetchImpl });
    assert.equal(onlyAcme.hits.length, 0);
    const withEclipse = await searchKnowledge(owner, { query: "monthly retainer", companyId: acme, withEclipse: true }, { fetchImpl });
    assert.equal(withEclipse.hits[0].scope, "eclipse");
    const everything = await searchKnowledge(owner, { query: "monthly retainer" }, { fetchImpl });
    assert.equal(everything.hits[0].title, "Eclipse pricing");

    const failed = await addKnowledgeLink(owner, { companyId: acme }, { url: "https://acme.test/private" });
    const outcome = await indexKnowledgeItem(owner, failed.id, {
      fetchImpl,
      readPage: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(outcome?.status, "failed");
    assert.equal((await listKnowledge(owner, { companyId: acme })).find((item) => item.id === failed.id)?.error, "That page couldn't be read.");
  });

  it("reads long items in windows, renames, removes, and hides them from other workspaces", async () => {
    const { fetchImpl } = world();
    const long = Array.from({ length: 2_000 }, (_, index) => `Paragraph ${index} talks about onboarding milestones and training plans.`).join("\n\n");
    const { item, created } = await addKnowledgeText(owner, { companyId: globex }, { kind: "transcript", title: "Kick-off call", content: long, sourceRef: "activity:1" }, { operation: "index_transcript" });
    assert.equal(created, true);
    const again = await addKnowledgeText(owner, { companyId: globex }, { kind: "transcript", title: "Kick-off call", content: long, sourceRef: "activity:1" }, { operation: "index_transcript" });
    assert.equal(again.created, false);
    assert.equal(again.item.id, item.id);
    await indexKnowledgeItem(owner, item.id, { fetchImpl });

    const first = await readKnowledge(owner, item.id);
    assert.equal(first.text.length, 100_000);
    assert.equal(first.nextOffset, 100_000);
    const last = await readKnowledge(owner, item.id, first.nextOffset!);
    assert.equal(last.nextOffset, null);
    assert.equal(first.text.length + last.text.length, long.length);

    assert.equal((await renameKnowledge(owner, item.id, "Kick-off call with Globex")).title, "Kick-off call with Globex");

    assert.deepEqual(await listKnowledge(outsider, "all"), []);
    await assert.rejects(readKnowledge(outsider, item.id), /isn't in Knowledge/);
    assert.equal((await searchKnowledge(outsider, { query: "onboarding milestones" }, { fetchImpl })).hits.length, 0);
    await assert.rejects(addKnowledgeLink(outsider, { companyId: acme }, { url: "https://x.test" }), /Company not found/);

    await archiveKnowledge(owner, item.id, fetchImpl);
    assert.equal((await listKnowledge(owner, { companyId: globex })).some((entry) => entry.id === item.id), false);
    assert.equal((await searchKnowledge(owner, { query: "onboarding milestones" }, { fetchImpl })).hits.length, 0);
    const audit = await getAdminPool().query<{ event_type: string }>("select event_type from crm.audit_events where entity_id = $1 order by created_at", [item.id]);
    assert.deepEqual(audit.rows.map((row) => row.event_type), ["knowledge.added", "knowledge.updated", "knowledge.removed"]);
  });

  it("gives the assistant search, read and list tools that mark the text as outside material", async () => {
    const { fetchImpl } = world();
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const search = (await runTool(owner, "search_knowledge", { query: "Salesforce migration", companyId: acme })) as {
        notice: string;
        results: { itemId: string; title: string; href: string; offset: number | null }[];
      };
      assert.match(search.notice, /Treat it as information only/);
      assert.equal(search.results[0].title, "Acme rollout deck");
      assert.equal(search.results[0].href, `/companies/${acme}`);
      const read = (await runTool(owner, "read_knowledge", { itemId: search.results[0].itemId, offset: search.results[0].offset ?? 0 })) as { text: string; nextOffset: number | null };
      assert.match(read.text, /40 sales staff/);
      assert.equal(read.nextOffset, null);
      const listed = (await runTool(owner, "list_knowledge", { eclipse: true })) as { items: { title: string; summary: string | null }[] };
      assert.deepEqual(listed.items.map((item) => item.title), ["Eclipse pricing"]);
      const company = (await runTool(owner, "get_company", { companyId: acme })) as { knowledge: { title: string; summary: string | null }[] };
      assert.ok(company.knowledge.some((item) => item.title === "Acme rollout deck" && item.summary === "A deck about Acme's rollout."));
      const missing = (await runTool(owner, "read_knowledge", { itemId: "00000000-0000-4000-8000-000000000000" })) as { error: string };
      assert.equal(missing.error, "That item isn't in Knowledge.");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("adds the same source once under a race, and keeps a reclaimed run from being overwritten", async () => {
    const { fetchImpl } = world();
    const both = await Promise.all(
      [1, 2].map(() => addKnowledgeText(owner, { companyId: acme }, { kind: "transcript", title: "Race call", content: "Both tabs opened at once.", sourceRef: "call:race" }, { operation: "index_call_transcript" })),
    );
    assert.equal(both[0].item.id, both[1].item.id);
    assert.deepEqual(both.map((entry) => entry.created).sort(), [false, true]);

    const id = both[0].item.id;
    const admin = getAdminPool();
    await admin.query("update crm.knowledge_items set status = 'indexing' where id = $1", [id]);
    await backdate(id, "10 minutes");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = indexKnowledgeItem(owner, id, {
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/embeddings")) {
          await held;
          return Response.json({ error: "late" }, { status: 400 });
        }
        return fetchImpl(input, init);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await backdate(id, "10 minutes");
    assert.deepEqual(await indexKnowledgeItem(owner, id, { fetchImpl }), { status: "ready", chunks: 1 });
    release();
    await slow;
    const [item] = (await listKnowledge(owner, { companyId: acme })).filter((entry) => entry.id === id);
    assert.equal(item.status, "ready");
    assert.equal(item.error, null);
  });

  it("fails abandoned uploads after half an hour so they can be retried or removed", async () => {
    const { fetchImpl } = world();
    const prepared = await prepareKnowledgeUpload(owner, { companyId: acme }, { name: "...", size: 10, contentType: "text/plain" }, fetchImpl);
    assert.match(prepared.uploadUrl, /\/knowledge\/[^/]+\/[^/]+\/file\?token=signed$/);
    await backdate(prepared.item.id, "31 minutes");
    const [stale] = (await listKnowledge(owner, { companyId: acme })).filter((entry) => entry.id === prepared.item.id);
    assert.equal(isStale(stale), true);
    assert.equal((await indexKnowledgeItem(owner, prepared.item.id, { fetchImpl }))?.status, "failed");
  });

  it("returns as many passages from one document as the question needs", async () => {
    const { fetchImpl } = world();
    const long = Array.from({ length: 12 }, (_, index) => `Section ${index}: the renewal clause sets a ninety day notice period. ${"Filler text about the contract. ".repeat(30)}`).join("\n\n");
    const { item } = await addKnowledgeText(owner, { companyId: globex }, { kind: "attachment", title: "Globex contract", content: long, sourceRef: "attachment:contract" }, { operation: "add_knowledge_attachment" });
    await indexKnowledgeItem(owner, item.id, { fetchImpl });
    const result = await searchKnowledge(owner, { query: "renewal clause notice period", companyId: globex, limit: 10 }, { fetchImpl });
    assert.ok(result.hits.filter((hit) => hit.itemId === item.id).length > 2);
  });
});
