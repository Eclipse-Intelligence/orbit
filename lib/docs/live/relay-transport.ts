import type { LiveEvent } from "@/lib/docs/live/protocol";
import type { LiveTransport } from "@/lib/docs/live/transport";

const ENDPOINT = "/api/docs/live/relay";
const KEEPALIVE_BODY_MAX = 16_000;

export function relayTransport(): LiveTransport {
  const client = crypto.randomUUID();
  return {
    open(topic, handlers) {
      let joined = false;
      let closed = false;
      let chain: Promise<unknown> = Promise.resolve();
      const source = new EventSource(`${ENDPOINT}?topic=${encodeURIComponent(topic)}&client=${client}`);
      handlers.status("joining");
      source.onopen = () => {
        joined = true;
        handlers.status("joined");
      };
      source.onerror = () => {
        if (closed) return;
        joined = false;
        handlers.status("closed");
      };
      source.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data as string) as { event: LiveEvent; payload: unknown };
          handlers.message(parsed.event, parsed.payload);
        } catch {}
      };
      return {
        send(event, payload) {
          if (!joined) return false;
          const body = JSON.stringify({ topic, event, payload, client });
          const keepalive = body.length < KEEPALIVE_BODY_MAX;
          chain = chain.then(() => fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body, credentials: "same-origin", keepalive }).catch(() => null));
          return true;
        },
        close() {
          closed = true;
          joined = false;
          source.close();
        },
      };
    },
  };
}
