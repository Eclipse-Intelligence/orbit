"use client";

import { useCommandState } from "cmdk";
import { CommandItem } from "@/components/_ui/command";
import Tag from "@/components/_ui/tag";
import { LIFECYCLE_LABELS, formatDate } from "@/lib/companies";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export const COMMAND_TABLE_GRID =
  "grid grid-cols-[minmax(0,1fr)_96px] gap-x-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_110px_minmax(0,0.9fr)]";

const HEADERS = [
  { label: "Company", className: "" },
  { label: "Domain", className: "hidden md:block" },
  { label: "Lifecycle", className: "hidden md:block" },
  { label: "Updated", className: "text-right" },
];

const LIFECYCLE_TONE = {
  lead: "amber",
  prospect: "blue",
  customer: "green",
  churned: "neutral",
} as const;

export function CommandTableHeader() {
  const count = useCommandState((state) => state.filtered.count);

  if (count === 0) return null;

  return (
    <div
      aria-hidden
      className={cn(
        COMMAND_TABLE_GRID,
        "caption-style border-line-strong text-subtle h-9 items-center border-b px-4",
      )}
    >
      {HEADERS.map((header) => (
        <span key={header.label} className={cn("truncate", header.className)}>
          {header.label}
        </span>
      ))}
    </div>
  );
}

type CommandCompanyRowProps = {
  company: Company;
  onSelect: () => void;
};

export function CommandCompanyRow({ company, onSelect }: CommandCompanyRowProps) {
  return (
    <CommandItem
      value={`${company.name} ${company.domain ?? ""} ${company.id}`}
      onSelect={onSelect}
      className={cn(COMMAND_TABLE_GRID, "text-foreground h-11 gap-x-4")}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="bg-muted caption-style text-soft flex size-6 shrink-0 items-center justify-center rounded-md shadow-[0px_0px_0px_1px_#232323]">
          {company.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">{company.name}</span>
      </span>
      <span className="text-soft hidden truncate md:block">{company.domain ?? "—"}</span>
      <span className="hidden md:block">
        <Tag tone={LIFECYCLE_TONE[company.lifecycle]} size="sm">
          {LIFECYCLE_LABELS[company.lifecycle]}
        </Tag>
      </span>
      <span className="text-soft text-right tabular-nums">{formatDate(company.updatedAt)}</span>
    </CommandItem>
  );
}
