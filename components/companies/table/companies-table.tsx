"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/_ui/table";
import CompanyRow from "./company-row";
import TableFooter from "./table-footer";
import { PAGE_SIZE } from "@/components/crm/paging";
import {
  TABLE_CELL_CLASS,
  TABLE_COLUMNS,
  TABLE_GRID_CLASS,
  TABLE_ROW_CLASS,
} from "./table-columns";
import { archiveCompanyAction } from "@/app/(crm)/actions";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";

export default function CompaniesTable({
  companies,
  total,
  page,
  now,
  filtered,
}: {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filtered: boolean;
}) {
  const selectedIds = useCompaniesStore((state) => state.selectedIds);
  const detailId = useCompaniesStore((state) => state.detailId);
  const detailOpen = useCompaniesStore((state) => state.detailOpen);
  const toggleSelected = useCompaniesStore((state) => state.toggleSelected);
  const setSelected = useCompaniesStore((state) => state.setSelected);
  const openDetail = useCompaniesStore((state) => state.openDetail);
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const selectedVisible = companies.filter((company) =>
    selectedIds.includes(company.id),
  );
  const allSelected =
    companies.length > 0 && selectedVisible.length === companies.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;

  function toggleAll() {
    setSelected(allSelected ? [] : companies.map((company) => company.id));
  }

  async function archiveSelected() {
    const ids = selectedVisible.map((company) => company.id);
    if (ids.length === 0) return;
    const label = ids.length === 1 ? "1 company" : `${ids.length} companies`;
    if (!window.confirm(`Archive ${label}?`)) return;
    setArchiving(true);
    setBulkError(null);
    const failed: string[] = [];
    let firstError: string | undefined;
    for (const id of ids) {
      const result = await archiveCompanyAction(id);
      if (result.error) {
        failed.push(id);
        firstError ??= result.error;
      }
    }
    setArchiving(false);
    setSelected(failed);
    if (firstError) {
      setBulkError(
        `${failed.length} of ${ids.length} could not be archived. ${firstError}`,
      );
    }
    router.refresh();
  }

  return (
    <div className="border-border flex min-h-0 flex-1 flex-col border-t">
      <ScrollArea orientation="both" className="min-h-0 flex-1">
        <Table role="table" className={cn(TABLE_GRID_CLASS, "w-full")}>
          <TableHeader role="rowgroup" className="contents">
            <TableRow role="row" className={TABLE_ROW_CLASS}>
              {TABLE_COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  role="columnheader"
                  className={cn(TABLE_CELL_CLASS, column.className)}
                >
                  {column.key === "name" ? (
                    <span className="flex items-center gap-2">
                      <span className="flex size-6 items-center justify-center">
                        <Checkbox
                          checked={
                            allSelected ? true : someSelected ? "indeterminate" : false
                          }
                          onCheckedChange={toggleAll}
                          aria-label="Select all companies"
                        />
                      </span>
                      {column.label}
                    </span>
                  ) : (
                    column.label
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody role="rowgroup" className="contents">
            {companies.map((company, index) => (
              <CompanyRow
                key={company.id}
                company={company}
                index={(page - 1) * PAGE_SIZE + index}
                now={now}
                selected={selectedIds.includes(company.id)}
                active={detailOpen && detailId === company.id}
                onToggle={() => toggleSelected(company.id)}
                onOpen={() => openDetail(company.id)}
              />
            ))}
            {companies.length === 0 && (
              <TableRow role="row" className={TABLE_ROW_CLASS}>
                <td
                  role="cell"
                  className="caption-style text-muted-foreground col-span-full flex h-[120px] items-center justify-center"
                >
                  {filtered
                    ? "No companies match the current filters."
                    : "No companies yet."}
                </td>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>
      {(selectedVisible.length > 0 || bulkError) && (
        <div className="caption-style border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-2">
          {bulkError ? (
            <span role="alert" className="text-danger">
              {bulkError}
            </span>
          ) : (
            <span className="text-foreground">
              {selectedVisible.length} selected
            </span>
          )}
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected([]);
                setBulkError(null);
              }}
              disabled={archiving}
            >
              Clear
            </Button>
            {selectedVisible.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={archiveSelected}
                disabled={archiving}
              >
                {archiving ? "Archiving…" : "Archive"}
              </Button>
            )}
          </span>
        </div>
      )}
      <TableFooter page={page} count={companies.length} total={total} />
    </div>
  );
}
