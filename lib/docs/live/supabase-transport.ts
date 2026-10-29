import { createBrowserClient } from "@supabase/ssr";
import type { LiveEvent } from "@/lib/docs/live/protocol";
import type { LiveTransport } from "@/lib/docs/live/transport";

type Client = ReturnType<typeof createBrowserClient>;
type Channel = ReturnType<Client["channel"]>;

let shared: Promise<Client | null> | null = null;
const leaving = new Map<string, Promise<void>>();

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

function remove(client: Client, topic: string, channel: Channel) {
  const previous = leaving.get(topic) ?? Promise.resolve();
  const done: Promise<void> = previous
    .then(() => client.removeChannel(channel))
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      if (leaving.get(topic) === done) leaving.delete(topic);
    });
  leaving.set(topic, done);
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
      let closed = false;
      let channel: Channel | null = null;
      handlers.status("joining");
      const join = () => {
        if (closed) return;
        const opened = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
        channel = opened;
        opened.on("broadcast", { event: "*" }, (message: { event: string; payload?: unknown }) => {
          if (!closed) handlers.message(message.event as LiveEvent, message.payload ?? null);
        });
        opened.subscribe((status: string) => {
          if (closed) return;
          if (status === "SUBSCRIBED") {
            joined = true;
            handlers.status("joined");
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            joined = false;
            handlers.status("closed");
          }
        });
      };
      const pending = leaving.get(topic);
      if (pending) void pending.then(join);
      else join();
      return {
        send(event, payload) {
          if (!joined || !channel) return false;
          void channel.send({ type: "broadcast", event, payload }).catch(() => {});
          return true;
        },
        close() {
          if (closed) return;
          closed = true;
          joined = false;
          if (channel) remove(client, topic, channel);
        },
      };
    },
  };
}
