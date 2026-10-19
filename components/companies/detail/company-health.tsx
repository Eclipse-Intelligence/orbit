"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HealthMark } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import { recordSelectClass } from "@/components/crm/record-form";
import { setCompanyHealthAction } from "@/app/(crm)/actions";
import { formatDate, HEALTH_LABELS } from "@/lib/companies";
import { ACCOUNT_HEALTH, type AccountHealth, type Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export default function CompanyHealth({ company }: { company: Company }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(value: string) {
    setError(null);
    startTransition(async () => {
      const result = await setCompanyHealthAction(company.id, value ? (value as AccountHealth) : null);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  const source = company.healthAt
    ? company.healthActivityId
      ? `From the call on ${formatDate(company.healthAt)}`
      : `Set by hand on ${formatDate(company.healthAt)}`
    : null;

  return (
    <DetailSection
      title="Health"
      action={
        <select
          aria-label="Change health"
          value={company.health ?? ""}
          disabled={pending || Boolean(company.archivedAt)}
          onChange={(event) => change(event.target.value)}
          className={cn(recordSelectClass, "h-[30px] w-auto text-[13px]")}
        >
          <option value="">Not set</option>
          {ACCOUNT_HEALTH.map((health) => (
            <option key={health} value={health}>
              {HEALTH_LABELS[health]}
            </option>
          ))}
        </select>
      }
    >
      {company.health ? (
        <div className="flex flex-col items-start gap-2">
          <HealthMark health={company.health} />
          {company.healthReason && <p className="text-[14px] leading-5">{company.healthReason}</p>}
          {source && <p className="caption-style text-subtle">{source}</p>}
        </div>
      ) : (
        <p className="caption-style text-subtle">Set automatically from the next summarised call, or choose one.</p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </DetailSection>
  );
}
