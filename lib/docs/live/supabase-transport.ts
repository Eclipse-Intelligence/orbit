import { createBrowserClient } from "@supabase/ssr";
import type { LiveEvent } from "@/lib/docs/live/protocol";
import type { LiveTransport } from "@/lib/docs/live/transport";

type Client = ReturnType<typeof createBrowserClient>;

let shared: Promise<Client | null> | null = null;

async function connect(): Promise<Client | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const client = createBrowserClient(url, key);
  const { data } = await client.auth.getSession();
  if (!data.session) return null;
  await client.realtime.setAuth();
  return client;
}

export async function supabaseTransport(): Promise<LiveTransport | null> {
  shared ??= connect().catch(() => null);
  const client = await shared;
  if (!client) {
    shared = null;
    return null;
  }
  return {
    open(topic, handlers) {
      let joined = false;
      const channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      channel.on("broadcast", { event: "*" }, (message: { event: string; payload?: unknown }) => {
        handlers.message(message.event as LiveEvent, message.payload ?? null);
      });
      handlers.status("joining");
      channel.subscribe((status: string) => {
        if (status === "SUBSCRIBED") {
          joined = true;
          handlers.status("joined");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          joined = false;
          handlers.status("closed");
        }
      });
      return {
        send(event, payload) {
          if (!joined) return false;
          void channel.send({ type: "broadcast", event, payload }).catch(() => {});
          return true;
        },
        close() {
          joined = false;
          void client.removeChannel(channel).catch(() => {});
        },
      };
    },
  };
}
