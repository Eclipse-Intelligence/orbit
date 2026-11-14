export function clickupUnlinkedLine(count: number) {
  if (count <= 0) return "";
  return count === 1 ? "1 task is unlinked from ClickUp." : `${count} tasks are unlinked from ClickUp.`;
}
