"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import CompanyFields, {
  type CompanyFormValues,
} from "@/components/companies/company-fields";
import DetailSection from "./detail-section";
import { updateCompanyAction } from "@/app/(crm)/actions";
import type { CompanyActionState } from "@/app/(crm)/actions";
import type { Company, Member } from "@/lib/crm/types";

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

export default function CompanyEditor({
  company,
  members,
  onSaved,
  onCancel,
}: {
  company: Company;
  members: Member[];
  onSaved: (company: Company) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(() => valuesFromCompany(company));
  const [state, action, pending] = useActionState(
    updateCompanyAction,
    {} as CompanyActionState,
  );
  const saved = useRef<string | null>(null);

  useEffect(() => {
    if (!state.company) return;
    const key = `${state.company.id}:${state.company.updatedAt}`;
    if (saved.current === key) return;
    saved.current = key;
    onSaved(state.company);
  }, [state.company, onSaved]);

  const fieldErrors =
    state.field && state.error
      ? ({ [state.field]: state.error } as Partial<
          Record<keyof CompanyFormValues, string>
        >)
      : undefined;
  const banner = state.field ? undefined : state.error;

  return (
    <form action={action} className="flex flex-col">
      <input type="hidden" name="id" value={company.id} />
      <DetailSection title="Edit company" className="gap-4">
        {banner && (
          <p role="alert" className="caption-style text-danger">
            {banner}
          </p>
        )}
        <CompanyFields
          idPrefix={`company-${company.id}`}
          values={values}
          members={members}
          onChange={setValues}
          errors={fieldErrors}
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="subtle"
            size="sm"
            type="button"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DetailSection>
    </form>
  );
}
