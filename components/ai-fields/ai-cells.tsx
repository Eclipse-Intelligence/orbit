"use client";

import { RecordTag } from "@/components/beautifui/record-marks";
import { displayAiValue, type AiCell, type AiField, type AiSource } from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import { appTimeZone } from "@/lib/time";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import EditIcon from "@/public/assets/images/workflows/edit.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";

const PICK_COLOURS = ["oklch(0.72 0.10 221)", "oklch(0.66 0.21 323)", "oklch(0.70 0.13 162)", "oklch(0.74 0.14 75)", "oklch(0.68 0.16 28)", "oklch(0.70 0.12 280)"];
const OTHER_COLOUR = "oklch(0.62 0.01 260)";

export function pickColour(field: Pick<AiField, "options">, option: string) {
  if (option.toLowerCase() === "other") return OTHER_COLOUR;
  const index = field.options.findIndex((item) => item.toLowerCase() === option.toLowerCase());
  return index < 0 ? OTHER_COLOUR : PICK_COLOURS[index % PICK_COLOURS.length];
}

export function AiMark({ className, label = "Answered by AI from the web" }: { className?: string; label?: string }) {
  return (
    <span title={label} className={cn("inline-flex shrink-0 items-center", className)}>
      <SparkleIcon aria-hidden className="size-3" />
      <span className="sr-only">, {label}</span>
    </span>
  );
}

export function ManualMark() {
  return (
    <span title="Set by you" className="text-subtle inline-flex">
      <EditIcon aria-hidden className="size-3" />
      <span className="sr-only">, set by you</span>
    </span>
  );
}

export function AiCellValue({ field, cell }: { field: AiField; cell: AiCell | undefined }) {
  if (!cell || cell.state === "outside") {
    return (
      <span className="text-faint text-[13px]" title="Not in this field's companies">
        <span aria-hidden>·</span>
        <span className="sr-only">Not checked for this company</span>
      </span>
    );
  }
  if (cell.state === "checking") {
    return (
      <span className="text-subtle inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap">
        <span aria-hidden className="bg-subtle size-1.5 animate-pulse rounded-full" />
        Checking…
      </span>
    );
  }
  if (cell.state === "unknown") {
    return (
      <span className="text-faint inline-flex items-center gap-1.5 text-[13px]">
        Unknown
        {cell.manual && <ManualMark />}
      </span>
    );
  }
  if (field.kind === "pick") {
    const options = Array.isArray(cell.value) ? cell.value : [];
    return (
      <span className="inline-flex items-center gap-1.5">
        {options.map((option) => (
          <RecordTag key={option} label={option} base={pickColour(field, option)} />
        ))}
        {cell.manual && <ManualMark />}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex max-w-[220px] items-center gap-1.5 text-[13px] tabular-nums", field.kind === "yes_no" && cell.value === false && "text-subtle")}>
      <span className="truncate">{displayAiValue(field, cell.value)}</span>
      {cell.manual && <ManualMark />}
    </span>
  );
}

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function SourceList({ sources }: { sources: AiSource[] }) {
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
              <span className="ui-style text-foreground truncate">{source.title || host(source.url)}</span>
              <span className="caption-style text-subtle truncate">{host(source.url)}</span>
            </span>
            <ExternalIcon aria-hidden className="text-subtle size-3.5 shrink-0 group-hover/source:text-foreground" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function shortDate(iso: string | null, withYear = false) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: appTimeZone() }).format(new Date(iso));
}
