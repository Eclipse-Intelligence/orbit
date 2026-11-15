"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DocPickHeader, DocPickNotice, DocPickOptions, useDocPicks } from "@/components/crm/task-doc-picker";
import { useDocChange } from "@/components/crm/task-docs";
import type { Task } from "@/lib/crm/types";
import type { DocPick } from "@/lib/docs/client-types";
import { insertReferenceAt, insideClosedReference, PRIVATE_DOC_NOTE, removeDocQuery, textEdit } from "@/lib/task-doc-picks";
import { docQueryAt, withoutDocQuery, type DocQuery } from "@/lib/task-pad";

type Mode = "title" | "description";

export function useDocMention({
  task,
  enabled,
  warn,
  mode,
  value,
  onChange,
  onWrite,
}: {
  task: Pick<Task, "id" | "docIds">;
  enabled: boolean;
  warn: boolean;
  mode: Mode;
  value: string;
  onChange: (value: string) => void;
  onWrite?: (update: (current: string) => string) => void;
}) {
  const id = useId();
  const listId = `${id}-docs-list`;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const muted = useRef<number | null>(null);
  const closing = useRef<number | null>(null);
  const [query, setQuery] = useState<DocQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const found = useDocPicks(query ? query.query : null, task.id);
  const change = useDocChange(task.id);
  const options = found.docs ? (mode === "title" ? found.docs.filter((doc) => !task.docIds.includes(doc.id)) : found.docs) : null;
  const active = options && options.length > 0 ? Math.min(highlight, options.length - 1) : -1;

  useEffect(
    () => () => {
      if (closing.current !== null) window.clearTimeout(closing.current);
    },
    [],
  );

  const attach = useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
  }, []);

  function keepOpen() {
    if (closing.current === null) return;
    window.clearTimeout(closing.current);
    closing.current = null;
  }

  function refresh(text: string, caret: number) {
    keepOpen();
    if (!enabled) return;
    const next = docQueryAt(text, caret);
    if (muted.current !== null && text.slice(muted.current, muted.current + 2) !== "[[") muted.current = null;
    if (!next || next.start === muted.current || insideClosedReference(text, next)) {
      setQuery(null);
      return;
    }
    setNote(null);
    setQuery((current) => (current && current.start === next.start && current.end === next.end && current.query === next.query ? current : next));
    if (next.query !== query?.query) setHighlight(0);
  }

  function write(next: string, caret: number) {
    const element = field.current;
    const edit = textEdit(element?.value ?? value, next);
    if (element && document.activeElement === element) {
      element.setSelectionRange(edit.start, edit.end);
      const done = edit.insert ? document.execCommand("insertText", false, edit.insert) : edit.start === edit.end || document.execCommand("delete");
      if (done && element.value === next) {
        element.setSelectionRange(caret, caret);
        return;
      }
      onChange(next);
      refresh(next, caret);
      window.requestAnimationFrame(() => field.current?.setSelectionRange(caret, caret));
      return;
    }
    setQuery(null);
    if (onWrite) onWrite(() => next);
    else onChange(next);
  }

  function name(doc: DocPick, where: { before: string; caret: number }) {
    const element = field.current;
    if (element) {
      const current = element.value;
      const next = insertReferenceAt(current, element.selectionStart ?? current.length, doc.title);
      write(next.text, next.caret);
      return;
    }
    onWrite?.((current) => insertReferenceAt(current, current.startsWith(where.before) ? where.caret : current.length, doc.title).text);
  }

  function pick(doc: DocPick) {
    if (!query) return;
    const picked = query;
    setQuery(null);
    setHighlight(0);
    setNote(null);
    const cleared = mode === "title" ? withoutDocQuery(value, picked) : removeDocQuery(value, picked);
    const linked = task.docIds.includes(doc.id);
    const nameNow = linked && mode === "description" && doc.shared;
    const first = nameNow ? insertReferenceAt(cleared.text, cleared.caret, doc.title) : cleared;
    write(first.text, first.caret);
    const named = () => {
      if (mode === "title") return;
      if (doc.shared) name(doc, { before: cleared.text.slice(0, cleared.caret), caret: cleared.caret });
      else setNote(PRIVATE_DOC_NOTE);
    };
    if (linked) {
      if (mode === "description" && !doc.shared) setNote(PRIVATE_DOC_NOTE);
      return;
    }
    void change.link(doc).then((ok) => {
      if (ok) named();
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!query || event.nativeEvent.isComposing) return false;
    const count = options?.length ?? 0;
    if (event.key === "Enter" && !event.shiftKey && found.loading) {
      event.preventDefault();
      return true;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
      event.preventDefault();
      setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && options && active >= 0 && !found.loading) {
      event.preventDefault();
      pick(options[active]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      muted.current = query.start;
      setQuery(null);
      return true;
    }
    return false;
  }

  function close() {
    keepOpen();
    closing.current = window.setTimeout(() => {
      closing.current = null;
      setQuery(null);
    }, 150);
  }

  const open = query !== null;
  const listed = open && Boolean(options && options.length > 0);
  const fieldProps = open
    ? {
        role: "combobox",
        "aria-autocomplete": "list" as const,
        "aria-expanded": true,
        "aria-controls": listed ? listId : undefined,
        "aria-activedescendant": listed && active >= 0 ? `${id}-docs-option-${active}` : undefined,
        "data-mention-open": "",
      }
    : {};

  const menu = query ? (
    <div
      role="group"
      aria-label="Link a doc"
      onMouseDown={(event) => event.preventDefault()}
      className="bg-popover border-line-strong shadow-overlay mt-1.5 w-full max-w-[24rem] overflow-hidden rounded-xl border p-1"
    >
      <DocPickHeader query={query.query} docs={options} loading={found.loading} />
      <DocPickNotice query={query.query} docs={options} failed={found.failed} />
      {options && options.length > 0 && <DocPickOptions id={`${id}-docs`} docs={options} query={query.query} active={active} warn={warn} onHover={setHighlight} onPick={pick} />}
    </div>
  ) : null;

  const status = change.busy ? (
    <p role="status" className="caption-style text-subtle">
      Saving…
    </p>
  ) : change.error ? (
    <p role="alert" className="caption-style text-danger">
      {change.error}
    </p>
  ) : note ? (
    <p role="status" className="caption-style text-subtle">
      {note}
    </p>
  ) : null;

  return { attach, open, refresh, onKeyDown, close, keepOpen, fieldProps, menu, status };
}
