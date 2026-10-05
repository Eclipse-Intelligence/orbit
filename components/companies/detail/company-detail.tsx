"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import CompanyFields, { type CompanyFormValues } from "@/components/companies/company-fields";
import DetailSection from "./detail-section";
import { archiveCompanyAction, updateCompanyAction } from "@/app/(crm)/actions";
import type { CompanyActionState } from "@/app/(crm)/actions";
import { formatDate } from "@/lib/companies";
import type { Company, Member } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import BuildingIcon from "@/public/assets/images/companies/detail/building.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

type CompanyDetailProps = {
  companies: Company[];
  members: Member[];
  onSaved: (company: Company) => void;
  onArchived: (id: string) => void;
};

function valuesFromCompany(company: Company): CompanyFormValues {
  return {
    name: company.name,
    domain: company.domain ?? "",
    website: company.website ?? "",
    industry: company.industry ?? "",
    sizeCategory: company.sizeCategory ?? "",
    lifecycle: company.lifecycle,
    ownerId: company.ownerId ?? "unassigned",
    source: company.source ?? "",
    description: company.description ?? "",
  };
}

export default function CompanyDetail({
  companies,
  members,
  onSaved,
  onArchived,
}: CompanyDetailProps) {
  const detailId = useCompaniesStore((state) => state.detailId);
  const detailOpen = useCompaniesStore((state) => state.detailOpen);
  const detailCompany = useCompaniesStore((state) => state.detailCompany);
  const closeDetail = useCompaniesStore((state) => state.closeDetail);
  const listed = companies.find((item) => item.id === detailId);
  const company = listed ?? (detailCompany?.id === detailId ? detailCompany : undefined);

  return (
    <Sheet open={detailOpen && company !== undefined} onOpenChange={(open) => !open && closeDetail()}>
      <SheetContent side="right" className="sm:w-[560px] sm:max-w-[560px]">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <BuildingIcon aria-hidden className="text-icon size-3.5" />
            <SheetTitle>Company</SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Edit the company record
          </SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1" aria-label="Close details">
              <XIcon aria-hidden className="text-foreground size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>
        {company && (
          <CompanyEditor
            key={company.id}
            company={company}
            members={members}
            onSaved={onSaved}
            onArchived={onArchived}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CompanyEditor({
  company,
  members,
  onSaved,
  onArchived,
}: {
  company: Company;
  members: Member[];
  onSaved: (company: Company) => void;
  onArchived: (id: string) => void;
}) {
  const router = useRouter();
  const closeDetail = useCompaniesStore((state) => state.closeDetail);
  const [values, setValues] = useState(() => valuesFromCompany(company));
  const [state, action, pending] = useActionState(updateCompanyAction, {} as CompanyActionState);
  const saved = useRef<string | null>(null);
  const [archiveState, setArchiveState] = useState<CompanyActionState>({});
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!state.company) return;
    const key = `${state.company.id}:${state.company.updatedAt}`;
    if (saved.current === key) return;
    saved.current = key;
    onSaved(state.company);
    closeDetail();
    router.refresh();
  }, [state.company, onSaved, closeDetail, router]);

  async function archive() {
    setArchiving(true);
    const result = await archiveCompanyAction(company.id);
    setArchiving(false);
    if (result.error) {
      setArchiveState(result);
      return;
    }
    onArchived(company.id);
    closeDetail();
    router.refresh();
  }

  const fieldErrors =
    state.field && state.error
      ? ({ [state.field]: state.error } as Partial<Record<keyof CompanyFormValues, string>>)
      : undefined;
  const banner = archiveState.error ?? (state.field ? undefined : state.error);

  return (
    <form action={action} className="flex min-h-0 flex-1 flex-col">
      <input type="hidden" name="id" value={company.id} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex items-start gap-3 p-5 shadow-[inset_0_-1px_0_var(--line-strong)]">
          <span className="bg-muted flex size-[50px] shrink-0 items-center justify-center rounded-[12.5px] shadow-[0px_6.25px_6.25px_0px_rgba(15,15,15,0.24),0px_0px_0px_1.563px_#232323]">
            <span className="h2-style text-soft">{company.name.slice(0, 1).toUpperCase()}</span>
          </span>
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="truncate">{company.name}</h2>
            <span className="caption-style text-soft block">
              Updated {formatDate(company.updatedAt)}
            </span>
          </div>
        </div>

        {banner && (
          <p role="alert" className="caption-style text-danger px-5 pt-4">
            {banner}
          </p>
        )}

        <DetailSection title="Record" className="gap-4">
          <CompanyFields
            idPrefix={`company-${company.id}`}
            values={values}
            members={members}
            onChange={setValues}
            errors={fieldErrors}
          />
        </DetailSection>

        <DetailSection title="Relationship" className="shadow-none">
          <p className="caption-style text-subtle">
            Contacts, conversations, opportunities, and next actions are not available yet.
            This record keeps the company so those can attach later.
          </p>
        </DetailSection>
      </ScrollArea>

      <SheetFooter>
        {confirmArchive ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="text-danger hover:text-danger"
            onClick={archive}
            disabled={archiving || pending}
          >
            {archiving ? "Archiving…" : "Archive company"}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setConfirmArchive(true)}
            disabled={pending}
          >
            Archive
          </Button>
        )}
        <div className="flex items-center gap-2">
          <SheetClose asChild>
            <Button variant="subtle" size="sm">
              Cancel
            </Button>
          </SheetClose>
          <Button variant="primary" size="sm" type="submit" disabled={pending || archiving}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </SheetFooter>
    </form>
  );
}
