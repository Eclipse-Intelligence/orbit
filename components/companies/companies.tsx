"use client";

import { useEffect } from "react";
import CompaniesHeader from "./header/header";
import CompaniesToolbar from "./toolbar/toolbar";
import CompaniesTable from "./table/companies-table";
import NewCompanyDialog from "./new-company/new-company-dialog";
import { RememberList } from "@/components/crm/list-memory";
import { activeFilterCount } from "@/lib/companies";
import { useCompaniesStore } from "@/stores/companies-store";
import type { Viewer } from "@/components/crm/viewer";
import type { Company, CompanyListQuery, Member } from "@/lib/crm/types";

export type { Viewer };

type CompaniesProps = {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filters: CompanyListQuery;
  members: Member[];
  viewer: Viewer;
};

export default function Companies({
  companies,
  total,
  page,
  now,
  filters,
  members,
  viewer,
}: CompaniesProps) {
  const setSelected = useCompaniesStore((state) => state.setSelected);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    setSelected([]);
  }, [filterKey, setSelected]);

  return (
    <section id="companies" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RememberList list="companies" />
      <CompaniesHeader viewer={viewer} />
      <CompaniesToolbar filters={filters} members={members} />
      <CompaniesTable
        companies={companies}
        total={total}
        page={page}
        now={now}
        filtered={activeFilterCount(filters) > 0}
      />
      <NewCompanyDialog members={members} viewerId={viewer.id} />
    </section>
  );
}
