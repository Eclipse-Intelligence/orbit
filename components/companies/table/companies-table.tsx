"use client";

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
import {
  TABLE_CELL_CLASS,
  TABLE_COLUMNS,
  TABLE_GRID_CLASS,
  TABLE_ROW_CLASS,
} from "./table-columns";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";

export default function CompaniesTable({
  companies,
  total,
  filtered,
}: {
  companies: Company[];
  total: number;
  filtered: boolean;
}) {
  const selectedIds = useCompaniesStore((state) => state.selectedIds);
  const detailId = useCompaniesStore((state) => state.detailId);
  const detailOpen = useCompaniesStore((state) => state.detailOpen);
  const toggleSelected = useCompaniesStore((state) => state.toggleSelected);
  const setSelected = useCompaniesStore((state) => state.setSelected);
  const openDetail = useCompaniesStore((state) => state.openDetail);

  const selectedVisible = companies.filter((company) =>
    selectedIds.includes(company.id),
  );
  const allSelected =
    companies.length > 0 && selectedVisible.length === companies.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;

  function toggleAll() {
    setSelected(allSelected ? [] : companies.map((company) => company.id));
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
                    <span className="flex items-center gap-5">
                      <Checkbox
                        checked={
                          allSelected ? true : someSelected ? "indeterminate" : false
                        }
                        onCheckedChange={toggleAll}
                        aria-label="Select all companies"
                      />
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
            {companies.map((company) => (
              <CompanyRow
                key={company.id}
                company={company}
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
      <TableFooter count={companies.length} total={total} />
    </div>
  );
}
