import type { MailDraft, MailNav, ThreadCursor, ThreadDetail, ThreadSummary } from "@/lib/mail/view";

export type ThreadPage = { threads: ThreadSummary[]; next: ThreadCursor | null };
export type ListQuery = { view: string; account: string | null; query: string };

const lists = new Map<string, ThreadPage>();
const details = new Map<string, ThreadDetail>();
const pending = new Map<string, Promise<ThreadDetail>>();

export function listKey(query: ListQuery) {
  return `${query.query ? "search" : query.view}|${query.account ?? ""}|${query.query}`;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Mail didn't load. Try again.");
  return body;
}

export function cachedList(query: ListQuery) {
  return lists.get(listKey(query)) ?? null;
}

export function storeList(query: ListQuery, page: ThreadPage) {
  lists.set(listKey(query), page);
}

export function forgetOtherLists(keep: ListQuery) {
  const key = listKey(keep);
  for (const existing of [...lists.keys()]) if (existing !== key) lists.delete(existing);
}

export async function fetchList(query: ListQuery, before?: ThreadCursor | null) {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  else params.set("view", query.view);
  if (query.account) params.set("account", query.account);
  if (before) params.set("before", `${before.at}~${before.key}`);
  return getJson<ThreadPage>(`/api/mail/threads?${params}`);
}

export function cachedThread(key: string) {
  return details.get(key) ?? null;
}

export function storeThread(detail: ThreadDetail) {
  details.set(detail.key, detail);
}

export function forgetThread(key: string) {
  details.delete(key);
}

export function loadThread(key: string, fresh = false) {
  const hit = details.get(key);
  if (hit && !fresh) return Promise.resolve(hit);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = getJson<ThreadDetail>(`/api/mail/thread?key=${encodeURIComponent(key)}`)
    .then((detail) => {
      details.set(key, detail);
      return detail;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function prefetchThreads(keys: string[]) {
  let index = 0;
  const work = async () => {
    while (index < keys.length) {
      const key = keys[index++];
      if (details.has(key)) continue;
      await loadThread(key).catch(() => null);
    }
  };
  void Promise.all([work(), work()]);
}

export function fetchNav() {
  return getJson<MailNav>("/api/mail/nav");
}

export function postAction(thread: string, action: string, view: string, until?: string) {
  return getJson<{ changed: number }>("/api/mail/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread, action, view, until }),
  });
}

export function fetchScheduled() {
  return getJson<{ drafts: MailDraft[] }>("/api/mail/scheduled").then((body) => body.drafts);
}

export function syncNow() {
  return getJson<{ stored: number; removed: number }>("/api/mail/sync", { method: "POST" });
}
