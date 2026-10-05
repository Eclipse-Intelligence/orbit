"use client";

import { useEffect, useState } from "react";
import CompaniesHeader from "./header/header";
import CompaniesToolbar from "./toolbar/toolbar";
import CompaniesTable from "./table/companies-table";
import CompanyDetail from "./detail/company-detail";
import NewCompanyDialog from "./new-company/new-company-dialog";
import CommandMenu from "./command-menu/command-menu";
import { activeFilterCount } from "@/lib/companies";
import { useCompaniesStore } from "@/stores/companies-store";
import type { Viewer } from "@/components/crm/viewer";
import type { Company, CompanyContext, CompanyListQuery, Member } from "@/lib/crm/types";

export type { Viewer };

type CompaniesProps = {
  companies: Company[];
  total: number;
  filters: CompanyListQuery;
  members: Member[];
  viewer: Viewer;
  context: CompanyContext | null;
};

export default function Companies({
  companies,
  total,
  filters,
  members,
  viewer,
  context,
}: CompaniesProps) {
  const serverKey = companies.map((company) => `${company.id}:${company.updatedAt}`).join("|");
  const [overlay, setOverlay] = useState<{ key: string; rows: Company[] } | null>(null);
  const rows = overlay?.key === serverKey ? overlay.rows : companies;
  const openDetail = useCompaniesStore((state) => state.openDetail);
  const detailId = useCompaniesStore((state) => state.detailId);

  useEffect(() => {
    if (context && detailId !== context.company.id) openDetail(context.company.id);
  }, [context, detailId, openDetail]);

  function upsertLocal(company: Company) {
    const current = overlay?.key === serverKey ? overlay.rows : companies;
    setOverlay({
      key: serverKey,
      rows: [company, ...current.filter((item) => item.id !== company.id)],
    });
  }

  function removeLocal(id: string) {
    const current = overlay?.key === serverKey ? overlay.rows : companies;
    setOverlay({
      key: serverKey,
      rows: current.filter((item) => item.id !== id),
    });
  }

  return (
    <section id="companies" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CompaniesHeader viewer={viewer} />
      <CompaniesToolbar filters={filters} members={members} />
      <CompaniesTable
        companies={rows}
        total={total}
        filtered={activeFilterCount(filters) > 0}
      />
      <CompanyDetail
        companies={rows}
        members={members}
        context={context}
        onSaved={upsertLocal}
        onArchived={removeLocal}
      />
      <NewCompanyDialog members={members} viewerId={viewer.id} onCreated={upsertLocal} />
      <CommandMenu companies={rows} />
    </section>
  );
}
