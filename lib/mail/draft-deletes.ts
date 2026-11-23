type Entry = { timer: ReturnType<typeof setTimeout>; thread: string; failed: (id: string, problem: string) => void };

export function createDraftDeletes(options: {
  delayMs: number;
  send: (id: string, keepalive: boolean) => Promise<string | null>;
  deleted: (thread: string) => void;
}) {
  const pending = new Map<string, Entry>();
  const discarded = new Set<string>();
  const listeners = new Set<() => void>();
  const watchers = new Set<(id: string, problem: string) => boolean>();
  let version = 0;

  function changed() {
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function run(id: string, keepalive: boolean) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    void options.send(id, keepalive).then((problem) => {
      if (!problem) {
        options.deleted(entry.thread);
        return;
      }
      discarded.delete(id);
      changed();
      const handled = [...watchers].map((watcher) => watcher(id, problem)).some(Boolean);
      if (!handled) entry.failed(id, problem);
    });
  }

  return {
    schedule(id: string, thread: string, failed: Entry["failed"]) {
      const earlier = pending.get(id);
      if (earlier) clearTimeout(earlier.timer);
      const added = !discarded.has(id);
      discarded.add(id);
      pending.set(id, { timer: setTimeout(() => run(id, false), options.delayMs), thread, failed });
      if (added) changed();
    },
    cancel(id: string) {
      const entry = pending.get(id);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(id);
      discarded.delete(id);
      changed();
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
    version() {
      return version;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onFailure(watcher: (id: string, problem: string) => boolean) {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}
