import type { PlanItem, WidgetSpec } from "@/lib/docs/editor/plan";

export type StaticSegment = { text: string; className: string; attributes?: Record<string, string> } | { widget: WidgetSpec };

export type InlineItem = Exclude<PlanItem, { type: "line" }>;

export function segmentsBetween(text: string, items: InlineItem[], from: number, to: number): StaticSegment[] {
  const within = items.filter((item) => item.from < to && item.to > from);
  const cuts = new Set<number>([from, to]);
  for (const item of within) {
    cuts.add(Math.max(from, item.from));
    cuts.add(Math.min(to, item.to));
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
  return segments;
}
