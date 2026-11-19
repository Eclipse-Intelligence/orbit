export type TickLedger = {
  busy: (id: string) => boolean;
  begin: (id: string, work: Promise<string | null>) => Promise<string | null>;
  release: (id: string) => void;
  take: (id: string) => Promise<string | null>;
};

export function createTickLedger(): TickLedger {
  const pending = new Map<string, Promise<string | null>>();
  const done = new Map<string, string>();
  return {
    busy: (id) => pending.has(id),
    begin(id, work) {
      const tracked: Promise<string | null> = work
        .catch(() => null)
        .then((doneId) => {
          if (doneId) done.set(id, doneId);
          else if (pending.get(id) === tracked) pending.delete(id);
          return doneId;
        });
      pending.set(id, tracked);
      return tracked;
    },
    release(id) {
      pending.delete(id);
    },
    async take(id) {
      const work = pending.get(id);
      const doneId = (work ? await work : null) ?? done.get(id) ?? null;
      pending.delete(id);
      done.delete(id);
      return doneId;
    },
  };
}
