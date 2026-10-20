"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ContactEnrichment, LookupState } from "@/lib/enrichment/contacts";
import type { ContactField } from "@/lib/enrichment/providers";
import { cn } from "@/lib/utils";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

const BULK_FIND_CHUNK = 6;

const NOUNS: Record<ContactField, string> = { email: "email", linkedin: "LinkedIn", phone: "phone" };

const PLURALS: Record<ContactField, [string, string]> = {
  email: ["email", "emails"],
  linkedin: ["LinkedIn profile", "LinkedIn profiles"],
  phone: ["phone number", "phone numbers"],
};

async function findDetails(ids: string[], field: ContactField): Promise<ContactEnrichment[]> {
  const response = await fetch("/api/enrichment/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, field }),
  });
  const payload = (await response.json().catch(() => null)) as { results?: ContactEnrichment[]; error?: string } | null;
  if (!response.ok || !payload?.results) throw new Error(payload?.error ?? "That lookup failed. Try again.");
  return payload.results;
}

export async function findDetailsInBatches(ids: string[], field: ContactField, progress: (done: number, found: number) => void) {
  const results: ContactEnrichment[] = [];
  for (let index = 0; index < ids.length; index += BULK_FIND_CHUNK) {
    results.push(...(await findDetails(ids.slice(index, index + BULK_FIND_CHUNK), field)));
    progress(results.length, results.filter((result) => result.status === "found").length);
  }
  return results;
}

export function bulkFindSummary(results: ContactEnrichment[], field: ContactField) {
  const found = results.filter((result) => result.status === "found").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed");
  const searched = results.length - skipped;
  const parts = [`Found ${found} of ${searched} ${PLURALS[field][searched === 1 ? 0 : 1]}`];
  if (skipped > 0) parts.push(`${skipped} skipped (already filled in or missing a name or company)`);
  if (failed.length > 0) parts.push(`${failed.length} couldn't be searched: ${failed[0].message}`);
  return { message: parts.join(". "), tone: failed.length > 0 && found === 0 ? ("error" as const) : ("status" as const) };
}

function attemptsTitle(result: ContactEnrichment) {
  const tried = result.attempts.map((attempt) => attempt.provider).join(", ");
  return tried ? `${result.message} Tried ${tried}.` : result.message;
}

export default function FindDetailButton({
  contactId,
  field,
  lookup,
  variant = "icon",
  className,
}: {
  contactId: string;
  field: ContactField;
  lookup?: LookupState;
  variant?: "icon" | "text";
  className?: string;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; title: string } | null>(null);
  const noun = NOUNS[field];
  const status = outcome?.status ?? lookup?.status ?? null;
  const missing = status === "not_found";
  const failed = status === "failed" || status === "skipped";
  const title = outcome?.title ?? (missing ? `No ${noun} found last time. Search again` : `Find ${noun}`);

  async function run(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (running) return;
    setRunning(true);
    setOutcome(null);
    try {
      const [result] = await findDetails([contactId], field);
      setOutcome({ status: result.status, title: attemptsTitle(result) });
      if (result.email || result.linkedinUrl || result.phone) router.refresh();
    } catch (error) {
      setOutcome({ status: "failed", title: error instanceof Error ? error.message : "That lookup failed." });
    } finally {
      setRunning(false);
    }
  }

  const label = running ? "Searching…" : missing ? "Not found" : failed ? "Couldn't search" : variant === "text" ? `Find ${noun}` : null;

  return (
    <button
      type="button"
      onClick={run}
      disabled={running}
      title={title}
      aria-label={running ? `Searching for ${noun}` : title}
      className={cn(
        "relative z-10 -my-1 inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-1 text-subtle transition-colors duration-150 ease-power3-out outline-none hover:bg-white/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-progress",
        failed && "text-danger/80",
        className,
      )}
    >
      <SparkleIcon aria-hidden className={cn("size-3.5 shrink-0", running && "animate-pulse")} />
      {label && <span className="caption-style truncate">{label}</span>}
    </button>
  );
}
