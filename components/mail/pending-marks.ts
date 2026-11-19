import type { ThreadSummary } from "@/lib/mail/view";

export type MarkAction = "read" | "unread" | "flag" | "unflag";

export function markSummary(thread: ThreadSummary, action: MarkAction): ThreadSummary {
  if (action === "read" || action === "unread") return { ...thread, unread: action === "unread" };
  return { ...thread, flagged: action === "flag" };
}

type Mark = { action: MarkAction; savedAt: number | null };

export function createPendingMarks() {
  const marks = new Map<string, Mark[]>();
  const reading = new Set<number>();
  let clock = 0;

  function prune() {
    const oldest = reading.size ? Math.min(...reading) : Infinity;
    for (const [key, list] of marks) {
      const rest = list.filter((mark) => mark.savedAt === null || mark.savedAt > oldest);
      if (rest.length) marks.set(key, rest);
      else marks.delete(key);
    }
  }

  function drop(key: string, mark: Mark) {
    const rest = (marks.get(key) ?? []).filter((item) => item !== mark);
    if (rest.length) marks.set(key, rest);
    else marks.delete(key);
  }

  return {
    hold(key: string, action: MarkAction) {
      const mark: Mark = { action, savedAt: null };
      marks.set(key, [...(marks.get(key) ?? []), mark]);
      return {
        saved() {
          if (mark.savedAt !== null) return;
          mark.savedAt = ++clock;
          prune();
        },
        failed() {
          drop(key, mark);
        },
      };
    },
    reading() {
      const startedAt = ++clock;
      reading.add(startedAt);
      return {
        startedAt,
        done() {
          reading.delete(startedAt);
          prune();
        },
      };
    },
    keep(threads: ThreadSummary[], startedAt = Infinity) {
      if (marks.size === 0) return threads;
      return threads.map((thread) =>
        (marks.get(thread.key) ?? [])
          .filter((mark) => mark.savedAt === null || mark.savedAt > startedAt)
          .reduce((kept, mark) => markSummary(kept, mark.action), thread),
      );
    },
  };
}
