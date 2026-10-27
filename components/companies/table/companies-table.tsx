"use client";

import KeyboardList from "@/components/shortcuts/keyboard-list";
import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/_ui/table";
import BulkActions, { SelectAllCheckbox, type BulkExtraAction } from "@/components/crm/bulk-bar";
import { companyEnrichSummary, enrichCompaniesInBatches } from "@/components/companies/company-enrich";
import { CompanyAdder } from "@/components/crm/inline-adders";
import CompanyRow from "./company-row";
import TableFooter from "./table-footer";
import { PAGE_SIZE } from "@/components/crm/paging";
import {
  TABLE_CELL_CLASS,
  TABLE_GRID_CLASS,
  TABLE_GRID_FIT_CLASS,
  tableColumns,
  TABLE_ROW_CLASS,
} from "./table-columns";
import {
  archiveCompaniesAction,
  companyRecipientsAction,
  exportSelectedCompaniesAction,
  unarchiveCompaniesAction,
} from "@/app/(crm)/bulk";
import { bulkAddTagAction, bulkRemoveTagAction } from "@/app/(crm)/tags";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import { SortHeader, useListParams } from "@/components/crm/list-controls";
import type { Company, CompanyListQuery, CompanySort, TagCount } from "@/lib/crm/types";
import { DEFAULT_COMPANY_SORT, defaultCompanyOrder, nextSort } from "@/lib/sorting";
import { cn } from "@/lib/utils";

const SORTABLE: Record<string, CompanySort | undefined> = {
  name: "name",
  last: "interaction",
  strength: "strength",
  domain: "domain",
  owner: "owner",
  fit: "fit",
};

export default function CompaniesTable({
  companies,
  total,
  page,
  now,
  filtered,
  selection,
  mailboxConnected,
  tags,
  filters,
  enrichment,
}: {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filtered: boolean;
  selection: BulkSelection;
  mailboxConnected: boolean;
  tags: TagCount[];
  filters: CompanyListQuery;
  enrichment: { company: boolean; logoClientId: string | null; fit?: boolean };
}) {
  const replaceParams = useListParams();
  const findDetails: BulkExtraAction = {
    key: "find-details",
    label: "Find details",
    title: "Fill in logos, socials and details from context.dev",
    run: async (ids, progress) => {
      const results = await enrichCompaniesInBatches(ids, (done) => progress(`Looking up ${done}/${ids.length}`));
      return companyEnrichSummary(results);
    },
  };
  const current = { sort: filters.sort ?? DEFAULT_COMPANY_SORT, order: filters.order ?? defaultCompanyOrder(filters.sort ?? DEFAULT_COMPANY_SORT) };
  const sortBy = (column: CompanySort) =>
    replaceParams(nextSort(column, current, { sort: DEFAULT_COMPANY_SORT, order: defaultCompanyOrder }));
  const header = (key: string, label: string) => {
    const column = SORTABLE[key];
    if (!column) return label;
    return <SortHeader label={label} direction={current.sort === column ? current.order : null} onSort={() => sortBy(column)} />;
  };
  return (
    <div className="border-border flex min-h-0 flex-1 flex-col border-t">
      <ScrollArea orientation="both" className="min-h-0 flex-1">
        <KeyboardList sequence>
        <Table role="table" className={cn(enrichment.fit ? TABLE_GRID_FIT_CLASS : TABLE_GRID_CLASS, "w-full pb-24")}>
          <TableHeader role="rowgroup" className="contents">
            <TableRow role="row" className={cn(TABLE_ROW_CLASS, "group")}>
              {tableColumns(Boolean(enrichment.fit)).map((column) => (
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
                      {header(column.key, column.label)}
                    </span>
                  ) : (
                    header(column.key, column.label)
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
                logoClientId={enrichment.logoClientId}
                showFit={Boolean(enrichment.fit)}
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
            <TableRow role="row" className={TABLE_ROW_CLASS}>
              <td role="cell" className="col-span-full">
                <CompanyAdder className="sticky left-0 w-fit max-w-[100vw]" />
              </td>
            </TableRow>
          </TableBody>
        </Table>
        </KeyboardList>
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
        extraActions={enrichment.company ? [findDetails] : []}
        tagging={{
          tags,
          selectedTags: (ids) => [
            ...new Set(
              companies
                .filter((company) => ids.includes(company.id))
                .flatMap((company) => company.tags),
            ),
          ],
          add: (ids, name) => bulkAddTagAction("company", ids, name),
          remove: (ids, name) => bulkRemoveTagAction("company", ids, name),
        }}
      />
      <TableFooter page={page} count={companies.length} total={total} />
    </div>
  );
}
