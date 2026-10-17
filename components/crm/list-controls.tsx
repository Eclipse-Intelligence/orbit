"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import type { SortOrder } from "@/lib/sorting";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import FilterIcon from "@/public/assets/images/_common/filter.svg";

export function useListParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
}

export function SortHeader({
  label,
  direction,
  onSort,
  className,
}: {
  label: string;
  direction: SortOrder | null;
  onSort: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSort}
      aria-label={`Sort by ${label}${direction ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
      className={cn(
        "group/sort -mx-1 -my-0.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 ease-power3-out outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        direction && "text-foreground",
        className,
      )}
    >
      {label}
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-[transform,opacity] duration-200 ease-power3-out",
          direction === "asc" && "rotate-180",
          !direction && "opacity-35 group-hover/sort:opacity-80 group-focus-visible/sort:opacity-80",
        )}
      />
    </button>
  );
}

export type PresenceField<T extends string> = { key: T; label: string; has: string; missing: string };

type PresenceState = "any" | "has" | "missing";

export function PresenceFilter<T extends string>({
  fields,
  has,
  missing,
  onChange,
  shortcut,
  className,
}: {
  fields: PresenceField<T>[];
  has: T[];
  missing: T[];
  onChange: (has: T[], missing: T[]) => void;
  shortcut?: string;
  className?: string;
}) {
  const active = has.length + missing.length;

  function set(field: T, state: PresenceState) {
    const nextHas = has.filter((item) => item !== field);
    const nextMissing = missing.filter((item) => item !== field);
    if (state === "has") nextHas.push(field);
    if (state === "missing") nextMissing.push(field);
    onChange(nextHas, nextMissing);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="none"
          data-shortcut={shortcut}
          title={shortcut === "filter" ? "Filter (F)" : undefined}
          className={cn("h-[30px] gap-1.5 px-[9px] text-[12px] data-[state=open]:bg-muted", className)}
        >
          <FilterIcon aria-hidden className="size-3" />
          Filter
          {active > 0 && <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[11px] leading-4 tabular-nums">{active}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-2">
        <ul className="flex flex-col gap-1">
          {fields.map((field) => {
            const state: PresenceState = has.includes(field.key) ? "has" : missing.includes(field.key) ? "missing" : "any";
            const options: { value: PresenceState; label: string }[] = [
              { value: "any", label: "Any" },
              { value: "has", label: field.has },
              { value: "missing", label: field.missing },
            ];
            return (
              <li key={field.key} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
                <span className="caption-style text-soft">{field.label}</span>
                <span role="radiogroup" aria-label={field.label} className="flex items-center rounded-full bg-white/[0.04] p-0.5">
                  {options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={state === option.value}
                      onClick={() => set(field.key, option.value)}
                      className={cn(
                        "caption-style cursor-pointer rounded-full px-2.5 py-1 whitespace-nowrap transition-colors duration-150 ease-power3-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        state === option.value ? "bg-muted text-foreground shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]" : "text-subtle hover:text-foreground",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
        {active > 0 && (
          <div className="border-border mt-1 flex justify-end border-t px-1 pt-2">
            <Button variant="ghost" size="sm" onClick={() => onChange([], [])}>
              Clear filters
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
