import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { supabaseConfigured } from "@/lib/auth/config";
import { query } from "@/lib/db/pool";
import { docTopic, LIVE_MESSAGE_MAX, personTopic, workspaceTopic, type LiveAwareness, type LiveEvent, type LiveTransportKind, type LiveUser } from "@/lib/docs/live/protocol";
import { relayEnabled, relayPublish } from "@/lib/docs/live/relay-hub";
import { decodeBytes, encodeBytes } from "@/lib/docs/live/ydoc";

export type LiveStep = { u: string; from: unknown; head: unknown };

export type LiveChange = {
  pageId: string;
  workspaceId: string;
  ownerId: string | null;
  shared: boolean;
  revision: number;
  generation: number;
  agent: LiveUser | null;
  steps: LiveStep[];
  typedCharacters: number;
  rebuilt?: boolean;
};

export type LiveSink = (topic: string, event: LiveEvent, payload: unknown) => Promise<void>;

type Options = { sink?: LiveSink | null; wait?: (ms: number) => Promise<void>; watched?: (pageId: string) => Promise<boolean> };

const WATCH_WINDOW_SECONDS = 90;
const TYPING_MIN_MS = 1_000;
const TYPING_MAX_MS = 3_000;
const TYPING_MS_PER_CHARACTER = 15;
const LINGER_MS = 1_500;
const SEND_TIMEOUT_MS = 5_000;
const BATCH_CONCURRENCY = 4;
const BATCH_BUDGET_MS = 8_000;

let testing: Options | null = null;

function baseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "") || null;
}

function secretKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim() || null;
}

export function liveTransport(): LiveTransportKind | null {
  if (supabaseConfigured()) return "supabase";
  if (relayEnabled()) return "relay";
  return null;
}

let batchOnly = false;

export function supabaseSink(fetchImpl: typeof fetch = fetch): LiveSink | null {
  const base = baseUrl();
  const key = secretKey();
  if (!base || !key) return null;
  const headers = { apikey: key, "content-type": "application/json", ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}) };
  const sendBatch = async (topic: string, event: LiveEvent, payload: unknown) => {
    const response = await fetchImpl(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Realtime broadcast failed with ${response.status}`);
  };
  return async (topic, event, payload) => {
    if (batchOnly) return sendBatch(topic, event, payload);
    const response = await fetchImpl(`${base}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}?private=true`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status === 404) {
      batchOnly = true;
      return sendBatch(topic, event, payload);
    }
    if (!response.ok) throw new Error(`Realtime broadcast failed with ${response.status}`);
  };
}

export function livePublishing() {
  return supabaseSink() !== null || relaySink() !== null;
}

export function resetBroadcastFallback() {
  batchOnly = false;
}

function relaySink(): LiveSink | null {
  if (!relayEnabled() || supabaseConfigured()) return null;
  return async (topic, event, payload) => {
    relayPublish(topic, event, payload);
  };
}

export function setLiveTesting(options: Options | null) {
  testing = options;
}

function currentSink() {
  if (testing && "sink" in testing) return testing.sink ?? null;
  return supabaseSink() ?? relaySink();
}

function pause(ms: number) {
  if (testing?.wait) return testing.wait(ms);
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function pageWatched(pageId: string) {
  if (testing?.watched) return testing.watched(pageId);
  const result = await query<{ watched: boolean }>("select private.page_watched($1, $2) as watched", [pageId, WATCH_WINDOW_SECONDS]);
  return result.rows[0]?.watched === true;
}

export function typingDuration(characters: number) {
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, characters * TYPING_MS_PER_CHARACTER));
}

function activityTopic(change: LiveChange) {
  if (change.shared) return workspaceTopic(change.workspaceId);
  return change.ownerId ? personTopic(change.ownerId) : null;
}

function mergedSteps(steps: LiveStep[]) {
  const updates: Uint8Array[] = [];
  for (const step of steps) {
    const update = decodeBytes(step.u);
    if (update) updates.push(update);
  }
  if (updates.length === 0) return null;
  return encodeBytes(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
}

async function stream(sink: LiveSink, topic: string, change: LiveChange, agent: LiveUser) {
  const awareness = new Awareness(new Y.Doc());
  const encode = (state: LiveAwareness | null) => {
    awareness.setLocalState(state);
    return encodeBytes(encodeAwarenessUpdate(awareness, [awareness.clientID]));
  };
  try {
    const interval = typingDuration(change.typedCharacters) / Math.max(1, change.steps.length);
    const started = Date.now();
    let last: LiveStep | null = null;
    for (const [index, step] of change.steps.entries()) {
      last = step;
      const a = encode({ user: agent, cursor: { anchor: step.head, head: step.head }, from: step.from, writing: true });
      await sink(topic, "update", { u: step.u, a, server: true, g: change.generation });
      if (index < change.steps.length - 1) await pause(started + (index + 1) * interval - Date.now());
    }
    if (last) await sink(topic, "awareness", { a: encode({ user: agent, cursor: { anchor: last.head, head: last.head }, from: last.from, writing: false }) });
    await pause(LINGER_MS);
    await sink(topic, "awareness", { a: encode(null) });
  } finally {
    awareness.destroy();
    awareness.doc.destroy();
  }
}

export async function publishLiveChange(change: LiveChange) {
  const sink = currentSink();
  if (!sink) return;
  if (change.rebuilt) {
    await sink(docTopic(change.pageId), "pull", { r: change.revision, g: change.generation });
    return;
  }
  if (change.steps.length === 0) return;
  const activity = change.agent ? activityTopic(change) : null;
  if (activity && change.agent) await sink(activity, "writing", { pageId: change.pageId, user: change.agent, writing: true }).catch(() => {});
  try {
    const watched = await pageWatched(change.pageId).catch(() => true);
    if (!watched) return;
    const topic = docTopic(change.pageId);
    const tooLarge = change.steps.some((step) => step.u.length > LIVE_MESSAGE_MAX);
    if (tooLarge) {
      await sink(topic, "pull", { r: change.revision, g: change.generation });
      return;
    }
    if (change.agent) {
      await stream(sink, topic, change, change.agent);
      return;
    }
    const merged = mergedSteps(change.steps);
    if (!merged) return;
    if (merged.length > LIVE_MESSAGE_MAX) await sink(topic, "pull", { r: change.revision, g: change.generation });
    else await sink(topic, "update", { u: merged, server: true, g: change.generation });
  } finally {
    if (activity && change.agent) await sink(activity, "writing", { pageId: change.pageId, user: change.agent, writing: false, revision: change.revision }).catch(() => {});
  }
}

export async function publishLiveChanges(changes: LiveChange[], budgetMs = BATCH_BUDGET_MS) {
  const stopAt = Date.now() + budgetMs;
  const queue = [...changes];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() > stopAt) return;
      await publishLiveChange(next).catch((error) => console.error("Live publish failed", error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
}
