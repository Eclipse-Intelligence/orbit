"use client";

import { useState } from "react";
import { usePhone } from "@/components/ai-fields/answer-detail";
import AiFieldDialog from "@/components/ai-fields/field-dialog";
import type { AiField, CompanyView } from "@/lib/ai-fields/types";
import SectionHeader from "@/components/crm/section-header";
import CompaniesToolbar from "./toolbar/toolbar";
import CompaniesTable from "./table/companies-table";
import { RememberList } from "@/components/crm/list-memory";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { activeFilterCount } from "@/lib/companies";
import type { Viewer } from "@/components/crm/viewer";
import type { Company, CompanyListQuery, LifecycleCount, Member, TagCount } from "@/lib/crm/types";


type CompaniesProps = {
  companies: Company[];
  total: number;
  page: number;
  now: number;
  filters: CompanyListQuery;
  members: Member[];
  tags: TagCount[];
  lifecycles: LifecycleCount[];
  viewer: Viewer;
  mailboxConnected: boolean;
  enrichment: { company: boolean; logoClientId: string | null; fit?: boolean };
  aiFields?: AiField[];
  hiddenAiFields?: string[];
  views?: CompanyView[];
};

export default function Companies({
  companies,
  total,
  page,
  now,
  filters,
  members,
  tags,
  lifecycles,
  viewer,
  mailboxConnected,
  enrichment,
  aiFields = [],
  hiddenAiFields = [],
  views = [],
}: CompaniesProps) {
  const selection = useBulkSelection(
    companies.map((company) => company.id),
    JSON.stringify(filters),
  );
  const phone = usePhone();
  const canManage = viewer.role === "owner" || viewer.role === "admin";
  const visible = aiFields.filter((field) => !hiddenAiFields.includes(field.id));
  const hidden = aiFields.filter((field) => hiddenAiFields.includes(field.id));
  const [dialog, setDialog] = useState<{ open: boolean; field: AiField | null }>({ open: false, field: null });
  const [filterField, setFilterField] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <section id="companies" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RememberList list="companies" />
      <SectionHeader title="Companies" viewer={viewer} />
      <CompaniesToolbar
        filters={filters}
        members={members}
        tags={tags}
        lifecycles={lifecycles}
        selection={selection}
        fit={Boolean(enrichment.fit)}
        aiFields={aiFields}
        views={views}
        canManage={canManage}
        total={total}
        filterField={filterField}
        onFilterFieldChange={setFilterField}
        mobileOpen={mobileOpen}
        onMobileOpenChange={setMobileOpen}
      />
      <CompaniesTable
        companies={companies}
        total={total}
        page={page}
        now={now}
        filtered={activeFilterCount(filters) > 0}
        filters={filters}
        selection={selection}
        mailboxConnected={mailboxConnected}
        tags={tags}
        enrichment={enrichment}
        aiFields={visible}
        hiddenFields={hidden}
        canManage={canManage}
        onAddField={() => setDialog({ open: true, field: null })}
        onEditField={(field) => setDialog({ open: true, field })}
        onFilterField={(field) => {
          if (phone) setMobileOpen(true);
          else setFilterField(field.id);
        }}
      />
      {canManage && (
        <AiFieldDialog
          key={dialog.field?.id ?? "new"}
          open={dialog.open}
          onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
          field={dialog.field}
          views={views}
        />
      )}
    </section>
  );
}
