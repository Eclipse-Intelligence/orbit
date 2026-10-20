"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import ApprovalCard from "@/components/workflows/approval-card";
import { createWorkflowAction } from "@/app/(crm)/workflows/actions";
import { relativeWhen } from "@/lib/companies";
import { TRIGGER_LABELS, type TriggerType } from "@/lib/workflows/definition";
import type { Approval, WorkflowSummary } from "@/lib/workflows/store";

const STATUS_TAG = {
  active: { label: "On", tone: "green" },
  paused: { label: "Off", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
} as const;

export const RUN_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Stopped",
};

function lastRun(item: WorkflowSummary) {
  if (!item.lastRunAt) return "Not run yet";
  return `${RUN_LABELS[item.lastRunStatus ?? ""] ?? "Ran"} ${relativeWhen(item.lastRunAt).toLowerCase()}`;
}

export default function WorkflowsScreen({
  viewer,
  mine,
  shared,
  starters,
  approvals,
  focus,
}: {
  viewer: Viewer;
  mine: WorkflowSummary[];
  shared: WorkflowSummary[];
  starters: { key: string; name: string; description: string }[];
  approvals: Approval[];
  focus: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(template: string | null) {
    setPending(template ?? "new");
    setError(null);
    const result = await createWorkflowAction({ template });
    if (!result.id) {
      setPending(null);
      setError(result.error ?? "Couldn't create the workflow.");
      return;
    }
    router.push(`/workflows/${result.id}`);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Workflows"
        viewer={viewer}
        action={
          <Button variant="primary" size="sm" data-shortcut="add-record" disabled={pending !== null} onClick={() => void create(null)}>
            {pending === "new" ? "Creating…" : "New workflow"}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[56em] flex-col gap-8 px-4 py-6 pb-24">
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          {approvals.length > 0 && (
            <section aria-labelledby="approvals-heading" className="flex flex-col gap-3">
              <h2 id="approvals-heading">Waiting for you</h2>
              <ul className="flex flex-col gap-3">
                {approvals.map((approval) => (
                  <ApprovalCard key={approval.runId} approval={approval} focused={approval.runId === focus} />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="mine-heading" className="flex flex-col gap-3">
            <h2 id="mine-heading">Your workflows</h2>
            {mine.length === 0 ? (
              <p className="caption-style text-subtle">
                Nothing yet. Start from a template below, or build your own with New workflow.
              </p>
            ) : (
              <ul className="border-border flex flex-col rounded-xl border">
                {mine.map((item) => (
                  <li key={item.id} className="border-border border-b last:border-b-0">
                    <a href={`/workflows/${item.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-white/3">
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[14px] leading-5">{item.name}</span>
                        <span className="caption-style text-subtle truncate">
                          {TRIGGER_LABELS[item.triggerType as TriggerType] ?? item.triggerType} · {lastRun(item)}
                          {item.runCount ? ` · ${item.runCount} ${item.runCount === 1 ? "run" : "runs"} in 30 days` : ""}
                        </span>
                      </span>
                      {item.isTemplate && <Tag tone="blue">Shared</Tag>}
                      <Tag tone={STATUS_TAG[item.status].tone}>{STATUS_TAG[item.status].label}</Tag>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="templates-heading" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="templates-heading">Templates</h2>
              <p className="caption-style text-subtle">
                Using a template makes your own copy. Share any of your workflows as a template from its page.
              </p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {starters.map((item) => (
                <li key={item.key} className="border-line-strong bg-card flex flex-col gap-3 rounded-xl border p-4">
                  <span className="flex items-center gap-2">
                    <span className="text-[14px] leading-5 font-medium">{item.name}</span>
                    <Tag tone="purple">Orbit</Tag>
                  </span>
                  <p className="caption-style text-subtle flex-1 leading-[1.45]">{item.description}</p>
                  <Button variant="secondary" size="sm" className="self-start" disabled={pending !== null} onClick={() => void create(item.key)}>
                    {pending === item.key ? "Copying…" : "Use template"}
                  </Button>
                </li>
              ))}
              {shared.map((item) => (
                <li key={item.id} className="border-line-strong bg-card flex flex-col gap-3 rounded-xl border p-4">
                  <span className="flex flex-col gap-1">
                    <span className="text-[14px] leading-5 font-medium">{item.name}</span>
                    <span className="caption-style text-subtle">
                      Shared by {item.ownerName ?? "a teammate"} · {TRIGGER_LABELS[item.triggerType as TriggerType] ?? item.triggerType}
                    </span>
                  </span>
                  {item.description && <p className="caption-style text-subtle flex-1 leading-[1.45]">{item.description}</p>}
                  <Button variant="secondary" size="sm" className="self-start" disabled={pending !== null} onClick={() => void create(item.id)}>
                    {pending === item.id ? "Copying…" : "Use template"}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
