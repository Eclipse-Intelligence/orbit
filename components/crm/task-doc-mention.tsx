"use client";

import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { DocPickHeader, DocPickNotice, DocPickOptions, useDocPicks } from "@/components/crm/task-doc-picker";
import { useDocChange } from "@/components/crm/task-docs";
import type { Task } from "@/lib/crm/types";
import type { DocPick } from "@/lib/docs/client-types";
import { pickIntoDescription } from "@/lib/task-doc-picks";
import { docQueryAt, withoutDocQuery, type DocQuery } from "@/lib/task-pad";

type Mode = "title" | "description";

export function useDocMention({
  task,
  enabled,
  warn,
  mode,
  value,
  onChange,
}: {
  task: Pick<Task, "id" | "docIds">;
  enabled: boolean;
  warn: boolean;
  mode: Mode;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
  }, []);
  const muted = useRef<number | null>(null);
  const [query, setQuery] = useState<DocQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const found = useDocPicks(query ? query.query : null, task.id);
  const change = useDocChange(task.id);
  const options = found.docs ? (mode === "title" ? found.docs.filter((doc) => !task.docIds.includes(doc.id)) : found.docs) : null;
  const active = options && options.length > 0 ? Math.min(highlight, options.length - 1) : -1;

  function refresh(text: string, caret: number) {
    if (!enabled) return;
    const next = docQueryAt(text, caret);
    if (muted.current !== null && text.slice(muted.current, muted.current + 2) !== "[[") muted.current = null;
    if (next && next.start === muted.current) {
      setQuery(null);
      return;
    }
    if (next) setNote(null);
    setQuery((current) => (current && next && current.start === next.start && current.end === next.end && current.query === next.query ? current : next));
    if (!next || next.query !== query?.query) setHighlight(0);
  }

  function focusAt(caret: number) {
    window.requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  }

  function pick(doc: DocPick) {
    if (!query) return;
    const next = mode === "title" ? { ...withoutDocQuery(value, query), note: null } : pickIntoDescription(value, query, doc);
    onChange(next.text);
    focusAt(next.caret);
    setQuery(null);
    setHighlight(0);
    setNote(next.note);
    if (!task.docIds.includes(doc.id)) void change.link(doc);
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
    window.setTimeout(() => setQuery(null), 150);
  }

  const menu = query ? (
    <div role="group" aria-label="Link a doc" className="bg-popover border-line-strong shadow-overlay mt-1.5 w-full max-w-[24rem] overflow-hidden rounded-xl border p-1">
      <DocPickHeader query={query.query} docs={options} loading={found.loading} />
      <DocPickNotice query={query.query} docs={options} failed={found.failed} />
      {options && options.length > 0 && <DocPickOptions id={`${id}-docs`} docs={options} query={query.query} active={active} warn={warn} buttons onHover={setHighlight} onPick={pick} />}
    </div>
  ) : null;

  const status =
    change.error ? (
      <p role="alert" className="caption-style text-danger">
        {change.error}
      </p>
    ) : note ? (
      <p role="status" className="caption-style text-subtle">
        {note}
      </p>
    ) : null;

  return { attach, open: query !== null, refresh, onKeyDown, close, menu, status };
}
