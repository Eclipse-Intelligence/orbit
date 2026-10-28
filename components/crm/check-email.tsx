"use client";

import { useState } from "react";
import { checkContactEmailAction } from "@/app/(crm)/enrichment";
import { relativeWhen } from "@/lib/companies";
import type { EmailCheck } from "@/lib/enrichment/email-check";
import type { Verdict } from "@/lib/enrichment/providers";
import { appTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";

const LABELS: Record<Verdict, string> = { valid: "Valid", invalid: "Invalid", unknown: "Unknown" };

const TONES: Record<Verdict, string> = { valid: "text-success", invalid: "text-danger", unknown: "text-subtle" };

function checkedDay(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: appTimeZone() }).format(new Date(iso));
}

function describeCheck(check: EmailCheck) {
  const when = check.stale ? relativeWhen(check.checkedAt).toLowerCase() : checkedDay(check.checkedAt);
  const by = check.providerName;
  const what =
    check.source === "find"
      ? `${LABELS[check.verdict]}, found and verified ${when}${by ? ` by ${by}` : ""}`
      : `${LABELS[check.verdict]}, checked ${when}${by ? ` with ${by}` : ""}`;
  return check.stale ? `${what}. It may have changed` : what;
}

export default function CheckEmailButton({
  contactId,
  email,
  check,
}: {
  contactId: string;
  email: string;
  check: EmailCheck | null;
}) {
  const [running, setRunning] = useState(false);
  const [fresh, setFresh] = useState<EmailCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = email.trim().toLowerCase();
  const latest = [fresh, check].find((item) => item?.email === address) ?? null;

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    const result = await checkContactEmailAction(contactId);
    setRunning(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setFresh(result.check);
  }

  const summary = latest ? describeCheck(latest) : null;
  const label = running
    ? "Checking…"
    : error
      ? "Couldn't check"
      : latest
        ? latest.stale
          ? `Checked ${relativeWhen(latest.checkedAt).toLowerCase()}`
          : `${LABELS[latest.verdict]} · ${checkedDay(latest.checkedAt)}`
        : "Check address";
  const title = error ?? (summary ? `${summary}. Check again` : "Check the address with an email checker");

  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={running}
        title={title}
        aria-label={running ? "Checking the address" : title}
        className={cn(
          "caption-style relative z-10 -my-1 inline-flex min-w-0 shrink-0 cursor-pointer items-center rounded-md px-1 py-1 whitespace-nowrap transition-colors duration-150 ease-power3-out outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-progress",
          error ? "text-danger/80" : latest && !running && !latest.stale ? TONES[latest.verdict] : "text-subtle hover:text-foreground",
        )}
      >
        {label === "Check address" ? (
          <>
            <span className="sm:hidden">Check</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </button>
      <span role="status" className="sr-only">
        {error ?? (fresh && summary) ?? ""}
      </span>
    </>
  );
}
