import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { systemPrompt } from "@/lib/assistant/prompt";
import { toolDefinitions } from "@/lib/assistant/tools";
import type { UserActor } from "@/lib/crm/types";
import { allowedEclipseUrl, clearEclipseSourceCache, listEclipseArticles, readEclipsePage } from "@/lib/eclipse-sources";
import { renderWithBrowserbase } from "@/lib/browserbase";
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
    const zip = site({ "https://acme.test/files.zip": { body: "PK", type: "application/zip" } });
    await assert.rejects(readWebPage("https://acme.test/files.zip", { fetchImpl: zip.fetchImpl, lookup: PUBLIC }), /application\/zip file/);
    const blocked = site({ "https://www.linkedin.com/in/x": { status: 403 } });
    await assert.rejects(readWebPage("https://www.linkedin.com/in/x", { fetchImpl: blocked.fetchImpl, lookup: PUBLIC }), /answered 403, so the page is private or blocks automated reading/);
  });
});

describe("pages that need a browser, and documents", () => {
  it("opens JavaScript pages and blocked pages in a browser, and reads PDFs", async () => {
    const shell = '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const rendered = '<html><head><title>Acme pricing</title></head><body><main><h1>Pricing</h1><p>Pro costs £900 a month and includes ten AI assistants with weekly reports for every client workspace you run.</p><p>Agency plans add client isolation, approvals and white-label reports, with onboarding included for the first month.</p></main></body></html>';
    const calls: { url: string; proxies: boolean }[] = [];
    const render = async (url: string, settings: { proxies: boolean }) => {
      calls.push({ url, proxies: settings.proxies });
      return { html: rendered, url };
    };
    const app = site({ "https://app.test/pricing": { body: shell } });
    const page = await readWebPage("https://app.test/pricing", { fetchImpl: app.fetchImpl, lookup: PUBLIC, render });
    assert.equal(page.via, "browser");
    assert.match(page.text, /Pro costs £900 a month/);
    assert.deepEqual(calls, [{ url: "https://app.test/pricing", proxies: false }]);
    const thin = await readWebPage("https://app.test/pricing", { fetchImpl: app.fetchImpl, lookup: PUBLIC, render: null });
    assert.equal(thin.via, "fetch");
    assert.equal(thin.title, "App");

    const shy = site({ "https://shy.test/": { status: 403 } });
    assert.equal((await readWebPage("https://shy.test/", { fetchImpl: shy.fetchImpl, lookup: PUBLIC, render })).via, "browser");
    assert.deepEqual(calls[1], { url: "https://shy.test/", proxies: true });
    await assert.rejects(
      readWebPage("https://shy.test/", { fetchImpl: shy.fetchImpl, lookup: PUBLIC, render: async () => { throw new Error("Browserbase answered 402"); } }),
      /blocks automated reading\. Opening it in a browser didn't work either \(Browserbase answered 402\)/,
    );

    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Acme annual report 2026", { x: 50, y: 700, size: 18, font });
    const bytes = await pdf.save();
    const files: typeof fetch = async () => new Response(Buffer.from(bytes), { headers: { "content-type": "application/pdf" } });
    const report = await readWebPage("https://acme.test/report.pdf", { fetchImpl: files, lookup: PUBLIC, render: null });
    assert.equal(report.via, "file");
    assert.equal(report.title, "report.pdf");
    assert.match(report.text, /Acme annual report 2026/);
  });
});

describe("Browserbase sessions", () => {
  it("asks for proxies only when needed and always releases the session", async () => {
    process.env.BROWSERBASE_API_KEY = "bb-test";
    process.env.BROWSERBASE_PROJECT_ID = "project-1";
    const requests: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")), key: new Headers(init?.headers).get("x-bb-api-key") });
      return Response.json({ id: "session-1", connectUrl: "ws://127.0.0.1:9/devtools" }, { status: 201 });
    };
    try {
      await assert.rejects(renderWithBrowserbase("https://shy.test/", { proxies: true, fetchImpl }));
      assert.equal(requests[0].url, "https://api.browserbase.com/v1/sessions");
      assert.equal(requests[0].key, "bb-test");
      assert.equal(requests[0].body.projectId, "project-1");
      assert.equal(requests[0].body.proxies, true);
      assert.deepEqual(requests[1], { url: "https://api.browserbase.com/v1/sessions/session-1", body: { projectId: "project-1", status: "REQUEST_RELEASE" }, key: "bb-test" });
      requests.length = 0;
      await assert.rejects(renderWithBrowserbase("https://app.test/", { proxies: false, fetchImpl }));
      assert.equal(requests[0].body.proxies, undefined);
    } finally {
      delete process.env.BROWSERBASE_API_KEY;
      delete process.env.BROWSERBASE_PROJECT_ID;
    }
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
