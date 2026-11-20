import { parseMarkdown, type Block, type ChatFormat, type Inline } from "@/lib/chat/markdown";
import type { ChatMessage, ChatSubjectKind } from "@/lib/chat/types";
import { namedMentions } from "@/lib/mentions";

export const TASK_TITLE_MAX = 200;

export const CHAT_LINK_LABEL = "Message in Chat";

export const DISCUSSION_LINK_LABELS: Record<ChatSubjectKind, string> = {
  task: "Comment on a task",
  doc: "Comment on a doc",
  mail_thread: "Note on a shared email",
};

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "mention":
          return node.mention.name;
        case "code":
          return namedMentions(node.text);
        case "url":
          return node.text;
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}

function blockText(block: Block): string {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return inlineText(block.children);
    case "code":
      return namedMentions(block.text);
    case "list":
      return block.items.map(inlineText).join(" ");
  }
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function plainTaskText(body: string, format: ChatFormat) {
  if (format === "plain") return oneLine(namedMentions(body));
  return oneLine(parseMarkdown(body).map(blockText).join(" "));
}

function withoutSplitPair(text: string) {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function taskTitleFrom(text: string) {
  if (text.length <= TASK_TITLE_MAX) return text;
  const cut = withoutSplitPair(text.slice(0, TASK_TITLE_MAX - 1));
  const space = cut.lastIndexOf(" ");
  const kept = space >= TASK_TITLE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s.,;:!?-]+$/, "")}…`;
}

export function taskTitleFromMessage(message: Pick<ChatMessage, "body" | "format" | "hook">) {
  const text = plainTaskText(message.body, message.format);
  return taskTitleFrom(text || oneLine(message.hook?.title ?? ""));
}

const ORBIT_PATH = /^\/(?!\/)[^\s()<>"\\[\]]{0,500}$/;

export function orbitPath(value: string) {
  return ORBIT_PATH.test(value);
}

export function orbitLink(label: string, path: string) {
  if (!orbitPath(path)) throw new Error("An Orbit link needs a path inside Orbit.");
  const shown = label.replace(/[[\]()\n]/g, " ").replace(/\s+/g, " ").trim();
  return `[${shown || "Link"}](${path})`;
}
