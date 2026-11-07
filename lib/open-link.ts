const OPEN_SECTIONS = new Set([
  "activities",
  "boards",
  "calendar",
  "capture",
  "companies",
  "contacts",
  "docs",
  "mail",
  "opportunities",
  "proposals",
  "settings",
  "tasks",
  "workflows",
]);

const BASE = "https://orbit.invalid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeOpenTarget(value: string | null | undefined): string | null {
  if (!value || value.length > 2000) return null;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const section = url.pathname.split("/")[1] ?? "";
  if (section === "" && url.pathname === "/") return `/${url.search}${url.hash}`;
  if (!OPEN_SECTIONS.has(section)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function openLink(workspaceId: string, path: string) {
  return `/open?workspace=${encodeURIComponent(workspaceId)}&to=${encodeURIComponent(path)}`;
}

export function workspaceLink(workspaceId: string, path: string, workspaceCount: number) {
  if (workspaceCount < 2 || !UUID.test(workspaceId)) return path;
  const target = safeOpenTarget(path);
  return target ? openLink(workspaceId, target) : path;
}

export function linkInWorkspace(href: string, currentWorkspaceId: string | null | undefined): { path: string; reload: boolean } {
  if (!href.startsWith("/open?")) return { path: href, reload: false };
  const params = new URL(href, BASE).searchParams;
  const target = safeOpenTarget(params.get("to"));
  if (target && currentWorkspaceId && params.get("workspace") === currentWorkspaceId) return { path: target, reload: false };
  return { path: href, reload: true };
}
