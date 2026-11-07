import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorSelection, Facet, type EditorState, type Extension, type Range, type SelectionRange } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { formatSpans, headingMarker, type FormatSpan } from "@/lib/mail/inline-format";

export type FormatMarker = "**" | "*";

export type BodyEditorHandlers = {
  files: (files: File[]) => void;
  fileLink: () => void;
};

export const fromProps = Annotation.define<boolean>();

export const steadyMarkers = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

const APP_KEYS = new Set(["Escape", "Mod-Enter", "Mod-/", "Mod-i", "Mod-[", "Mod-]", "Mod-Alt-\\", "Shift-Mod-k", "Shift-Mod-\\", "Alt-A"]);

const syntax = Decoration.mark({ class: "mail-syntax" });
const hidden = Decoration.replace({});
const strong = Decoration.mark({ class: "mail-strong" });
const em = Decoration.mark({ class: "mail-em" });
const link = Decoration.mark({ class: "mail-link" });
const heading = Decoration.line({ class: "mail-heading" });

function activeLines(view: EditorView) {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    for (let line = view.state.doc.lineAt(range.from).number; line <= view.state.doc.lineAt(range.to).number; line += 1) lines.add(line);
  }
  return lines;
}

function addSpans(ranges: Range<Decoration>[], spans: FormatSpan[], show: boolean) {
  const marker = (from: number, to: number) => {
    if (to > from) ranges.push((show ? syntax : hidden).range(from, to));
  };
  for (const span of spans) {
    const [innerFrom, innerTo] = span.inner;
    marker(span.from, innerFrom);
    if (innerTo > innerFrom) ranges.push((span.kind === "bold" ? strong : span.kind === "italic" ? em : link).range(innerFrom, innerTo));
    if (span.kind !== "link") addSpans(ranges, span.spans, show);
    marker(innerTo, span.to);
  }
}

export function formatDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const steady = view.state.facet(steadyMarkers);
  const active = steady ? null : activeLines(view);
  for (const visible of view.visibleRanges) {
    for (let pos = visible.from; pos <= visible.to; ) {
      const line = view.state.doc.lineAt(pos);
      const show = active ? active.has(line.number) : true;
      const marker = headingMarker(line.text);
      if (marker) {
        ranges.push(heading.range(line.from));
        ranges.push((show ? syntax : hidden).range(line.from, line.from + marker));
      }
      addSpans(ranges, formatSpans(line.text, line.from), show);
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = formatDecorations(view);
    }
    update(update: ViewUpdate) {
      const moved = !update.state.facet(steadyMarkers) && (update.selectionSet || update.focusChanged);
      if (update.docChanged || update.viewportChanged || moved) this.decorations = formatDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export type ActiveFormats = { bold: boolean; italic: boolean };

const KIND: Record<FormatMarker, "bold" | "italic"> = { "**": "bold", "*": "italic" };

function enclosingSpans(state: EditorState, range: SelectionRange) {
  const line = state.doc.lineAt(range.from);
  if (range.to > line.to) return [];
  const found: Extract<FormatSpan, { kind: "bold" | "italic" }>[] = [];
  const visit = (spans: FormatSpan[]) => {
    for (const span of spans) {
      if (span.kind === "link") continue;
      const inside = range.empty ? range.from >= span.inner[0] && range.from <= span.inner[1] : range.from >= span.from && range.to <= span.to;
      if (!inside) continue;
      found.push(span);
      visit(span.spans);
    }
  };
  visit(formatSpans(line.text, line.from));
  return found;
}

const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;

function wordAround(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  let from = pos - line.from;
  let to = from;
  while (from > 0 && WORD_CHAR.test(line.text[from - 1])) from -= 1;
  while (to < line.text.length && WORD_CHAR.test(line.text[to])) to += 1;
  if (from === pos - line.from || to === pos - line.from) return null;
  return { from: line.from + from, to: line.from + to };
}

export function activeFormats(state: EditorState): ActiveFormats {
  const spans = enclosingSpans(state, state.selection.main);
  return { bold: spans.some((span) => span.kind === "bold"), italic: spans.some((span) => span.kind === "italic") };
}

export function toggleFormat(view: EditorView, marker: FormatMarker) {
  const state = view.state;
  view.dispatch(
    state.changeByRange((range) => {
      const span = enclosingSpans(state, range)
        .filter((candidate) => candidate.kind === KIND[marker])
        .at(-1);
      if (span) {
        const [innerFrom, innerTo] = span.inner;
        const open = innerFrom - span.from;
        const whole = range.from < innerFrom || range.to > innerTo;
        return {
          changes: [
            { from: span.from, to: innerFrom },
            { from: innerTo, to: span.to },
          ],
          range: EditorSelection.range((whole ? innerFrom : range.from) - open, (whole ? innerTo : range.to) - open),
        };
      }
      const word = range.empty ? wordAround(state, range.head) : null;
      const from = word?.from ?? range.from;
      const to = word?.to ?? range.to;
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

export function insertBlock(view: EditorView, text: string) {
  const at = view.state.selection.main.to;
  const before = view.state.sliceDoc(at - 1, at);
  const insert = `${at > 0 && before !== "\n" ? "\n" : ""}${text}\n`;
  view.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: "input.paste", scrollIntoView: true });
}

function isFileLink(transfer: DataTransfer) {
  return /^file:/i.test(transfer.getData("text/uri-list") || transfer.getData("text/plain"));
}

export function bodyEditorExtensions(options: { placeholder: string; label: string; handlers: BodyEditorHandlers; touch?: boolean }): Extension[] {
  return [
    steadyMarkers.of(Boolean(options.touch)),
    history(),
    EditorView.lineWrapping,
    keymap.of([
      { key: "Mod-b", run: (view) => toggleFormat(view, "**") },
      { key: "Mod-i", run: (view) => toggleFormat(view, "*") },
      ...historyKeymap,
      ...defaultKeymap.filter((binding) => !APP_KEYS.has(binding.key ?? "")),
    ]),
    livePreview,
    placeholder(options.placeholder),
    EditorView.domEventHandlers({
      paste(event) {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        options.handlers.files(files);
        return true;
      },
      drop(event) {
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        const files = Array.from(transfer.files);
        if (files.length === 0 && !isFileLink(transfer)) return false;
        event.preventDefault();
        event.stopPropagation();
        if (files.length) options.handlers.files(files);
        else options.handlers.fileLink();
        return true;
      },
    }),
    EditorView.contentAttributes.of({
      "aria-label": options.label,
      "aria-multiline": "true",
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
      "data-composer-body": "",
    }),
    EditorView.editorAttributes.of({ class: "mail-body-editor" }),
  ];
}
