export const THREAD_CACHE_LIMIT = 100;
export const SUMMARY_CACHE_LIMIT = 200;
export const ATTACHMENT_CACHE_LIMIT = 200;
export const GENERATION_LIMIT = 400;
export const LIST_CACHE_LIMIT = 30;
export const DWELL_READ_LIMIT = 500;

export function refresh<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
}

export function trimOldest<K, V>(map: Map<K, V>, limit: number, evicted?: (key: K) => void) {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
    evicted?.(oldest.value);
  }
}

export function trimRecord<V>(record: Record<string, V>, limit: number, keep: (string | null)[]): Record<string, V> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  const protectedKeys = new Set(keep);
  const drop = new Set<string>();
  for (const key of keys) {
    if (keys.length - drop.size <= limit) break;
    if (!protectedKeys.has(key)) drop.add(key);
  }
  return Object.fromEntries(keys.filter((key) => !drop.has(key)).map((key) => [key, record[key]]));
}
