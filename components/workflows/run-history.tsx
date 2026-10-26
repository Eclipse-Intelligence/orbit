"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Tag from "@/components/_ui/tag";
import { RUN_LABELS } from "@/components/workflows/workflows-screen";
import { runDetailsAction } from "@/app/(crm)/workflows/actions";
import { formatWhen, relativeWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { RunStepLog, RunSummary } from "@/lib/workflows/store";
import { cn } from "@/lib/utils";
import { STEP_LABELS, type StepType } from "@/lib/workflows/definition";

const TONES: Record<string, "green" | "red" | "amber" | "blue" | "neutral"> = {
  succeeded: "green",
  failed: "red",
  waiting: "amber",
  running: "blue",
  queued: "blue",
  cancelled: "neutral",
};

function pretty(value: unknown) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value, null, 2);
}

function StepLog({ step }: { step: RunStepLog }) {
  const [open, setOpen] = useState(step.status === "failed");
  const output = pretty(step.output);
  const input = pretty(step.input);
  return (
    <li className="border-border flex flex-col gap-1.5 border-b py-2.5 last:border-b-0">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex cursor-pointer items-center gap-2 text-left">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            step.status === "succeeded" ? "bg-success" : step.status === "failed" ? "bg-danger" : step.status === "waiting" ? "bg-warning" : "bg-faint",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13.5px] leading-5">{step.label || STEP_LABELS[step.stepType as StepType] || step.stepId}</span>
        <span className="caption-style text-subtle">{step.status === "waiting" ? "Waiting" : step.status === "failed" ? "Failed" : "Done"}</span>
      </button>
      {step.error && <p className="caption-style text-danger pl-3.5">{step.error}</p>}
      {open && (
        <div className="flex flex-col gap-2 pl-3.5">
          {output && (
            <div className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Result</span>
              <pre className="bg-secondary max-h-64 overflow-auto rounded-md p-2 text-[12px] leading-[1.45] whitespace-pre-wrap">{output}</pre>
            </div>
          )}
          {input && (
            <div className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Settings used</span>
              <pre className="bg-secondary max-h-48 overflow-auto rounded-md p-2 text-[12px] leading-[1.45] whitespace-pre-wrap">{input}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function RunHistory({
  runs,
  selected,
  onSelect,
  onSteps,
}: {
  runs: RunSummary[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onSteps?: (steps: RunStepLog[] | null) => void;
}) {
  const [details, setDetails] = useState<{ runId: string; steps: RunStepLog[]; error?: string } | null>(null);

  useEffect(() => {
    if (!selected) {
      onSteps?.(null);
      return;
    }
    let live = true;
    void runDetailsAction(selected).then((result) => {
      if (!live) return;
      setDetails({ runId: selected, steps: result.steps ?? [], error: result.error });
      onSteps?.(result.steps ?? null);
    });
    return () => {
      live = false;
    };
  }, [selected, runs, onSteps]);

  if (runs.length === 0) return <p className="caption-style text-subtle">No runs yet. Use Test run to try it on a record.</p>;

  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => {
        const active = run.id === selected;
        const record = run.companyName ?? run.contactName;
        const shown = active && details?.runId === run.id ? details : null;
        return (
          <li key={run.id} className={cn("border-line-strong rounded-lg border", active && "bg-white/2")}>
            <button
              type="button"
              aria-expanded={active}
              onClick={() => onSelect(active ? null : run.id)}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13.5px] leading-5">{record ?? "No record"}</span>
                <span className="caption-style text-subtle" title={formatWhen(run.createdAt)}>
                  {relativeWhen(run.createdAt)}
                  {run.test ? " · Test run" : ""}
                </span>
              </span>
              <Tag tone={TONES[run.status] ?? "neutral"}>{run.waitingFor === "approval" ? "Needs approval" : (RUN_LABELS[run.status] ?? run.status)}</Tag>
            </button>
            {active && (
              <div className="border-border flex flex-col gap-2 border-t px-3 py-2">
                {run.error && <p className="caption-style text-danger">{run.error}</p>}
                {run.waitingFor === "approval" && (
                  <Link href={`/workflows?approve=${run.id}#approval-${run.id}`} className="caption-style text-foreground underline underline-offset-2">
                    Review the approval
                  </Link>
                )}
                {(run.companyId || run.contactId) && (
                  <Link
                    href={run.companyId ? companyHref(run.companyId) : contactHref(run.contactId!)}
                    className="caption-style text-subtle hover:text-foreground underline underline-offset-2"
                  >
                    Open {record}
                  </Link>
                )}
                {!shown ? (
                  <p className="caption-style text-subtle">Loading…</p>
                ) : shown.error ? (
                  <p className="caption-style text-danger">{shown.error}</p>
                ) : (
                  <ol className="flex flex-col">
                    {shown.steps.map((step) => (
                      <StepLog key={step.id} step={step} />
                    ))}
                  </ol>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
