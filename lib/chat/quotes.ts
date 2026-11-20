import { chatApi } from "@/lib/chat/client";
import { CHAT_QUOTES_MAX, type ChatLiveEvent, type ChatQuote } from "@/lib/chat/types";

const QUOTE_FRESH_MS = 30_000;

export const QUOTE_UNAVAILABLE = "Message unavailable";

export type QuoteView = "loading" | "failed" | "unavailable" | "shown";

export function quoteView(quote: ChatQuote | null | undefined, failed: boolean): QuoteView {
  if (quote === null) return "unavailable";
  if (quote === undefined) return failed ? "failed" : "loading";
  return "shown";
}

type Entry = { at: number; quote: ChatQuote | null };
type Loader = (ids: string[]) => Promise<ChatQuote[]>;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const generations = new Map<string, number>();

function generation(id: string) {
  return generations.get(id) ?? 0;
}

function fresh(id: string, now: number) {
  const entry = entries.get(id);
  return entry && now - entry.at <= QUOTE_FRESH_MS ? entry : null;
}

function changed() {
  for (const listener of listeners) listener();
}

export function subscribeQuotes(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cachedQuote(id: string): ChatQuote | null | undefined {
  const entry = entries.get(id);
  return entry ? entry.quote : undefined;
}

function supersede(id: string) {
  if (inflight.has(id)) generations.set(id, generation(id) + 1);
}

export function applyQuoteEvent(event: ChatLiveEvent, now = Date.now()) {
  if (event.type === "delete") {
    supersede(event.messageId);
    if (!entries.has(event.messageId)) return;
    entries.set(event.messageId, { at: now, quote: null });
    changed();
    return;
  }
  if (event.type === "edit") {
    const id = event.message.id;
    const entry = entries.get(id);
    supersede(id);
    if (!entry?.quote) return;
    entries.set(id, { at: 0, quote: entry.quote });
    void loadQuotes([id]);
    return;
  }
  if (event.type === "removed") {
    for (const id of inflight.keys()) supersede(id);
    let touched = false;
    for (const [id, entry] of entries) {
      if (entry.quote?.conversationId !== event.conversationId) continue;
      entries.set(id, { at: now, quote: null });
      touched = true;
    }
    if (touched) changed();
  }
}

export async function loadQuotes(ids: string[], options: { load?: Loader; now?: () => number } = {}): Promise<void> {
  const load = options.load ?? ((wanted) => chatApi.quotes(wanted).then((result) => result.quotes));
  const now = options.now ?? Date.now;
  const missing = [...new Set(ids)].filter((id) => !fresh(id, now()) && !inflight.has(id));
  for (let start = 0; start < missing.length; start += CHAT_QUOTES_MAX) {
    const batch = missing.slice(start, start + CHAT_QUOTES_MAX);
    const started = new Map(batch.map((id) => [id, generation(id)]));
    const request = load(batch)
      .then((quotes) => {
        const at = now();
        for (const id of batch) {
          if (generation(id) !== started.get(id)) continue;
          entries.set(id, { at, quote: quotes.find((quote) => quote.id === id) ?? null });
        }
        changed();
      })
      .catch(() => undefined)
      .finally(() => {
        for (const id of batch) inflight.delete(id);
        const edited = batch.filter((id) => generation(id) !== started.get(id));
        if (edited.length > 0) void loadQuotes(edited, options);
      });
    for (const id of batch) inflight.set(id, request);
  }
  await Promise.all(ids.map((id) => inflight.get(id)));
}

let pending = new Set<string>();
let flushing: Promise<void> | null = null;

export function requestQuote(id: string): Promise<void> {
  pending.add(id);
  if (!flushing) {
    flushing = Promise.resolve().then(() => {
      const ids = [...pending];
      pending = new Set();
      flushing = null;
      return loadQuotes(ids);
    });
  }
  return flushing;
}
