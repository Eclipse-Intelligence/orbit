import type { Db } from "@/lib/db/pool";

type Task = () => Promise<void> | void;

const queued = new WeakMap<Db, Task[]>();
const batches = new WeakMap<Db, Map<string, unknown>>();

export function afterCommit(db: Db, task: Task) {
  const list = queued.get(db);
  if (list) list.push(task);
  else queued.set(db, [task]);
}

export function commitBatch<T>(db: Db, key: string, create: () => T): T {
  let found = batches.get(db);
  if (!found) {
    found = new Map();
    batches.set(db, found);
  }
  if (!found.has(key)) found.set(key, create());
  return found.get(key) as T;
}

export function takeAfterCommit(db: Db) {
  const list = queued.get(db) ?? [];
  queued.delete(db);
  batches.delete(db);
  return list;
}
