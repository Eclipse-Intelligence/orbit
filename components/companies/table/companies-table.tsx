"use client";

import { useState } from "react";
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
  gridTemplate,
  TABLE_CELL_CLASS,
  TABLE_GRID_CLASS,
  tableColumns,
  TABLE_ROW_CLASS,
} from "./table-columns";
import { AddColumnMenu, AiColumnHeader } from "@/components/ai-fields/column-menu";
import { aiSortValue } from "@/lib/ai-fields/params";
import type { AiField } from "@/lib/ai-fields/types";
import {
  archiveCompaniesAction,
  companyRecipientsAction,
  exportSelectedCompaniesAction,
  unarchiveCompaniesAction,
} from "@/app/(crm)/bulk";
import { bulkAddTagAction, bulkRemoveTagAction } from "@/app/(crm)/tags";
import type { BulkSelection } from "@/hooks/use-bulk-selection";
import { SortHeader, useListParams } from "@/components/crm/list-controls";
import { type Company, type CompanyListQuery, type CompanySort, type TagCount } from "@/lib/crm/types";
import { activeFilterCount } from "@/lib/companies";
import { DEFAULT_COMPANY_SORT, defaultCompanyOrder, nextSort } from "@/lib/sorting";
import { cn } from "@/lib/utils";
import type { WorkspaceRef } from "@/lib/crm/workspaces";

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
  moveTargets = [],
  workspaceName = "",
  tags,
  filters,
  enrichment,
  aiFields = [],
  hiddenFields = [],
  canManage = false,
  onAddField,
  onEditField,
  onFilterField,
}: {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filtered: boolean;
  selection: BulkSelection;
  mailboxConnected: boolean;
  moveTargets?: WorkspaceRef[];
  workspaceName?: string;
  tags: TagCount[];
  filters: CompanyListQuery;
  enrichment: { company: boolean; logoClientId: string | null; fit?: boolean };
  aiFields?: AiField[];
  hiddenFields?: AiField[];
  canManage?: boolean;
  onAddField?: () => void;
  onEditField?: (field: AiField) => void;
  onFilterField?: (field: AiField) => void;
}) {
  const replaceParams = useListParams();
  const [columnMessage, setColumnMessage] = useState<{ text: string; error: boolean } | null>(null);
  const setColumnError = (text: string | null) => setColumnMessage(text ? { text, error: true } : null);
  const addColumn = (canManage && aiFields.length > 0) || hiddenFields.length > 0;
  const columns = tableColumns(Boolean(enrichment.fit), aiFields, addColumn);
  const findDetails: BulkExtraAction = {
    key: "find-details",
    label: "Find details",
    run: async (ids, progress) => {
      const results = await enrichCompaniesInBatches(ids, (done) => progress(`Looking up ${done}/${ids.length}`));
      return companyEnrichSummary(results);
    },
  };
  const current = { sort: filters.sort ?? DEFAULT_COMPANY_SORT, order: filters.order ?? defaultCompanyOrder(filters.sort ?? DEFAULT_COMPANY_SORT) };
  const sortBy = (column: CompanySort) =>
    replaceParams(
      nextSort(column, filters.aiSort ? { sort: "" as CompanySort, order: current.order } : current, { sort: DEFAULT_COMPANY_SORT, order: defaultCompanyOrder }),
    );
  const header = (key: string, label: string) => {
    const column = SORTABLE[key];
    if (!column) return label;
    return <SortHeader label={label} direction={!filters.aiSort && current.sort === column ? current.order : null} onSort={() => sortBy(column)} />;
  };
  const aiHeader = (field: AiField) => (
    <AiColumnHeader
      field={field}
      direction={filters.aiSort === field.id ? (filters.order === "asc" ? "asc" : "desc") : null}
      canManage={canManage}
      onSort={(order) => replaceParams({ sort: aiSortValue(field.id), order })}
      onFilter={() => onFilterField?.(field)}
      onEdit={() => onEditField?.(field)}
      onAdd={() => onAddField?.()}
      onError={setColumnError}
      onNotice={(text) => setColumnMessage({ text, error: false })}
    />
  );
  return (
    <div className="border-border flex min-h-0 flex-1 flex-col border-t">
      {columnMessage && (
        <p role={columnMessage.error ? "alert" : "status"} className={cn("caption-style px-4 py-2", columnMessage.error ? "text-danger" : "text-subtle")}>
          {columnMessage.text}
        </p>
      )}
      <ScrollArea orientation="both" className="min-h-0 flex-1">
        <KeyboardList sequence>
        <Table role="table" className={cn(TABLE_GRID_CLASS, "w-full pb-24")} style={gridTemplate(columns.length)}>
          <TableHeader role="rowgroup" className="contents">
            <TableRow role="row" className={cn(TABLE_ROW_CLASS, "group")}>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  role="columnheader"
                  className={cn(TABLE_CELL_CLASS, column.className)}
                >
                  {column.key === "add" ? (
                    <AddColumnMenu canManage={canManage} hidden={hiddenFields} onAdd={() => onAddField?.()} onError={setColumnError} />
                  ) : column.aiFieldId ? (
                    aiHeader(aiFields.find((field) => field.id === column.aiFieldId)!)
                  ) : column.key === "name" ? (
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
                aiFields={aiFields}
                canManage={canManage}
                addColumn={addColumn}
              />
            ))}
            {companies.length === 0 && (
              <TableRow role="row" className={TABLE_ROW_CLASS}>
                <td
                  role="cell"
                  className="caption-style text-muted-foreground col-span-full flex h-[120px] items-center justify-center"
                >
                  {filters.quiet && activeFilterCount(filters) === 1
                    ? "No quiet companies"
                    : filtered
                      ? "No matches"
                      : "No companies"}
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
        emailLabel="Email contacts"
        recipients={companyRecipientsAction}
        mailboxConnected={mailboxConnected}
        extraActions={enrichment.company ? [findDetails] : []}
        move={{ kind: "company", workspaces: moveTargets, currentWorkspace: workspaceName }}
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
