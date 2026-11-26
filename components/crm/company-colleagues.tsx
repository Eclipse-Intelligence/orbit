"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import DetailSection from "@/components/companies/detail/detail-section";
import { contactHref } from "@/lib/crm/hrefs";
import type { Contact } from "@/lib/crm/types";

const SHOWN = 8;

export default function CompanyColleagues({
  companyName,
  colleagues,
  className,
}: {
  companyName: string;
  colleagues: Pick<Contact, "id" | "name" | "jobTitle" | "email">[];
  className?: string;
}) {
  const [all, setAll] = useState(false);
  if (colleagues.length === 0) return null;
  const shown = all ? colleagues : colleagues.slice(0, SHOWN);
  const hidden = colleagues.length - shown.length;

  return (
    <DetailSection title={`Others at ${companyName}`} className={className}>
      <ul className="flex flex-col gap-3">
        {shown.map((colleague) => (
          <li key={colleague.id} className="flex min-w-0 flex-col gap-1">
            <Link
              href={contactHref(colleague.id)}
              className="hit hover:text-soft self-start text-[14px] leading-5 underline-offset-2 [overflow-wrap:anywhere] hover:underline"
            >
              {colleague.name}
            </Link>
            {(colleague.jobTitle || colleague.email) && (
              <span className="caption-style text-subtle [overflow-wrap:anywhere]">
                {colleague.jobTitle ?? colleague.email}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll(true)}>
          Show all {colleagues.length}
        </Button>
      )}
    </DetailSection>
  );
}
