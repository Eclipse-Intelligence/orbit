import type { MatchStatus } from "../../lib/extension/protocol";
import { lookup, OrbitError, readToken } from "./api";
import { LINKEDIN_URL, TOKEN_KEY } from "./config";
import { isBackgroundMessage } from "./messages";
import { classifyUrl } from "./urls";

const CACHE_MS = 60_000;
const COLOURS: Record<Exclude<MatchStatus, "none">, string> = { in: "#22c55e", maybe: "#fbbf24" };
const TITLES: Record<MatchStatus, string> = { in: "In Orbit", maybe: "Possible match in Orbit", none: "Orbit" };

const cache = new Map<string, { at: number; status: MatchStatus }>();
const reported = new Map<number, { url: string; status: MatchStatus }>();
const latest = new Map<number, string>();
const inflight = new Map<string, Promise<MatchStatus>>();

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function paint(tabId: number, status: MatchStatus) {
  try {
    if (status === "none") {
      await chrome.action.setBadgeText({ tabId, text: "" });
    } else {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: COLOURS[status] });
      await chrome.action.setBadgeText({ tabId, text: " " });
    }
    await chrome.action.setTitle({ tabId, title: TITLES[status] });
  } catch {}
}

function statusFor(canonical: string): Promise<MatchStatus> {
  const cached = cache.get(canonical);
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.status);
  const running = inflight.get(canonical);
  if (running) return running;
  const pending = fetchStatus(canonical).finally(() => inflight.delete(canonical));
  inflight.set(canonical, pending);
  return pending;
}

async function fetchStatus(canonical: string): Promise<MatchStatus> {
  const token = await readToken();
  if (!token) return "none";
  try {
    const result = await lookup(token, { url: canonical });
    const status: MatchStatus = result.workspaces.some((item) => item.status === "in") ? "in" : "none";
    cache.set(canonical, { at: Date.now(), status });
    return status;
  } catch (error) {
    if (error instanceof OrbitError && error.status === 401) await chrome.storage.local.remove(TOKEN_KEY);
    return "none";
  }
}

async function refresh(tabId: number, url: string | undefined) {
  const target = classifyUrl(url, LINKEDIN_URL);
  latest.set(tabId, url ?? "");
  if (!target.canonical || (target.kind !== "person" && target.kind !== "company" && target.kind !== "lead")) {
    await paint(tabId, "none");
    return;
  }
  const status = await statusFor(target.canonical);
  if (latest.get(tabId) !== (url ?? "")) return;
  const panel = reported.get(tabId);
  const shown = status === "in" ? "in" : panel && panel.url === target.canonical ? panel.status : status;
  await paint(tabId, shown);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void refresh(tabId, changeInfo.url ?? tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => refresh(tabId, tab.url))
    .catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  reported.delete(tabId);
  latest.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(TOKEN_KEY in changes)) return;
  cache.clear();
  inflight.clear();
  reported.clear();
});

chrome.runtime.onMessage.addListener((message) => {
  if (!isBackgroundMessage(message)) return;
  if (message.type === "orbit:signed-out") {
    cache.clear();
    inflight.clear();
    reported.clear();
    return;
  }
  reported.set(message.tabId, { url: message.url, status: message.status });
  cache.set(message.url, { at: Date.now(), status: message.status === "in" ? "in" : "none" });
  void paint(message.tabId, message.status);
});
