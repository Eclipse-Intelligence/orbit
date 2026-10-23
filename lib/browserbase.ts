const API = "https://api.browserbase.com/v1";
const SESSION_SECONDS = 120;
const LOAD_MS = 25_000;
const SETTLE_MS = 6_000;

export type RenderedPage = { html: string; url: string };
export type Renderer = (url: string, options: { proxies: boolean }) => Promise<RenderedPage>;

export class BrowserbaseError extends Error {}

export function browserbaseConfigured() {
  return Boolean(process.env.BROWSERBASE_API_KEY?.trim());
}

async function api(path: string, body: unknown, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-api-key": process.env.BROWSERBASE_API_KEY!.trim() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new BrowserbaseError(`Browserbase answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response.json() as Promise<{ id: string; connectUrl: string }>;
}

export async function renderWithBrowserbase(url: string, options: { proxies: boolean; fetchImpl?: typeof fetch }): Promise<RenderedPage> {
  if (!browserbaseConfigured()) throw new BrowserbaseError("Browserbase isn't set up.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  const session = await api(
    "/sessions",
    {
      ...(projectId ? { projectId } : {}),
      timeout: SESSION_SECONDS,
      browserSettings: { blockAds: true, solveCaptchas: true, viewport: { width: 1366, height: 900 } },
      ...(options.proxies ? { proxies: true } : {}),
    },
    fetchImpl,
  );
  const { chromium } = await import("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
    return { html: await page.content(), url: page.url() };
  } finally {
    await browser?.close().catch(() => undefined);
    await api(`/sessions/${encodeURIComponent(session.id)}`, { ...(projectId ? { projectId } : {}), status: "REQUEST_RELEASE" }, fetchImpl).catch(() => undefined);
  }
}
