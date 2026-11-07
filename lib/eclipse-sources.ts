export const DOCS_URL = "https://docs.geteclipse.co";

const DOCS_INDEX = `${DOCS_URL}/llms.txt`;
const CACHE_MS = 60 * 60_000;
const TEXT_MAX = 200_000;
const TIMEOUT_MS = 10_000;

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

export function allowedEclipseUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "docs.geteclipse.co" ? url : null;
  } catch {
    return null;
  }
}

export async function readEclipsePage(value: string, options: { fetchImpl?: Fetcher } = {}) {
  const url = allowedEclipseUrl(value);
  if (!url) throw new Error("Only Eclipse docs pages (docs.geteclipse.co) can be read here. Use read_web_page for other pages.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = url.pathname.replace(/\/+$/, "") || "/getting-started/introduction";
  const markdown = path.endsWith(".md") ? path : `${path}.md`;
  const text = await cached(`docs:${markdown}`, () => fetchText(`${DOCS_URL}${markdown}`, fetchImpl));
  return { url: `${DOCS_URL}${path.replace(/\.md$/, "")}`, title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null, text: text.slice(0, TEXT_MAX) };
}

export async function eclipseDocsIndex(options: { fetchImpl?: Fetcher } = {}) {
  return cached("docs-index", () => fetchText(DOCS_INDEX, options.fetchImpl ?? fetch).then((text) => text.slice(0, TEXT_MAX)));
}
