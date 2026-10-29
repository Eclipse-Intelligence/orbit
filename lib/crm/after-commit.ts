import type { Db } from "@/lib/db/pool";

type Task = () => Promise<void> | void;

const queued = new WeakMap<Db, Task[]>();

export function afterCommit(db: Db, task: Task) {
  const list = queued.get(db);
  if (list) list.push(task);
  else queued.set(db, [task]);
}

export function takeAfterCommit(db: Db) {
  const list = queued.get(db) ?? [];
  queued.delete(db);
  return list;
}
