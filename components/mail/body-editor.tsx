"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bodyEditorExtensions, fromProps, insertBlock, toggleFormat, type FormatMarker } from "@/lib/mail/body-editor";
import { cn } from "@/lib/utils";

export type BodyEditorHandle = {
  focus: () => void;
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  insertBlock: (text: string) => void;
  toggle: (marker: FormatMarker) => void;
};

export default function BodyEditor({
  ref,
  value,
  onChange,
  onFiles,
  onFileLink,
  placeholder,
  label,
  fill,
}: {
  ref?: Ref<BodyEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  onFiles: (files: File[]) => void;
  onFileLink: () => void;
  placeholder: string;
  label: string;
  fill: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onFiles, onFileLink });
  const initial = useRef({ value, placeholder, label });

  useLayoutEffect(() => {
    latest.current = { onChange, onFiles, onFileLink };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          bodyEditorExtensions({
            placeholder: initial.current.placeholder,
            label: initial.current.label,
            handlers: { files: (files) => latest.current.onFiles(files), fileLink: () => latest.current.onFileLink() },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.every((transaction) => transaction.annotation(fromProps))) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: fromProps.of(true) });
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      scrollIntoView: (options) => host.current?.scrollIntoView(options),
      insertBlock: (text) => {
        const view = viewRef.current;
        if (!view) return;
        insertBlock(view, text);
        view.focus();
      },
      toggle: (marker) => {
        const view = viewRef.current;
        if (!view) return;
        toggleFormat(view, marker);
        view.focus();
      },
    }),
    [],
  );

  return <div ref={host} className={cn("mt-2 w-full", fill && "mail-body-fill flex min-h-0 flex-1 flex-col")} />;
}
