"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DocPickHeader, DocPickNotice, DocPickOptions, useDocPicks } from "@/components/crm/task-doc-picker";
import { useDocChange } from "@/components/crm/task-docs";
import type { Task } from "@/lib/crm/types";
import type { DocPick } from "@/lib/docs/client-types";
import { caretAfterEdit, insideClosedReference, pickIntoDescription, textEdit, withoutReferenceNear } from "@/lib/task-doc-picks";
import { docQueryAt, withoutDocQuery, type DocQuery } from "@/lib/task-pad";

type Mode = "title" | "description";

export function useDocMention({
  task,
  enabled,
  warn,
  mode,
  value,
  onChange,
  onStore,
}: {
  task: Pick<Task, "id" | "docIds">;
  enabled: boolean;
  warn: boolean;
  mode: Mode;
  value: string;
  onChange: (value: string) => void;
  onStore?: () => void;
}) {
  const id = useId();
  const listId = `${id}-docs-list`;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const latest = useRef(value);
  const muted = useRef<number | null>(null);
  const closing = useRef<number | null>(null);
  const [query, setQuery] = useState<DocQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const found = useDocPicks(query ? query.query : null, task.id);
  const change = useDocChange(task.id);
  const options = found.docs ? (mode === "title" ? found.docs.filter((doc) => !task.docIds.includes(doc.id)) : found.docs) : null;
  const active = options && options.length > 0 ? Math.min(highlight, options.length - 1) : -1;

  useEffect(() => {
    latest.current = value;
  }, [value]);
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
    const edit = textEdit(value, next);
    if (element && document.activeElement === element) {
      element.setSelectionRange(edit.start, edit.end);
      const done = edit.insert ? document.execCommand("insertText", false, edit.insert) : edit.start === edit.end || document.execCommand("delete");
      if (done && element.value === next) {
        element.setSelectionRange(caret, caret);
        return;
      }
    }
    onChange(next);
    window.requestAnimationFrame(() => {
      const target = field.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  }

  function pick(doc: DocPick) {
    if (!query) return;
    const next = mode === "title" ? { ...withoutDocQuery(value, query), note: null, reference: null } : pickIntoDescription(value, query, doc);
    const at = query.start;
    setQuery(null);
    setHighlight(0);
    write(next.text, next.caret);
    setNote(next.note);
    if (task.docIds.includes(doc.id)) return;
    const reference = next.reference;
    void change.link(doc).then((linked) => {
      if (linked || !reference) return;
      setNote(null);
      const current = latest.current;
      const cleaned = withoutReferenceNear(current, reference, at);
      if (cleaned === current) return;
      const element = field.current;
      const focused = Boolean(element && document.activeElement === element);
      const caret = element?.selectionStart ?? current.length;
      const edit = textEdit(current, cleaned);
      const kept = caretAfterEdit(edit, caret);
      onChange(cleaned);
      onStore?.();
      if (focused) {
        window.requestAnimationFrame(() => {
          const target = field.current;
          if (target && document.activeElement === target) target.setSelectionRange(kept, kept);
        });
      }
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

  const status = change.error ? (
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
