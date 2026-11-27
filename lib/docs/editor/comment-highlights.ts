import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export type CommentMark = { from: number; to: number; active: boolean };

export const setCommentMarks = StateEffect.define<CommentMark[]>();

const plain = Decoration.mark({ class: "note-comment-mark" });
const active = Decoration.mark({ class: "note-comment-mark note-comment-mark-active" });

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setCommentMarks)) continue;
      const length = transaction.state.doc.length;
      const ranges: Range<Decoration>[] = effect.value
        .filter((mark) => mark.from >= 0 && mark.to > mark.from && mark.to <= length)
        .map((mark) => (mark.active ? active : plain).range(mark.from, mark.to));
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const listeners = new Set<() => void>();

export function onCommentDocChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const commentHighlights: Extension = [
  marks,
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    for (const listener of listeners) listener();
  }),
];
