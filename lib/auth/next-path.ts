const NEXT_PREFIXES = ["/connect/"];

export function safeNextPath(value: string | null | undefined) {
  if (!value || value.length > 1000 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return NEXT_PREFIXES.some((prefix) => value.startsWith(prefix)) ? value : null;
}
