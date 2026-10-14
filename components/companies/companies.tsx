"use client";

import CompaniesHeader from "./header/header";
import CompaniesToolbar from "./toolbar/toolbar";
import CompaniesTable from "./table/companies-table";
import NewCompanyDialog from "./new-company/new-company-dialog";
import { RememberList } from "@/components/crm/list-memory";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { activeFilterCount } from "@/lib/companies";
import type { Viewer } from "@/components/crm/viewer";
import type { Company, CompanyListQuery, Member, TagCount } from "@/lib/crm/types";

export type { Viewer };

type CompaniesProps = {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filters: CompanyListQuery;
  members: Member[];
  tags: TagCount[];
  viewer: Viewer;
  mailboxConnected: boolean;
};

export default function Companies({
  companies,
  total,
  page,
  now,
  filters,
  members,
  tags,
  viewer,
  mailboxConnected,
}: CompaniesProps) {
  const selection = useBulkSelection(
    companies.map((company) => company.id),
    JSON.stringify(filters),
  );

  return (
    <section id="companies" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RememberList list="companies" />
      <CompaniesHeader viewer={viewer} />
      <CompaniesToolbar
        filters={filters}
        members={members}
        tags={tags}
        selection={selection}
      />
      <CompaniesTable
        companies={companies}
        total={total}
        page={page}
        now={now}
        filtered={activeFilterCount(filters) > 0}
        selection={selection}
        mailboxConnected={mailboxConnected}
        tags={tags}
      />
      <NewCompanyDialog members={members} viewerId={viewer.id} />
    </section>
  );
}
