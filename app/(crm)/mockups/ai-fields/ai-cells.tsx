"use client";

import type { ComponentProps, ReactNode } from "react";
import Button from "@/components/_ui/button";
import { RecordTag } from "@/components/beautifui/record-marks";
import { cn } from "@/lib/utils";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import type { AiField, Cell, Source } from "./mock-data";

const PICK_COLOURS: Record<string, string> = {
  SEO: "oklch(0.72 0.10 221)",
  PR: "oklch(0.66 0.21 323)",
  Content: "oklch(0.70 0.13 162)",
  Other: "oklch(0.62 0.01 260)",
};

export function pickBase(value: string) {
  return PICK_COLOURS[value];
}

export function AiMark({ className, label = "Answered by AI from the web" }: { className?: string; label?: string }) {
  return (
    <span title={label} className={cn("inline-flex shrink-0 items-center", className)}>
      <SparkleIcon aria-hidden className="size-3" />
      <span className="sr-only">, {label}</span>
    </span>
  );
}

export function AiHeader({ field, direction, open, ...props }: ComponentProps<"button"> & { field: AiField; direction?: "asc" | "desc" | null; open?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      aria-label={`${field.label}, AI field. Sort, filter or edit`}
      aria-expanded={open}
      className={cn(
        "-mx-1 -my-0.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 ease-power3-out outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        (direction || open) && "text-foreground",
        open && "bg-white/6",
      )}
    >
      <AiMark />
      {field.label}
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0", direction === "asc" && "rotate-180", !direction && "opacity-35")}
      />
    </button>
  );
}

function Manual() {
  return (
    <span title="Set by you" className="text-subtle inline-flex">
      <EditIcon aria-hidden className="size-3" />
      <span className="sr-only">, set by you</span>
    </span>
  );
}

export function AiCellValue({ field, cell }: { field: AiField; cell: Cell }) {
  if (cell.state === "outside") {
    return (
      <span className="text-faint" title="Not in this field's companies">
        <span aria-hidden>·</span>
        <span className="sr-only">Not checked for this company</span>
      </span>
    );
  }
  if (cell.state === "checking") {
    return (
      <span className="text-subtle inline-flex items-center gap-1.5 text-[13px]">
        <span aria-hidden className="bg-subtle size-1.5 animate-pulse rounded-full" />
        Checking…
      </span>
    );
  }
  if (cell.state === "unknown") return <span className="text-faint text-[13px]">Unknown</span>;
  if (field.type === "pick") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <RecordTag label={cell.value} base={pickBase(cell.value)} />
        {cell.manual && <Manual />}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] tabular-nums", field.type === "yesno" && cell.value === "No" && "text-subtle")}>
      {cell.value}
      {cell.manual && <Manual />}
    </span>
  );
}

export function SourceList({ sources }: { sources: Source[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {sources.map((source) => (
        <li key={source.url}>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="group/source -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="ui-style text-foreground truncate">{source.title}</span>
              <span className="caption-style text-subtle truncate">{source.host}</span>
            </span>
            <ExternalIcon aria-hidden className="text-subtle size-3.5 shrink-0 group-hover/source:text-foreground" />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function AnswerDetail({
  field,
  question,
  answer,
  likely,
  reason,
  sources,
  checked,
  next,
  footer,
}: {
  field: string;
  question: string;
  answer: string;
  likely: number;
  reason: string;
  sources: Source[];
  checked: string;
  next: string;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle flex items-center gap-1.5">
            <AiMark />
            {field}
          </span>
          <p className="caption-style text-soft">{question}</p>
        </div>
        <div className="flex items-baseline gap-2">
          <h3 className="leading-5">{answer}</h3>
          <span className="caption-style text-subtle">{likely}% likely</span>
        </div>
        <p className="ui-style text-soft">{reason}</p>
      </div>
      <div className="border-border flex flex-col gap-1.5 border-t px-4 py-3">
        <span className="caption-style text-subtle">Sources</span>
        <SourceList sources={sources} />
      </div>
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <span className="caption-style text-subtle">
          {checked}. {next}.
        </span>
        {footer ?? (
          <span className="flex items-center gap-1">
            <Button variant="ghost" size="sm">
              <RefreshIcon aria-hidden className="size-3" />
              Check again
            </Button>
            <Button variant="secondary" size="sm">
              <EditIcon aria-hidden className="size-3" />
              Edit answer
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
