"use client";

import { useId, useState, type ReactNode } from "react";
import Tag from "@/components/_ui/tag";
import ChannelIcon from "@/components/campaigns/channel-icon";
import type { CampaignProgress, ProgressStatus, ProgressStep } from "@/lib/campaigns/progress";
import { PROGRESS_STATUS_LABELS } from "@/lib/campaigns/progress-view";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const STATUS_TONES: Record<ProgressStatus, "blue" | "green" | "amber" | "neutral"> = {
  in_progress: "blue",
  pending: "neutral",
  replied: "green",
  stopped: "neutral",
  finished: "neutral",
  paused: "amber",
};

const STEP_WORDS: Record<ProgressStep["state"], string> = {
  done: "Done",
  current: "Current step",
  next: "Next",
  later: "Later",
  stopped: "Not sent",
};

function Marker({ state }: { state: ProgressStep["state"] }) {
  if (state === "done") {
    return (
      <span aria-hidden className="grid size-3.5 place-items-center rounded-full border border-(--tag-green-border) bg-(--tag-green-bg) text-(--tag-green-text)">
        <CheckIcon className="size-2.5" />
      </span>
    );
  }
  if (state === "current") return <span aria-hidden className="bg-primary size-3.5 rounded-full" />;
  return <span aria-hidden className="size-3.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--line-strong)]" />;
}

function Steps({ steps }: { steps: ProgressStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col">
      {steps.map((step) => (
        <li
          key={step.step}
          className={cn(
            "ui-style grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 py-[5px]",
            (step.state === "later" || step.state === "stopped") && "text-subtle",
            step.state === "current" && "font-medium",
          )}
        >
          <Marker state={step.state} />
          <span className="truncate">
            <span className="sr-only">{STEP_WORDS[step.state]}: </span>
            {step.label}
          </span>
          <span className="caption-style text-subtle font-normal whitespace-nowrap tabular-nums">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Counts({ progress }: { progress: CampaignProgress }) {
  const counts = progress.counts;
  const items: [string, string][] =
    progress.channel === "email"
      ? [
          [String(counts.opens ?? 0), counts.opens === 1 ? "open" : "opens"],
          [String(counts.clicks ?? 0), counts.clicks === 1 ? "click" : "clicks"],
        ]
      : [
          [counts.accepted ? "Yes" : "No", "accepted"],
          [String(counts.messages ?? 0), counts.messages === 1 ? "message" : "messages"],
          [counts.replied ? "Yes" : "No", "replied"],
        ];
  return (
    <p className="caption-style text-subtle flex flex-wrap gap-x-4 gap-y-1">
      {items.map(([value, label]) => (
        <span key={label}>
          <span className="text-foreground mr-1 font-medium tabular-nums">{value}</span>
          {label}
        </span>
      ))}
    </p>
  );
}

function Head({ progress, trailing }: { progress: CampaignProgress; trailing?: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="text-subtle flex shrink-0">
          <ChannelIcon channel={progress.channel} className="size-3" />
        </span>
        <span className="truncate text-[13.5px] font-medium">{progress.name}</span>
        <Tag tone={STATUS_TONES[progress.status]} size="sm" className="caption-style">
          {PROGRESS_STATUS_LABELS[progress.status]}
        </Tag>
        {trailing}
      </span>
      <span className="caption-style text-soft">{progress.stage}</span>
    </>
  );
}

function CampaignBlock({ progress, columns }: { progress: CampaignProgress; columns: boolean }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <li className={cn("border-border flex min-w-0 flex-col gap-2.5 not-first:border-t not-first:pt-3", columns && "lg:not-first:border-t-0 lg:not-first:pt-0")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((value) => !value)}
        className="hit focus-visible:ring-ring/60 flex min-w-0 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-2 sm:hidden"
      >
        <Head
          progress={progress}
          trailing={<ChevronDownIcon aria-hidden className={cn("text-subtle ease-power3-out ml-auto size-3 shrink-0 transition-transform duration-150", open && "rotate-180")} />}
        />
      </button>
      <div className="flex min-w-0 flex-col gap-1 max-sm:hidden">
        <Head progress={progress} />
      </div>
      <div id={detailId} className={cn("flex flex-col gap-2.5", !open && "max-sm:hidden")}>
        <Steps steps={progress.steps} />
        <Counts progress={progress} />
      </div>
    </li>
  );
}

export default function CampaignProgressList({ progress, columns = false, className }: { progress: CampaignProgress[]; columns?: boolean; className?: string }) {
  if (progress.length === 0) return null;
  const split = columns && progress.length > 1;
  return (
    <ul aria-label="Progress" className={cn("flex flex-col gap-3", split && "lg:grid lg:grid-cols-2 lg:gap-x-8", className)}>
      {progress.map((item) => (
        <CampaignBlock key={item.prospectId} progress={item} columns={split} />
      ))}
    </ul>
  );
}
