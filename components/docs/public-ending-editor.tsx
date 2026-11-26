"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import type { PageSummary } from "@/lib/docs/client-types";
import { ENDING_AVAILABLE, ENDING_TAKEN, endingProblem, settleEnding, typeEnding, type EndingStatus } from "@/lib/docs/public-ending";
import { cn } from "@/lib/utils";

const CHECK_DELAY = 300;
const CHECK_FAILED = "Couldn't check the ending. Try again.";

type Remote = { value: string; status: EndingStatus | "failed" };
type Line = { text: string; tone: "ok" | "bad" | "plain" };

function lineOf(input: { error: string | null; problem: string | null; settled: string; current: string | null; needsCheck: boolean; answer: Remote["status"] | null }): Line {
  if (input.error) return { text: input.error, tone: "bad" };
  if (input.problem) return { text: input.problem, tone: "bad" };
  if (input.settled === "") return { text: input.current ? "Save to go back to the random code." : "", tone: "plain" };
  if (!input.needsCheck) return { text: ENDING_AVAILABLE, tone: "ok" };
  if (input.answer === null) return { text: "", tone: "plain" };
  if (input.answer === "failed") return { text: CHECK_FAILED, tone: "bad" };
  if (input.answer.status === "available") return { text: ENDING_AVAILABLE, tone: "ok" };
  return { text: input.answer.status === "taken" ? ENDING_TAKEN : input.answer.message, tone: "bad" };
}

export function PublicEndingEditor({
  summary,
  prefix,
  onSave,
  onClose,
  check,
}: {
  summary: Pick<PageSummary, "id" | "publicSlug">;
  prefix: string;
  onSave: (slug: string | null) => Promise<string | null>;
  onClose: () => void;
  check: (id: string, value: string) => Promise<EndingStatus | null>;
}) {
  const current = summary.publicSlug;
  const [value, setValue] = useState(current ?? "");
  const [remote, setRemote] = useState<Remote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const settled = settleEnding(value);
  const problem = settled === "" ? null : endingProblem(settled);
  const needsCheck = settled !== "" && problem === null && settled !== current;

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!needsCheck) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void check(summary.id, settled).then((status) => {
        if (live) setRemote({ value: settled, status: status ?? "failed" });
      });
    }, CHECK_DELAY);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [needsCheck, settled, summary.id, check]);

  const answer = needsCheck && remote?.value === settled ? remote.status : null;
  const line = lineOf({ error, problem, settled, current, needsCheck, answer });
  const target = settled === "" ? null : settled;
  const verified = !needsCheck || answer === "failed" || (answer !== null && answer.status === "available");
  const canSave = !saving && target !== current && problem === null && verified;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const failure = await onSave(target);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="bg-surface-field focus-within:border-ring/50 focus-within:bg-surface-raised ease-power3-out flex h-9 min-w-0 items-center rounded-lg border border-transparent pl-2.5 text-[13px] transition-[background-color,border-color] duration-150">
        <span aria-hidden className="text-subtle max-w-[65%] min-w-0 shrink truncate">
          {prefix}
        </span>
        <Input
          ref={input}
          value={value}
          onChange={(event) => {
            setError(null);
            setValue(typeEnding(event.target.value));
          }}
          onKeyDown={onKeyDown}
          aria-label="Link ending"
          aria-invalid={line.tone === "bad"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={saving}
          className="h-full min-w-[6ch] flex-1 border-0 bg-transparent px-0 text-[13px] hover:bg-transparent focus-visible:border-0 focus-visible:bg-transparent"
        />
      </div>
      <div className="flex items-start gap-2 pointer-coarse:gap-3">
        <span role="status" className={cn("caption-style min-w-0 flex-1 pt-1.5", line.tone === "bad" ? "text-danger" : line.tone === "ok" ? "text-success" : "text-subtle")}>
          {line.text}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose} className="hit">
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={() => void save()} className="hit">
          Save
        </Button>
      </div>
    </div>
  );
}
