"use client";

import { useId, useState } from "react";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { AiMark } from "@/components/ai-fields/ai-cells";
import type { AiFilter } from "@/lib/ai-fields/params";
import type { AiField } from "@/lib/ai-fields/types";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

function number(value: number) {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

export function aiFilterSummary(filter: AiFilter | undefined) {
  if (!filter) return "Any";
  if (filter.op === "is") return filter.value === "yes" ? "Yes" : filter.value === "no" ? "No" : "Unknown";
  if (filter.op === "has") return `Contains “${filter.text}”`;
  const tail = filter.unknown ? ["Unknown"] : [];
  if (filter.op === "range") {
    const range =
      filter.min !== null && filter.max !== null
        ? `${number(filter.min)} to ${number(filter.max)}`
        : filter.min !== null
          ? `${number(filter.min)} or more`
          : filter.max !== null
            ? `Up to ${number(filter.max)}`
            : null;
    return [range, ...tail].filter(Boolean).join(" or ");
  }
  return [...filter.options, ...tail].join(", ");
}

function Segmented({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) {
  return (
    <span role="radiogroup" aria-label={label} className="flex w-fit items-center rounded-full bg-white/[0.04] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "caption-style cursor-pointer rounded-full px-2.5 py-1 whitespace-nowrap transition-colors duration-150 ease-power3-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            value === option.value ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

function Pills({ label, options, selected, onToggle }: { label: string; options: string[]; selected: string[]; onToggle: (option: string) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(option)}
            className={cn(
              "caption-style h-7 cursor-pointer rounded-full px-3 transition-colors duration-150 ease-power3-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              on ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.1)]" : "text-subtle bg-white/[0.04] hover:text-foreground",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function parseNumber(text: string) {
  const clean = text.replace(/[,\s]/g, "");
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

function FieldLabel({ field, compact }: { field: AiField; compact: boolean }) {
  return (
    <span className={cn("flex items-center gap-1", compact ? "caption-style text-soft" : "ui-style text-foreground")}>
      <AiMark />
      {field.label}
    </span>
  );
}

export function AiFilterEditor({ field, filter, onChange, compact = false }: { field: AiField; filter: AiFilter | undefined; onChange: (filter: AiFilter | null) => void; compact?: boolean }) {
  const id = useId();
  const range = filter?.op === "range" ? filter : null;
  const [from, setFrom] = useState(range?.min === null || range?.min === undefined ? "" : String(range.min));
  const [to, setTo] = useState(range?.max === null || range?.max === undefined ? "" : String(range.max));
  const [unknown, setUnknown] = useState(filter?.op === "range" || filter?.op === "any" ? filter.unknown : false);
  const [text, setText] = useState(filter?.op === "has" ? filter.text : "");

  if (field.kind === "yes_no") {
    const value = filter?.op === "is" ? filter.value : "any";
    return (
      <div className={cn("flex items-center justify-between gap-3", compact && "px-2 py-1.5")}>
        <FieldLabel field={field} compact />
        <Segmented
          label={field.label}
          value={value}
          options={[
            { value: "any", label: "Any" },
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
            { value: "unknown", label: "Unknown" },
          ]}
          onChange={(next) => onChange(next === "any" ? null : { fieldId: field.id, op: "is", value: next as "yes" | "no" | "unknown" })}
        />
      </div>
    );
  }

  if (field.kind === "number") {
    const apply = (nextFrom = from, nextTo = to, nextUnknown = unknown) => {
      const min = parseNumber(nextFrom);
      const max = parseNumber(nextTo);
      if (min === null && max === null && !nextUnknown) onChange(null);
      else onChange({ fieldId: field.id, op: "range", min, max, unknown: nextUnknown });
    };
    return (
      <div className={cn("flex flex-col gap-3", compact && "px-2 py-1.5")}>
        <FieldLabel field={field} compact={compact} />
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <label htmlFor={`${id}-from`} className="sr-only">
            {field.label} from
          </label>
          <Input
            id={`${id}-from`}
            inputMode="decimal"
            value={from}
            placeholder="From"
            onChange={(event) => setFrom(event.target.value)}
            onBlur={() => apply()}
            onKeyDown={(event) => {
              if (event.key === "Enter") apply();
            }}
          />
          <span className="caption-style text-subtle">to</span>
          <label htmlFor={`${id}-to`} className="sr-only">
            {field.label} to
          </label>
          <Input
            id={`${id}-to`}
            inputMode="decimal"
            value={to}
            placeholder="To"
            onChange={(event) => setTo(event.target.value)}
            onBlur={() => apply()}
            onKeyDown={(event) => {
              if (event.key === "Enter") apply();
            }}
          />
        </div>
        <label htmlFor={`${id}-unknown`} className="caption-style text-soft flex items-center gap-2">
          <Checkbox
            id={`${id}-unknown`}
            checked={unknown}
            onCheckedChange={(checked) => {
              setUnknown(checked === true);
              apply(from, to, checked === true);
            }}
          />
          Include Unknown
        </label>
      </div>
    );
  }

  if (field.kind === "text") {
    const apply = (value = text) => {
      const clean = value.trim();
      onChange(clean ? { fieldId: field.id, op: "has", text: clean } : null);
    };
    return (
      <div className={cn("flex flex-col gap-2", compact && "px-2 py-1.5")}>
        <label htmlFor={`${id}-text`} className={cn("flex items-center gap-1", compact ? "caption-style text-soft" : "ui-style text-foreground")}>
          <AiMark />
          {field.label} contains
        </label>
        <Input
          id={`${id}-text`}
          value={text}
          maxLength={100}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => apply()}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
      </div>
    );
  }

  const selected = filter?.op === "any" ? [...filter.options, ...(filter.unknown ? ["Unknown"] : [])] : [];
  return (
    <div className={cn("flex flex-col gap-2", compact && "px-2 py-1.5")}>
      <FieldLabel field={field} compact />
      <Pills
        label={field.label}
        options={[...field.options, "Unknown"]}
        selected={selected}
        onToggle={(option) => {
          const next = selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option];
          const options = next.filter((item) => item !== "Unknown");
          const withUnknown = next.includes("Unknown");
          onChange(options.length === 0 && !withUnknown ? null : { fieldId: field.id, op: "any", options, unknown: withUnknown });
        }}
      />
    </div>
  );
}

export function AiFilterChip({
  field,
  filter,
  open,
  onOpenChange,
  onChange,
}: {
  field: AiField;
  filter: AiFilter | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (filter: AiFilter | null) => void;
}) {
  const value = aiFilterSummary(filter);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="none" aria-label={`${field.label}: ${value}. Change`} className="group h-[30px] max-w-[22rem] gap-0 overflow-hidden text-[12px] data-[state=open]:bg-muted">
          <span className="text-subtle flex shrink-0 items-center gap-1 px-[9px] font-normal">
            <AiMark />
            {field.label}
          </span>
          <span aria-hidden className="h-full w-px shrink-0 bg-white/8" />
          <span className="flex min-w-0 items-center gap-1.5 px-[9px]">
            <span className="truncate">{value}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-[#898b8d] transition-transform duration-200 ease-power3-out group-data-[state=open]:rotate-180" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(18rem,calc(100vw-2rem))] p-3">
        <div className="flex flex-col gap-3">
          <AiFilterEditor field={field} filter={filter} onChange={onChange} />
          <div className="border-border flex justify-between gap-2 border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange(null);
                onOpenChange(false);
              }}
            >
              Remove filter
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
