"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import FilterMenu from "@/components/_common/filter-menu";
import MobileFilters from "./mobile-filters";
import { exportCompaniesAction } from "@/app/(crm)/actions";
import {
  ALL_OWNERS,
  ANY_HEALTH,
  ANY_LIFECYCLE,
  HEALTH_OPTIONS,
  UNASSIGNED_OWNER,
} from "@/lib/companies";
import { SelectToggle } from "@/components/crm/bulk-bar";
import { PresenceFilter, type PresenceField } from "@/components/crm/list-controls";
import { ANY_TAG, tagFilterOptions } from "@/components/crm/tags";
import RecordTransfer from "@/components/crm/record-transfer";
import ListSearch from "@/components/shortcuts/list-search";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import { downloadCsv } from "@/lib/csv";
import type { CompanyListQuery, CompanyPresence, LifecycleCount, Member, TagCount } from "@/lib/crm/types";
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
};

export default function CompaniesToolbar({
  filters,
  members = [],
  tags = [],
  lifecycles = [],
  fit = false,
  selection,
}: ToolbarProps) {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);

  const replaceParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      params.delete("page");
      for (const [key, value] of Object.entries(updates)) {
        if (!value) params.delete(key);
        else params.set(key, value);
      }
      const next = params.toString();
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

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-4">
      <div className="flex items-center gap-2 sm:hidden">
        <MobileFilters filters={filters} members={members} tagOptions={tagOptions} lifecycleOptions={lifecycleOptions} fit={fit} onChange={replaceParams} />
        <PresenceFilter
          fields={PRESENCE_FIELDS}
          has={filters.has ?? []}
          missing={filters.missing ?? []}
          onChange={(has, missing) => replaceParams({ has: has.join(",") || null, missing: missing.join(",") || null })}
        />
      </div>

      <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex">
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
  );
}
