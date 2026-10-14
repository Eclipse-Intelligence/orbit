import { stopsRun } from "@/lib/crm/personalise";

export type SendUpdate =
  | { id: string; status: "sending" }
  | { id: string; status: "sent"; warning?: string }
  | { id: string; status: "failed"; error: string };

export async function sendPaced<T extends { id: string }>(
  items: T[],
  send: (item: T) => Promise<{ error?: string | null; warning?: string | null }>,
  options: {
    gapMs: number;
    stopped: () => boolean;
    wait: (ms: number) => Promise<void>;
    onUpdate: (update: SendUpdate) => void;
    now?: () => number;
  },
) {
  const now = options.now ?? Date.now;
  let sent = 0;
  let halted: string | null = null;
  let started: number | null = null;
  let index = 0;
  for (; index < items.length; index += 1) {
    if (options.stopped()) break;
    if (started !== null) {
      const wait = options.gapMs - (now() - started);
      if (wait > 0) await options.wait(wait);
      if (options.stopped()) break;
    }
    const item = items[index];
    started = now();
    options.onUpdate({ id: item.id, status: "sending" });
    let result: { error?: string | null; warning?: string | null };
    try {
      result = await send(item);
    } catch {
      result = { error: "Could not reach Orbit." };
    }
    if (result.error) {
      options.onUpdate({ id: item.id, status: "failed", error: result.error });
      if (stopsRun(result.error)) {
        halted = result.error;
        index += 1;
        break;
      }
      continue;
    }
    sent += 1;
    options.onUpdate({ id: item.id, status: "sent", warning: result.warning ?? undefined });
  }
  return { sent, halted, unsent: items.slice(index).map((item) => item.id) };
}
