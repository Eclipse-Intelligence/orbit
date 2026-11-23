type Entry = { timer: ReturnType<typeof setTimeout>; thread: string; failed: (id: string, problem: string) => void };

export function createDraftDeletes(options: {
  delayMs: number;
  send: (id: string, keepalive: boolean) => Promise<string | null>;
  deleted: (thread: string) => void;
}) {
  const pending = new Map<string, Entry>();
  const discarded = new Set<string>();

  function run(id: string, keepalive: boolean) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    void options.send(id, keepalive).then((problem) => {
      if (problem) {
        discarded.delete(id);
        entry.failed(id, problem);
      } else options.deleted(entry.thread);
    });
  }

  return {
    schedule(id: string, thread: string, failed: Entry["failed"]) {
      const earlier = pending.get(id);
      if (earlier) clearTimeout(earlier.timer);
      discarded.add(id);
      pending.set(id, { timer: setTimeout(() => run(id, false), options.delayMs), thread, failed });
    },
    cancel(id: string) {
      const entry = pending.get(id);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(id);
      discarded.delete(id);
      return true;
    },
    flush() {
      for (const id of [...pending.keys()]) run(id, true);
    },
    isDiscarded(id: string) {
      return discarded.has(id);
    },
    waiting() {
      return pending.size;
    },
  };
}
