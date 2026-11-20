import { defaultKeymap, history, historyKeymap, invertedEffects, redo } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type Extension,
  type Range,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import type { FormatKind } from "@/lib/chat/markdown";
import {
  carriedAt,
  coveredBy,
  fromMarkdown,
  linkAt,
  normalSpans,
  sameLook,
  sliceMarkdown,
  toMarkdown,
  withRange,
  type InlineKind,
  type InlineSpan,
  type LineKind,
  type RichDoc,
  type RichLine,
} from "@/lib/chat/rich-text";
import { minimalChange } from "@/lib/mail/body-editor";
import { roomMentionRanges } from "@/lib/mentions";

export type Pending = { at: number; add: InlineKind[]; remove: InlineKind[] };

export type RichMeta = {
  spans: InlineSpan[];
  lines: RichLine[];
  pending: Pending | null;
};

export type BlockKind = Exclude<LineKind, "text">;

export const setRich = StateEffect.define<{
  spans: InlineSpan[];
  lines: RichLine[];
}>();

export const setPending = StateEffect.define<Pending | null>();

export const fromProps = Annotation.define<boolean>();

export const mentionLabels = Facet.define<{ names: string[]; room: boolean }, { names: string[]; room: boolean }>({
  combine: (values) => ({
    names: values.flatMap((value) => value.names),
    room: values.some((value) => value.room),
  }),
});

const APP_KEYS = new Set(["Enter", "Shift-Enter", "Mod-Enter", "Escape", "Mod-i", "Mod-[", "Mod-]", "Mod-Alt-\\", "Shift-Mod-k", "Shift-Mod-\\", "Alt-A", "Mod-/"]);

const TEXT_LINE: RichLine = { kind: "text" };

function coveredByChange(changes: ChangeDesc, from: number, to: number) {
  let covered = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA && fromA <= from && toA >= to) covered = true;
  });
  return covered;
}

export function mapLines(lines: RichLine[], before: Text, changes: ChangeDesc, after: Text): RichLine[] {
  const blocks: { from: number; to: number; line: RichLine }[] = [];
  for (let number = 1; number <= before.lines; number += 1) {
    const line = lines[number - 1];
    if (!line || line.kind === "text") continue;
    const range = before.line(number);
    const gone = number < before.lines ? coveredByChange(changes, range.from, range.to + 1) : number > 1 && coveredByChange(changes, range.from - 1, range.to);
    if (gone) continue;
    blocks.push({
      from: changes.mapPos(range.from, -1),
      to: changes.mapPos(range.to, 1),
      line,
    });
  }
  const out: RichLine[] = [];
  for (let number = 1; number <= after.lines; number += 1) {
    const start = after.line(number).from;
    const block = blocks.find((candidate) => candidate.from <= start && start <= candidate.to);
    out.push(!block ? TEXT_LINE : start === block.from ? block.line : { kind: block.line.kind });
  }
  return out;
}

function spanAt(spans: InlineSpan[], pos: number) {
  return spans.filter((span) => span.from <= pos && pos < span.to);
}

export function mapSpans(spans: InlineSpan[], changes: ChangeDesc): InlineSpan[] {
  return spans.map((span) => ({
    ...span,
    from: changes.mapPos(span.from, 1),
    to: changes.mapPos(span.to, span.kind === "link" ? -1 : 1),
  }));
}

export const richField = StateField.define<RichMeta>({
  create: (state) => ({
    spans: [],
    lines: Array.from({ length: state.doc.lines }, () => TEXT_LINE),
    pending: null,
  }),
  update(value, tr) {
    let next = value;
    let replaced = false;
    let pendingSet = false;
    for (const effect of tr.effects) {
      if (effect.is(setRich)) {
        next = {
          spans: effect.value.spans,
          lines: effect.value.lines,
          pending: null,
        };
        replaced = true;
      }
    }
    if (!replaced && tr.docChanged) {
      const kept: { fromA: number; text: InlineSpan[] }[] = [];
      if (tr.isUserEvent("input")) {
        tr.changes.iterChanges((fromA, toA) => {
          if (toA > fromA) kept.push({ fromA, text: spanAt(value.spans, fromA) });
        });
      }
      let spans = mapSpans(value.spans, tr.changes);
      const lines = mapLines(value.lines, tr.startState.doc, tr.changes, tr.newDoc);
      const pending = value.pending;
      tr.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (toB <= fromB) return;
        const carried = kept.find((item) => item.fromA === fromA && toA > fromA);
        if (carried) for (const span of carried.text) spans = withRange(spans, fromB, toB, span.kind, true, span.href);
        if (pending && tr.isUserEvent("input") && fromA === pending.at) {
          for (const kind of pending.add) spans = withRange(spans, fromB, toB, kind, true);
          for (const kind of pending.remove) spans = withRange(spans, fromB, toB, kind, false);
        }
      });
      next = {
        spans: normalSpans(tr.newDoc.toString(), lines, spans),
        lines,
        pending: null,
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(setPending)) {
        next = { ...next, pending: effect.value };
        pendingSet = true;
      }
    }
    if (!pendingSet && !tr.docChanged && tr.selection && next.pending) next = { ...next, pending: null };
    return next;
  },
});

export function richDoc(state: EditorState): RichDoc {
  const meta = state.field(richField);
  return { text: state.doc.toString(), lines: meta.lines, spans: meta.spans };
}

export function stateMarkdown(state: EditorState) {
  return toMarkdown(richDoc(state));
}

export function loadMarkdown(state: EditorState, markdown: string): TransactionSpec {
  const doc = fromMarkdown(markdown);
  const current = state.doc.toString();
  return {
    changes: minimalChange(current, doc.text),
    effects: setRich.of({ spans: doc.spans, lines: doc.lines }),
    selection: EditorSelection.cursor(doc.text.length),
    annotations: [fromProps.of(true), Transaction.addToHistory.of(false)],
  };
}

function lineNumbers(state: EditorState, from: number, to: number) {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  return { first, last };
}

export function activeFormats(state: EditorState): Set<FormatKind> {
  const active = new Set<FormatKind>();
  const meta = state.field(richField);
  const range = state.selection.main;
  const { first, last } = lineNumbers(state, range.from, range.to);
  const kinds = new Set<LineKind>();
  for (let number = first; number <= last; number += 1) kinds.add(meta.lines[number - 1]?.kind ?? "text");
  if (kinds.size === 1) {
    const [kind] = kinds;
    if (kind === "code") active.add("codeBlock");
    else if (kind !== "text") active.add(kind);
  }
  if (kinds.has("code") && kinds.size === 1) return active;
  if (range.empty) {
    const carried = carriedAt(meta.spans, range.head);
    if (meta.pending && meta.pending.at === range.head) {
      for (const kind of meta.pending.add) carried.add(kind);
      for (const kind of meta.pending.remove) carried.delete(kind);
    }
    for (const kind of carried) active.add(kind);
    return active;
  }
  const doc = { text: state.doc.toString(), spans: meta.spans };
  for (const kind of ["bold", "italic", "strike", "code", "link"] as const) if (coveredBy(doc, range.from, range.to, kind)) active.add(kind);
  return active;
}

export function inCodeBlock(state: EditorState) {
  const meta = state.field(richField);
  const range = state.selection.main;
  const { first, last } = lineNumbers(state, range.from, range.to);
  for (let number = first; number <= last; number += 1) if (meta.lines[number - 1]?.kind !== "code") return false;
  return true;
}

export function inCodeAt(state: EditorState, pos: number) {
  const meta = state.field(richField);
  if (meta.lines[state.doc.lineAt(pos).number - 1]?.kind === "code") return true;
  return meta.spans.some((span) => span.kind === "code" && span.from < pos && pos <= span.to);
}

export function inlineToggle(state: EditorState, kind: Exclude<InlineKind, "link">): TransactionSpec {
  const meta = state.field(richField);
  const range = state.selection.main;
  if (kind === "code" && state.sliceDoc(range.from, range.to).includes("\n")) return lineToggle(state, "code");
  if (inCodeBlock(state)) return {};
  if (range.empty) {
    const pending = meta.pending && meta.pending.at === range.head ? meta.pending : { at: range.head, add: [], remove: [] };
    const carried = carriedAt(meta.spans, range.head);
    const on = (carried.has(kind) && !pending.remove.includes(kind)) || pending.add.includes(kind);
    const add = pending.add.filter((item) => item !== kind);
    const remove = pending.remove.filter((item) => item !== kind);
    if (on && !pending.add.includes(kind)) remove.push(kind);
    if (!on && !carried.has(kind)) add.push(kind);
    return {
      effects: setPending.of(add.length || remove.length ? { at: range.head, add, remove } : null),
    };
  }
  const doc = { text: state.doc.toString(), spans: meta.spans };
  const on = !coveredBy(doc, range.from, range.to, kind);
  const spans = normalSpans(doc.text, meta.lines, withRange(meta.spans, range.from, range.to, kind, on));
  return {
    effects: setRich.of({ spans, lines: meta.lines }),
    userEvent: "input.format",
  };
}

export function lineToggle(state: EditorState, kind: BlockKind): TransactionSpec {
  const meta = state.field(richField);
  const range = state.selection.main;
  const { first, last } = lineNumbers(state, range.from, range.to);
  const touched = meta.lines.slice(first - 1, last);
  const filled = touched.filter((line, index) => line.kind === kind || state.doc.line(first + index).length > 0 || touched.length === 1);
  const off = filled.length > 0 && filled.every((line) => line.kind === kind);
  const lines = meta.lines.map((line, index) => {
    const number = index + 1;
    if (number < first || number > last) return line;
    if (off) return TEXT_LINE;
    if (touched.length > 1 && state.doc.line(number).length === 0 && kind !== "code") return line;
    return { kind };
  });
  const spans = normalSpans(state.doc.toString(), lines, meta.spans);
  return { effects: setRich.of({ spans, lines }), userEvent: "input.format" };
}

export function linkEdit(state: EditorState, target: { from: number; to: number; href: string | null; text?: string }): TransactionSpec {
  const meta = state.field(richField);
  const from = Math.min(Math.max(0, target.from), state.doc.length);
  const input = { ...target, from, to: Math.min(Math.max(from, target.to), state.doc.length) };
  const text = input.text ?? state.sliceDoc(input.from, input.to);
  const replacing = input.text !== undefined && input.text !== state.sliceDoc(input.from, input.to);
  const end = input.from + text.length;
  const doc = state.doc.toString();
  const next = replacing ? `${doc.slice(0, input.from)}${text}${doc.slice(input.to)}` : doc;
  const changes = replacing ? { from: input.from, to: input.to, insert: text } : undefined;
  const lines = replacing ? mapLines(meta.lines, state.doc, state.changes(changes!), state.toText(next)) : meta.lines;
  const mapped = replacing ? mapSpans(meta.spans, state.changes(changes!)) : meta.spans;
  const spans = normalSpans(next, lines, withRange(mapped, input.from, end, "link", input.href !== null, input.href ?? undefined));
  return {
    changes,
    effects: setRich.of({ spans, lines }),
    selection: EditorSelection.cursor(end),
    userEvent: "input.format",
  };
}

export function currentLink(state: EditorState) {
  const range = state.selection.main;
  return linkAt(state.field(richField).spans, range.from, range.to);
}

export function newline(state: EditorState, options: { exitCode?: boolean } = {}): TransactionSpec {
  const meta = state.field(richField);
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const kind = meta.lines[line.number - 1]?.kind ?? "text";
  const empty = range.empty && line.length === 0;
  const lastCode = kind === "code" && (meta.lines[line.number]?.kind ?? "text") !== "code";
  if (empty && (kind === "bullets" || kind === "numbers" || kind === "quote" || (kind === "code" && options.exitCode && lastCode))) {
    const lines = meta.lines.map((item, index) => (index === line.number - 1 ? TEXT_LINE : item));
    return {
      effects: setRich.of({ spans: meta.spans, lines }),
      userEvent: "input.format",
    };
  }
  return {
    ...state.replaceSelection("\n"),
    userEvent: "input",
    scrollIntoView: true,
  };
}

export function lineStartBackspace(state: EditorState): TransactionSpec | null {
  const meta = state.field(richField);
  const range = state.selection.main;
  if (!range.empty) return null;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.from || (meta.lines[line.number - 1]?.kind ?? "text") === "text") return null;
  const lines = meta.lines.map((item, index) => (index === line.number - 1 ? TEXT_LINE : item));
  return {
    effects: setRich.of({
      spans: normalSpans(state.doc.toString(), lines, meta.spans),
      lines,
    }),
    userEvent: "delete.format",
  };
}

export function shortcutConversion(state: EditorState, retype = true): TransactionSpec | null {
  const current = richDoc(state);
  const parsed = fromMarkdown(toMarkdown(current));
  if (sameLook(current, parsed) || (!retype && parsed.text !== current.text)) return null;
  return {
    changes: minimalChange(current.text, parsed.text),
    effects: setRich.of({ spans: parsed.spans, lines: parsed.lines }),
  };
}

function wordEnded(tr: Transaction) {
  if (!tr.docChanged || tr.isUserEvent("delete") || tr.isUserEvent("input.format")) return true;
  let ended = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (text.length > 1 || /\s/.test(text)) ended = true;
  });
  return ended;
}

const markdownShortcuts = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(fromProps) || tr.isUserEvent("input.type.compose")) return tr;
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return tr;
  if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setRich))) return tr;
  const conversion = shortcutConversion(tr.state, wordEnded(tr));
  return conversion ? [tr, { ...conversion, sequential: true }] : tr;
});

const undoFormats = invertedEffects.of((tr) => {
  if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setRich))) return [];
  const before = tr.startState.field(richField);
  return [setRich.of({ spans: before.spans, lines: before.lines })];
});

const historySlot = new Compartment();

export function reloadMarkdown(state: EditorState, markdown: string): TransactionSpec[] {
  const doc = fromMarkdown(markdown);
  return [
    {
      changes: minimalChange(state.doc.toString(), doc.text),
      effects: [setRich.of({ spans: doc.spans, lines: doc.lines }), historySlot.reconfigure([])],
      selection: EditorSelection.cursor(doc.text.length),
      annotations: [fromProps.of(true), Transaction.addToHistory.of(false)],
    },
    { effects: historySlot.reconfigure(history()), annotations: [fromProps.of(true)] },
  ];
}

export function resetHistory(): TransactionSpec[] {
  return [
    { effects: historySlot.reconfigure([]), annotations: [fromProps.of(true)] },
    { effects: historySlot.reconfigure(history()), annotations: [fromProps.of(true)] },
  ];
}

const LINE_CLASS: Record<BlockKind, string> = {
  bullets: "chat-li chat-li-bullet",
  numbers: "chat-li chat-li-number",
  quote: "chat-quote",
  code: "chat-code-line",
};
const INLINE_CLASS: Record<InlineKind, string> = {
  bold: "chat-strong",
  italic: "chat-em",
  strike: "chat-strike",
  code: "chat-code",
  link: "chat-link",
};
const inlineMarks = Object.fromEntries(Object.entries(INLINE_CLASS).map(([kind, className]) => [kind, Decoration.mark({ class: className })])) as Record<InlineKind, Decoration>;
const mentionMark = Decoration.mark({ class: "chat-mention" });
const urlMark = Decoration.mark({ class: "chat-link" });
const URL = /(^|[^\w/])(https?:\/\/[^\s<>"]+)/gi;

export function richDecorations(state: EditorState): DecorationSet {
  const meta = state.field(richField);
  const labels = state.facet(mentionLabels);
  const ranges: Range<Decoration>[] = [];
  const numbers: number[] = [];
  const widest: number[] = [];
  for (let index = 0; index < meta.lines.length; index += 1) {
    if (meta.lines[index].kind !== "numbers") continue;
    numbers[index] = meta.lines[index - 1]?.kind === "numbers" ? numbers[index - 1] + 1 : (meta.lines[index].start ?? 1);
  }
  for (let index = meta.lines.length - 1; index >= 0; index -= 1) {
    if (meta.lines[index].kind === "numbers") widest[index] = meta.lines[index + 1]?.kind === "numbers" ? widest[index + 1] : numbers[index];
  }
  for (let index = 1; index <= state.doc.lines; index += 1) {
    const line = state.doc.line(index);
    const kind = meta.lines[index - 1]?.kind ?? "text";
    if (kind === "code") {
      const first = meta.lines[index - 2]?.kind !== "code" || Boolean(meta.lines[index - 1].open);
      const last = meta.lines[index]?.kind !== "code" || Boolean(meta.lines[index]?.open);
      ranges.push(
        Decoration.line({
          class: `${LINE_CLASS.code}${first ? " chat-code-first" : ""}${last ? " chat-code-last" : ""}`,
        }).range(line.from),
      );
      continue;
    }
    if (kind === "numbers")
      ranges.push(
        Decoration.line({
          class: `${LINE_CLASS.numbers} chat-li-w${Math.min(3, String(widest[index - 1]).length)}`,
          attributes: { "data-n": `${numbers[index - 1]}.` },
        }).range(line.from),
      );
    else if (kind !== "text") ranges.push(Decoration.line({ class: LINE_CLASS[kind] }).range(line.from));
    for (const match of line.text.matchAll(URL)) {
      const from = line.from + (match.index ?? 0) + match[1].length;
      ranges.push(urlMark.range(from, from + match[2].replace(/[.,;:!?)\]*~]+$/, "").length));
    }
    for (const name of labels.names) {
      const label = `@${name}`;
      for (let at = line.text.indexOf(label); at >= 0; at = line.text.indexOf(label, at + label.length)) ranges.push(mentionMark.range(line.from + at, line.from + at + label.length));
    }
    if (labels.room) for (const range of roomMentionRanges(line.text)) ranges.push(mentionMark.range(line.from + range.start, line.from + range.end));
  }
  for (const span of meta.spans) if (span.to > span.from) ranges.push(inlineMarks[span.kind].range(span.from, span.to));
  return Decoration.set(ranges, true);
}

const decorations = EditorView.decorations.compute(["doc", richField, mentionLabels], richDecorations);

export function runSpec(view: EditorView, spec: TransactionSpec) {
  view.dispatch(spec);
  return true;
}

export function chatInputSettings(options: { placeholder: string; label: string; id: string; enterKeyHint: string }): Extension[] {
  return [
    placeholder(options.placeholder),
    EditorView.contentAttributes.of({
      id: options.id,
      "aria-label": options.label,
      enterkeyhint: options.enterKeyHint,
    }),
  ];
}

export function chatEditorExtensions(): Extension[] {
  return [
    richField,
    undoFormats,
    decorations,
    markdownShortcuts,
    historySlot.of(history()),
    EditorView.lineWrapping,
    EditorView.clipboardOutputFilter.of((text, state) => {
      const range = state.selection.main;
      if (state.selection.ranges.length !== 1 || range.empty || state.sliceDoc(range.from, range.to) !== text) return text;
      return sliceMarkdown(richDoc(state), range.from, range.to);
    }),
    EditorView.domEventHandlers({
      drop: (event) => Boolean(event.dataTransfer?.files.length),
    }),
    Prec.high(
      keymap.of([
        {
          key: "Backspace",
          run: (view) => {
            const spec = lineStartBackspace(view.state);
            return spec ? runSpec(view, spec) : false;
          },
        },
      ]),
    ),
    keymap.of([{ key: "Mod-Shift-z", run: redo, preventDefault: true }, ...historyKeymap, ...defaultKeymap.filter((binding) => !APP_KEYS.has(binding.key ?? ""))]),
    EditorView.contentAttributes.of({
      "aria-multiline": "true",
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
      "data-chat-input": "",
    }),
    EditorView.editorAttributes.of({ class: "chat-input" }),
  ];
}
