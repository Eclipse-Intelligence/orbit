"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { decideApprovalAction } from "@/app/(crm)/workflows/actions";
import { relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import type { Approval } from "@/lib/workflows/store";
import { cn } from "@/lib/utils";

export default function ApprovalCard({ approval, focused = false }: { approval: Approval; focused?: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approved: boolean) {
    setPending(approved ? "approve" : "reject");
    setError(null);
    const result = await decideApprovalAction(approval.runId, approved, note);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li
      id={`approval-${approval.runId}`}
      className={cn("border-line-strong bg-card flex flex-col gap-3 rounded-xl border p-4", focused && "ring-primary/60 ring-2")}
    >
      <div className="flex flex-col gap-1">
        <span className="caption-style text-subtle">
          <Link href={`/workflows/${approval.workflowId}`} className="hover:text-foreground">
            {approval.workflowName}
          </Link>
          {approval.companyId && approval.companyName ? (
            <>
              {" · "}
              <Link href={companyHref(approval.companyId)} className="hover:text-foreground">
                {approval.companyName}
              </Link>
            </>
          ) : null}
          {` · ${relativeWhen(approval.createdAt)}`}
        </span>
        <span className="text-[14px] leading-5 font-medium">{approval.title}</span>
      </div>
      {approval.details && <p className="text-soft text-[14px] leading-5 whitespace-pre-wrap">{approval.details}</p>}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input aria-label="Note (optional)" placeholder="Note (optional)" value={note} onChange={(event) => setNote(event.target.value)} className="flex-1" />
        <span className="flex gap-2">
          <Button variant="subtle" size="sm" className="h-9" disabled={pending !== null} onClick={() => void decide(false)}>
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </Button>
          <Button variant="primary" size="sm" className="h-9" disabled={pending !== null} onClick={() => void decide(true)}>
            {pending === "approve" ? "Running…" : "Approve"}
          </Button>
        </span>
      </div>
    </li>
  );
}
