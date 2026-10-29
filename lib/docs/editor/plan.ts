import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { safeHref } from "@/lib/docs/editor/links";
import { ENTRY_TIME, splitTarget } from "@/lib/docs/markdown";
import type { MentionKind } from "@/lib/mentions";

export type WidgetSpec =
  | { kind: "hang"; text: string }
  | { kind: "bullet"; label: string | null; raw: string | null }
  | { kind: "checkbox"; checked: boolean; hanging: string | null }
  | { kind: "mention"; name: string; mentionKind: MentionKind; id: string }
  | { kind: "fence"; language: string }
  | { kind: "entry"; time: string };

export type PlanItem =
  | { type: "line"; from: number; className: string }
  | { type: "mark"; from: number; to: number; className: string; attributes?: Record<string, string> }
  | { type: "hide"; from: number; to: number }
  | { type: "widget"; from: number; to: number; widget: WidgetSpec };

export type PlanInput = {
  doc: Text;
  tree: Tree;
  from: number;
  to: number;
  active: Set<number>;
  daily: boolean;
  resolve: (target: string) => boolean;
};

const MENTION = /^@\[([^[\]\n]{1,200})\]\((contact|company|task|opportunity|proposal):([0-9a-f-]{36})\)$/;
const LIST_MARK = /^([-*+]|\d+[.)])(\s+|$)(\[[ xX]\](?:\s+|$))?/;

type ListLine = { depth: number; first: boolean; task: boolean; done: boolean };

function listDepth(node: SyntaxNode) {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "BulletList" || parent.name === "OrderedList") depth += 1;
  }
  return Math.max(0, depth - 1);
}

export function previewPlan({ doc, tree, from, to, active, daily, resolve }: PlanInput): PlanItem[] {
  const items: PlanItem[] = [];
  const listLines = new Map<number, ListLine>();
  const prefixEnds = new Map<number, number>();
  const codeLines = new Set<number>();
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const line = (at: number, className: string) => items.push({ type: "line", from: at, className });
  const mark = (start: number, end: number, className: string, attributes?: Record<string, string>) => {
    if (end > start) items.push(attributes ? { type: "mark", from: start, to: end, className, attributes } : { type: "mark", from: start, to: end, className });
  };
  const hide = (start: number, end: number) => {
    if (end > start) items.push({ type: "hide", from: start, to: end });
  };
  const syntax = (start: number, end: number, lineActive: boolean) => (lineActive ? mark(start, end, "note-syntax") : hide(start, end));
  const widget = (start: number, end: number, spec: WidgetSpec) => items.push({ type: "widget", from: start, to: end, widget: spec });
  const spaceAfter = (pos: number, limit: number) => Math.min(limit, pos + (doc.sliceString(pos, pos + 1) === " " ? 1 : 0));
  const quoteMark = (from: number, to: number) => {
    const current = doc.lineAt(from);
    const end = spaceAfter(to, current.to);
    const start = Math.max(from, prefixEnds.get(current.number) ?? current.from);
    widget(start, end, { kind: "hang", text: active.has(current.number) ? ">" : "" });
    prefixEnds.set(current.number, end);
  };

  tree.iterate({
    from,
    to,
    enter(ref) {
      const name = ref.name;
      const node = ref.node;
      if (/^ATXHeading[1-6]$/.test(name)) {
        const level = Number(name.slice(-1));
        const current = doc.lineAt(ref.from);
        const lineActive = active.has(current.number);
        line(current.from, `note-h note-h${Math.min(level, 3)}`);
        const marks = node.getChildren("HeaderMark");
        const prefix = prefixEnds.get(current.number);
        marks.forEach((child, index) => {
          if (index > 0) syntax(child.from, child.to, lineActive);
          else if (prefix !== undefined) syntax(child.from, spaceAfter(child.to, current.to), lineActive);
          else widget(current.from, spaceAfter(child.to, current.to), { kind: "hang", text: lineActive ? "#".repeat(level) : "" });
        });
        return;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        line(doc.lineAt(ref.from).from, `note-h ${name === "SetextHeading1" ? "note-h1" : "note-h2"}`);
        const underline = node.getChild("HeaderMark");
        if (underline) {
          const rule = doc.lineAt(underline.from);
          if (!active.has(rule.number)) {
            line(rule.from, "note-setext-rule");
            hide(underline.from, underline.to);
          } else mark(underline.from, underline.to, "note-syntax");
        }
        return false;
      }
      if (name === "StrongEmphasis") return void mark(ref.from, ref.to, "note-strong");
      if (name === "Emphasis") return void mark(ref.from, ref.to, "note-em");
      if (name === "Strikethrough") return void mark(ref.from, ref.to, "note-strike");
      if (name === "EmphasisMark" || name === "StrikethroughMark") return void syntax(ref.from, ref.to, isActive(ref.from));
      if (name === "InlineCode") return void mark(ref.from, ref.to, "note-code");
      if (name === "CodeMark" && node.parent?.name === "InlineCode") return void syntax(ref.from, ref.to, isActive(ref.from));
      if (name === "FencedCode") {
        const first = doc.lineAt(ref.from);
        const last = doc.lineAt(ref.to);
        let blockActive = false;
        for (let number = first.number; number <= last.number; number += 1) if (active.has(number)) blockActive = true;
        const closed = last.number > first.number && /^[\s>]*(`{3,}|~{3,})\s*$/.test(last.text);
        for (let number = first.number; number <= last.number; number += 1) {
          codeLines.add(number);
          const classes = ["note-codeblock"];
          if (number === first.number) classes.push("note-codeblock-start");
          if (number === last.number) classes.push("note-codeblock-end");
          if (!blockActive && (number === first.number || (closed && number === last.number))) classes.push("note-fence");
          line(doc.line(number).from, classes.join(" "));
        }
        for (const quote of node.getChildren("QuoteMark")) quoteMark(quote.from, quote.to);
        if (!blockActive) {
          const info = node.getChild("CodeInfo");
          const opening = prefixEnds.get(first.number) ?? first.from;
          if (first.to > opening) widget(opening, first.to, { kind: "fence", language: info ? doc.sliceString(info.from, info.to).trim() : "" });
          if (closed) hide(prefixEnds.get(last.number) ?? last.from, last.to);
        }
        return false;
      }
      if (name === "Blockquote") {
        const first = doc.lineAt(ref.from).number;
        const last = doc.lineAt(ref.to).number;
        for (let number = first; number <= last; number += 1) line(doc.line(number).from, "note-quote");
        return;
      }
      if (name === "QuoteMark") {
        quoteMark(ref.from, ref.to);
        return;
      }
      if (name === "ListItem") {
        const depth = listDepth(node);
        const firstLine = doc.lineAt(ref.from).number;
        const lastLine = doc.lineAt(ref.to).number;
        const marker = node.getChild("Task")?.getChild("TaskMarker");
        const done = marker ? /x/i.test(doc.sliceString(marker.from, marker.to)) : false;
        for (let number = firstLine; number <= lastLine; number += 1) {
          const first = number === firstLine;
          listLines.set(number, { depth, first, task: Boolean(marker) && first, done: done && first });
        }
        return;
      }
      if (name === "ListMark") {
        const current = doc.lineAt(ref.from);
        const match = LIST_MARK.exec(doc.sliceString(ref.from, current.to));
        if (!match) return;
        let start = ref.from;
        const floor = prefixEnds.get(current.number) ?? current.from;
        while (start > floor && /[ \t]/.test(doc.sliceString(start - 1, start))) start -= 1;
        const lineActive = active.has(current.number);
        const ordered = /\d/.test(match[1]);
        const marker = match[3]?.trim() ?? null;
        const end = ref.from + match[0].length;
        if (marker) widget(start, end, { kind: "checkbox", checked: /x/i.test(marker), hanging: lineActive ? `${match[1]} ${marker}` : null });
        else widget(start, end, { kind: "bullet", label: ordered ? match[1] : null, raw: lineActive && !ordered ? match[1] : null });
        prefixEnds.set(current.number, end);
        return;
      }
      if (name === "HorizontalRule") {
        const current = doc.lineAt(ref.from);
        line(current.from, "note-hr");
        syntax(ref.from, ref.to, active.has(current.number));
        return;
      }
      if (name === "Link") {
        const marks = node.getChildren("LinkMark");
        const url = node.getChild("URL");
        if (marks.length < 2) return;
        const href = url ? safeHref(doc.sliceString(url.from, url.to)) : null;
        const tail = doc.lineAt(marks[1].from);
        if (href) mark(marks[0].to, marks[1].from, "note-link", { "data-href": href });
        syntax(marks[0].from, marks[0].to, isActive(ref.from));
        syntax(marks[1].from, Math.min(ref.to, tail.to), active.has(tail.number));
        return false;
      }
      if (name === "URL" && node.parent?.name !== "Link") {
        const href = safeHref(doc.sliceString(ref.from, ref.to));
        if (href) mark(ref.from, ref.to, "note-link", { "data-href": href });
        return;
      }
      if (name === "WikiLink") {
        const inner = doc.sliceString(ref.from + 2, ref.to - 2);
        const parsed = splitTarget(inner);
        const lineActive = isActive(ref.from);
        const pipe = inner.indexOf("|");
        const labelFrom = pipe >= 0 && !lineActive ? ref.from + 2 + pipe + 1 : ref.from + 2;
        const attributes: Record<string, string> = { "data-target": parsed.title || parsed.target };
        if (parsed.heading) attributes["data-heading"] = parsed.heading;
        mark(labelFrom, ref.to - 2, `note-wikilink${resolve(parsed.title || parsed.target) ? "" : " is-unresolved"}`, attributes);
        syntax(ref.from, labelFrom, lineActive);
        syntax(ref.to - 2, ref.to, lineActive);
        return false;
      }
      if (name === "Hashtag") {
        mark(ref.from, ref.to, "note-tag", { "data-tag": doc.sliceString(ref.from + 1, ref.to) });
        return false;
      }
      if (name === "Mention") {
        const match = MENTION.exec(doc.sliceString(ref.from, ref.to));
        if (match) widget(ref.from, ref.to, { kind: "mention", name: match[1], mentionKind: match[2] as MentionKind, id: match[3] });
        return false;
      }
      if (daily && name === "Paragraph" && node.parent?.name === "Document") {
        const current = doc.lineAt(ref.from);
        const match = ENTRY_TIME.exec(current.text);
        if (!match) return;
        const solo = current.text.trim().length === 5 && !active.has(current.number);
        line(current.from, solo ? "note-entry note-entry-solo" : "note-entry");
        widget(current.from, Math.min(current.to, current.from + 6), { kind: "entry", time: `${match[1]}:${match[2]}` });
      }
    },
  });

  for (const [number, info] of listLines) {
    const current = doc.line(number);
    if (current.from < from - 1 || current.from > to + 1) continue;
    const classes = [info.first ? "note-li" : "note-li-cont", `note-depth-${Math.min(info.depth, 5)}`];
    if (info.task) classes.push("note-task");
    if (info.done) classes.push("note-task-done");
    line(current.from, classes.join(" "));
  }

  const firstLine = doc.lineAt(from).number;
  const lastLine = doc.lineAt(to).number;
  for (let number = firstLine; number <= lastLine; number += 1) {
    if (codeLines.has(number) || listLines.has(number)) continue;
    const current = doc.line(number);
    if (!current.text.trim()) line(current.from, "note-blank");
  }

  return items;
}
