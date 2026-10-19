import type { Db } from "@/lib/db/pool";

const queued = new WeakSet<Db>();

export function markWebhooksQueued(db: Db) {
  queued.add(db);
}

export function takeWebhooksQueued(db: Db) {
  const had = queued.has(db);
  queued.delete(db);
  return had;
}
