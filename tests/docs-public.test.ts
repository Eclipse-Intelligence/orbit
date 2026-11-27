import "./svg-stub";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET as pdfRoute } from "@/app/api/d/[token]/pdf/route";
import { GET as readRoute, PATCH as patchRoute } from "@/app/api/v1/docs/[id]/route";
import PublicDocPage, { generateMetadata } from "@/app/d/[token]/page";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { removeMember } from "@/lib/crm/team";
import { createWebhook, deliverDueWebhooks } from "@/lib/crm/webhooks";
import { scopesForRole } from "@/lib/crm/scopes";
import type { Actor, AgentActor, UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { openDailyNote } from "@/lib/docs/daily-notes";
import { takeOverFormerMemberDocs } from "@/lib/docs/admin";
import { hashPublicToken } from "@/lib/docs/public-link";
import { openPublicDoc, publicDocPdf } from "@/lib/docs/public";
import { archiveDoc, createDoc, getDoc, restoreDoc, setDocPublic } from "@/lib/docs/store";
import { createCrmMcpServer } from "@/server/mcp/server";
import { createAgent, createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;
let priya: UserActor;
let agent: AgentActor;
let agentToken = "";
let otherAgent: AgentActor;

function tokenOf(url: string | null) {
  const match = /\/d\/([A-Za-z0-9_-]{32})$/.exec(url ?? "");
  assert.ok(match, `a public url, got ${url}`);
  return match[1];
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pageParams = (token: string) => ({ params: Promise.resolve({ token }) });

async function connect(actor: Actor) {
  const server = createCrmMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "public-docs", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? "";
      return { error: result.isError ? text : null, value: result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function audited(docId: string) {
  const rows = await getAdminPool().query<{ event_type: string; changes: Record<string, unknown>; actor_type: string; source: string | null }>(
    "select event_type, changes, actor_type, source from crm.audit_events where entity_id = $1 and event_type = 'page.public_changed' order by created_at",
    [docId],
  );
  return rows.rows;
}

before(async () => {
  process.env.SITE_URL = "https://orbit.test";
  await resetDatabase();
  mark = await createUser("mark@docs-public.test", "Mark Ridgeon");
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user('priya@docs-public.test', 'password-123', 'Priya Shah') as id")).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, id]);
  priya = { ...mark, userId: id, email: "priya@docs-public.test", fullName: "Priya Shah", role: "member", scopes: scopesForRole("member") };
  const made = await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Claude Code");
  agent = made.actor;
  agentToken = made.token;
  otherAgent = (await createAgent(mark.workspaceId, ["crm:read", "docs:read", "docs:write"], "Other agent")).actor;
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
});

after(async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.SITE_URL;
  await getPool().end();
  await getAdminPool().end();
});

describe("Public docs: the link", () => {
  useServerlessPool();

  it("is off by default and independent of sharing", async () => {
    const doc = await createDoc(mark, { title: "Private by default", content: "Body" });
    const detail = await getDoc(mark, doc.id);
    assert.equal(detail.public, false);
    assert.equal(detail.allowDownload, false);
    assert.equal(detail.publicUrl, null);
    assert.equal(detail.visibility, "private");
    assert.equal(detail.canChangePublic, true);

    const made = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(made.public, true);
    assert.equal(made.visibility, "private");
    assert.equal(made.allowDownload, false);
    assert.match(made.publicUrl ?? "", /^https:\/\/orbit\.test\/d\/[A-Za-z0-9_-]{32}$/);
    await assert.rejects(getDoc(priya, doc.id), /private to someone else/);
  });

  it("lets a token read only its own doc, with the same url every time it is turned on", async () => {
    const first = await createDoc(mark, { title: "First doc", content: "First body" });
    const second = await createDoc(mark, { title: "Second doc", content: "Second body" });
    const firstUrl = (await setDocPublic(mark, first.id, { public: true })).publicUrl;
    const secondUrl = (await setDocPublic(mark, second.id, { public: true })).publicUrl;
    const firstToken = tokenOf(firstUrl);
    const secondToken = tokenOf(secondUrl);
    assert.notEqual(firstToken, secondToken);
    assert.equal((await openPublicDoc(firstToken))?.title, "First doc");
    assert.equal((await openPublicDoc(firstToken))?.content, "First body");
    assert.equal((await openPublicDoc(secondToken))?.title, "Second doc");

    const off = await setDocPublic(mark, first.id, { public: false });
    assert.equal(off.public, false);
    assert.equal(off.publicUrl, null);
    assert.equal(await openPublicDoc(firstToken), null);
    assert.equal((await openPublicDoc(secondToken))?.title, "Second doc");

    const on = await setDocPublic(mark, first.id, { public: true });
    assert.equal(on.publicUrl, firstUrl);
    assert.equal((await openPublicDoc(firstToken))?.title, "First doc");
  });

  it("stores only a hash and a sealed copy of the token, never the token", async () => {
    const doc = await createDoc(mark, { title: "Stored safely" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    const row = (await getAdminPool().query<{ public_token_hash: string; public_token_enc: string }>("select public_token_hash, public_token_enc from crm.pages where id = $1", [doc.id])).rows[0];
    assert.equal(row.public_token_hash, hashPublicToken(token));
    assert.ok(!row.public_token_enc.includes(token));
    const everything = JSON.stringify((await getAdminPool().query("select * from crm.pages where id = $1", [doc.id])).rows[0]);
    assert.ok(!everything.includes(token));
  });

  it("shows the current content every time", async () => {
    const doc = await createDoc(mark, { title: "Live", content: "Before" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    assert.equal((await openPublicDoc(token))?.content, "Before");
    await getAdminPool().query("update crm.pages set content = 'After' where id = $1", [doc.id]);
    assert.equal((await openPublicDoc(token))?.content, "After");
  });

  it("returns not found for unknown, malformed, archived and daily docs", async () => {
    assert.equal(await openPublicDoc("A".repeat(32)), null);
    assert.equal(await openPublicDoc("short"), null);
    assert.equal(await openPublicDoc("../../etc/passwd"), null);
    assert.equal(await openPublicDoc(""), null);

    const doc = await createDoc(mark, { title: "Archivable", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    await archiveDoc(mark, doc.id);
    assert.equal(await openPublicDoc(token), null);
    await restoreDoc(mark, doc.id);
    assert.equal((await openPublicDoc(token))?.title, "Archivable");

    const daily = (await openDailyNote(mark)).page;
    await assert.rejects(setDocPublic(mark, daily.id, { public: true }), /Daily notes are private/);
    await assert.rejects(getAdminPool().query("update crm.pages set public_enabled = true where id = $1", [daily.id]), /pages_daily_not_public|pages_public_has_token/);
    assert.equal((await getDoc(mark, daily.id)).canChangePublic, false);
  });

  it("keeps the private definer function out of reach of signed-in roles", async () => {
    await assert.rejects(queryAsUser(mark.userId, "select * from private.public_page_link('x')"), /permission denied/);
    const columns = await getAdminPool().query("select * from private.public_page_link('x')");
    assert.deepEqual(columns.fields.map((field) => field.name), ["title", "content", "edited_at", "allow_download", "expires_at", "public_slug", "forward_token_enc", "allow_comments"]);
  });

  it("exposes only the title, text, updated date and download flag", async () => {
    const doc = await createDoc(mark, { title: "Payload", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    const opened = await openPublicDoc(token);
    assert.deepEqual(Object.keys(opened ?? {}).sort(), ["allowComments", "allowDownload", "content", "expiresAt", "redirectTo", "title", "updatedAt"]);
    assert.ok(!JSON.stringify(opened).includes(doc.id));
    assert.ok(!JSON.stringify(opened).includes(mark.workspaceId));
    assert.ok(!JSON.stringify(opened).includes(mark.userId));
    assert.ok(!JSON.stringify(opened).includes("Ridgeon"));
  });
});

describe("Public docs: the page and the PDF", () => {
  useServerlessPool();

  it("renders mentions as plain chips and wikilinks and tags as plain text, with nothing that identifies a record", async () => {
    const contactId = "11111111-2222-4333-8444-555555555555";
    const content = [
      "## Summary",
      "",
      `Prepared for @[Dan Price](contact:${contactId}). See [[Website rebuild plan]] and [[Hidden target|Shown label]]. #climateworks`,
      "",
      "A [real link](https://example.com/page) too.",
      "",
      "| Post | Clicks |",
      "| --- | ---: |",
      "| One | 5 |",
    ].join("\n");
    const doc = await createDoc(mark, { title: "Public page", content });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true, allowDownload: true })).publicUrl);
    const html = renderToStaticMarkup(await PublicDocPage(pageParams(token)));
    assert.match(html, /Public page/);
    assert.match(html, /Updated \d{1,2} [A-Z][a-z]{2} \d{4}/);
    assert.match(html, /Dan Price/);
    assert.match(html, /Website rebuild plan/);
    assert.match(html, /Shown label/);
    assert.match(html, /#climateworks/);
    assert.match(html, /<table/);
    assert.match(html, /Download PDF/);
    assert.match(html, new RegExp(`/api/d/${token}/pdf`));
    assert.ok(!html.includes(contactId));
    assert.ok(!html.includes("Hidden target"));
    assert.ok(!html.includes("data-target"));
    assert.ok(!html.includes("data-tag"));
    assert.ok(!html.includes("note-wikilink"));
    assert.ok(!html.includes("note-tag"));
    assert.ok(!html.includes(doc.id));
    assert.ok(!html.includes(mark.workspaceId));
    assert.ok(!html.includes("Ridgeon"));
    assert.ok(!html.includes('aria-hidden="true" class="cm-editor'));
    assert.match(html, /href="https:\/\/example\.com\/page"/);

    const metadata = await generateMetadata(pageParams(token));
    assert.deepEqual(metadata.robots, { index: false, follow: false, nocache: true });
  });

  it("hides the download button when download is off", async () => {
    const doc = await createDoc(mark, { title: "No download", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    const html = renderToStaticMarkup(await PublicDocPage(pageParams(token)));
    assert.ok(!html.includes("Download PDF"));
  });

  it("shows the same not found page for an unknown token and a link that was turned off", async () => {
    const doc = await createDoc(mark, { title: "Soon off", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    await setDocPublic(mark, doc.id, { public: false });
    await assert.rejects(PublicDocPage(pageParams(token)), (error: { digest?: string }) => String(error.digest).includes("404"));
    await assert.rejects(PublicDocPage(pageParams("Z".repeat(32))), (error: { digest?: string }) => String(error.digest).includes("404"));
    assert.equal((await generateMetadata(pageParams(token))).title, (await generateMetadata(pageParams("Z".repeat(32)))).title);

    const off = await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token));
    const unknown = await pdfRoute(new Request(`http://crm.test/api/d/${"Z".repeat(32)}/pdf`), pageParams("Z".repeat(32)));
    assert.equal(off.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(await off.text(), await unknown.text());
  });

  it("serves a PDF only while the link and download are both on, and keeps download across the link being toggled", async () => {
    const doc = await createDoc(mark, { title: "Report: Q4 plan", content: "## Plan\n\nBody text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    assert.equal(await publicDocPdf(token), null);
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 404);

    const allowed = await setDocPublic(mark, doc.id, { allowDownload: true });
    assert.equal(allowed.allowDownload, true);
    const response = await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="report-q4-plan\.pdf"/);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

    await setDocPublic(mark, doc.id, { public: false });
    assert.equal(await publicDocPdf(token), null);
    assert.equal((await pdfRoute(new Request(`http://crm.test/api/d/${token}/pdf`), pageParams(token))).status, 404);
    const back = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(back.allowDownload, true);
    assert.ok(await publicDocPdf(token));

    await setDocPublic(mark, doc.id, { allowDownload: false });
    assert.equal(await publicDocPdf(token), null);
  });

  it("builds the PDF from the current content on every download", async () => {
    const doc = await createDoc(mark, { title: "Fresh", content: "First wording" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true, allowDownload: true })).publicUrl);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const text = async () => {
      const file = await publicDocPdf(token);
      assert.ok(file);
      return (await extractText(await getDocumentProxy(new Uint8Array(file.data)), { mergePages: true })).text;
    };
    assert.match(await text(), /First wording/);
    await getAdminPool().query("update crm.pages set content = 'Second wording' where id = $1", [doc.id]);
    assert.match(await text(), /Second wording/);
  });
});

describe("Public docs: who can change it", () => {
  useServerlessPool();

  it("lets teammates see the link but not change it, in the app and in the database", async () => {
    const doc = await createDoc(mark, { title: "Shared plan", content: "Plan", shared: true });
    const url = (await setDocPublic(mark, doc.id, { public: true })).publicUrl;
    const seen = await getDoc(priya, doc.id);
    assert.equal(seen.public, true);
    assert.equal(seen.publicUrl, url);
    assert.equal(seen.canChangePublic, false);
    await assert.rejects(setDocPublic(priya, doc.id, { public: false }), /Only Mark Ridgeon can change this note's public link/);
    await assert.rejects(setDocPublic(priya, doc.id, { allowDownload: true }), /Only Mark Ridgeon can change/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set public_enabled = false where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    await assert.rejects(queryAsUser(priya.userId, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    await assert.rejects(queryAsUser(mark.userId, "update crm.pages set public_token_hash = 'x' where id = $1 returning id", [doc.id]), /never changes/);
    assert.equal((await getDoc(mark, doc.id)).public, true);
    assert.equal(tokenOf(url).length, 32);
  });

  it("limits a workspace agent token to docs it made", async () => {
    const own = await createDoc(agent, { title: "Agent's own doc", content: "Hello" });
    assert.equal((await getDoc(agent, own.id)).canChangePublic, true);
    const made = await setDocPublic(agent, own.id, { public: true, allowDownload: true });
    assert.equal(made.public, true);
    assert.ok(await publicDocPdf(tokenOf(made.publicUrl)));

    await assert.rejects(setDocPublic(otherAgent, own.id, { public: false }), /Only Claude Code or the workspace owner can change this note's public link/);

    const marks = await createDoc(mark, { title: "Mark's shared doc", content: "Hi", shared: true });
    assert.equal((await getDoc(agent, marks.id)).canChangePublic, false);
    await assert.rejects(setDocPublic(agent, marks.id, { public: true }), /Only Mark Ridgeon can change/);
    await assert.rejects(setDocPublic(agent, marks.id, { allowDownload: true }), /Only Mark Ridgeon can change/);
  });
});

describe("Public docs: audit", () => {
  useServerlessPool();

  it("records every change with its provenance and never the link", async () => {
    const doc = await createDoc(mark, { title: "Audited", content: "Text", shared: true });
    await setDocPublic(mark, doc.id, { public: true }, { operation: "docs.app" });
    await setDocPublic(mark, doc.id, { allowDownload: true }, { operation: "docs.app" });
    await setDocPublic(mark, doc.id, { public: false }, { operation: "docs.app" });
    await setDocPublic(mark, doc.id, { public: false }, { operation: "docs.app" });
    const events = await audited(doc.id);
    assert.deepEqual(events.map((event) => event.changes.public), [true, true, false]);
    assert.deepEqual(events.map((event) => event.changes.allowDownload), [false, true, true]);
    assert.ok(events.every((event) => event.changes.title === "Audited"));
    assert.ok(!JSON.stringify(events).includes("/d/"));
  });

  it("follows the Docs rule that a private doc's changes are not recorded", async () => {
    const doc = await createDoc(mark, { title: "Private audit", content: "Text" });
    await setDocPublic(mark, doc.id, { public: true });
    assert.deepEqual(await audited(doc.id), []);
  });

  it("records agent changes against the agent", async () => {
    const doc = await createDoc(agent, { title: "Agent audit", content: "Text" });
    await setDocPublic(agent, doc.id, { public: true }, { operation: "set_doc_public", source: "mcp" });
    const events = await audited(doc.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_type, "agent");
    assert.equal(events[0].source, "mcp");
  });
});

describe("Public docs: API, MCP and assistant", () => {
  useServerlessPool();

  it("changes and reads the switches over the REST API with an agent token", async () => {
    const own = await createDoc(agent, { title: "API doc", content: "Hello" });
    const patched = await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: true, allowDownload: true, provenance: { source: "api-test" } }), params(own.id));
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as { doc: { public: boolean; allowDownload: boolean; publicUrl: string } };
    assert.equal(body.doc.public, true);
    assert.equal(body.doc.allowDownload, true);
    assert.match(body.doc.publicUrl, /^https:\/\/orbit\.test\/d\/[A-Za-z0-9_-]{32}$/);
    const read = (await (await readRoute(request(`/docs/${own.id}`), params(own.id))).json()) as { doc: { public: boolean; allowDownload: boolean; publicUrl: string } };
    assert.equal(read.doc.publicUrl, body.doc.publicUrl);
    assert.equal((await audited(own.id))[0].source, "api-test");

    const off = await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: false }), params(own.id));
    assert.equal(((await off.json()) as { doc: { publicUrl: string | null } }).doc.publicUrl, null);

    const marks = await createDoc(mark, { title: "Mark's API doc", content: "Hi", shared: true });
    const refused = await patchRoute(request(`/docs/${marks.id}`, "PATCH", { public: true }), params(marks.id));
    assert.equal(refused.status, 403);
    const invalid = await patchRoute(request(`/docs/${own.id}`, "PATCH", { public: "yes" }), params(own.id));
    assert.equal(invalid.status, 400);

  });

  it("changes and reads the switches over MCP", async () => {
    const personal = await connect(mark);
    const workspace = await connect(agent);
    try {
      assert.ok((await personal.names()).includes("set_doc_public"));
      assert.ok((await workspace.names()).includes("set_doc_public"));
      const doc = await createDoc(mark, { title: "MCP doc", content: "Body" });
      const empty = await personal.call("set_doc_public", { id: doc.id });
      assert.match(empty.error ?? "", /invalid_input/);
      const on = (await personal.call("set_doc_public", { id: doc.id, public: true, allow_download: true })).value!.doc as { public: boolean; allowDownload: boolean; publicUrl: string };
      assert.equal(on.public, true);
      assert.equal(on.allowDownload, true);
      assert.match(on.publicUrl, /\/d\//);
      const read = (await personal.call("read_doc", { id: doc.id })).value!.doc as { public: boolean; publicUrl: string };
      assert.equal(read.publicUrl, on.publicUrl);
      const blocked = await workspace.call("set_doc_public", { id: doc.id, public: false });
      assert.match(blocked.error ?? "", /not_found|forbidden/);

      const shared = await createDoc(mark, { title: "MCP shared", content: "Body", shared: true });
      const refused = await workspace.call("set_doc_public", { id: shared.id, public: true });
      assert.match(refused.error ?? "", /forbidden: Only Mark Ridgeon/);
      const own = await createDoc(agent, { title: "MCP agent doc", content: "Body" });
      const mine = (await workspace.call("set_doc_public", { id: own.id, public: true })).value!.doc as { public: boolean };
      assert.equal(mine.public, true);
      const teammate = await connect(priya);
      try {
        const seen = (await teammate.call("read_doc", { id: shared.id })).value!.doc as { public: boolean };
        assert.equal(seen.public, false);
        assert.match((await teammate.call("set_doc_public", { id: shared.id, public: true })).error ?? "", /forbidden/);
      } finally {
        await teammate.close();
      }
    } finally {
      await personal.close();
      await workspace.close();
    }
  });

  it("goes through an approval card in the assistant", async () => {
    const doc = await createDoc(mark, { title: "Assistant doc", content: "Body" });
    const publish = { action: "publish", docId: doc.id };
    assert.deepEqual(describeAction("save_doc", publish, await recordNames(mark, [publish], ["save_doc"])).lines, ["Assistant doc", "Anyone with the link can read it. Download stays off."]);
    assert.equal(describeAction("save_doc", publish, await recordNames(mark, [publish], ["save_doc"])).title, "Turn on the public link");
    assert.match(((await runTool(mark, "save_doc", publish, { unattended: true })) as { error: string }).error, /Only edits to a doc's text/);

    const result = (await runTool(mark, "save_doc", publish)) as { saved: boolean; doc: { public: boolean; publicUrl: string; allowDownload: boolean } };
    assert.equal(result.saved, true);
    assert.equal(result.doc.public, true);
    assert.match(result.doc.publicUrl, /\/d\//);

    const allow = { action: "allow_download", docId: doc.id };
    const allowCard = describeAction("save_doc", allow, await recordNames(mark, [allow], ["save_doc"]));
    assert.equal(allowCard.title, "Allow download");
    assert.deepEqual(allowCard.lines, ["Assistant doc", "Readers can download it as a PDF."]);
    assert.equal(((await runTool(mark, "save_doc", allow)) as { doc: { allowDownload: boolean } }).doc.allowDownload, true);
    const publishedAgain = { action: "publish", docId: doc.id };
    assert.deepEqual(describeAction("save_doc", publishedAgain, await recordNames(mark, [publishedAgain], ["save_doc"])).lines[1], "Anyone with the link can read it. Download is on.");

    const block = { action: "block_download", docId: doc.id };
    assert.equal(describeAction("save_doc", block, await recordNames(mark, [block], ["save_doc"])).title, "Stop downloads");
    assert.equal(((await runTool(mark, "save_doc", block)) as { doc: { allowDownload: boolean } }).doc.allowDownload, false);

    const unpublish = { action: "unpublish", docId: doc.id };
    const offCard = describeAction("save_doc", unpublish, await recordNames(mark, [unpublish], ["save_doc"]));
    assert.equal(offCard.title, "Turn off the public link");
    assert.equal(((await runTool(mark, "save_doc", unpublish)) as { doc: { public: boolean } }).doc.public, false);
    assert.equal(await openPublicDoc("A".repeat(32)), null);
  });

  it("refuses the assistant on a teammate's doc and on daily notes", async () => {
    const shared = await createDoc(mark, { title: "Mark's doc", content: "Body", shared: true });
    const refused = (await runTool(priya, "save_doc", { action: "publish", docId: shared.id })) as { error: string };
    assert.match(refused.error, /Only Mark Ridgeon can change/);
    const daily = (await openDailyNote(priya)).page;
    const dailyRefused = (await runTool(priya, "save_doc", { action: "publish", docId: daily.id })) as { error: string };
    assert.match(dailyRefused.error, /Daily notes are private/);
  });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function addMember(email: string, name: string, role: "member" | "admin") {
  const admin = getAdminPool();
  const id = (await admin.query<{ id: string }>("select private.create_local_user($1, 'password-123', $2) as id", [email, name])).rows[0].id;
  await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, id, role]);
  return { ...mark, userId: id, email, fullName: name, role, scopes: scopesForRole(role) } as UserActor;
}

async function asAgent(actor: AgentActor, sql: string, values: unknown[]) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true), set_config('app.agent_id', $2, true), set_config('app.actor_type', 'agent', true)", [actor.workspaceId, actor.agentId]);
    await client.query("set local role crm_agent");
    return (await client.query(sql, values)).rows;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

describe("Public docs: roles, workspaces and races", () => {
  useServerlessPool();

  it("lets the workspace owner, but not an admin or a member, change an agent-made doc's link", async () => {
    const admin = await addMember("admin@docs-public.test", "Ada Admin", "admin");
    const member = await addMember("member@docs-public.test", "Mo Member", "member");
    const doc = await createDoc(agent, { title: "Agent-made for roles", content: "Text" });
    assert.equal((await getDoc(mark, doc.id)).canChangePublic, true);
    assert.equal((await getDoc(admin, doc.id)).canChangePublic, false);
    assert.equal((await getDoc(member, doc.id)).canChangePublic, false);
    await assert.rejects(setDocPublic(admin, doc.id, { public: true }), /Only Claude Code or the workspace owner/);
    await assert.rejects(setDocPublic(member, doc.id, { allowDownload: true }), /Only Claude Code or the workspace owner/);
    await assert.rejects(queryAsUser(admin.userId, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await getDoc(agent, doc.id)).public, false);
    const made = await setDocPublic(mark, doc.id, { public: true, allowDownload: true });
    assert.equal(made.public, true);
    assert.equal(made.allowDownload, true);
    assert.equal((await getDoc(admin, doc.id)).publicUrl, made.publicUrl);
    assert.equal((await setDocPublic(agent, doc.id, { public: false })).public, false);
    const humanDoc = await createDoc(member, { title: "Member's own", content: "Text", shared: true });
    await assert.rejects(setDocPublic(mark, humanDoc.id, { public: true }), /Only Mo Member can change/);
  });

  it("refuses a crm_agent that didn't make the doc at the database, and lets the one that did", async () => {
    const doc = await createDoc(agent, { title: "SQL agent doc", content: "Text" });
    await assert.rejects(asAgent(otherAgent, "update crm.pages set public_enabled = false, allow_download = true where id = $1 returning id", [doc.id]), /Only the doc's owner can change its public link/);
    await assert.rejects(asAgent(otherAgent, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await asAgent(agent, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id])).length, 1);
  });

  it("keeps a doc's link out of reach of someone in another workspace", async () => {
    const outsider = await createUser("outsider@docs-public.test", "Olive Outsider");
    const doc = await createDoc(mark, { title: "Mark's secret", content: "Text", shared: true });
    await setDocPublic(mark, doc.id, { public: true });
    await assert.rejects(setDocPublic(outsider, doc.id, { public: false }), /doesn't exist, or it's private/);
    await assert.rejects(getDoc(outsider, doc.id), /doesn't exist, or it's private/);
    assert.deepEqual(await queryAsUser(outsider.userId, "update crm.pages set public_enabled = false where id = $1 returning id", [doc.id]), []);
    assert.equal((await getDoc(mark, doc.id)).public, true);
  });

  it("makes one token when two first publishes race", async () => {
    const doc = await createDoc(mark, { title: "Race", content: "Text" });
    const [first, second] = await Promise.all([setDocPublic(mark, doc.id, { public: true }), setDocPublic(mark, doc.id, { public: true })]);
    assert.equal(first.publicUrl, second.publicUrl);
    const hashes = await getAdminPool().query("select public_token_hash from crm.pages where id = $1 and public_token_hash is not null", [doc.id]);
    assert.equal(hashes.rowCount, 1);
    assert.equal((await audited(doc.id)).length, 0, "a private doc records nothing");
    const shared = await createDoc(mark, { title: "Race shared", content: "Text", shared: true });
    await Promise.all([setDocPublic(mark, shared.id, { public: true }), setDocPublic(mark, shared.id, { public: true })]);
    assert.equal((await audited(shared.id)).length, 1, "only the first change counts");
  });

  it("sends page.public_changed to a webhook", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      await createWebhook(mark, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, events: ["page.public_changed"] });
      const doc = await createDoc(mark, { title: "Hooked", content: "Text", shared: true });
      await setDocPublic(mark, doc.id, { public: true });
      const until = Date.now() + 5000;
      while (bodies.length === 0 && Date.now() < until) {
        await deliverDueWebhooks();
        if (bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(bodies.length, 1);
      const payload = JSON.parse(bodies[0]) as { type: string; data: Record<string, unknown> };
      assert.equal(payload.type, "page.public_changed");
      assert.ok(!bodies[0].includes("/d/"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    }
  });

  it("turns off a leaver's public links, keeps the token, and lets whoever takes over bring the same link back", async () => {
    const leaver = await addMember("leaver@docs-public.test", "Lee Leaver", "member");
    const doc = await createDoc(leaver, { title: "Leaver's shared doc", content: "Hello", shared: true });
    const mine = await createDoc(mark, { title: "Mark's own public", content: "Stays", shared: true });
    const url = (await setDocPublic(leaver, doc.id, { public: true, allowDownload: true })).publicUrl;
    const markUrl = (await setDocPublic(mark, mine.id, { public: true })).publicUrl;
    assert.ok(await openPublicDoc(tokenOf(url)));
    await removeMember(mark, leaver.userId);
    assert.equal(await openPublicDoc(tokenOf(url)), null);
    assert.equal((await pdfRoute(new Request("http://crm.test/x"), pageParams(tokenOf(url)))).status, 404);
    assert.ok(await openPublicDoc(tokenOf(markUrl)), "other people's links stay on");
    const after = await getDoc(mark, doc.id);
    assert.equal(after.public, false);
    assert.equal(after.allowDownload, true);
    await takeOverFormerMemberDocs(mark, leaver.userId);
    assert.equal((await getDoc(mark, doc.id)).canChangePublic, true);
    const revived = await setDocPublic(mark, doc.id, { public: true });
    assert.equal(revived.publicUrl, url);
    assert.equal((await openPublicDoc(tokenOf(url)))?.title, "Leaver's shared doc");
  });
});

describe("Public docs: more roles and the not found head", () => {
  useServerlessPool();

  it("gives a doc with no title the title Untitled in the page head", async () => {
    const doc = await createDoc(mark, { title: "", content: "Body" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    assert.equal((await generateMetadata(pageParams(token))).title, "Untitled");
    assert.match(renderToStaticMarkup(await PublicDocPage(pageParams(token))), /Untitled/);
  });

  it("lets only the workspace owner change a doc with no owner and no agent left", async () => {
    const admin = await addMember("admin2@docs-public.test", "Ann Admin", "admin");
    const gone = (await createAgent(mark.workspaceId, ["docs:read", "docs:write"], "Short-lived")).actor;
    const doc = await createDoc(gone, { title: "Orphaned doc", content: "Text" });
    await getAdminPool().query("delete from crm.agents where id = $1", [gone.agentId]);
    const row = await getAdminPool().query("select user_id, created_by_agent_id from crm.pages where id = $1", [doc.id]);
    assert.deepEqual(row.rows[0], { user_id: null, created_by_agent_id: null });
    assert.equal((await getDoc(mark, doc.id)).canChangePublic, true);
    assert.equal((await getDoc(admin, doc.id)).canChangePublic, false);
    await assert.rejects(setDocPublic(admin, doc.id, { public: true }), /Only the workspace owner can change/);
    await assert.rejects(queryAsUser(admin.userId, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id]), /Only the doc's owner/);
    assert.equal((await setDocPublic(mark, doc.id, { public: true })).public, true);
    assert.equal((await queryAsUser(mark.userId, "update crm.pages set allow_download = true where id = $1 returning id", [doc.id])).length, 1);
  });

  it("turns a leaver's links off even when the removal runs under another person's session", async () => {
    const admin = await addMember("admin3@docs-public.test", "Abe Admin", "admin");
    const leaver = await addMember("leaver2@docs-public.test", "Lou Leaver", "member");
    const doc = await createDoc(leaver, { title: "Leaver under claims", content: "Text", shared: true });
    const url = (await setDocPublic(leaver, doc.id, { public: true })).publicUrl;
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: admin.userId, role: "authenticated" })]);
      await client.query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [mark.workspaceId, leaver.userId]);
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.equal(await openPublicDoc(tokenOf(url)), null);
    assert.equal((await getDoc(mark, doc.id)).public, false);
  });

  it("serves a neutral head on the not found page for an off link and an unknown link", { timeout: 120_000, skip: !existsSync(".next/BUILD_ID") && "run next build first" }, async () => {
    const doc = await createDoc(mark, { title: "Head check", content: "Text" });
    const token = tokenOf((await setDocPublic(mark, doc.id, { public: true })).publicUrl);
    await setDocPublic(mark, doc.id, { public: false });
    const port = await freePort();
    const child = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
      env: { ...process.env, SITE_URL: `http://localhost:${port}` },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const base = `http://localhost:${port}`;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The production server didn't start.")), 60_000);
        child.once("exit", () => reject(new Error("The production server stopped early.")));
        child.stdout?.on("data", (chunk: Buffer) => {
          if (/Ready/.test(chunk.toString())) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const heads: string[] = [];
      for (const path of [token, "Z".repeat(32)]) {
        const response = await fetch(`${base}/d/${path}`);
        assert.equal(response.status, 404);
        const html = await response.text();
        assert.match(html, /This page doesn&#x27;t exist or isn&#x27;t public\.|This page doesn't exist or isn't public\./);
        heads.push(html.slice(0, html.indexOf("</head>")).replace(/data:[^"]+/g, "data"));
      }
      for (const head of heads) {
        assert.match(head, /<title>Not found<\/title>/);
        assert.match(head, /name="robots" content="noindex, nofollow/);
        assert.doesNotMatch(head, /Orbit|focused CRM|og:|twitter:|rel="canonical"|manifest|apple-mobile-web-app|name="description"/i);
      }
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
  });
});
