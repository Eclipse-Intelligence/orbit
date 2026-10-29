import { supabaseConfigured } from "@/lib/auth/config";
import { getUserActor } from "@/lib/auth/user";
import { canonicalTopic, type LiveEvent } from "@/lib/docs/live/protocol";
import { relayAllows } from "@/lib/docs/live/relay-access";
import { relayEnabled, relayPublish, relaySubscribe } from "@/lib/docs/live/relay-hub";

export const dynamic = "force-dynamic";

const EVENTS: LiveEvent[] = ["hello", "state", "update", "awareness", "saved", "pull", "title"];

function unavailable() {
  return Response.json({ error: "Live editing isn't switched on here." }, { status: 404 });
}

export async function GET(request: Request) {
  if (!relayEnabled() || supabaseConfigured()) return unavailable();
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const topic = canonicalTopic(params.get("topic") ?? "");
  const client = params.get("client") ?? "";
  if (!topic || !client || !(await relayAllows(actor, topic, false))) return Response.json({ error: "You can't follow that note." }, { status: 403 });
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const unsubscribe = relaySubscribe(topic, client, (event, payload) => write(`data: ${JSON.stringify({ event, payload })}\n\n`));
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      stop = () => {
        unsubscribe();
        clearInterval(ping);
      };
      request.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
      write(": joined\n\n");
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}

export async function POST(request: Request) {
  if (!relayEnabled() || supabaseConfigured()) return unavailable();
  const actor = await getUserActor();
  if (!actor) return Response.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  const input = (await request.json().catch(() => null)) as { topic?: unknown; event?: unknown; payload?: unknown; client?: unknown } | null;
  const topic = typeof input?.topic === "string" ? canonicalTopic(input.topic) : null;
  const event = EVENTS.find((item) => item === input?.event);
  if (!topic || !event || !(await relayAllows(actor, topic, true))) return Response.json({ error: "You can't edit that note." }, { status: 403 });
  relayPublish(topic, event, input?.payload ?? null, typeof input?.client === "string" ? input.client : null);
  return new Response(null, { status: 204 });
}
