import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { after, before, beforeEach, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { indexKnowledgeItem } from "@/lib/knowledge/indexing";
import { allowed, mapSite, robotsRules } from "@/lib/knowledge/site";
import { addKnowledgePages, listKnowledge } from "@/lib/knowledge/store";
import { mainText } from "@/lib/web-page";
import { createUser, resetDatabase } from "./helpers";

const lookup = async () => ["93.184.216.34"];
const LLM = "https://llm.test/v1";

function web(pages: Record<string, { body: string | Uint8Array; type?: string }>) {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(typeof page.body === "string" ? page.body : Buffer.from(page.body), { headers: { "content-type": page.type ?? "text/html" } });
  };
  return { fetchImpl, seen };
}

describe("knowledge sites", () => {
  let owner: UserActor;
  let acme: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("sites@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme Sites", domain: "acme-sites.test" })).body.company.id;
  });

  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_API_BASE_URL = LLM;
  });

  after(async () => {
    await getPool().end();
  });

  it("reads the whole page when the article or main part is only a small slice", () => {
    const cards = `<html><body><nav>Menu</nav><article><p>Hear the market.</p></article><section><h1>Content infrastructure</h1><p>${"Eclipse turns research into approved content. ".repeat(20)}</p></section><footer>Footer links</footer></body></html>`;
    const text = mainText(cards);
    assert.match(text, /Content infrastructure/);
    assert.match(text, /Hear the market/);
    assert.doesNotMatch(text, /Menu|Footer links/);
    const article = `<html><body><header>Site</header><article><h1>Pricing</h1><p>${"Plans start at 500 pounds a month. ".repeat(20)}</p></article><aside>Related</aside></body></html>`;
    assert.doesNotMatch(mainText(article), /Related/);
  });

  it("reads robots rules for every agent and honours the longest match", () => {
    const rules = robotsRules("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /*.pdf$\n\nSitemap: https://acme.test/sitemap_index.xml");
    assert.deepEqual(rules.sitemaps, ["https://acme.test/sitemap_index.xml"]);
    assert.equal(allowed(rules, "/pricing"), true);
    assert.equal(allowed(rules, "/admin/users"), false);
    assert.equal(allowed(rules, "/admin/public/help"), true);
    assert.equal(allowed(rules, "/files/deck.pdf"), false);
  });

  it("maps a site from its sitemap index, gzip included, keeping to the site and skipping files and blocked paths", async () => {
    const { fetchImpl } = web({
      "https://acme.test/robots.txt": { body: "User-agent: *\nDisallow: /private\nSitemap: https://acme.test/sitemap_index.xml", type: "text/plain" },
      "https://acme.test/sitemap_index.xml": {
        body: `<sitemapindex><sitemap><loc>https://acme.test/pages.xml</loc></sitemap><sitemap><loc>https://cdn.acme.test/posts.xml.gz</loc></sitemap></sitemapindex>`,
        type: "application/xml",
      },
      "https://acme.test/pages.xml": {
        body: `<urlset><url><loc>https://acme.test/</loc></url><url><loc>https://www.acme.test/about/</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://acme.test/private/plans</loc></url><url><loc>https://other.test/x</loc></url><url><loc>https://acme.test/logo.png</loc></url></urlset>`,
        type: "application/xml",
      },
      "https://cdn.acme.test/posts.xml.gz": { body: gzipSync(`<urlset><url><loc><![CDATA[https://acme.test/blog/ai-search]]></loc></url></urlset>`), type: "application/gzip" },
    });
    const map = await mapSite("acme.test", { fetchImpl, lookup });
    assert.equal(map.source, "sitemap");
    assert.equal(map.host, "acme.test");
    assert.deepEqual(
      map.pages.map((page) => [page.path, page.depth]),
      [
        ["/", 0],
        ["/about/", 1],
        ["/blog/ai-search", 2],
      ],
    );
    assert.equal(map.pages.find((page) => page.path === "/about/")?.lastModified, "2026-10-01");
  });

  it("follows links when a site has no sitemap", async () => {
    const { fetchImpl } = web({
      "https://plain.test/": { body: `<a href="/team">Team</a><a href="/work#top">Work</a><a href="https://elsewhere.test/">Out</a><a href="/style.css">x</a>` },
      "https://plain.test/team": { body: `<a href="/team/jane">Jane</a><a href="/">Home</a>` },
      "https://plain.test/work": { body: `<a href="/brochure.pdf">Brochure</a>` },
      "https://plain.test/team/jane": { body: `<p>Jane</p>` },
    });
    const map = await mapSite("https://plain.test/", { fetchImpl, lookup });
    assert.equal(map.source, "links");
    assert.deepEqual(map.pages.map((page) => page.path), ["/", "/brochure.pdf", "/team", "/work", "/team/jane"]);
  });

  it("says why when a site can't be reached, and opens blocked sites in a browser", async () => {
    await assert.rejects(mapSite("26pmx.con", { fetchImpl: web({}).fetchImpl, lookup: async () => Promise.reject(new Error("ENOTFOUND")), render: null }), /26pmx\.con couldn't be found/);
    const blocked: typeof fetch = async () => new Response("denied", { status: 403 });
    await assert.rejects(mapSite("https://guarded.test/", { fetchImpl: blocked, lookup, render: null }), /guarded\.test answered 403/);
    const rendered: string[] = [];
    const map = await mapSite("https://guarded.test/", {
      fetchImpl: blocked,
      lookup,
      render: async (url) => {
        rendered.push(url);
        return { url, html: `<a href="/services">Services</a><a href="/contact">Contact</a>` };
      },
    });
    assert.deepEqual(rendered, ["https://guarded.test/"]);
    assert.deepEqual(map.pages.map((page) => page.path), ["/", "/contact", "/services"]);
  });

  it("refuses to map private addresses", async () => {
    await assert.rejects(mapSite("http://127.0.0.1/", { lookup }), /Private and local/);
  });

  it("adds chosen pages once, and swaps the placeholder title for the page's own", async () => {
    const urls = ["https://acme.test/", "https://acme.test/about/", "https://acme.test/about/"];
    const first = await addKnowledgePages(owner, { companyId: acme }, urls);
    assert.equal(first.ids.length, 2);
    assert.equal(first.skipped, 0);
    const again = await addKnowledgePages(owner, { companyId: acme }, ["https://acme.test/about/", "https://acme.test/pricing"]);
    assert.equal(again.ids.length, 1);
    await assert.rejects(addKnowledgePages(owner, { companyId: acme }, []), /Choose at least one page/);

    const listed = await listKnowledge(owner, { companyId: acme });
    const about = listed.find((item) => item.sourceUrl === "https://acme.test/about/")!;
    assert.equal(about.title, "acme.test/about");
    assert.equal(about.status, "pending");
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
        return Response.json({ data: texts.map((_, index) => ({ index, embedding: new Array(1536).fill(0).map((__, d) => (d === index ? 1 : 0)) })) });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "About Acme." }) }, finish_reason: "stop" }] });
    };
    await indexKnowledgeItem(owner, about.id, { fetchImpl, readPage: async () => ({ title: "About Acme", text: "Acme was founded in 2019." }) });
    assert.equal((await listKnowledge(owner, { companyId: acme })).find((item) => item.id === about.id)?.title, "About Acme");
  });
});
