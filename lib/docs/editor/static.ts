import { Text } from "@codemirror/state";
import { docsParser } from "@/lib/docs/editor/syntax";
import { previewPlan } from "@/lib/docs/editor/plan";
import { segmentsBetween, type InlineItem, type StaticSegment } from "@/lib/docs/editor/segments";
import { tableViews, type TableView } from "@/lib/docs/editor/tables";

export type { StaticSegment } from "@/lib/docs/editor/segments";

export type StaticLine = { className: string; segments: StaticSegment[]; table?: TableView };

export function staticLines(body: string, options: { daily?: boolean; maxLines?: number; resolve?: (target: string) => boolean } = {}): StaticLine[] {
  const all = body.split("\n");
  const lines = all.slice(0, options.maxLines ?? 400);
  const doc = Text.of(lines.length ? lines : [""]);
  const text = doc.toString();
  const tree = docsParser.parse(text);
  const resolve = options.resolve ?? (() => true);
  const items = previewPlan({
    doc,
    tree,
    from: 0,
    to: doc.length,
    active: new Set(),
    daily: Boolean(options.daily),
    resolve,
  });
  const lineClasses = new Map<number, string[]>();
  const inline: InlineItem[] = [];
  for (const item of items) {
    if (item.type === "line") {
      const list = lineClasses.get(item.from) ?? [];
      list.push(item.className);
      lineClasses.set(item.from, list);
    } else inline.push(item);
  }
  const tables = new Map(tableViews({ doc, tree, resolve }).map((table) => [doc.lineAt(table.from).number, table]));
  const result: StaticLine[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const table = tables.get(number);
    if (table) {
      result.push({ className: "note-table-block", segments: [], table });
      number = doc.lineAt(table.to).number;
      continue;
    }
    const line = doc.line(number);
    result.push({ className: ["cm-line", ...(lineClasses.get(line.from) ?? [])].join(" "), segments: segmentsBetween(text, inline, line.from, line.to) });
  }
  return result;
}
