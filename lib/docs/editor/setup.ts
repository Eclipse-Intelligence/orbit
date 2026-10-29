import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorSelection, EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet, type KeyBinding } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type { DiffPart } from "@/lib/docs/diff";
import { docsLanguage } from "@/lib/docs/editor/syntax";
import { activeLines, livePreview } from "@/lib/docs/editor/preview";
import { presenceField } from "@/lib/docs/editor/presence";
import { DeletedText } from "@/lib/docs/editor/widgets";
import { isTagChar, toggleTaskMarker, triggerBefore, type Trigger } from "@/lib/docs/markdown";
import type { MentionKind } from "@/lib/mentions";

export type ActiveTrigger = Trigger & { at: number; head: number };

export type PickerKey = "up" | "down" | "enter" | "shift-enter" | "mod-enter" | "tab" | "escape";

export type EditorBridge = {
  resolve: (target: string) => boolean;
  openLink: (target: string, heading: string | null, newTab: boolean) => void;
  openTag: (path: string, newTab: boolean) => void;
  openRecord: (kind: MentionKind, id: string, newTab: boolean) => void;
  trigger: (value: ActiveTrigger | null) => void;
  pickerKey: (key: PickerKey) => boolean;
  changed: (view: EditorView) => void;
  escape: () => boolean;
  focusTitle: () => boolean;
};

export const external = Annotation.define<boolean>();

export const bridge: EditorBridge = {
  resolve: () => true,
  openLink: () => undefined,
  openTag: () => undefined,
  openRecord: () => undefined,
  trigger: () => undefined,
  pickerKey: () => false,
  changed: () => undefined,
  escape: () => false,
  focusTitle: () => false,
};

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeText", "CodeBlock", "CodeInfo"]);

export function detectTrigger(state: EditorState, focused: boolean): ActiveTrigger | null {
  const range = state.selection.main;
  if (!focused || !range.empty || state.selection.ranges.length > 1) return null;
  const line = state.doc.lineAt(range.head);
  const found = triggerBefore(line.text.slice(0, range.head - line.from));
  if (!found) return null;
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(range.head, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return null;
  }
  return { ...found, at: line.from + found.from, head: range.head };
}

export function applyLink(view: EditorView, trigger: ActiveTrigger, text: string) {
  const after = view.state.doc.sliceString(trigger.head, trigger.head + 2) === "]]" ? 2 : 0;
  const insert = `[[${text}]]`;
  view.dispatch({
    changes: { from: trigger.at, to: trigger.head + after, insert },
    selection: EditorSelection.cursor(trigger.at + insert.length),
    userEvent: "input.complete",
  });
}

export function applyTag(view: EditorView, trigger: ActiveTrigger, path: string) {
  let end = trigger.head;
  const doc = view.state.doc;
  while (end < doc.length && isTagChar(doc.sliceString(end, end + 1))) end += 1;
  const next = doc.sliceString(end, end + 1);
  const needsSpace = next !== " ";
  const insert = `#${path}${needsSpace ? " " : ""}`;
  view.dispatch({
    changes: { from: trigger.at, to: end, insert },
    selection: EditorSelection.cursor(trigger.at + insert.length + (needsSpace ? 0 : 1)),
    userEvent: "input.complete",
  });
}

export function applyMention(view: EditorView, trigger: ActiveTrigger, record: { kind: MentionKind; id: string; name: string }) {
  const name = record.name.replace(/[[\]\n]/g, " ").trim();
  const insert = `@[${name}](${record.kind}:${record.id}) `;
  view.dispatch({
    changes: { from: trigger.at, to: trigger.head, insert },
    selection: EditorSelection.cursor(trigger.at + insert.length),
    userEvent: "input.complete",
  });
}

export function toggleTaskAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const next = toggleTaskMarker(line.text);
  if (next === null) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input.toggle" });
  return true;
}

export function insertAtCursor(view: EditorView, text: string) {
  const range = view.state.selection.main;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: EditorSelection.cursor(range.from + text.length), userEvent: "input.type" });
  view.focus();
}

export function toggleChecklist(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const task = /^(\s*)[-*+]\s+\[[ xX]\]\s?/.exec(line.text);
  const bullet = /^(\s*)[-*+]\s+/.exec(line.text);
  const change = task
    ? { from: line.from + task[1].length, to: line.from + task[0].length, insert: "" }
    : bullet
      ? { from: line.from + bullet[0].length, to: line.from + bullet[0].length, insert: "[ ] " }
      : { from: line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0), to: line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0), insert: "- [ ] " };
  view.dispatch({ changes: change, userEvent: "input.format" });
  view.focus();
}

export function toggleHeading(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const heading = /^#{1,6}\s+/.exec(line.text);
  const change = heading ? { from: line.from, to: line.from + heading[0].length, insert: "" } : { from: line.from, to: line.from, insert: "## " };
  view.dispatch({ changes: change, userEvent: "input.format" });
  view.focus();
}

function wrapWith(marker: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const text = view.state.sliceDoc(range.from, range.to);
        if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
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
      { userEvent: "input.format" },
    );
    return true;
  };
}

function inList(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  return /^\s*(?:[-*+]|\d+[.)])\s/.test(line.text);
}

const pickerKeymap: KeyBinding[] = [
  { key: "ArrowDown", run: () => bridge.pickerKey("down") },
  { key: "ArrowUp", run: () => bridge.pickerKey("up") },
  { key: "Enter", run: () => bridge.pickerKey("enter") },
  { key: "Shift-Enter", run: () => bridge.pickerKey("shift-enter") },
  { key: "Mod-Enter", run: () => bridge.pickerKey("mod-enter") },
  { key: "Tab", run: () => bridge.pickerKey("tab") },
  { key: "Escape", run: () => bridge.pickerKey("escape") || bridge.escape() },
];

const editingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: wrapWith("**") },
  { key: "Mod-i", run: wrapWith("*") },
  { key: "Mod-e", run: wrapWith("`") },
  { key: "Tab", run: (view) => (inList(view) ? indentMore(view) : false) },
  { key: "Shift-Tab", run: (view) => (inList(view) ? indentLess(view) : false) },
  {
    key: "ArrowUp",
    run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty) return false;
      const moved = view.moveVertically(range, false);
      if (moved.head !== range.head) return false;
      return bridge.focusTitle();
    },
  },
];

function clickHandler(event: MouseEvent, view: EditorView) {
  if (event.button !== 0) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return false;
  const newTab = event.metaKey || event.ctrlKey;
  const box = target.closest("[data-checkbox]");
  if (box && !view.state.readOnly) {
    event.preventDefault();
    return toggleTaskAt(view, view.posAtDOM(box));
  }
  const mention = target.closest<HTMLElement>("[data-mention-id]");
  if (mention) {
    event.preventDefault();
    bridge.openRecord(mention.dataset.mentionKind as MentionKind, mention.dataset.mentionId ?? "", newTab);
    return true;
  }
  const link = target.closest<HTMLElement>(".note-wikilink, .note-tag, .note-link");
  if (!link) return false;
  const line = view.state.doc.lineAt(view.posAtDOM(link)).number;
  const editing = activeLines(view.state, view.hasFocus).has(line) && !view.state.readOnly;
  if (editing && !newTab) return false;
  event.preventDefault();
  if (link.classList.contains("note-wikilink")) bridge.openLink(link.dataset.target ?? "", link.dataset.heading ?? null, newTab);
  else if (link.classList.contains("note-tag")) bridge.openTag(link.dataset.tag ?? "", newTab);
  else if (link.dataset.href) window.open(link.dataset.href, "_blank", "noopener,noreferrer");
  return true;
}

export type NoteExtensionOptions = {
  daily?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  label?: string;
  collaboration?: Extension;
};

export function noteExtensions(options: NoteExtensionOptions = {}): Extension[] {
  const editable = !options.readOnly;
  return [
    options.collaboration ?? history(),
    docsLanguage(),
    livePreview({ daily: Boolean(options.daily), resolve: (target) => bridge.resolve(target) }),
    presenceField,
    EditorView.lineWrapping,
    editable ? Prec.highest(keymap.of(pickerKeymap)) : [],
    keymap.of([...(editable ? [...markdownKeymap, ...editingKeymap] : []), ...historyKeymap, ...defaultKeymap]),
    EditorView.domEventHandlers({ mousedown: clickHandler }),
    editable
      ? EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.every((transaction) => transaction.annotation(external))) bridge.changed(update.view);
          if (update.docChanged || update.selectionSet || update.focusChanged) bridge.trigger(detectTrigger(update.state, update.view.hasFocus));
        })
      : [],
    options.placeholder ? placeholder(options.placeholder) : [],
    EditorView.contentAttributes.of({
      "aria-label": options.label ?? "Note text",
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
      "aria-multiline": "true",
    }),
    EditorView.editorAttributes.of({ class: options.daily ? "note-editor note-editor-daily" : "note-editor" }),
    options.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
  ];
}

const inserted = Decoration.mark({ class: "note-ins" });
const changedLine = Decoration.line({ class: "note-changed" });

export function diffDecorations(doc: Text, parts: DiffPart[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lines = new Set<number>();
  let pos = 0;
  for (const part of parts) {
    if (part.type === "same") {
      pos += part.text.length;
      continue;
    }
    if (part.type === "add") {
      const end = Math.min(doc.length, pos + part.text.length);
      if (part.text.trim()) {
        ranges.push(inserted.range(pos, end));
        for (let line = doc.lineAt(pos).number; line <= doc.lineAt(end).number; line += 1) lines.add(line);
      }
      pos = end;
      continue;
    }
    const text = part.text.replace(/\s*\n+\s*/g, " ").trim();
    if (!text) continue;
    ranges.push(Decoration.widget({ widget: new DeletedText(text), side: -1 }).range(Math.min(pos, doc.length)));
    lines.add(doc.lineAt(Math.min(pos, doc.length)).number);
  }
  for (const line of lines) ranges.push(changedLine.range(doc.line(line).from));
  return Decoration.set(ranges, true);
}
