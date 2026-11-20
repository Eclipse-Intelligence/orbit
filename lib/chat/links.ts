import { parseMarkdown, type Block, type ChatFormat, type Inline } from "@/lib/chat/markdown";
import { LINK_PREVIEWS_MAX } from "@/lib/chat/types";
import { splitMentions } from "@/lib/mentions";
import { textParts, withoutBidi } from "@/lib/text-links";

export const LINK_MAX_LENGTH = 2048;
export const RECORD_CARDS_MAX = 2;
const LINKS_SCANNED = 20;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const RECORD_CARD_KINDS = ["company", "contact", "opportunity", "task", "doc"] as const;
export type RecordCardKind = (typeof RECORD_CARD_KINDS)[number];
export type RecordRef = { kind: RecordCardKind; id: string };

export type ChatRecordCard = {
  kind: RecordCardKind;
  id: string;
  title: string;
  subtitle: string | null;
  pill: string | null;
  figure: string | null;
  dueAt: string | null;
  href: string;
};

function inlineLinks(nodes: Inline[]): string[] {
  return nodes.flatMap((node): string[] => {
    switch (node.type) {
      case "url":
        return [node.href];
      case "link":
        return [node.href, ...inlineLinks(node.children)];
      case "bold":
      case "italic":
      case "strike":
        return inlineLinks(node.children);
      default:
        return [];
    }
  });
}

function blockLinks(block: Block): string[] {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return inlineLinks(block.children);
    case "list":
      return block.items.flatMap(inlineLinks);
    case "code":
      return [];
  }
}

function writtenLinks(body: string, format: ChatFormat) {
  if (format === "markdown") return parseMarkdown(body).flatMap(blockLinks);
  return splitMentions(body).flatMap((piece) =>
    "mention" in piece ? [] : textParts(withoutBidi(piece.text), { markdown: true, balanced: true }).flatMap((part) => (part.kind === "url" ? [part.href] : [])),
  );
}

export function messageLinks(body: string, format: ChatFormat): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  for (const written of writtenLinks(body, format)) {
    let url: URL;
    try {
      url = new URL(written);
    } catch {
      continue;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.href.length > LINK_MAX_LENGTH || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url);
    if (links.length >= LINKS_SCANNED) break;
  }
  return links;
}

export function previewUrls(body: string, format: ChatFormat, orbitOrigin: string | null): string[] {
  return messageLinks(body, format)
    .filter((url) => url.protocol === "https:" && url.origin !== orbitOrigin)
    .slice(0, LINK_PREVIEWS_MAX)
    .map((url) => url.href);
}

const RECORD_PATHS: { kind: Exclude<RecordCardKind, "task">; pattern: RegExp }[] = [
  { kind: "company", pattern: new RegExp(`^/companies/(${UUID})/?$`, "i") },
  { kind: "contact", pattern: new RegExp(`^/contacts/(${UUID})/?$`, "i") },
  { kind: "opportunity", pattern: new RegExp(`^/opportunities/(${UUID})/?$`, "i") },
  { kind: "doc", pattern: new RegExp(`^/docs/(${UUID})/?$`, "i") },
];

const TASK_ID = new RegExp(`^${UUID}$`, "i");

export function recordRef(url: URL): RecordRef | null {
  for (const { kind, pattern } of RECORD_PATHS) {
    const id = pattern.exec(url.pathname)?.[1];
    if (id) return { kind, id: id.toLowerCase() };
  }
  const task = url.pathname.replace(/\/$/, "") === "/tasks" ? url.searchParams.get("task") : null;
  return task && TASK_ID.test(task) ? { kind: "task", id: task.toLowerCase() } : null;
}

export function recordRefs(body: string, format: ChatFormat, orbitOrigin: string | null): RecordRef[] {
  if (!orbitOrigin) return [];
  const seen = new Set<string>();
  const refs: RecordRef[] = [];
  for (const url of messageLinks(body, format)) {
    if (url.origin !== orbitOrigin) continue;
    const ref = recordRef(url);
    if (!ref || seen.has(`${ref.kind}:${ref.id}`)) continue;
    seen.add(`${ref.kind}:${ref.id}`);
    refs.push(ref);
    if (refs.length >= RECORD_CARDS_MAX) break;
  }
  return refs;
}
