export function teamKeys(keys: readonly string[] | undefined, count: number, blockId: string): string[] {
  return Array.from({ length: count }, (_, index) => keys?.[index] ?? `${blockId}-${keys ? "extra" : "p"}${index}`);
}

export function withoutTeamKey(keys: readonly string[] | undefined, count: number, blockId: string, index: number): string[] {
  return teamKeys(keys, count, blockId).filter((_, position) => position !== index);
}

export function withTeamKey(keys: readonly string[] | undefined, count: number, blockId: string, key: string): string[] {
  return [...teamKeys(keys, count, blockId), key];
}

