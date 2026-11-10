import type { ThreadSummary } from "@/lib/mail/view";

export type Shown = { thread: ThreadSummary; leaving: boolean };

export function keepLeaving(previous: Shown[], next: ThreadSummary[]): Shown[] {
  const result: Shown[] = next.map((thread) => ({ thread, leaving: false }));
  const position = new Map(next.map((thread, index) => [thread.key, index]));
  let anchor = -1;
  let inserted = 0;
  for (const item of previous) {
    const at = position.get(item.thread.key);
    if (at !== undefined) {
      anchor = at + inserted;
      continue;
    }
    result.splice(anchor + 1, 0, { thread: item.thread, leaving: true });
    anchor += 1;
    inserted += 1;
  }
  return result;
}
