"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { activeFormats, bodyEditorExtensions, fromProps, insertBlock, minimalChange, toggleFormat, type ActiveFormats, type FormatMarker } from "@/lib/mail/body-editor";
import { cn } from "@/lib/utils";

const NO_FORMATS: ActiveFormats = { bold: false, italic: false };

function lockedExtensions(readOnly: boolean) {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-readonly": "true", class: "caret-transparent" })] : [];
}

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
  onFormats,
  placeholder,
  label,
  fill,
  readOnly = false,
}: {
  readOnly?: boolean;
  ref?: Ref<BodyEditorHandle>;
  value: string;
  onChange: (value: string) => void;
  onFiles: (files: File[]) => void;
  onFileLink: () => void;
  onFormats: (formats: ActiveFormats) => void;
  placeholder: string;
  label: string;
  fill: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onFiles, onFileLink, onFormats });
  const initial = useRef({ value, placeholder, label, readOnly });
  const locking = useRef(new Compartment());

  useLayoutEffect(() => {
    latest.current = { onChange, onFiles, onFileLink, onFormats };
  });

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current.value,
        selection: { anchor: initial.current.value.length },
        extensions: [
          locking.current.of(lockedExtensions(initial.current.readOnly)),
          bodyEditorExtensions({
            placeholder: initial.current.placeholder,
            label: initial.current.label,
            touch: window.matchMedia("(pointer: coarse)").matches,
            handlers: { files: (files) => latest.current.onFiles(files), fileLink: () => latest.current.onFileLink() },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.every((transaction) => transaction.annotation(fromProps))) latest.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet || update.focusChanged) {
              latest.current.onFormats(update.view.hasFocus ? activeFormats(update.state) : NO_FORMATS);
            }
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
    view.dispatch({ changes: minimalChange(current, value), annotations: fromProps.of(true) });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: locking.current.reconfigure(lockedExtensions(readOnly)) });
  }, [readOnly]);

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
