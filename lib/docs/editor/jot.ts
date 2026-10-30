import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, Prec, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder, type KeyBinding } from "@codemirror/view";
import { livePreview } from "@/lib/docs/editor/preview";
import { detectTrigger, type ActiveTrigger, type PickerKey } from "@/lib/docs/editor/setup";
import { docsLanguage } from "@/lib/docs/editor/syntax";

export type JotHandlers = {
  resolve: (target: string) => boolean;
  trigger: (value: ActiveTrigger | null, typed: boolean) => void;
  pickerKey: (key: PickerKey) => boolean;
  submit: () => boolean;
};

export const jotLabel = new Compartment();

const lineBreak = Annotation.define<boolean>();

function insertLineBreak(view: EditorView) {
  view.dispatch(view.state.replaceSelection("\n"), { annotations: lineBreak.of(true), userEvent: "input", scrollIntoView: true });
  return true;
}

export function typedReturn(transaction: Transaction) {
  if (!transaction.docChanged || transaction.annotation(lineBreak) || transaction.isUserEvent("input.paste") || !transaction.isUserEvent("input")) return false;
  let found = false;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.toString().includes("\n")) found = true;
  });
  return found;
}

export function jotLabelAttributes(label: string) {
  return EditorView.contentAttributes.of({ "aria-label": label });
}

export function entryBlock(text: string, stamp: string) {
  const clean = text.trim();
  if (!clean) return null;
  return /^([-*+]|\d+[.)])\s/.test(clean) ? `${stamp}\n${clean}` : `${stamp} ${clean}`;
}

export function clearJot(view: EditorView) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" }, selection: { anchor: 0 }, userEvent: "delete" });
}

function returnTyped(view: EditorView, handlers: JotHandlers) {
  const at = view.state.selection.main.head;
  if (at > 0 && view.state.sliceDoc(at - 1, at) === "\n") view.dispatch({ changes: { from: at - 1, to: at }, userEvent: "delete" });
  if (!handlers.pickerKey("enter")) handlers.submit();
}

export function jotExtensions(options: { label: string; placeholder: string; handlers: JotHandlers }): Extension[] {
  const { handlers } = options;
  const pickerKeys: KeyBinding[] = [
    { key: "ArrowDown", run: () => handlers.pickerKey("down") },
    { key: "ArrowUp", run: () => handlers.pickerKey("up") },
    { key: "Enter", run: () => handlers.pickerKey("enter") },
    { key: "Shift-Enter", run: () => handlers.pickerKey("shift-enter") },
    { key: "Mod-Enter", run: () => handlers.pickerKey("mod-enter") },
    { key: "Tab", run: () => handlers.pickerKey("tab") },
    { key: "Escape", run: () => handlers.pickerKey("escape") },
  ];
  return [
    history(),
    docsLanguage(),
    livePreview({ daily: false, resolve: (target) => handlers.resolve(target) }),
    EditorView.lineWrapping,
    Prec.highest(keymap.of(pickerKeys)),
    keymap.of([
      { key: "Enter", run: () => handlers.submit() },
      { key: "Shift-Enter", run: insertLineBreak },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.transactions.some(typedReturn)) setTimeout(() => returnTyped(update.view, handlers), 0);
      if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
      const typed = update.transactions.some((transaction) => transaction.isUserEvent("input.type") || transaction.isUserEvent("delete") || transaction.isUserEvent("input.paste"));
      handlers.trigger(detectTrigger(update.state, update.view.hasFocus), typed);
    }),
    placeholder(options.placeholder),
    jotLabel.of(jotLabelAttributes(options.label)),
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", enterkeyhint: "enter" }),
    EditorView.editorAttributes.of({ class: "note-editor note-jot" }),
  ];
}
