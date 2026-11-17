export type ChildCounts = { total: number; succeeded: number; skipped: number; failed: number };

export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"];

export function childrenDone(counts: ChildCounts) {
  return counts.succeeded + counts.skipped + counts.failed;
}

export function runProgress(counts: ChildCounts, finished: boolean) {
  const done = childrenDone(counts);
  const head = finished && done >= counts.total ? `${counts.total} done` : `${done} of ${counts.total} done`;
  return [head, counts.skipped ? `${counts.skipped} skipped` : "", counts.failed ? `${counts.failed} failed` : ""].filter(Boolean).join(", ");
}
