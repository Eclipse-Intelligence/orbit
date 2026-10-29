type Listener = (event: string, payload: unknown) => void;

type Hub = { topics: Map<string, Map<string, Listener>> };

const holder = globalThis as typeof globalThis & { __docsRelayHub?: Hub };

function hub(): Hub {
  holder.__docsRelayHub ??= { topics: new Map() };
  return holder.__docsRelayHub;
}

export function relayEnabled() {
  return process.env.DOCS_LIVE_RELAY === "1";
}

export function relaySubscribe(topic: string, id: string, listener: Listener) {
  const topics = hub().topics;
  const members = topics.get(topic) ?? new Map<string, Listener>();
  members.set(id, listener);
  topics.set(topic, members);
  return () => {
    members.delete(id);
    if (members.size === 0) topics.delete(topic);
  };
}

export function relayPublish(topic: string, event: string, payload: unknown, from: string | null = null) {
  const members = hub().topics.get(topic);
  if (!members) return 0;
  let delivered = 0;
  for (const [id, listener] of members) {
    if (id === from) continue;
    try {
      listener(event, payload);
      delivered += 1;
    } catch {}
  }
  return delivered;
}
