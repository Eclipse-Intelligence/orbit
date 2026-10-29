import { canonicalTopic } from "@/lib/docs/live/protocol";

type Listener = (event: string, payload: unknown) => void;

type Member = { client: string; listener: Listener };
type Hub = { topics: Map<string, Map<number, Member>>; next: number };

const holder = globalThis as typeof globalThis & { __docsRelayHub?: Hub };

function hub(): Hub {
  if (typeof holder.__docsRelayHub?.next !== "number") holder.__docsRelayHub = { topics: new Map(), next: 1 };
  return holder.__docsRelayHub;
}

export function relayEnabled() {
  return process.env.DOCS_LIVE_RELAY === "1";
}

export function relaySubscribe(topic: string, client: string, listener: Listener) {
  const state = hub();
  const key = canonicalTopic(topic) ?? topic;
  const members = state.topics.get(key) ?? new Map<number, Member>();
  const id = state.next++;
  members.set(id, { client, listener });
  state.topics.set(key, members);
  return () => {
    members.delete(id);
    if (members.size === 0 && state.topics.get(key) === members) state.topics.delete(key);
  };
}

export function relayPublish(topic: string, event: string, payload: unknown, from: string | null = null) {
  const members = hub().topics.get(canonicalTopic(topic) ?? topic);
  if (!members) return 0;
  let delivered = 0;
  for (const { client, listener } of [...members.values()]) {
    if (from !== null && client === from) continue;
    try {
      listener(event, payload);
      delivered += 1;
    } catch {}
  }
  return delivered;
}
