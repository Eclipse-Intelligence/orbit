"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import type { CompanyEnrichment } from "@/lib/enrichment/companies";
import { formatWhen } from "@/lib/companies";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

export default function CompanyEnrichButton({ companyId, enrichedAt }: { companyId: string; enrichedAt: string | null }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ message: string; error: boolean } | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const response = await fetch("/api/enrichment/company", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const payload = (await response.json().catch(() => null)) as { result?: CompanyEnrichment; error?: string } | null;
      if (!response.ok || !payload?.result) {
        setResult({ message: payload?.error ?? "That lookup failed. Try again.", error: true });
        return;
      }
      setResult({ message: payload.result.message, error: payload.result.status === "failed" });
      if (payload.result.status === "updated") router.refresh();
    } catch {
      setResult({ message: "That lookup failed. Try again.", error: true });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="secondary" size="sm" disabled={running} onClick={run}>
        <SparkleIcon aria-hidden className={running ? "size-3.5 animate-pulse" : "size-3.5"} />
        {running ? "Finding details…" : enrichedAt ? "Refresh details" : "Find company details"}
      </Button>
      <span role="status" className={result?.error ? "caption-style text-danger" : "caption-style text-subtle"}>
        {result?.message ?? (enrichedAt ? `Checked with context.dev ${formatWhen(enrichedAt)}` : "")}
      </span>
    </div>
  );
}
