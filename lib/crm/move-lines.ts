export function clickupUnlinkedLine(count: number) {
  if (count <= 0) return "";
  return count === 1 ? "1 task is unlinked from ClickUp." : `${count} tasks are unlinked from ClickUp.`;
}

export function docsUnlinkedLine(count: number, source: string) {
  if (count <= 0) return "";
  return count === 1 ? `1 task is unlinked from its docs, which stay in ${source}.` : `${count} tasks are unlinked from their docs, which stay in ${source}.`;
}
