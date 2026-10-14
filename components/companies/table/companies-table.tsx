"use client";

import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/_ui/table";
import BulkActions, { SelectAllCheckbox } from "@/components/crm/bulk-bar";
import CompanyRow from "./company-row";
import TableFooter from "./table-footer";
import { PAGE_SIZE } from "@/components/crm/paging";
import {
  TABLE_CELL_CLASS,
  TABLE_COLUMNS,
  TABLE_GRID_CLASS,
  TABLE_ROW_CLASS,
} from "./table-columns";
import {
  archiveCompaniesAction,
  companyRecipientsAction,
  exportSelectedCompaniesAction,
  unarchiveCompaniesAction,
} from "@/app/(crm)/bulk";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export default function CompaniesTable({
  companies,
  total,
  page,
  now,
  filtered,
  selection,
  mailboxConnected,
}: {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filtered: boolean;
  selection: BulkSelection;
  mailboxConnected: boolean;
}) {
  return (
    <div className="border-border flex min-h-0 flex-1 flex-col border-t">
      <ScrollArea orientation="both" className="min-h-0 flex-1">
        <Table role="table" className={cn(TABLE_GRID_CLASS, "w-full")}>
          <TableHeader role="rowgroup" className="contents">
            <TableRow role="row" className={cn(TABLE_ROW_CLASS, "group")}>
              {TABLE_COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  role="columnheader"
                  className={cn(TABLE_CELL_CLASS, column.className)}
                >
                  {column.key === "name" ? (
                    <span className="flex items-center gap-2">
                      <span className="flex size-6 items-center justify-center">
                        <SelectAllCheckbox
                          selection={selection}
                          label="Select all companies on this page"
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
                selected={selection.isSelected(company.id)}
                revealed={selection.revealed}
                selecting={selection.selecting}
                onToggle={(range) => selection.toggle(company.id, range)}
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
      <BulkActions
        selection={selection}
        noun={["company", "companies"]}
        archive={archiveCompaniesAction}
        unarchive={unarchiveCompaniesAction}
        exportRows={exportSelectedCompaniesAction}
        exportName="companies"
        emailLabel="Email people"
        recipients={companyRecipientsAction}
        mailboxConnected={mailboxConnected}
      />
      <TableFooter page={page} count={companies.length} total={total} />
    </div>
  );
}
