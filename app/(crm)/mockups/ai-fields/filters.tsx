"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import FilterMenu from "@/components/_common/filter-menu";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import { AiMark } from "./ai-cells";

const VIEWS = [
  { value: "all", label: "All companies" },
  { value: "geo", label: "GEO prospects" },
  { value: "customers", label: "Customers" },
];

export function ViewMenu({ value, phone = false }: { value: string; phone?: boolean }) {
  const id = useId();
  if (phone) {
    return (
      <Field label="View" htmlFor={id}>
        <NativeSelect id={id} defaultValue={value}>
          {VIEWS.map((view) => (
            <option key={view.value} value={view.value}>
              {view.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    );
  }
  return <FilterMenu label="View" value={value} options={[...VIEWS, { value: "save", label: "Save current filters as a view…" }]} onChange={() => undefined} />;
}

export function SortField() {
  const id = useId();
  return (
    <Field label="Sort by" htmlFor={id}>
      <NativeSelect id={id} defaultValue="staff-asc">
        <option value="name">Name A to Z</option>
        <option value="fit">Best ICP fit</option>
        <option value="staff-asc">Staff, low to high</option>
        <option value="staff-desc">Staff, high to low</option>
      </NativeSelect>
    </Field>
  );
}

export function AiFilterChip({ label, value, open = false }: { label: string; value: string; open?: boolean }) {
  return (
    <Button
      variant="secondary"
      size="none"
      aria-label={`${label}: ${value}. Change`}
      aria-expanded={open}
      className={cn("group h-[30px] gap-0 overflow-hidden text-[12px]", open && "bg-muted")}
    >
      <span className="text-subtle flex items-center gap-1 px-[9px] font-normal">
        <AiMark />
        {label}
      </span>
      <span aria-hidden className="h-full w-px bg-white/8" />
      <span className="flex items-center gap-1.5 px-[9px]">
        {value}
        <ChevronDownIcon aria-hidden className={cn("size-3 text-[#898b8d]", open && "rotate-180")} />
      </span>
    </Button>
  );
}

function Segmented({ label, options, value }: { label: string; options: string[]; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
      <span className="caption-style text-soft flex items-center gap-1">
        <AiMark />
        {label}
      </span>
      <span role="radiogroup" aria-label={label} className="flex items-center rounded-full bg-white/[0.04] p-0.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={cn(
              "caption-style cursor-pointer rounded-full px-2.5 py-1 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              value === option ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
            )}
          >
            {option}
          </button>
        ))}
      </span>
    </div>
  );
}

export function GeoFilter() {
  return <Segmented label="Sells GEO" options={["Any", "Yes", "No", "Unknown"]} value="Yes" />;
}

export function StaffRange({ compact = false }: { compact?: boolean }) {
  const from = useId();
  const to = useId();
  const unknown = useId();
  return (
    <div className="flex flex-col gap-3">
      <span className={cn("flex items-center gap-1", compact ? "caption-style text-soft" : "ui-style text-foreground")}>
        <AiMark />
        Staff
      </span>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <label htmlFor={from} className="sr-only">
          From
        </label>
        <Input id={from} inputMode="numeric" defaultValue="5" />
        <span className="caption-style text-subtle">to</span>
        <label htmlFor={to} className="sr-only">
          To
        </label>
        <Input id={to} inputMode="numeric" defaultValue="30" />
      </div>
      <label htmlFor={unknown} className="caption-style text-soft flex items-center gap-2">
        <Checkbox id={unknown} />
        Include Unknown
      </label>
      {!compact && (
        <div className="border-border flex justify-between gap-2 border-t pt-3">
          <Button variant="ghost" size="sm">
            Remove filter
          </Button>
          <Button variant="secondary" size="sm">
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

export function AgencyTypeFilter() {
  const options = [
    { label: "SEO", on: true },
    { label: "PR", on: false },
    { label: "Content", on: true },
    { label: "Other", on: false },
    { label: "Unknown", on: false },
  ];
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5">
      <span className="caption-style text-soft flex items-center gap-1">
        <AiMark />
        Agency type
      </span>
      <div role="group" aria-label="Agency type" className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={option.on}
            className={cn(
              "caption-style h-7 cursor-pointer rounded-full px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              option.on ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.1)]" : "text-subtle bg-white/[0.04]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
