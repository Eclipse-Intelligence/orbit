import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { previewPlan, type PlanItem, type WidgetSpec } from "@/lib/docs/editor/plan";
import { BulletWidget, CheckboxWidget, EntryTime, FenceLabel, HangingMark, MentionWidget } from "@/lib/docs/editor/widgets";

export type PreviewOptions = {
  focused: boolean;
  daily: boolean;
  resolve: (target: string) => boolean;
};

export type Preview = { decorations: DecorationSet; atomic: DecorationSet };

export const refreshPreview = StateEffect.define<null>();

const hidden = Decoration.replace({});
const lineCache = new Map<string, Decoration>();
const markCache = new Map<string, Decoration>();

export function activeLines(state: EditorState, focused: boolean) {
  const lines = new Set<number>();
  if (!focused) return lines;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines;
}

function widgetFor(spec: WidgetSpec): WidgetType {
  if (spec.kind === "hang") return new HangingMark(spec.text);
  if (spec.kind === "bullet") return new BulletWidget(spec.label, spec.raw);
  if (spec.kind === "checkbox") return new CheckboxWidget(spec.checked, spec.hanging);
  if (spec.kind === "mention") return new MentionWidget(spec.name, spec.mentionKind, spec.id);
  if (spec.kind === "fence") return new FenceLabel(spec.language);
  return new EntryTime(spec.time, false);
}

function lineDecoration(className: string) {
  let decoration = lineCache.get(className);
  if (!decoration) {
    decoration = Decoration.line({ class: className });
    lineCache.set(className, decoration);
  }
  return decoration;
}

function markDecoration(item: Extract<PlanItem, { type: "mark" }>) {
  if (item.attributes) return Decoration.mark({ class: item.className, attributes: item.attributes });
  let decoration = markCache.get(item.className);
  if (!decoration) {
    decoration = Decoration.mark({ class: item.className });
    markCache.set(item.className, decoration);
  }
  return decoration;
}

export function planToDecorations(items: PlanItem[]): Preview {
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const item of items) {
    if (item.type === "line") ranges.push(lineDecoration(item.className).range(item.from));
    else if (item.type === "mark") ranges.push(markDecoration(item).range(item.from, item.to));
    else if (item.type === "hide") ranges.push(hidden.range(item.from, item.to));
    else {
      const decoration = Decoration.replace({ widget: widgetFor(item.widget) });
      ranges.push(decoration.range(item.from, item.to));
      atomic.push(decoration.range(item.from, item.to));
    }
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
}

export function buildPreview(state: EditorState, from: number, to: number, options: PreviewOptions): Preview {
  return planToDecorations(
    previewPlan({ doc: state.doc, tree: syntaxTree(state), from, to, active: activeLines(state, options.focused), daily: options.daily, resolve: options.resolve }),
  );
}

export function livePreview(options: { daily: boolean; resolve: (target: string) => boolean }) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      constructor(view: EditorView) {
        const preview = this.compute(view);
        this.decorations = preview.decorations;
        this.atomic = preview.atomic;
      }
      compute(view: EditorView) {
        const ranges = view.visibleRanges;
        const from = ranges.length ? ranges[0].from : view.viewport.from;
        const to = ranges.length ? ranges[ranges.length - 1].to : view.viewport.to;
        return buildPreview(view.state, from, to, { focused: view.hasFocus, daily: options.daily, resolve: options.resolve });
      }
      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshPreview)));
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          refreshed ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          const preview = this.compute(update.view);
          this.decorations = preview.decorations;
          this.atomic = preview.atomic;
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    },
  );
}
