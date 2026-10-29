import { Text } from "@codemirror/state";
import { docsParser } from "@/lib/docs/editor/syntax";
import { previewPlan, type PlanItem, type WidgetSpec } from "@/lib/docs/editor/plan";

export type StaticSegment = { text: string; className: string; attributes?: Record<string, string> } | { widget: WidgetSpec };

export type StaticLine = { className: string; segments: StaticSegment[] };

export function staticLines(body: string, options: { daily?: boolean; maxLines?: number; resolve?: (target: string) => boolean } = {}): StaticLine[] {
  const all = body.split("\n");
  const lines = all.slice(0, options.maxLines ?? 400);
  const doc = Text.of(lines.length ? lines : [""]);
  const text = doc.toString();
  const items = previewPlan({
    doc,
    tree: docsParser.parse(text),
    from: 0,
    to: doc.length,
    active: new Set(),
    daily: Boolean(options.daily),
    resolve: options.resolve ?? (() => true),
  });
  const lineClasses = new Map<number, string[]>();
  const inline: Exclude<PlanItem, { type: "line" }>[] = [];
  for (const item of items) {
    if (item.type === "line") {
      const list = lineClasses.get(item.from) ?? [];
      list.push(item.className);
      lineClasses.set(item.from, list);
    } else inline.push(item);
  }
  const result: StaticLine[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const within = inline.filter((item) => item.from < line.to && item.to > line.from);
    const cuts = new Set<number>([line.from, line.to]);
    for (const item of within) {
      cuts.add(Math.max(line.from, item.from));
      cuts.add(Math.min(line.to, item.to));
    }
    const points = [...cuts].sort((left, right) => left - right);
    const segments: StaticSegment[] = [];
    const emitted = new Set<PlanItem>();
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (end <= start) continue;
      const cover = within.find((item) => (item.type === "hide" || item.type === "widget") && item.from <= start && item.to >= end);
      if (cover) {
        if (cover.type === "widget" && !emitted.has(cover)) {
          segments.push({ widget: cover.widget });
          emitted.add(cover);
        }
        continue;
      }
      const marks = within.filter((item): item is Extract<PlanItem, { type: "mark" }> => item.type === "mark" && item.from <= start && item.to >= end);
      const attributes = marks.reduce<Record<string, string> | undefined>((all, item) => (item.attributes ? { ...(all ?? {}), ...item.attributes } : all), undefined);
      segments.push({ text: text.slice(start, end), className: marks.map((item) => item.className).join(" "), ...(attributes ? { attributes } : {}) });
    }
    result.push({ className: ["cm-line", ...(lineClasses.get(line.from) ?? [])].join(" "), segments });
  }
  return result;
}
