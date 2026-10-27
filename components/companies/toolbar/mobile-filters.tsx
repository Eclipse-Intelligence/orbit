"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import CountBadge from "@/components/_ui/count-badge";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/_ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import {
  ALL_OWNERS,
  ANY_HEALTH,
  ANY_LIFECYCLE,
  HEALTH_OPTIONS,
  SORT_OPTIONS,
  UNASSIGNED_OWNER,
  activeFilterCount,
  sortValue,
} from "@/lib/companies";
import { ANY_TAG } from "@/components/crm/tags";
import { DEFAULT_COMPANY_SORT, defaultCompanyOrder } from "@/lib/sorting";
import type { FilterOption } from "@/components/_common/filter-menu";
import type { CompanyListQuery, Member } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import FilterIcon from "@/public/assets/images/_common/filter.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

type MobileFiltersProps = {
  className?: string;
  filters: CompanyListQuery;
  members: Member[];
  tagOptions: FilterOption[];
  lifecycleOptions: FilterOption[];
  fit?: boolean;
  onChange: (updates: Record<string, string | null>) => void;
};

export default function MobileFilters({
  className,
  filters,
  members,
  tagOptions,
  lifecycleOptions,
  fit = false,
  onChange,
}: MobileFiltersProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(filters.query ?? "");
  const activeCount = activeFilterCount(filters);

  function applySearch() {
    onChange({ q: query.trim() || null });
  }

  function reset() {
    setQuery("");
    onChange({
      q: null,
      owner: null,
      lifecycle: null,
      health: null,
      tag: null,
      sort: null,
      order: null,
      has: null,
      missing: null,
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        className={cn("data-[active=true]:bg-muted", className)}
        data-active={activeCount > 0}
      >
        <FilterIcon aria-hidden className="size-3" />
        Filters
        {activeCount > 0 && <CountBadge>{activeCount}</CountBadge>}
      </Button>

      <SheetContent side="bottom">
        <SheetHeader className="px-4">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription className="sr-only">
            Search, sort, and filter companies
          </SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close filters">
              <XIcon aria-hidden className="text-foreground size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <ScrollArea viewportClassName="max-h-[calc(85dvh-118px)]">
          <div className="flex flex-col gap-4 p-4">
            <Field label="Search" htmlFor="mobile-search">
              <Input
                id="mobile-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onBlur={applySearch}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applySearch();
                  }
                }}
                placeholder="Name or domain"
              />
            </Field>

            <Field label="Sort by" htmlFor="mobile-sort">
              <Select
                value={sortValue(filters.sort, filters.order)}
                onValueChange={(value) => {
                  const next = SORT_OPTIONS.find((option) => option.value === value);
                  onChange({
                    sort: !next || next.sort === DEFAULT_COMPANY_SORT ? null : next.sort,
                    order: !next || next.order === defaultCompanyOrder(next.sort) ? null : next.order,
                  });
                }}
              >
                <SelectTrigger id="mobile-sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.filter((option) => fit || option.sort !== "fit").map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Owner" htmlFor="mobile-owner">
              <Select
                value={filters.ownerId ?? ALL_OWNERS}
                onValueChange={(value) =>
                  onChange({ owner: value === ALL_OWNERS ? null : value })
                }
              >
                <SelectTrigger id="mobile-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_OWNERS}>All owners</SelectItem>
                  <SelectItem value={UNASSIGNED_OWNER}>Unassigned</SelectItem>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Lifecycle" htmlFor="mobile-lifecycle">
              <Select
                value={filters.lifecycle ?? ANY_LIFECYCLE}
                onValueChange={(value) =>
                  onChange({ lifecycle: value === ANY_LIFECYCLE ? null : value })
                }
              >
                <SelectTrigger id="mobile-lifecycle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lifecycleOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Health" htmlFor="mobile-health">
              <Select
                value={filters.health ?? ANY_HEALTH}
                onValueChange={(value) => onChange({ health: value === ANY_HEALTH ? null : value })}
              >
                <SelectTrigger id="mobile-health">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HEALTH_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {tagOptions.length > 1 && (
              <Field label="Tag" htmlFor="mobile-tag">
                <Select
                  value={filters.tag ?? ANY_TAG}
                  onValueChange={(value) => onChange({ tag: value === ANY_TAG ? null : value })}
                >
                  <SelectTrigger id="mobile-tag">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tagOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="px-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={activeCount === 0}
            className="-ml-1.5"
          >
            Reset
          </Button>
          <SheetClose asChild>
            <Button variant="primary" size="sm" onClick={applySearch}>
              Done
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
