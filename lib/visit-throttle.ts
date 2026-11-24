const MAX_KEYS = 2000;
const lastRun = new Map<string, number>();

export function visitDue(key: string, gapMs: number, now = Date.now()) {
  const last = lastRun.get(key);
  if (last !== undefined && now - last < gapMs) return false;
  if (lastRun.size >= MAX_KEYS) {
    for (const [stale, at] of lastRun) if (now - at >= gapMs) lastRun.delete(stale);
    if (lastRun.size >= MAX_KEYS) lastRun.clear();
  }
  lastRun.set(key, now);
  return true;
}

export function resetVisitThrottle() {
  lastRun.clear();
}
