import { gunzipSync } from "node:zlib";
import { CrmError } from "@/lib/crm/errors";
import { cleanUrl } from "@/lib/knowledge/store";
import { browserbaseConfigured, renderWithBrowserbase, type Renderer } from "@/lib/browserbase";
import { downloadPublic, WebPageError, type Lookup } from "@/lib/web-page";

const PAGES_MAX = 5_000;
const SITEMAPS_MAX = 60;
const CRAWL_MAX = 400;
const CRAWL_PARALLEL = 6;
const SKIP = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif|css|js|mjs|json|xml|txt|zip|gz|rar|7z|mp3|m4a|wav|mp4|mov|webm|avi|woff2?|ttf|eot|otf|exe|dmg|apk)$/i;

export type SitePage = { url: string; path: string; depth: number; lastModified: string | null };
export type SiteMap = { origin: string; host: string; pages: SitePage[]; source: "sitemap" | "links"; truncated: boolean };
type Options = { fetchImpl?: typeof fetch; lookup?: Lookup; deadline?: number; render?: Renderer | null };
type Rules = { allow: string[]; disallow: string[]; sitemaps: string[] };

function bare(host: string) {
  return host.toLowerCase().replace(/^www\./, "");
}

function sameSite(url: URL, host: string) {
  return (url.protocol === "https:" || url.protocol === "http:") && bare(url.hostname) === bare(host);
}

function normal(raw: string, base: URL | string) {
  try {
    const url = new URL(raw.replace(/&amp;/g, "&").trim(), base);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "/");
    return url;
  } catch {
    return null;
  }
}

function timeLeft(options: Options) {
  return !options.deadline || Date.now() < options.deadline - 3_000;
}

async function text(url: string, options: Options, maxBytes: number) {
  const response = await downloadPublic(url, { fetchImpl: options.fetchImpl, lookup: options.lookup, maxBytes, timeoutMs: 15_000 });
  const bytes = response.bytes[0] === 0x1f && response.bytes[1] === 0x8b ? new Uint8Array(gunzipSync(response.bytes)) : response.bytes;
  return { ...response, body: new TextDecoder().decode(bytes) };
}

export function robotsRules(body: string): Rules {
  const rules: Rules = { allow: [], disallow: [], sitemaps: [] };
  let agents: string[] = [];
  let grouping = false;
  for (const line of body.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.replace(/#.*$/, "").split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!key) continue;
    if (key === "sitemap") {
      if (value) rules.sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (grouping) agents = [];
      agents.push(value.toLowerCase());
      grouping = false;
      continue;
    }
    grouping = true;
    if (!agents.includes("*")) continue;
    if (key === "disallow" && value) rules.disallow.push(value);
    if (key === "allow" && value) rules.allow.push(value);
  }
  return rules;
}

function matches(rule: string, path: string) {
  const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
  return pattern.test(path);
}

export function allowed(rules: Rules, path: string) {
  const blocked = rules.disallow.filter((rule) => matches(rule, path)).sort((a, b) => b.length - a.length)[0];
  if (!blocked) return true;
  const allowedBy = rules.allow.filter((rule) => matches(rule, path)).sort((a, b) => b.length - a.length)[0];
  return Boolean(allowedBy && allowedBy.length >= blocked.length);
}

async function fromSitemaps(start: URL, rules: Rules, options: Options) {
  const queue = [...new Set(rules.sitemaps.length ? rules.sitemaps : [`${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`])];
  const seen = new Set<string>();
  const pages = new Map<string, string | null>();
  while (queue.length && seen.size < SITEMAPS_MAX && pages.size < PAGES_MAX && timeLeft(options)) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    let body: string;
    try {
      body = (await text(next, options, 50_000_000)).body;
    } catch {
      continue;
    }
    if (/<sitemapindex\b/i.test(body)) {
      for (const match of body.matchAll(/<sitemap\b[\s\S]*?<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) queue.push(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
      continue;
    }
    for (const match of body.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
      const loc = match[0].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, "");
      const url = loc ? normal(loc, start) : null;
      if (!url || !sameSite(url, start.hostname) || SKIP.test(url.pathname) || !allowed(rules, url.pathname)) continue;
      if (!pages.has(url.href)) pages.set(url.href, match[0].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1] ?? null);
      if (pages.size >= PAGES_MAX) break;
    }
  }
  return pages;
}

export function pageLinksOf(html: string, base: URL) {
  const links: URL[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const url = normal(match[1], base);
    if (url) links.push(url);
  }
  return links;
}

function renderer(options: Options): Renderer | null {
  if (options.render !== undefined) return options.render;
  return browserbaseConfigured() ? (target, settings) => renderWithBrowserbase(target, settings) : null;
}

async function fromLinks(start: URL, rules: Rules, options: Options) {
  const pages = new Map<string, string | null>([[start.href, null]]);
  const depth = new Map<string, number>([[start.href, 0]]);
  const queue = [start.href];
  let fetched = 0;
  let active = 0;
  let reached = 0;
  let problem: string | null = null;
  const collect = (html: string, pageUrl: string, from: string) => {
    reached += 1;
    for (const url of pageLinksOf(html, new URL(pageUrl))) {
      if (!sameSite(url, start.hostname) || SKIP.test(url.pathname) || !allowed(rules, url.pathname) || pages.has(url.href)) continue;
      pages.set(url.href, null);
      depth.set(url.href, (depth.get(from) ?? 0) + 1);
      if ((depth.get(url.href) ?? 0) < 4 && !/\.(pdf|docx?|pptx?|xlsx?)$/i.test(url.pathname)) queue.push(url.href);
      if (pages.size >= PAGES_MAX) break;
    }
  };
  const worker = async () => {
    while ((queue.length || active) && fetched < CRAWL_MAX && pages.size < PAGES_MAX && timeLeft(options)) {
      if (!queue.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const current = queue.shift()!;
      fetched += 1;
      active += 1;
      let page;
      try {
        page = await text(current, options, 5_000_000);
      } catch (error) {
        if (current === start.href) {
          problem = error instanceof WebPageError ? error.message : "Orbit couldn't open that site.";
          const render = renderer(options);
          if (render && !/couldn't be found|Private and local/.test(problem)) {
            try {
              const rendered = await render(start.href, { proxies: true });
              collect(rendered.html, rendered.url, current);
            } catch {}
          }
        }
        continue;
      } finally {
        active -= 1;
      }
      if (!/html/.test(page.contentType) && !/^\s*</.test(page.body)) continue;
      collect(page.body, page.url, current);
    }
  };
  await Promise.all(Array.from({ length: CRAWL_PARALLEL }, worker));
  return { pages, complete: queue.length === 0, reached, problem };
}

function readable(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export async function mapSite(raw: unknown, options: Options = {}): Promise<SiteMap> {
  const start = new URL(cleanUrl(raw));
  start.pathname = start.pathname || "/";
  let rules: Rules = { allow: [], disallow: [], sitemaps: [] };
  try {
    rules = robotsRules((await text(`${start.origin}/robots.txt`, options, 2_000_000)).body);
  } catch (error) {
    if (error instanceof WebPageError && /Private and local/.test(error.message)) throw new CrmError("invalid_input", error.message, 400, { field: "url" });
  }
  let source: SiteMap["source"] = "sitemap";
  let pages = await fromSitemaps(start, rules, options);
  let truncated = pages.size >= PAGES_MAX;
  if (pages.size === 0) {
    source = "links";
    const crawled = await fromLinks(start, rules, options);
    if (crawled.reached === 0) throw new CrmError("invalid_input", crawled.problem ?? "Orbit couldn't open that site.", 400, { field: "url" });
    pages = crawled.pages;
    truncated = !crawled.complete || pages.size >= PAGES_MAX;
  }
  if (!pages.has(start.href) && allowed(rules, start.pathname)) pages.set(start.href, null);
  const list = [...pages].map(([url, lastModified]) => {
    const parsed = new URL(url);
    const path = `${readable(parsed.pathname)}${parsed.search}`;
    return { url, path, depth: parsed.pathname.split("/").filter(Boolean).length, lastModified };
  });
  list.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return { origin: start.origin, host: bare(start.hostname), pages: list, source, truncated };
}
