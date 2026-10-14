"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/_ui/dialog";
import CompanyFields, {
  emptyCompanyForm,
  type CompanyFormValues,
} from "@/components/companies/company-fields";
import FormSection from "./form-section";
import { createCompanyAction } from "@/app/(crm)/actions";
import type { CompanyActionState } from "@/app/(crm)/actions";
import { companyHref } from "@/lib/crm/hrefs";
import type { Member } from "@/lib/crm/types";
import { useCompaniesStore } from "@/stores/companies-store";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type NewCompanyDialogProps = {
  members: Member[];
  viewerId: string;
};

export default function NewCompanyDialog({
  members,
  viewerId,
}: NewCompanyDialogProps) {
  const open = useCompaniesStore((state) => state.newCompanyOpen);
  const setOpen = useCompaniesStore((state) => state.setNewCompanyOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[560px]">
        {open && (
          <NewCompanyForm members={members} viewerId={viewerId} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCompanyForm({ members, viewerId }: NewCompanyDialogProps) {
  const router = useRouter();
  const setOpen = useCompaniesStore((state) => state.setNewCompanyOpen);
  const saved = useRef(false);
  const [values, setValues] = useState<CompanyFormValues>(() => emptyCompanyForm(viewerId));
  const [state, action, pending] = useActionState(createCompanyAction, {} as CompanyActionState);

  useEffect(() => {
    if (!state.company || saved.current) return;
    saved.current = true;
    setOpen(false);
    router.push(companyHref(state.company.id));
  }, [state.company, setOpen, router]);

  const fieldErrors =
    state.field && state.error
      ? ({ [state.field]: state.error } as Partial<Record<keyof CompanyFormValues, string>>)
      : undefined;

  return (
    <form action={action} className="flex flex-col">
      <DialogHeader>
        <DialogTitle>New Company</DialogTitle>
        <DialogDescription>
          Add a company to this workspace. A matching domain updates the existing record
          instead of creating a duplicate when an agent submits it later.
        </DialogDescription>
      </DialogHeader>

      {state.error && !state.field && (
        <p role="alert" className="caption-style text-danger px-6 pt-4">
          {state.error}
        </p>
      )}

      <FormSection title="Company">
        <CompanyFields
          idPrefix="new-company"
          values={values}
          members={members}
          onChange={setValues}
          errors={fieldErrors}
        />
      </FormSection>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="subtle" size="sm">
            Cancel
          </Button>
        </DialogClose>
        <Button variant="primary" size="sm" type="submit" disabled={pending}>
          <PlusIcon aria-hidden className="size-3" />
          {pending ? "Creating…" : "Create Company"}
        </Button>
      </DialogFooter>
    </form>
  );
}
