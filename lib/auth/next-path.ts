const NEXT_PREFIXES = ["/connect/"];

const NEXT_PATHS = ["/open"];

function decodedPath(value: string) {
  try {
    return decodeURIComponent(value.split(/[?#]/)[0]);
  } catch {
    return null;
  }
}

export function safeNextPath(value: string | null | undefined) {
  if (!value || value.length > 1000 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const path = decodedPath(value);
  if (!path || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (NEXT_PATHS.includes(path)) return value;
  return NEXT_PREFIXES.some((prefix) => value.startsWith(prefix)) ? value : null;
}
