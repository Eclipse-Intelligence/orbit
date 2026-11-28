const queues = new Map<string, Promise<unknown>>();

export function queueRename<T>(id: string, run: () => Promise<T>) {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => null).then(run);
  const tail = next.catch(() => null);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return next;
}

export async function renameIfLatest(
  id: string,
  title: string,
  steps: { latest: () => string; settle: () => Promise<boolean>; send: (title: string) => Promise<boolean> },
) {
  return queueRename(id, async () => {
    if (!(await steps.settle())) return false;
    if (steps.latest() !== title) return null;
    return steps.send(title);
  });
}
