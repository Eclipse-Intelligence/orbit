import type { ThreadSummary } from "@/lib/mail/view";

export type MarkAction = "read" | "unread" | "flag" | "unflag";

export function markSummary(thread: ThreadSummary, action: MarkAction): ThreadSummary {
  if (action === "read" || action === "unread") return { ...thread, unread: action === "unread" };
  return { ...thread, flagged: action === "flag" };
}

export function createPendingMarks() {
  const pending = new Map<string, { action: MarkAction }[]>();
  return {
    hold(key: string, action: MarkAction) {
      const entry = { action };
      pending.set(key, [...(pending.get(key) ?? []), entry]);
      return () => {
        const rest = (pending.get(key) ?? []).filter((item) => item !== entry);
        if (rest.length) pending.set(key, rest);
        else pending.delete(key);
      };
    },
    keep(threads: ThreadSummary[]) {
      if (pending.size === 0) return threads;
      return threads.map((thread) => (pending.get(thread.key) ?? []).reduce((kept, entry) => markSummary(kept, entry.action), thread));
    },
  };
}
