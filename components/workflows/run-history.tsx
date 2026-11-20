"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import HoldButton from "@/components/_ui/hold-button";
import Tag from "@/components/_ui/tag";
import { RUN_LABELS } from "@/components/workflows/workflows-screen";
import { cancelRunAction, runDetailsAction, runsProgressAction } from "@/app/(crm)/workflows/actions";
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

type Details = { runId: string; steps: RunStepLog[]; run: RunSummary | null; error?: string };

const REFRESH_MS = 5_000;

function runTag(run: RunSummary): { tone: "green" | "red" | "amber" | "blue" | "neutral"; label: string } {
  if (run.waitingFor === "approval") return { tone: "amber", label: "Needs approval" };
  if (run.children && run.waitingFor === "children") return { tone: "blue", label: "Running" };
  if (run.children && run.status === "succeeded") return { tone: "green", label: "Succeeded" };
  if (run.skipReason && run.status === "succeeded") return { tone: "neutral", label: "Skipped" };
  return { tone: TONES[run.status] ?? "neutral", label: RUN_LABELS[run.status] ?? run.status };
}

function childTag(child: ChildRun): { tone: "green" | "red" | "amber" | "blue" | "neutral"; label: string } {
  if (child.skipReason) return { tone: "neutral", label: "Skipped" };
  return { tone: TONES[child.status] ?? "neutral", label: RUN_LABELS[child.status] ?? child.status };
}

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
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-surface-hover">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            step.status === "succeeded" ? "bg-success" : step.status === "failed" ? "bg-danger" : step.status === "waiting" ? "bg-warning" : "bg-faint",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13.5px] leading-5">{step.label || STEP_LABELS[step.stepType as StepType] || step.stepId}</span>
        <span className="caption-style text-subtle">{step.status === "waiting" ? "Waiting" : step.status === "failed" ? "Failed" : step.status === "skipped" ? "Skipped" : "Done"}</span>
      </button>
      {step.error && step.status !== "skipped" && <p className="caption-style text-danger pl-3.5">{step.error}</p>}
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

function ChildRow({ child, initiallyOpen = false }: { child: ChildRun; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [steps, setSteps] = useState<RunStepLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tag = childTag(child);

  useEffect(() => {
    if (!open || steps) return;
    let live = true;
    runDetailsAction(child.id)
      .then((result) => {
        if (!live) return;
        setSteps(result.steps ?? []);
        setError(result.error ?? null);
      })
      .catch(() => {
        if (!live) return;
        setSteps([]);
        setError("Couldn't load this item. Try again.");
      });
    return () => {
      live = false;
    };
  }, [open, steps, child.id]);

  function toggle() {
    setOpen((value) => !value);
  }

  return (
    <li className="border-border flex flex-col border-b last:border-b-0">
      <button type="button" onClick={toggle} aria-expanded={open} className="-mx-2 flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-hover">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="ui-style truncate">{child.name}</span>
          {(child.skipReason ?? child.error) && <span className="caption-style text-subtle line-clamp-2">{child.skipReason ?? child.error}</span>}
        </span>
        <Tag tone={tag.tone}>{tag.label}</Tag>
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

function progressing(run: RunSummary) {
  return run.status === "queued" || run.status === "running" || run.waitingFor === "children";
}

export default function RunHistory({
  runs: given,
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
  const [polled, setPolled] = useState<{ from: RunSummary[]; runs: RunSummary[] } | null>(null);
  const runs = polled?.from === given ? polled.runs : given;
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
      setDetails({ runId: selected, steps: result.steps ?? [], run: result.run ?? null, error: result.error });
      onSteps?.(result.steps ?? null);
    });
    return () => {
      live = false;
    };
  }, [selected, runs, onSteps]);

  const workflowId = given[0]?.workflowId ?? null;
  const moving = runs.some(progressing);
  useEffect(() => {
    if (!moving || !workflowId) return;
    let live = true;
    const timer = window.setInterval(() => {
      void runsProgressAction(workflowId)
        .then((result) => {
          if (live && result.runs) setPolled({ from: given, runs: result.runs });
        })
        .catch(() => undefined);
    }, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [moving, workflowId, given]);

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
        const tag = runTag(run);
        const listed = shown?.run ?? run;
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
                <Tag tone={tag.tone}>{tag.label}</Tag>
              </button>
              {open && (
                <HoldButton disabled={cancelling === run.id} onConfirm={() => void cancel(run)}>
                  {cancelling === run.id ? "Stopping…" : "Hold to stop"}
                </HoldButton>
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
              {listed.items.length > 0 && (
                <div className="flex w-full flex-col">
                  <ul className="flex flex-col">
                    {listed.items.map((child) => (
                      <ChildRow key={`${child.id}-${run.test && active}`} child={child} initiallyOpen={run.test && active} />
                    ))}
                  </ul>
                  {moreLine(listed.more) && <p className="caption-style text-subtle py-1.5">{moreLine(listed.more)}</p>}
                </div>
              )}
            </div>
            {active && (
              <div className="border-border flex flex-col gap-2 border-t px-3 py-2">
                {run.error && <p className={cn("caption-style", run.skipReason ? "text-subtle" : "text-danger")}>{run.error}</p>}
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
