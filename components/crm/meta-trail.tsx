import { formatDayShort, formatMoneyWhole } from "@/lib/companies";
import type { MetaTrailStep } from "@/lib/crm/meta-outcomes";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/mail/check.svg";

function label(step: MetaTrailStep) {
  if (step.value === null || !step.currency) return step.name;
  return `${step.name} · ${formatMoneyWhole(step.value, step.currency)}`;
}

export default function MetaTrail({ steps }: { steps: MetaTrailStep[] }) {
  return (
    <div role="group" aria-label="Sent to Meta" className="flex flex-col gap-1">
      <span className="caption-style text-subtle">Sent to Meta</span>
      <ul className="flex flex-col">
        {steps.map((step) => (
          <li key={step.name} className="flex items-center gap-2.5 py-1 text-[13px] leading-5">
            <span
              aria-hidden
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                step.state === "sent" && "border-(--tag-green-border) bg-(--tag-green-bg) text-(--tag-green-text)",
                step.state === "retrying" && "border-danger bg-danger",
                step.state === "waiting" && "border-border border-dashed",
              )}
            >
              {step.state === "sent" && <CheckIcon className="size-2.5" />}
            </span>
            <span className={cn("min-w-0 flex-1 wrap-anywhere", step.state === "waiting" ? "text-subtle" : "text-foreground")}>{label(step)}</span>
            {step.state === "sent" && step.at && <time dateTime={step.at} className="caption-style text-subtle shrink-0 tabular-nums">{formatDayShort(step.at)}</time>}
            {step.state === "retrying" && <span className="caption-style text-danger shrink-0">Retrying</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
