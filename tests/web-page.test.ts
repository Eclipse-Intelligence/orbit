import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { systemPrompt } from "@/lib/assistant/prompt";
import { toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";
import { allowedEclipseUrl, clearEclipseSourceCache, listEclipseArticles, readEclipsePage } from "@/lib/eclipse-sources";
import { privateAddress, readWebPage } from "@/lib/web-page";

const PUBLIC: (host: string) => Promise<string[]> = async () => ["93.184.216.34"];

const ACME = `<!doctype html><html><head><title>Acme | Home</title><meta name="description" content="Acme makes widgets &amp; more."></head>
<body><nav><a href="/login">Log in</a></nav><main><h1>We make widgets</h1><p>Founded in 2019, Acme sells to <b>agencies</b>.</p>
<a href="/about">About us</a><a href="https://news.example/acme">Acme in the news</a><a href="mailto:hi@acme.test">Email</a></main></body></html>`;

function site(pages: Record<string, { status?: number; body?: string; type?: string; location?: string }>) {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.location ? { location: page.location } : {}) },
    });
  };
  return { fetchImpl, seen };
}

describe("reading web pages", () => {
  it("reads the main text, title, description and links of a public page", async () => {
    const { fetchImpl } = site({ "https://acme.test/": { body: ACME } });
    const page = await readWebPage("https://acme.test/", { fetchImpl, lookup: PUBLIC });
    assert.equal(page.title, "Acme | Home");
    assert.equal(page.description, "Acme makes widgets & more.");
    assert.match(page.text, /We make widgets\nFounded in 2019, Acme sells to agencies\./);
    assert.ok(!page.text.includes("Log in"));
    assert.deepEqual(page.links, [
      { text: "Log in", url: "https://acme.test/login" },
      { text: "About us", url: "https://acme.test/about" },
      { text: "Acme in the news", url: "https://news.example/acme" },
    ]);
  });

  it("refuses private addresses, including after a redirect, and files that aren't pages", async () => {
    assert.equal(privateAddress("10.0.0.5"), true);
    assert.equal(privateAddress("169.254.169.254"), true);
    assert.equal(privateAddress("::ffff:127.0.0.1"), true);
    assert.equal(privateAddress("fd00::1"), true);
    assert.equal(privateAddress("93.184.216.34"), false);
    await assert.rejects(readWebPage("http://localhost:3000/admin", { lookup: PUBLIC }), /Private and local/);
    await assert.rejects(readWebPage("https://sneaky.test/", { lookup: async () => ["192.168.1.4"] }), /Private and local/);
    const hop = site({ "https://short.test/x": { status: 302, location: "http://169.254.169.254/latest/meta-data" } });
    await assert.rejects(readWebPage("https://short.test/x", { fetchImpl: hop.fetchImpl, lookup: PUBLIC }), /Private and local/);
    assert.deepEqual(hop.seen, ["https://short.test/x"]);
    const moved = site({ "https://old.test/": { status: 301, location: "https://acme.test/" }, "https://acme.test/": { body: ACME } });
    assert.equal((await readWebPage("https://old.test/", { fetchImpl: moved.fetchImpl, lookup: PUBLIC })).url, "https://acme.test/");
    const pdf = site({ "https://acme.test/deck.pdf": { body: "%PDF", type: "application/pdf" } });
    await assert.rejects(readWebPage("https://acme.test/deck.pdf", { fetchImpl: pdf.fetchImpl, lookup: PUBLIC }), /application\/pdf file/);
    const blocked = site({ "https://www.linkedin.com/in/x": { status: 403 } });
    await assert.rejects(readWebPage("https://www.linkedin.com/in/x", { fetchImpl: blocked.fetchImpl, lookup: PUBLIC }), /answered 403, so the page is private or blocks automated reading/);
  });
});

describe("Eclipse articles and docs", () => {
  beforeEach(() => clearEclipseSourceCache());

  it("lists articles newest first, finds them by topic and reads docs pages as markdown", async () => {
    const article = (title: string, description: string, date: string) =>
      `<html><head><title>${title}</title><meta name="description" content="${description}"><meta property="article:published_time" content="${date}"></head><body><article><h1>${title}</h1><p>Body of ${title}.</p></article><footer>Footer</footer></body></html>`;
    const { fetchImpl } = site({
      "https://geteclipse.co/sitemap.xml": {
        type: "application/xml",
        body: "<urlset><url><loc>https://geteclipse.co/</loc></url><url><loc>https://geteclipse.co/articles/reddit-tools/</loc></url><url><loc>https://geteclipse.co/articles/ai-visibility-evidence/</loc></url></urlset>",
      },
      "https://geteclipse.co/articles/reddit-tools/": { body: article("Reddit tools for agencies", "How agencies pick Reddit tools.", "2026-09-01") },
      "https://geteclipse.co/articles/ai-visibility-evidence/": { body: article("Proving AI visibility", "An evidence guide for agencies.", "2026-10-01") },
      "https://docs.geteclipse.co/features/content/planner.md": { type: "text/markdown", body: "# Planner\n\nPlan article topics and briefs." },
    });
    const all = await listEclipseArticles({ fetchImpl });
    assert.deepEqual(all.map((item) => item.title), ["Proving AI visibility", "Reddit tools for agencies"]);
    assert.equal(all[0].url, "https://geteclipse.co/articles/ai-visibility-evidence/");
    assert.deepEqual((await listEclipseArticles({ query: "reddit", fetchImpl })).map((item) => item.title), ["Reddit tools for agencies"]);
    const read = await readEclipsePage("https://geteclipse.co/articles/reddit-tools/", { fetchImpl });
    assert.match(read.text, /Body of Reddit tools for agencies\./);
    assert.ok(!read.text.includes("Footer"));
    const docs = await readEclipsePage("https://docs.geteclipse.co/features/content/planner", { fetchImpl });
    assert.equal(docs.title, "Planner");
    assert.equal(allowedEclipseUrl("https://evil.test/articles/x"), null);
    assert.equal(allowedEclipseUrl("https://geteclipse.co/admin"), null);
  });

  it("gives the assistant the tools and tells it how to use them", () => {
    const names = toolDefinitions().map((tool) => tool.function.name);
    for (const name of ["read_web_page", "eclipse_articles", "eclipse_docs"]) assert.ok(names.includes(name), name);
    const actor = { type: "user", userId: "u", workspaceId: "w", email: "mark@eclipse.test", fullName: "Mark", role: "owner", scopes: [] } as unknown as UserActor;
    const prompt = systemPrompt(actor, { webSearch: false });
    assert.match(prompt, /https:\/\/geteclipse\.co\/articles/);
    assert.match(prompt, /sales collateral/);
    assert.match(prompt, /https:\/\/docs\.geteclipse\.co/);
    assert.match(prompt, /you can still open any address you know or are given with read_web_page/);
  });
});
