export const WEB_TOOLS: ReadonlySet<string> = new Set(["read_web_page", "map_website", "check_web", "social_lookup"]);

export const WEB_APPROVAL_MARK = "web";

export const WEB_APPROVAL_RESULT =
  "This chat has read outside content, so Orbit asks the user before sending this address or question out. It is shown to them as a card. Carry on without it, and don't ask for it again.";

export type WebGateState = { outside: boolean; seen: Set<string>; typed: string };

const LINK = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>\\)\]}`]*)?/gi;
const HANDLE = /@[a-z0-9_]{1,30}\b/gi;
const SEEN_MAX = 5_000;
const FORWARDED_MARK = "[Forwarded material starts.";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalTarget(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "");
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

export function addSeen(into: Set<string>, content: string) {
  for (const item of seenTargets(content)) {
    if (into.size >= SEEN_MAX) break;
    into.add(item);
  }
  return into;
}

function outbound(name: string, args: Record<string, unknown>): { links: string[]; questions: string[] } {
  if (name === "read_web_page" || name === "map_website") return { links: [text(args.url)].filter(Boolean), questions: [] };
  if (name === "social_lookup") return { links: [text(args.url)].filter(Boolean), questions: [] };
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
    return state.seen.has(normal) || state.seen.has(normal.replace(/^@/, "")) || typed.includes(normal);
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

export type GateRow = { role: string; content: string | null; tool_name?: string | null };

export function webGateState(rows: GateRow[], external: (name: string) => boolean, extra: { outside?: boolean; seen?: string[] } = {}): WebGateState {
  const seen = new Set<string>(extra.seen ?? []);
  const typed: string[] = [];
  let outside = extra.outside === true || rows[0]?.role === "assistant";
  for (const row of rows) {
    const content = row.content ?? "";
    if (row.role === "user") {
      if (content.includes(FORWARDED_MARK)) outside = true;
      typed.push(content);
      addSeen(seen, content);
    } else if (row.role === "tool") {
      if (row.tool_name && external(row.tool_name)) outside = true;
      addSeen(seen, content);
    }
  }
  return { outside, seen, typed: typed.join("\n") };
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
