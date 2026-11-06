import type { PageKind } from "../../lib/extension/protocol";

export type PageTarget = { kind: PageKind; canonical: string | null; path: string };

const REAL_ORIGIN = "https://www.linkedin.com";

function bareHost(host: string) {
  return host.toLowerCase().replace(/^www\./, "");
}

function originHost(origin: string) {
  try {
    return bareHost(new URL(origin).host);
  } catch {
    return "";
  }
}

export function isLinkedinHost(url: URL, linkedinOrigin: string) {
  const expected = originHost(linkedinOrigin);
  const host = bareHost(url.host);
  if (!expected) return false;
  if (expected === "linkedin.com") return host === "linkedin.com" || host.endsWith(".linkedin.com");
  return host === expected;
}

function decode(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function targetFromPath(pathname: string): PageTarget {
  const parts = pathname.split("/").filter(Boolean);
  const first = parts[0]?.toLowerCase();
  const path = `/${parts.join("/")}`;
  if (first === "in" && parts[1]) {
    const slug = decode(parts[1]).toLowerCase();
    if (/^[a-z0-9_-]{2,100}$/.test(slug)) return { kind: "person", canonical: `${REAL_ORIGIN}/in/${slug}`, path };
  }
  if ((first === "company" || first === "school" || first === "showcase") && parts[1]) {
    const slug = decode(parts[1]).toLowerCase();
    if (/^[a-z0-9_.-]{1,150}$/.test(slug)) return { kind: "company", canonical: `${REAL_ORIGIN}/${first}/${slug}`, path };
  }
  if (first === "sales" && (parts[1] === "lead" || parts[1] === "people") && parts[2]) {
    const id = decode(parts[2]).split(",")[0].trim();
    if (/^[A-Za-z0-9_-]{4,200}$/.test(id)) return { kind: "lead", canonical: `${REAL_ORIGIN}/sales/lead/${id}`, path };
  }
  if (first === "messaging" && parts[1] === "thread" && parts[2]) {
    const id = decode(parts[2]).trim();
    if (/^[A-Za-z0-9_=,:.-]{2,300}$/.test(id)) return { kind: "conversation", canonical: `${REAL_ORIGIN}/messaging/thread/${encodeURIComponent(id)}`, path };
  }
  return { kind: "other", canonical: null, path };
}

export function classifyUrl(raw: string | null | undefined, linkedinOrigin: string): PageTarget {
  if (!raw) return { kind: "other", canonical: null, path: "" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "other", canonical: null, path: "" };
  }
  if (!isLinkedinHost(url, linkedinOrigin)) return { kind: "other", canonical: null, path: "" };
  return targetFromPath(url.pathname);
}

export function targetFromUrl(url: string): PageTarget {
  try {
    return targetFromPath(new URL(url).pathname);
  } catch {
    return { kind: "other", canonical: null, path: "" };
  }
}

function resolvedTarget(href: string | null | undefined, base: string) {
  if (!href) return null;
  try {
    return targetFromPath(new URL(href, base).pathname);
  } catch {
    return null;
  }
}

export function canonicalProfile(href: string | null | undefined, base: string): string | null {
  const target = resolvedTarget(href, base);
  return target?.kind === "person" ? target.canonical : null;
}

export function canonicalCompany(href: string | null | undefined, base: string): string | null {
  const target = resolvedTarget(href, base);
  return target?.kind === "company" ? target.canonical : null;
}

export function onLinkedin(canonical: string, linkedinOrigin: string) {
  try {
    return `${linkedinOrigin.replace(/\/+$/, "")}${new URL(canonical).pathname}`;
  } catch {
    return linkedinOrigin;
  }
}

export function domainFrom(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".") || host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "lnkd.in") return null;
    return host;
  } catch {
    return null;
  }
}

export function shortUrl(value: string | null | undefined) {
  return (value ?? "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
}
