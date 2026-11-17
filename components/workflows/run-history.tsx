"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { RUN_LABELS } from "@/components/workflows/workflows-screen";
import { cancelRunAction, runDetailsAction } from "@/app/(crm)/workflows/actions";
import { formatWhen, relativeWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { ChildRun, RunStepLog, RunSummary } from "@/lib/workflows/store";
import { ACTIVE_RUN_STATUSES, childrenDone, runProgress } from "@/lib/workflows/progress";
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

type Details = { runId: string; steps: RunStepLog[]; children: ChildRun[]; more: { skipped: number; failed: number }; error?: string };

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
              <span className="caption-style text-subtle">Input</span>
              <pre className="bg-secondary max-h-48 overflow-auto rounded-md p-2 text-[12px] leading-[1.45] whitespace-pre-wrap">{input}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ChildRow({ child }: { child: ChildRun }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<RunStepLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skipped = Boolean(child.skipReason);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !steps) {
      void runDetailsAction(child.id).then((result) => {
        setSteps(result.steps ?? []);
        setError(result.error ?? null);
      });
    }
  }

  return (
    <li className="border-border flex flex-col border-b last:border-b-0">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex min-h-10 cursor-pointer items-center gap-2 py-1.5 text-left">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="ui-style truncate">{child.name}</span>
          <span className="caption-style text-subtle line-clamp-2">{child.skipReason ?? child.error ?? "Failed"}</span>
        </span>
        <Tag tone={skipped ? "neutral" : "red"}>{skipped ? "Skipped" : "Failed"}</Tag>
      </button>
      {open && (
        <div className="pb-2 pl-3">
          {!steps ? (
            <p className="caption-style text-subtle">Loading…</p>
          ) : error ? (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          ) : (
            <ol className="flex flex-col">
              {steps.map((step) => (
                <StepLog key={step.id} step={step} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

function moreLine(more: { skipped: number; failed: number }) {
  return [more.failed ? `${more.failed} more failed` : "", more.skipped ? `${more.skipped} more skipped` : ""].filter(Boolean).join(", ");
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
  const router = useRouter();
  const [details, setDetails] = useState<Details | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ runId: string; message: string } | null>(null);

  useEffect(() => {
    if (!selected) {
      onSteps?.(null);
      return;
    }
    let live = true;
    void runDetailsAction(selected).then((result) => {
      if (!live) return;
      setDetails({ runId: selected, steps: result.steps ?? [], children: result.children ?? [], more: result.more ?? { skipped: 0, failed: 0 }, error: result.error });
      onSteps?.(result.steps ?? null);
    });
    return () => {
      live = false;
    };
  }, [selected, runs, onSteps]);

  async function cancel(run: RunSummary) {
    setCancelling(run.id);
    setCancelError(null);
    const result = await cancelRunAction(run.id, run.workflowId);
    setCancelling(null);
    if (result.error) {
      setCancelError({ runId: run.id, message: result.error });
      return;
    }
    router.refresh();
  }

  if (runs.length === 0) return <p className="caption-style text-subtle">No runs</p>;

  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => {
        const active = run.id === selected;
        const record = run.companyName ?? run.contactName;
        const shown = active && details?.runId === run.id ? details : null;
        const open = ACTIVE_RUN_STATUSES.includes(run.status);
        const progress = run.children ? runProgress(run.children, !open) : null;
        const share = run.children && run.children.total ? Math.round((childrenDone(run.children) / run.children.total) * 100) : 0;
        return (
          <li key={run.id} className={cn("border-line-strong rounded-lg border", active && "bg-white/2")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5">
              <button type="button" aria-expanded={active} onClick={() => onSelect(active ? null : run.id)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn("text-[13.5px] leading-5", !progress && "truncate")}>{progress ?? record ?? "No record"}</span>
                  <span className="caption-style text-subtle" title={formatWhen(run.createdAt)}>
                    {relativeWhen(run.createdAt)}
                    {run.test ? " · Test run" : ""}
                  </span>
                </span>
                <Tag tone={TONES[run.status] ?? "neutral"}>{run.waitingFor === "approval" ? "Needs approval" : (RUN_LABELS[run.status] ?? run.status)}</Tag>
              </button>
              {open && (
                <Button variant="secondary" size="sm" className="hit" disabled={cancelling === run.id} onClick={() => void cancel(run)}>
                  {cancelling === run.id ? "Cancelling…" : "Cancel run"}
                </Button>
              )}
              {run.children && open && (
                <div
                  role="progressbar"
                  aria-label="Items done"
                  aria-valuemin={0}
                  aria-valuemax={run.children.total}
                  aria-valuenow={childrenDone(run.children)}
                  className="bg-muted h-1 w-full overflow-hidden rounded-full"
                >
                  <div className="bg-primary h-full rounded-full transition-[width] duration-300 ease-power3-out" style={{ width: `${share}%` }} />
                </div>
              )}
              {cancelError?.runId === run.id && (
                <p role="alert" className="caption-style text-danger w-full">
                  {cancelError.message}
                </p>
              )}
            </div>
            {active && (
              <div className="border-border flex flex-col gap-2 border-t px-3 py-2">
                {run.error && <p className="caption-style text-danger">{run.error}</p>}
                {run.waitingFor === "approval" && (
                  <Link href={`/workflows?approve=${run.id}#approval-${run.id}`} className="caption-style text-foreground underline underline-offset-2">
                    Review
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
                  <>
                    {shown.children.length > 0 && (
                      <div className="flex flex-col">
                        <ul className="flex flex-col">
                          {shown.children.map((child) => (
                            <ChildRow key={child.id} child={child} />
                          ))}
                        </ul>
                        {moreLine(shown.more) && <p className="caption-style text-subtle py-1.5">{moreLine(shown.more)}</p>}
                      </div>
                    )}
                    <ol className="flex flex-col">
                      {shown.steps.map((step) => (
                        <StepLog key={step.id} step={step} />
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
