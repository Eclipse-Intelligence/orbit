import type {
  ExistingMailChoice,
  MailAttachmentMeta,
  MailDraft,
  MailNav,
  SubscriptionSender,
  SubscriptionStatus,
  ThreadCursor,
  ThreadDetail,
  ThreadSummary,
  UnsubscribePreview,
  UnsubscribeResult,
} from "@/lib/mail/view";

export type ThreadPage = { threads: ThreadSummary[]; next: ThreadCursor | null };
export type ListQuery = { view: string; account: string | null; query: string };

const lists = new Map<string, ThreadPage>();
const details = new Map<string, ThreadDetail>();
const pending = new Map<string, Promise<ThreadDetail>>();
const prefetching = new Map<string, Promise<ThreadDetail>>();
const summaries = new Map<string, Promise<ThreadSummaryText>>();
const attachmentLists = new Map<string, MailAttachmentMeta[]>();

export type ThreadSummaryText = { summary: string | null; todo: string | null };
export type AskResult = { answer: string; sources: { key: string; subject: string | null; from: string; at: string | null }[] };

function listKey(query: ListQuery) {
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

function keep(detail: ThreadDetail) {
  details.set(detail.key, detail);
  const cached = detail.cachedSummary;
  if (cached && !summaries.has(`${detail.key}|${cached.latestId}`)) {
    summaries.set(`${detail.key}|${cached.latestId}`, Promise.resolve({ summary: cached.summary, todo: cached.todo }));
  }
  for (const message of detail.messages) if (message.attachments) attachmentLists.set(message.id, message.attachments);
}

export function storeThread(detail: ThreadDetail) {
  keep(detail);
}

export function cachedAttachments(messageId: string) {
  return attachmentLists.get(messageId) ?? null;
}

export function forgetThread(key: string) {
  details.delete(key);
}

function requestThread(key: string, attachments: boolean) {
  const queue = attachments ? prefetching : pending;
  const request = getJson<ThreadDetail>(`/api/mail/thread?key=${encodeURIComponent(key)}${attachments ? "&attachments=1" : ""}`)
    .then((detail) => {
      keep(detail);
      return detail;
    })
    .finally(() => queue.delete(key));
  queue.set(key, request);
  return request;
}

export function loadThread(key: string, fresh = false) {
  const hit = details.get(key);
  if (hit && !fresh) return Promise.resolve(hit);
  return pending.get(key) ?? requestThread(key, false);
}

export function prefetchThreads(keys: string[]) {
  let index = 0;
  const work = async () => {
    while (index < keys.length) {
      const key = keys[index++];
      if (details.has(key) || pending.has(key)) continue;
      await (prefetching.get(key) ?? requestThread(key, true)).catch(() => null);
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
  return getJson<{ stored: number; removed: number; version?: string | null }>("/api/mail/sync", { method: "POST" });
}

export function loadSummary(key: string, latestId: string) {
  const cacheKey = `${key}|${latestId}`;
  const hit = summaries.get(cacheKey);
  if (hit) return hit;
  const request = getJson<ThreadSummaryText>(`/api/mail/summary?key=${encodeURIComponent(key)}`).catch((error) => {
    summaries.delete(cacheKey);
    throw error;
  });
  summaries.set(cacheKey, request);
  return request;
}

export function askAi(question: string, account: string | null) {
  return getJson<AskResult>("/api/mail/ai/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, account }),
  });
}

export function writeWithAi(input: { mode: string; messageId: string | null; to: unknown[]; subject: string; instruction: string; current: string }) {
  return getJson<{ body: string }>("/api/mail/ai/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function postSenderSplit(sender: string, split: string | null) {
  return getJson<{ sender: string; split: string | null }>("/api/mail/sender-split", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender, split }),
  });
}

export type UnsubscribeTarget = { thread?: string; sender?: string };
export type SenderAction = "keep" | "research" | "block" | "subscribe";
export type SenderChange = { sender: string; status: SubscriptionStatus; moved: number; remaining: number; error: string | null };
export type BulkResult = UnsubscribeResult | { sender: string; error: string };

export function fetchUnsubscribePreview(target: UnsubscribeTarget, mode?: string) {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (target.thread) params.set("thread", target.thread);
  if (target.sender) params.set("sender", target.sender);
  return getJson<UnsubscribePreview>(`/api/mail/unsubscribe?${params}`);
}

export function postUnsubscribe(target: UnsubscribeTarget & { existing: ExistingMailChoice; block?: boolean; confirmed?: boolean }) {
  return getJson<UnsubscribeResult>("/api/mail/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
}

export function postSenderAction(input: { sender: string; action: SenderAction; existing?: ExistingMailChoice; confirmed?: boolean }) {
  return getJson<SenderChange>("/api/mail/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function fetchSubscriptions() {
  return getJson<{ days: number; senders: SubscriptionSender[] }>("/api/mail/subscriptions");
}

export function postBulkUnsubscribe(senders: string[], existing: ExistingMailChoice) {
  return getJson<{ results: BulkResult[] }>("/api/mail/subscriptions/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senders, existing }),
  });
}
