export function createStateCache<T>(limit: number) {
  const entries = new Map<string, { value: T; epoch: number }>();
  return {
    remember(id: string, value: T, epoch: number, pinned: string | null = null) {
      entries.delete(id);
      entries.set(id, { value, epoch });
      for (const key of entries.keys()) {
        if (entries.size <= limit) break;
        if (key !== pinned && key !== id) entries.delete(key);
      }
    },
    take(id: string, epoch: number): T | null {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.epoch === epoch) return entry.value;
      entries.delete(id);
      return null;
    },
    peek(id: string): T | null {
      return entries.get(id)?.value ?? null;
    },
    has(id: string) {
      return entries.has(id);
    },
    clear() {
      entries.clear();
    },
  };
}
