import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type HtmlNode = {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?: (name: string) => string | null;
};

const TEXT = 3;
const ELEMENT = 1;

const SKIPPED = new Set(["SCRIPT", "STYLE", "HEAD", "META", "TITLE", "LINK", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "SELECT", "OPTION", "IFRAME", "CANVAS"]);
const BLOCKS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "ADDRESS", "DETAILS", "SUMMARY",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "HR", "DL", "DT", "DD", "BODY", "HTML",
]);
const STRUCTURE = /<(table|h[1-6]|li|pre|blockquote|strong|b|em|i|a)[\s>]/i;
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeText", "CodeBlock"]);

const children = (node: HtmlNode) => Array.from(node.childNodes);
const isElement = (node: HtmlNode, name?: string) => node.nodeType === ELEMENT && (!name || node.nodeName.toUpperCase() === name);
const tag = (node: HtmlNode) => node.nodeName.toUpperCase();

function safeLink(href: string | null | undefined) {
  if (!href) return null;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

function wrap(marker: string, text: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function inline(node: HtmlNode, breakAs: string): string {
  if (node.nodeType === TEXT) return (node.nodeValue ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== ELEMENT || SKIPPED.has(tag(node))) return "";
  const name = tag(node);
  if (name === "BR") return breakAs;
  if (name === "IMG") return node.getAttribute?.("alt") ?? "";
  if (name === "INPUT") {
    if (node.getAttribute?.("type")?.toLowerCase() !== "checkbox") return "";
    return node.getAttribute?.("checked") !== null && node.getAttribute?.("checked") !== undefined ? "[x] " : "[ ] ";
  }
  const inner = children(node).map((child) => inline(child, breakAs)).join("");
  if (name === "STRONG" || name === "B") return wrap("**", inner);
  if (name === "EM" || name === "I") return wrap("*", inner);
  if (name === "S" || name === "DEL" || name === "STRIKE") return wrap("~~", inner);
  if (name === "CODE" || name === "KBD" || name === "SAMP") return inner.trim() ? `\`${inner.replace(/`/g, "")}\`` : inner;
  if (name === "A") {
    const href = safeLink(node.getAttribute?.("href"));
    const label = inner.trim();
    if (!href || !label) return inner;
    return label === href ? href : `[${label}](${href})`;
  }
  return inner;
}

function tidy(text: string) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function rowsOf(table: HtmlNode): HtmlNode[] {
  const rows: HtmlNode[] = [];
  for (const child of children(table)) {
    if (isElement(child, "TR")) rows.push(child);
    else if (isElement(child, "THEAD") || isElement(child, "TBODY") || isElement(child, "TFOOT")) rows.push(...children(child).filter((row) => isElement(row, "TR")));
  }
  return rows;
}

function cellText(cell: HtmlNode) {
  const text = tidy(children(cell).map((child) => blockAwareInline(child)).join("")).replace(/\n/g, " ");
  return text.replace(/\|/g, "\\|");
}

function blockAwareInline(node: HtmlNode): string {
  if (node.nodeType === ELEMENT && BLOCKS.has(tag(node)) && tag(node) !== "TABLE") return ` ${children(node).map(blockAwareInline).join("")} `;
  return inline(node, " ");
}

function table(node: HtmlNode): string {
  const rows = rowsOf(node).map((row) => {
    const cells: string[] = [];
    for (const cell of children(row)) {
      if (!isElement(cell, "TD") && !isElement(cell, "TH")) continue;
      cells.push(cellText(cell));
      const span = Number(cell.getAttribute?.("colspan") ?? 1);
      for (let extra = 1; extra < Math.min(Number.isFinite(span) ? span : 1, 50); extra += 1) cells.push("");
    }
    return cells;
  }).filter((cells) => cells.length);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${Array.from({ length: width }, () => " --- ").join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}

function list(node: HtmlNode): string {
  const ordered = tag(node) === "OL";
  let number = Number(node.getAttribute?.("start") ?? 1);
  if (!Number.isFinite(number)) number = 1;
  const items: string[] = [];
  let lastMarker = "";
  const nest = (text: string, width: number) => text.split("\n").map((line) => (line ? `${" ".repeat(width)}${line}` : line)).join("\n");
  for (const item of children(node)) {
    if (!isElement(item, "LI")) {
      if (isElement(item, "UL") || isElement(item, "OL")) items.push(nest(list(item), lastMarker.length));
      continue;
    }
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    lastMarker = marker;
    const own: HtmlNode[] = [];
    const nested: string[] = [];
    for (const child of children(item)) {
      if (isElement(child, "UL") || isElement(child, "OL")) nested.push(nest(list(child), marker.length));
      else own.push(child);
    }
    const text = blocks(own).join("\n");
    items.push([`${marker}${nest(text, marker.length).slice(marker.length)}`, ...nested].join("\n"));
  }
  return items.join("\n");
}

function holdsBlocks(node: HtmlNode): boolean {
  return children(node).some((child) => child.nodeType === ELEMENT && !SKIPPED.has(tag(child)) && (BLOCKS.has(tag(child)) || holdsBlocks(child)));
}

function blocks(nodes: HtmlNode[]): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const text = tidy(run);
    if (text) out.push(text);
    run = "";
  };
  for (const node of nodes) {
    if (node.nodeType === ELEMENT && SKIPPED.has(tag(node))) continue;
    if (node.nodeType !== ELEMENT || !BLOCKS.has(tag(node))) {
      if (node.nodeType === ELEMENT && holdsBlocks(node)) {
        flush();
        out.push(...blocks(children(node)));
      } else run += inline(node, "\n");
      continue;
    }
    flush();
    const name = tag(node);
    if (/^H[1-6]$/.test(name)) {
      const text = tidy(children(node).map((child) => inline(child, " ")).join("")).replace(/\n/g, " ");
      if (text) out.push(`${"#".repeat(Number(name[1]))} ${text.replace(/^\*\*((?:(?!\*\*)[\s\S])*)\*\*$/, "$1")}`);
    } else if (name === "UL" || name === "OL") {
      const text = list(node);
      if (text.trim()) out.push(text);
    } else if (name === "TABLE") {
      const text = table(node);
      if (text) out.push(text);
    } else if (name === "PRE") {
      const text = textOf(node).replace(/\n+$/, "");
      if (text.trim()) out.push(`\`\`\`\n${text}\n\`\`\``);
    } else if (name === "HR") {
      out.push("---");
    } else if (name === "BLOCKQUOTE") {
      const text = blocks(children(node)).join("\n\n");
      if (text) out.push(text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
    } else {
      out.push(...blocks(children(node)));
    }
  }
  flush();
  return out;
}

function textOf(node: HtmlNode): string {
  if (node.nodeType === TEXT) return node.nodeValue ?? "";
  if (isElement(node, "BR")) return "\n";
  return children(node).map(textOf).join("");
}

export function htmlToMarkdown(root: HtmlNode): string {
  return blocks(children(root)).join("\n\n");
}

export function worthConverting(html: string) {
  return STRUCTURE.test(html);
}

export function inCode(state: EditorState, pos: number) {
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

const BLOCK_START = /^(#{1,6} |[-*+] |\d+\. |> |\||```|---$)/;

function blankLine(state: EditorState, number: number) {
  return number < 1 || number > state.doc.lines || !state.doc.line(number).text.trim();
}

export function pasteChange(state: EditorState, markdown: string): TransactionSpec {
  const range = state.selection.main;
  let text = markdown;
  if (text.includes("\n") || BLOCK_START.test(text)) {
    const first = state.doc.lineAt(range.from);
    const last = state.doc.lineAt(range.to);
    if (state.doc.sliceString(first.from, range.from).trim()) text = `\n\n${text}`;
    else if (!blankLine(state, first.number - 1)) text = `\n${text}`;
    if (state.doc.sliceString(range.to, last.to).trim()) text = `${text}\n\n`;
    else if (!blankLine(state, last.number + 1)) text = `${text}\n`;
  }
  return {
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
    scrollIntoView: true,
    userEvent: "input.paste",
  };
}

export function richPaste(event: ClipboardEvent, view: EditorView) {
  if (view.state.readOnly || typeof DOMParser === "undefined") return false;
  const html = event.clipboardData?.getData("text/html");
  if (!html || !worthConverting(html)) return false;
  if (inCode(view.state, view.state.selection.main.from)) return false;
  const body = new DOMParser().parseFromString(html, "text/html").body as unknown as HtmlNode;
  const markdown = htmlToMarkdown(body);
  if (!markdown.trim()) return false;
  event.preventDefault();
  view.dispatch(pasteChange(view.state, markdown));
  return true;
}
