"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import type { PageSummary } from "@/lib/docs/client-types";
import { caretAfterTyping, endingCanSave, endingEnter, endingLine, endingView, saveAfterCheck, typeEnding, type EndingAnswer } from "@/lib/docs/public-ending";
import { cn } from "@/lib/utils";

const CHECK_DELAY = 300;

type Remote = { value: string; answer: EndingAnswer };

export function PublicEndingEditor({
  summary,
  prefix,
  busy,
  onSave,
  onClose,
  check,
}: {
  summary: Pick<PageSummary, "id" | "publicSlug">;
  prefix: string;
  busy: boolean;
  onSave: (slug: string | null) => Promise<string | null>;
  onClose: () => void;
  check: (id: string, value: string) => Promise<EndingAnswer>;
}) {
  const current = summary.publicSlug;
  const [value, setValue] = useState(current ?? "");
  const [remote, setRemote] = useState<Remote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [checking, setChecking] = useState(false);
  const open = useRef(true);
  const latest = useRef(value);
  const { settled, needsCheck, target } = endingView({ value, current });

  useEffect(() => {
    open.current = true;
    input.current?.focus();
    return () => {
      open.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    latest.current = value;
    if (caret.current === null) return;
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  useEffect(() => {
    if (!needsCheck) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void check(summary.id, settled).then((answer) => {
        if (live) setRemote({ value: settled, answer });
      });
    }, CHECK_DELAY);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [needsCheck, settled, summary.id, check]);

  const answer = needsCheck && remote?.value === settled ? remote.answer : null;
  const state = { value, current, answer, error, saving: saving || checking, busy };
  const line = endingLine(state);

  async function store() {
    setSaving(true);
    setError(null);
    const failure = await onSave(target);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  }

  async function submit() {
    const next = endingEnter(state);
    if (next === "save") return store();
    if (next !== "check") return;
    setChecking(true);
    const result = await check(summary.id, settled);
    if (!open.current) return;
    setChecking(false);
    setRemote({ value: settled, answer: result });
    if (saveAfterCheck({ open: open.current, checkedValue: settled, value: latest.current, answer: result })) await store();
    else input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "bg-surface-field focus-within:bg-surface-raised ease-power3-out flex h-9 min-w-0 items-center rounded-lg border pl-2.5 text-[13px] transition-[background-color,border-color] duration-150",
          line.tone === "bad" ? "border-danger focus-within:border-danger" : "focus-within:border-ring/50 border-transparent",
        )}
      >
        <span aria-hidden className="text-subtle min-w-0 shrink-[100] truncate">
          {prefix}
        </span>
        <Input
          ref={input}
          value={value}
          onChange={(event) => {
            const raw = event.target.value;
            caret.current = caretAfterTyping(raw, event.target.selectionStart ?? raw.length);
            setError(null);
            setValue(typeEnding(raw));
          }}
          onKeyDown={onKeyDown}
          aria-label="Link ending"
          aria-invalid={line.tone === "bad"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={saving || checking}
          className="h-full min-w-[12ch] flex-1 border-0 bg-transparent px-0 pr-2.5 text-[13px] hover:bg-transparent focus-visible:border-0 focus-visible:bg-transparent"
        />
      </div>
      <div className="flex items-start gap-2 pointer-coarse:gap-3">
        <span role={error ? "alert" : "status"} className={cn("caption-style min-w-0 flex-1 pt-1.5", line.tone === "bad" ? "text-danger" : line.tone === "ok" ? "text-success" : "text-subtle")}>
          {line.text}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose} className="hit">
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!endingCanSave(state)} onClick={() => void store()} className="hit">
          Save
        </Button>
      </div>
    </div>
  );
}
