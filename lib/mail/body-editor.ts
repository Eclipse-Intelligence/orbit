import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorSelection, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { formatSpans, headingMarker, type FormatSpan } from "@/lib/mail/inline-format";

export type FormatMarker = "**" | "*";

export type BodyEditorHandlers = {
  files: (files: File[]) => void;
  fileLink: () => void;
};

export const fromProps = Annotation.define<boolean>();

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
  const active = activeLines(view);
  for (const visible of view.visibleRanges) {
    for (let pos = visible.from; pos <= visible.to; ) {
      const line = view.state.doc.lineAt(pos);
      const show = active.has(line.number);
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
      if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) this.decorations = formatDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function wrappedBy(view: EditorView, from: number, to: number, marker: FormatMarker) {
  const doc = view.state.doc;
  if (doc.sliceString(from - marker.length, from) !== marker || doc.sliceString(to, to + marker.length) !== marker) return false;
  if (marker === "**") return true;
  return doc.sliceString(from - 2, from - 1) !== "*" || doc.sliceString(to + 1, to + 2) !== "*" || doc.sliceString(from - 3, from) === "***";
}

export function toggleFormat(view: EditorView, marker: FormatMarker) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      if (!range.empty && wrappedBy(view, range.from, range.to, marker)) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        };
      }
      if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
        const inner = text.slice(marker.length, text.length - marker.length);
        return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
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

export function bodyEditorExtensions(options: { placeholder: string; label: string; handlers: BodyEditorHandlers }): Extension[] {
  return [
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
