const ON_ITS_OWN = /^[ \t]*create\s+(?:unique\s+)?index\s+concurrently\b[^;]*;/gim;

export function migrationBatches(sql: string) {
  const batches: string[] = [];
  let last = 0;
  for (const match of sql.matchAll(ON_ITS_OWN)) {
    const before = sql.slice(last, match.index).trim();
    if (before) batches.push(before);
    batches.push(match[0].trim());
    last = match.index + match[0].length;
  }
  const rest = sql.slice(last).trim();
  if (rest) batches.push(rest);
  return batches;
}

export async function applyMigrationSql(db: { query: (sql: string) => Promise<unknown> }, sql: string) {
  for (const batch of migrationBatches(sql)) await db.query(batch);
}
