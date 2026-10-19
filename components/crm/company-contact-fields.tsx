"use client";

import { useState, type ReactNode } from "react";
import RecordPicker, {
  type PickedRecord,
} from "@/components/crm/record-picker";

export default function CompanyContactFields({
  idPrefix,
  initialCompany,
  initialContact,
  contactLabel,
  onCompanyChange,
  children,
}: {
  idPrefix: string;
  initialCompany: PickedRecord | null;
  initialContact: PickedRecord | null;
  contactLabel: string;
  onCompanyChange?: (company: PickedRecord | null) => void;
  children?: ReactNode;
}) {
  const [company, setCompany] = useState<PickedRecord | null>(initialCompany);
  const [contact, setContact] = useState<PickedRecord | null>(initialContact);

  function chooseCompany(next: PickedRecord | null) {
    setCompany(next);
    onCompanyChange?.(next);
    if (contact && contact.company?.id !== next?.id) setContact(null);
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-2">
        <label
          className="caption-style text-subtle"
          htmlFor={`${idPrefix}-company`}
        >
          Company
        </label>
        <input type="hidden" name="companyId" value={company?.id ?? ""} />
        <RecordPicker
          id={`${idPrefix}-company`}
          kind="company"
          value={company}
          onChange={chooseCompany}
          placeholder="Choose a company"
        />
      </div>
      {children}
      <div className="flex min-w-0 flex-col gap-2">
        <label
          className="caption-style text-subtle"
          htmlFor={`${idPrefix}-contact`}
        >
          {contactLabel}
        </label>
        <input
          type="hidden"
          name="primaryContactId"
          value={contact?.id ?? "none"}
        />
        <RecordPicker
          id={`${idPrefix}-contact`}
          kind="contact"
          value={contact}
          onChange={(next) => {
            setContact(next);
            if (next?.company && next.company.id !== company?.id) {
              setCompany(next.company);
              onCompanyChange?.(next.company);
            }
          }}
          placeholder={
            company ? `Choose someone at ${company.name}` : "Choose a contact"
          }
          companyId={company?.id ?? null}
        />
      </div>
    </>
  );
}
