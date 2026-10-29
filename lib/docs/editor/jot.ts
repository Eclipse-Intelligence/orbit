import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { Compartment, Prec, type Extension } from "@codemirror/state";
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
      { key: "Shift-Enter", run: insertNewline },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((update) => {
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
