"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { runWorkflowAction } from "@/app/(crm)/workflows/actions";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";

const OUTCOMES: Record<string, string> = {
  succeeded: "Done",
  waiting: "Waiting for approval or a delay",
  failed: "It failed. See the run for details",
  cancelled: "Stopped",
};

export default function RunWorkflowButton({
  object,
  recordId,
  workflows,
}: {
  object: "company" | "contact";
  recordId: string;
  workflows: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (workflows.length === 0) return null;

  async function run(workflow: { id: string; name: string }) {
    setBusy(true);
    setStatus(`Running ${workflow.name}…`);
    const result = await runWorkflowAction(workflow.id, { test: false, record: { type: object, id: recordId } });
    setBusy(false);
    setStatus(result.error ?? `${workflow.name}: ${OUTCOMES[result.status ?? ""] ?? "Started"}`);
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      {status && (
        <span role="status" className="caption-style text-subtle hidden max-w-56 truncate md:inline">
          {status}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="icon" aria-label="Run a workflow" title="Run a workflow" disabled={busy}>
            <ZapIcon aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Run a workflow</DropdownMenuLabel>
          {workflows.map((workflow) => (
            <DropdownMenuItem key={workflow.id} onSelect={() => void run(workflow)}>
              {workflow.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
