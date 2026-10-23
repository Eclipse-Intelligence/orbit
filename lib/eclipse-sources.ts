import { htmlToText } from "@/lib/mail/text";

export const ARTICLES_URL = "https://geteclipse.co/articles";
export const DOCS_URL = "https://docs.geteclipse.co";

const SITEMAP = "https://geteclipse.co/sitemap.xml";
const DOCS_INDEX = `${DOCS_URL}/llms.txt`;
const CACHE_MS = 60 * 60_000;
const TEXT_MAX = 40_000;
const TIMEOUT_MS = 10_000;

export type EclipseArticle = { title: string; url: string; summary: string | null; published: string | null };

type Fetcher = typeof fetch;

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearEclipseSourceCache() {
  cache.clear();
}

async function fetchText(url: string, fetchImpl: Fetcher) {
  const response = await fetchImpl(url, { headers: { accept: "text/html,text/markdown,text/plain,application/xml" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

function attribute(html: string, pattern: RegExp) {
  const value = html.match(pattern)?.[1];
  return value ? htmlToText(value).trim() || null : null;
}

function pageTitle(html: string) {
  return attribute(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) ?? attribute(html, /<title[^>]*>([^<]*)<\/title>/i);
}

function mainText(html: string) {
  const part = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html;
  return htmlToText(part).slice(0, TEXT_MAX);
}

export function allowedEclipseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "docs.geteclipse.co") return url;
    if ((url.hostname === "geteclipse.co" || url.hostname === "www.geteclipse.co") && /^\/articles\/[a-z0-9-]+\/?$/i.test(url.pathname)) return url;
    return null;
  } catch {
    return null;
  }
}

export async function listEclipseArticles(options: { query?: string; fetchImpl?: Fetcher } = {}): Promise<EclipseArticle[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const articles = await cached("articles", async () => {
    const sitemap = await fetchText(SITEMAP, fetchImpl);
    const urls = [...new Set([...sitemap.matchAll(/<loc>\s*(https:\/\/geteclipse\.co\/articles\/[a-z0-9-]+\/?)\s*<\/loc>/gi)].map((match) => match[1]))].slice(0, 60);
    const found = await Promise.all(
      urls.map(async (url): Promise<EclipseArticle | null> => {
        try {
          const html = await fetchText(url, fetchImpl);
          return {
            title: pageTitle(html) ?? url,
            url,
            summary: attribute(html, /<meta[^>]+name="description"[^>]+content="([^"]*)"/i),
            published: attribute(html, /property="article:published_time"[^>]+content="([^"]*)"/i),
          };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((item): item is EclipseArticle => item !== null).sort((left, right) => (right.published ?? "").localeCompare(left.published ?? ""));
  });
  const words = (options.query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (words.length === 0) return articles;
  return articles
    .map((article) => ({ article, score: words.filter((word) => `${article.title} ${article.summary ?? ""}`.toLowerCase().includes(word)).length }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.article);
}

export async function readEclipsePage(value: string, options: { fetchImpl?: Fetcher } = {}) {
  const url = allowedEclipseUrl(value);
  if (!url) throw new Error("Only Eclipse articles (geteclipse.co/articles/…) and docs pages (docs.geteclipse.co) can be read.");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (url.hostname === "docs.geteclipse.co") {
    const path = url.pathname.replace(/\/+$/, "") || "/getting-started/introduction";
    const markdown = path.endsWith(".md") ? path : `${path}.md`;
    const text = await cached(`docs:${markdown}`, () => fetchText(`${DOCS_URL}${markdown}`, fetchImpl));
    return { url: `${DOCS_URL}${path.replace(/\.md$/, "")}`, title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null, text: text.slice(0, TEXT_MAX) };
  }
  const html = await cached(`page:${url.href}`, () => fetchText(url.href, fetchImpl));
  return { url: url.href, title: pageTitle(html), text: mainText(html) };
}

export async function eclipseDocsIndex(options: { fetchImpl?: Fetcher } = {}) {
  return cached("docs-index", () => fetchText(DOCS_INDEX, options.fetchImpl ?? fetch).then((text) => text.slice(0, TEXT_MAX)));
}
