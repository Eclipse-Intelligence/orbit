"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import FilterMenu from "@/components/_common/filter-menu";
import { Input } from "@/components/_ui/input";
import MobileFilters from "./mobile-filters";
import { exportCompaniesAction } from "@/app/(crm)/actions";
import {
  ALL_OWNERS,
  ANY_LIFECYCLE,
  LIFECYCLE_LABELS,
  SORT_OPTIONS,
  UNASSIGNED_OWNER,
  parseSortValue,
  sortValue,
} from "@/lib/companies";
import RecordTransfer from "@/components/crm/record-transfer";
import { downloadCsv } from "@/lib/csv";
import type { CompanyListQuery, Member } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import ShareIcon from "@/public/assets/images/companies/toolbar/share.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type ToolbarProps = {
  filters: CompanyListQuery;
  members?: Member[];
};

export default function CompaniesToolbar({ filters, members = [] }: ToolbarProps) {
  const router = useRouter();
  const setNewCompanyOpen = useCompaniesStore((state) => state.setNewCompanyOpen);
  const filterQuery = filters.query ?? "";
  const [query, setQuery] = useState(filterQuery);
  const [syncedQuery, setSyncedQuery] = useState(filterQuery);
  const [exporting, setExporting] = useState(false);
  if (filterQuery !== syncedQuery) {
    setSyncedQuery(filterQuery);
    setQuery(filterQuery);
  }

  const replaceParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(updates)) {
        if (!value) params.delete(key);
        else params.set(key, value);
      }
      const next = params.toString();
      router.replace(next ? `/?${next}` : "/", { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const current = filters.query ?? "";
      if (query.trim() === current) return;
      replaceParams({ q: query.trim() || null });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, filters.query, replaceParams]);

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = await exportCompaniesAction(filters);
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(`companies-${day}.csv`, rows);
    } finally {
      setExporting(false);
    }
  }

  const ownerOptions = [
    { value: ALL_OWNERS, label: "All owners" },
    { value: UNASSIGNED_OWNER, label: "Unassigned" },
    ...members.map((member) => ({ value: member.id, label: member.name })),
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-4">
      <MobileFilters
        className="sm:hidden"
        filters={filters}
        members={members}
        onChange={replaceParams}
      />

      <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex">
        <label className="sr-only" htmlFor="company-search">
          Search companies
        </label>
        <Input
          id="company-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or domain"
          className="w-[220px]"
        />
        <FilterMenu
          label="Sort by"
          value={sortValue(filters.sort, filters.order)}
          options={SORT_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(value) => {
            const next = parseSortValue(value);
            replaceParams({
              sort: next.sort === "updated" ? null : next.sort,
              order: next.order === "desc" ? null : next.order,
            });
          }}
        />
        <FilterMenu
          label="Owner"
          value={filters.ownerId ?? ALL_OWNERS}
          options={ownerOptions}
          onChange={(value) =>
            replaceParams({ owner: value === ALL_OWNERS ? null : value })
          }
        />
        <FilterMenu
          label="Lifecycle"
          value={filters.lifecycle ?? ANY_LIFECYCLE}
          options={[
            { value: ANY_LIFECYCLE, label: "Any lifecycle" },
            ...Object.entries(LIFECYCLE_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
          onChange={(value) =>
            replaceParams({ lifecycle: value === ANY_LIFECYCLE ? null : value })
          }
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <RecordTransfer resource="companies" mode="import" />
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exporting}>
          <ShareIcon aria-hidden className="size-3" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
        <Button variant="primary" size="sm" onClick={() => setNewCompanyOpen(true)}>
          <PlusIcon aria-hidden className="size-3" />
          New Company
        </Button>
      </div>
    </div>
  );
}
