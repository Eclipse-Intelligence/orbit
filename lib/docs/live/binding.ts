import { EditorState, Transaction, type ChangeSet } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";
import { ySync, ySyncAnnotation, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import { liveSlot } from "@/lib/docs/editor/live-slot";
import { setPresence } from "@/lib/docs/editor/presence";
import { external } from "@/lib/docs/editor/setup";
import { RECONCILE, type LiveSession } from "@/lib/docs/live/session";
import { changesBetween, rebase } from "@/lib/docs/live/rebase";

const remoteChange = EditorState.transactionExtender.of((transaction) =>
  transaction.annotation(ySyncAnnotation) ? { annotations: [external.of(true), Transaction.addToHistory.of(false)] } : null,
);

function applyToText(doc: Y.Doc, text: Y.Text, changes: ChangeSet) {
  const edits: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => edits.push({ from: fromA, to: toA, insert: inserted.toString() }));
  doc.transact(() => {
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
      if (edit.insert) text.insert(edit.from, edit.insert);
    }
  }, RECONCILE);
}

function cursorPublisher<S>(session: LiveSession<S>) {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        this.publish(view);
      }
      update(update: ViewUpdate) {
        if (update.selectionSet || update.focusChanged) this.publish(update.view);
      }
      publish(view: EditorView) {
        const range = view.state.selection.main;
        session.setCursor(view.hasFocus ? { anchor: range.anchor, head: range.head } : null);
      }
      destroy() {
        session.setCursor(null);
      }
    },
  );
}

function reconcile<S>(view: EditorView, session: LiveSession<S>, base: string) {
  const text = session.text;
  const shared = text.toString();
  const shown = view.state.doc.toString();
  if (shared === shown) return;
  const { toShared, toShown } = rebase(base, shown, shared);
  if (!toShared.empty) applyToText(session.doc, text, toShared);
  if (!toShown.empty) view.dispatch({ changes: toShown, annotations: [external.of(true), Transaction.addToHistory.of(false)] });
  const after = text.toString();
  if (after !== view.state.doc.toString()) {
    const repair = changesBetween(view.state.doc.toString(), after);
    view.dispatch({ changes: repair, annotations: [external.of(true), Transaction.addToHistory.of(false)] });
  }
}

export function bind<S>(view: EditorView, session: LiveSession<S>, base: string) {
  reconcile(view, session, base);
  view.dispatch({
    effects: liveSlot.reconfigure([ySyncFacet.of(new YSyncConfig(session.text, session.awareness)), ySync, remoteChange, cursorPublisher(session)]),
  });
}

export function unbind(view: EditorView) {
  view.dispatch({ effects: [liveSlot.reconfigure([]), setPresence.of([])] });
}
