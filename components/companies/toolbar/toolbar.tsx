"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import FilterMenu from "@/components/_common/filter-menu";
import MobileFilters from "./mobile-filters";
import { exportCompaniesAction } from "@/app/(crm)/actions";
import {
  ACTIVITY_OPTIONS,
  ALL_OWNERS,
  ANY_ACTIVITY,
  ANY_HEALTH,
  ANY_LIFECYCLE,
  HEALTH_OPTIONS,
  QUIET_ACTIVITY,
  UNASSIGNED_OWNER,
} from "@/lib/companies";
import { SelectToggle } from "@/components/crm/bulk-bar";
import { PresenceFilter, type FilterChoice, type PresenceField } from "@/components/crm/list-controls";
import { ANY_TAG, tagFilterOptions } from "@/components/crm/tags";
import RecordTransfer from "@/components/crm/record-transfer";
import ListSearch from "@/components/shortcuts/list-search";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import { downloadCsv } from "@/lib/csv";
import type { CompanyListQuery, CompanyPresence, LifecycleCount, Member, TagCount } from "@/lib/crm/types";
import ViewMenu, { useDropEditedView } from "@/components/ai-fields/view-menu";
import { AiFilterChip } from "@/components/ai-fields/ai-filters";
import { aiFilterValue, aiParamKey, type AiFilter } from "@/lib/ai-fields/params";
import type { AiField, CompanyView } from "@/lib/ai-fields/types";
import ShareIcon from "@/public/assets/images/companies/toolbar/share.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const PRESENCE_FIELDS: PresenceField<CompanyPresence>[] = [
  { key: "domain", label: "Domain", has: "Has domain", missing: "No domain" },
  { key: "contacts", label: "People", has: "Has people", missing: "No people" },
  { key: "interactions", label: "Interactions", has: "Contacted", missing: "Never contacted" },
];

type ToolbarProps = {
  filters: CompanyListQuery;
  members?: Member[];
  tags?: TagCount[];
  lifecycles?: LifecycleCount[];
  selection: BulkSelection;
  fit?: boolean;
  aiFields?: AiField[];
  views?: CompanyView[];
  canManage?: boolean;
  total?: number;
  filterField?: string | null;
  onFilterFieldChange?: (fieldId: string | null) => void;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
};

export default function CompaniesToolbar({
  filters,
  members = [],
  tags = [],
  lifecycles = [],
  fit = false,
  selection,
  aiFields = [],
  views = [],
  canManage = false,
  total = 0,
  filterField = null,
  onFilterFieldChange,
  mobileOpen,
  onMobileOpenChange,
}: ToolbarProps) {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  useDropEditedView(views, canManage);

  const searchParams = useSearchParams();
  const pending = useRef<string | null>(null);
  useEffect(() => {
    pending.current = null;
  }, [searchParams]);

  const replaceParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(pending.current ?? window.location.search);
      params.delete("page");
      for (const [key, value] of Object.entries(updates)) {
        if (!value) params.delete(key);
        else params.set(key, value);
      }
      const next = params.toString();
      pending.current = next;
      router.replace(next ? `/?${next}` : "/", { scroll: false });
    },
    [router],
  );

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

  const activity: FilterChoice = {
    key: "activity",
    label: "Activity",
    options: ACTIVITY_OPTIONS,
    value: filters.quiet ? QUIET_ACTIVITY : ANY_ACTIVITY,
    empty: ANY_ACTIVITY,
    onChange: (value) => replaceParams({ quiet: value === QUIET_ACTIVITY ? "true" : null }),
  };
  const clearPresence = () => replaceParams({ has: null, missing: null, quiet: null });
  const tagOptions = tagFilterOptions(tags, "company", filters.tag);
  const lifecycleOptions = [
    { value: ANY_LIFECYCLE, label: "Any lifecycle" },
    ...lifecycles.filter((item) => item.builtIn || item.companies > 0).map((item) => ({ value: item.value, label: item.label })),
  ];
  const ownerOptions = [
    { value: ALL_OWNERS, label: "All owners" },
    { value: UNASSIGNED_OWNER, label: "Unassigned" },
    ...members.map((member) => ({ value: member.id, label: member.name })),
  ];

  const setAiFilter = (field: AiField, filter: AiFilter | null) => replaceParams({ [aiParamKey(field.id)]: filter ? aiFilterValue(filter) : null });
  const chipFields = aiFields.filter((field) => field.id === filterField || filters.ai?.some((filter) => filter.fieldId === field.id));
  const sortedBy = filters.aiSort ? aiFields.find((field) => field.id === filters.aiSort) : null;

  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 py-4">
    <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap sm:items-start">
      <div className="flex items-center gap-2 sm:hidden">
        <MobileFilters
          filters={filters}
          members={members}
          tagOptions={tagOptions}
          lifecycleOptions={lifecycleOptions}
          fit={fit}
          onChange={replaceParams}
          aiFields={aiFields}
          views={views}
          canManage={canManage}
          total={total}
          open={mobileOpen}
          onOpenChange={onMobileOpenChange}
        />
        <PresenceFilter
          fields={PRESENCE_FIELDS}
          has={filters.has ?? []}
          missing={filters.missing ?? []}
          onChange={(has, missing) => replaceParams({ has: has.join(",") || null, missing: missing.join(",") || null })}
          choices={[activity]}
          onClear={clearPresence}
        />
      </div>

      <div className="hidden min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex">
        {(views.length > 0 || canManage) && <ViewMenu views={views} canManage={canManage} />}
        <ListSearch noun="companies" />
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
          options={lifecycleOptions}
          onChange={(value) =>
            replaceParams({ lifecycle: value === ANY_LIFECYCLE ? null : value })
          }
        />
        <FilterMenu
          label="Health"
          value={filters.health ?? ANY_HEALTH}
          options={HEALTH_OPTIONS}
          onChange={(value) => replaceParams({ health: value === ANY_HEALTH ? null : value })}
        />
        {tagOptions.length > 1 && (
          <FilterMenu
            label="Tag"
            value={filters.tag ?? ANY_TAG}
            options={tagOptions}
            onChange={(value) => replaceParams({ tag: value === ANY_TAG ? null : value })}
          />
        )}
        <PresenceFilter
          fields={PRESENCE_FIELDS}
          shortcut="filter"
          has={filters.has ?? []}
          missing={filters.missing ?? []}
          onChange={(has, missing) => replaceParams({ has: has.join(",") || null, missing: missing.join(",") || null })}
          choices={[activity]}
          onClear={clearPresence}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <SelectToggle selection={selection} />
        <RecordTransfer resource="companies" mode="import" />
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={exporting} data-shortcut="export">
          <ShareIcon aria-hidden className="size-3" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const input = document.getElementById("inline-add-company");
            input?.scrollIntoView({ block: "center" });
            input?.focus();
          }}
          data-shortcut="add-record"
          title="Add company (C then O)"
          shortcut={["C", "O"]}
        >
          <PlusIcon aria-hidden className="size-3" />
          Add company
        </Button>
      </div>
    </div>
      {(chipFields.length > 0 || sortedBy) && (
        <div className="flex flex-wrap items-center gap-2 max-sm:hidden">
          {chipFields.map((field) => (
            <AiFilterChip
              key={field.id}
              field={field}
              filter={filters.ai?.find((filter) => filter.fieldId === field.id)}
              open={filterField === field.id}
              onOpenChange={(open) => onFilterFieldChange?.(open ? field.id : null)}
              onChange={(filter) => setAiFilter(field, filter)}
            />
          ))}
          {sortedBy && (
            <span className="caption-style text-subtle">
              Sorted by {sortedBy.label}, {filters.order === "asc" ? "low to high" : "high to low"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
