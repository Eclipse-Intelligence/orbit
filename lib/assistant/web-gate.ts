export const WEB_TOOLS: ReadonlySet<string> = new Set(["read_web_page", "map_website", "check_web", "social_lookup"]);

export const OUTSIDE_TOOLS: ReadonlySet<string> = new Set([
  "search_knowledge",
  "read_knowledge",
  "list_knowledge",
  "search_email",
  "get_email_thread",
  "get_capture",
  "read_web_page",
  "map_website",
  "check_web",
  "social_lookup",
  "eclipse_docs",
  "eclipse_guide",
  "eclipse_tools",
  "eclipse_read",
  "eclipse_action",
  "linear_search_issues",
  "linear_get_issue",
  "reader_list",
  "reader_read",
  "recall_search",
  "recall_read",
  "recall",
  "get_daily_brief",
  "get_call_transcript",
  "list_activities",
  "list_email_attachments",
  "read_chat_file",
]);

function flaggedOutside(value: unknown, depth: number): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => flaggedOutside(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.descriptionFromOutside === true) return true;
  return Object.values(record).some((item) => flaggedOutside(item, depth + 1));
}

function outsideDescription(content: string) {
  try {
    return flaggedOutside(JSON.parse(content), 0);
  } catch {
    return true;
  }
}

export function outsideRead(name: string, content: string) {
  return OUTSIDE_TOOLS.has(name) || (name === "list_calendar_events" && outsideDescription(content));
}

const PAGE_TOOLS: ReadonlySet<string> = new Set(["read_web_page", "map_website"]);

export const WEB_APPROVAL_MARK = "web";

export const WEB_APPROVAL_RESULT =
  "This chat has read outside content, so Orbit asks the user before sending this address or question out. It is shown to them as a card. Carry on without it, and don't ask for it again.";

export type WebGateState = { outside: boolean; seen: Set<string>; hosts: Set<string>; typed: string };

export type GateRow = { role: string; content: string | null; tool_name?: string | null; sources?: unknown[] | null; page_context?: string | null };

const LINK = /(?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#][^\s"'<>\\)\]}`]*)?/gi;
const HANDLE = /@[a-z0-9_]{1,30}\b/gi;
const SEEN_MAX = 5_000;
const HOST_PREFIX = "host:";
const FORWARDED_START = "[Forwarded material starts.";
const FORWARDED_END = "[Forwarded material ends.]";
const FIRST_PARTY_FIELD = /^(domain|website|url|linkedin(url)?|x(url)?|twitter(url)?|homepage)$/i;
const PAGE_OUTSIDE_LINE =
  /^(?:Open: email thread |Event they last opened:|Capture item they last selected: (?:waiting for a reply|email from someone|sent email nobody|email reminder|suggested follow-up email|unfiled ))/m;
const PAGE_DOMAIN = /(?:^|, )domain "([^"\\]+)"/gm;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalTarget(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/#.*$/, "")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "");
}

export function hostOf(value: string) {
  const normal = normalTarget(value);
  if (normal.startsWith("@")) return "";
  const host = normal.split(/[/?]/)[0].replace(/:\d+$/, "");
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : "";
}

function plain(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function seenTargets(content: string) {
  const found = new Set<string>();
  for (const match of content.matchAll(LINK)) found.add(normalTarget(match[0]));
  for (const match of content.matchAll(HANDLE)) {
    found.add(match[0].toLowerCase());
    found.add(match[0].slice(1).toLowerCase());
  }
  found.delete("");
  return found;
}

function add(into: Set<string>, items: Iterable<string>) {
  for (const item of items) {
    if (into.size >= SEEN_MAX) break;
    if (item) into.add(item);
  }
}

export function ownText(content: string) {
  const start = content.indexOf(FORWARDED_START);
  if (start === -1) return { own: content, forwarded: false };
  const end = content.indexOf(FORWARDED_END, start);
  return { own: `${content.slice(0, start)}${end === -1 ? "" : content.slice(end + FORWARDED_END.length)}`, forwarded: true };
}

function firstPartyHosts(content: string) {
  const hosts = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return hosts;
  }
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && FIRST_PARTY_FIELD.test(key)) {
        const host = hostOf(item);
        if (host) hosts.add(host);
      } else walk(item, depth + 1);
    }
  };
  walk(parsed, 0);
  return hosts;
}

export function pageGate(pageContext: string | null | undefined) {
  const block = pageContext ?? "";
  const hosts = [...block.matchAll(PAGE_DOMAIN)].map((match) => hostOf(match[1])).filter(Boolean);
  return { outside: PAGE_OUTSIDE_LINE.test(block), hosts };
}

export function readTargets(name: string, content: string) {
  if (PAGE_TOOLS.has(name)) return [];
  const exact = [...seenTargets(content)];
  const hosts = outsideRead(name, content) ? [] : [...firstPartyHosts(content)].map((host) => `${HOST_PREFIX}${host}`);
  return [...exact, ...hosts];
}

export function webGateState(rows: GateRow[], extra: { outside?: boolean; seen?: string[] } = {}): WebGateState {
  const seen = new Set<string>();
  const hosts = new Set<string>();
  for (const item of extra.seen ?? []) {
    if (item.startsWith(HOST_PREFIX)) hosts.add(item.slice(HOST_PREFIX.length));
    else seen.add(item);
  }
  const typed: string[] = [];
  let outside = extra.outside === true || rows[0]?.role === "assistant";
  for (const row of rows) {
    const content = row.content ?? "";
    if (row.role === "user") {
      const { own, forwarded } = ownText(content);
      if (forwarded) outside = true;
      typed.push(own);
      const targets = seenTargets(own);
      add(seen, targets);
      add(hosts, [...targets].map(hostOf));
      const page = pageGate(row.page_context);
      if (page.outside) outside = true;
      add(hosts, page.hosts);
    } else if (row.role === "assistant") {
      if (Array.isArray(row.sources) && row.sources.length > 0) outside = true;
    } else if (row.role === "tool" && row.tool_name) {
      if (outsideRead(row.tool_name, content)) outside = true;
      for (const item of readTargets(row.tool_name, content)) {
        if (item.startsWith(HOST_PREFIX)) hosts.add(item.slice(HOST_PREFIX.length));
        else if (seen.size < SEEN_MAX) seen.add(item);
      }
    }
  }
  return { outside, seen, hosts, typed: typed.join("\n") };
}

function outbound(name: string, args: Record<string, unknown>): { links: string[]; questions: string[] } {
  if (name === "read_web_page" || name === "map_website" || name === "social_lookup") return { links: [text(args.url)].filter(Boolean), questions: [] };
  if (name === "check_web") {
    const questions = Array.isArray(args.questions) ? args.questions : [];
    return {
      links: [],
      questions: [
        text(args.about),
        ...questions.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          return [text(entry.question), ...(Array.isArray(entry.options) ? entry.options.map(text) : [])];
        }),
      ].filter(Boolean),
    };
  }
  return { links: [], questions: [] };
}

export function needsWebApproval(name: string, args: Record<string, unknown>, state: WebGateState) {
  if (!WEB_TOOLS.has(name) || !state.outside) return false;
  const { links, questions } = outbound(name, args);
  const typed = plain(state.typed);
  const linkKnown = (link: string) => {
    const normal = normalTarget(link);
    const host = hostOf(link);
    return state.seen.has(normal) || state.seen.has(normal.replace(/^@/, "")) || (host !== "" && state.hosts.has(host));
  };
  return links.some((link) => !linkKnown(link)) || questions.some((question) => !typed.includes(plain(question)));
}

export function webCard(name: string, args: Record<string, unknown>) {
  const { links, questions } = outbound(name, args);
  const target = links[0] ?? "";
  const title =
    name === "map_website" ? `Map ${target}?` : name === "social_lookup" ? `Look up ${target}?` : name === "check_web" ? "Check these on the web?" : `Open ${target}?`;
  return {
    title,
    lines: [
      ...(name === "check_web" ? questions.slice(0, 12) : []),
      name === "check_web"
        ? "This chat has read outside content, and these questions didn't come from you. Check them before they go to Parallel."
        : "This chat has read outside content, and this address didn't come from you or from Orbit. Check it before it's opened.",
    ],
  };
}

export function isWebApproval(content: string | undefined) {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as { approvalNeeded?: unknown };
    return parsed?.approvalNeeded === WEB_APPROVAL_MARK;
  } catch {
    return false;
  }
}
