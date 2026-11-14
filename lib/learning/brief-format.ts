export const DUE_HEADING = "Due today";
export const QUIET_HEADING = "Opportunities gone quiet";
export const SUGGESTED_TASK = "Suggested task:";
export const CREATE_THOSE = "Create those";

export function suggestsTasks(body: string) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${QUIET_HEADING}`);
  if (start < 0) return false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ")) return false;
    if (line.startsWith("- ") && line.includes(SUGGESTED_TASK)) return true;
  }
  return false;
}

export function markdownText(value: string) {
  return value.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").replace(/[*`]/g, "").trim();
}
