import type { PageFilter } from "@/lib/docs/client-types";
import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import { isDailyDate } from "@/lib/docs/daily";
import type { MentionKind } from "@/lib/mentions";

export type DocsRoute = {
  list: PageFilter;
  pageId: string | null;
  date: string | null;
  level: "home" | "list" | "note";
};

function decode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function isDocsPath(pathname: string) {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

export function parseDocsRoute(pathname: string, search: URLSearchParams | string = ""): DocsRoute {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const parts = pathname.replace(/^\/docs\/?/, "").split("/").filter(Boolean).map(decode);
  const query = (params.get("q") ?? "").trim();
  const contextList = (): PageFilter => {
    if (query) return { kind: "search", query };
    const folder = params.get("folder");
    if (folder) return { kind: "folder", folderId: folder };
    const tag = params.get("tag");
    if (tag) return { kind: "tag", path: tag };
    if (params.get("in") === "daily") return { kind: "daily" };
    return { kind: "all" };
  };
  if (parts.length === 0) {
    const list = contextList();
    return { list, pageId: null, date: null, level: list.kind === "all" ? "home" : "list" };
  }
  const [head, ...rest] = parts;
  if (head === "folder" && rest[0]) return { list: { kind: "folder", folderId: rest[0] }, pageId: null, date: null, level: "list" };
  if (head === "tag" && rest.length) return { list: { kind: "tag", path: rest.join("/") }, pageId: null, date: null, level: "list" };
  if (head === "daily") {
    const date = isDailyDate(rest[0]) ? rest[0] : null;
    return { list: { kind: "daily" }, pageId: null, date, level: date ? "note" : "list" };
  }
  return { list: contextList(), pageId: head, date: null, level: "note" };
}

export function listHref(list: PageFilter) {
  if (list.kind === "folder") return `/docs/folder/${encodeURIComponent(list.folderId)}`;
  if (list.kind === "tag") return `/docs/tag/${list.path.split("/").map(encodeURIComponent).join("/")}`;
  if (list.kind === "daily") return "/docs/daily";
  if (list.kind === "search") return `/docs?q=${encodeURIComponent(list.query)}`;
  return "/docs";
}

export function pageHref(pageId: string, list: PageFilter = { kind: "all" }) {
  const base = `/docs/${encodeURIComponent(pageId)}`;
  if (list.kind === "folder") return `${base}?folder=${encodeURIComponent(list.folderId)}`;
  if (list.kind === "tag") return `${base}?tag=${encodeURIComponent(list.path)}`;
  if (list.kind === "search") return `${base}?q=${encodeURIComponent(list.query)}`;
  if (list.kind === "daily") return `${base}?in=daily`;
  return base;
}

export function dailyHref(date: string) {
  return `/docs/daily/${date}`;
}

export function listKey(list: PageFilter) {
  if (list.kind === "folder") return `folder:${list.folderId}`;
  if (list.kind === "tag") return `tag:${list.path}`;
  if (list.kind === "search") return `search:${list.query.toLowerCase()}`;
  return list.kind;
}

export function sameList(left: PageFilter, right: PageFilter) {
  return listKey(left) === listKey(right);
}

export function recordHref(kind: MentionKind, id: string) {
  if (kind === "company") return companyHref(id);
  if (kind === "contact") return contactHref(id);
  if (kind === "opportunity") return dealHref(id);
  if (kind === "proposal") return `/proposals/${encodeURIComponent(id)}`;
  return "/tasks";
}
