"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import DetailSection from "@/components/companies/detail/detail-section";
import CreateProposalDialog from "@/components/proposals/create-proposal-dialog";
import { statusTag } from "@/components/proposals/status";
import type { DocumentSummary } from "@/lib/proposals/documents";

export default function ProposalsCard({
  documents,
  company,
  contactId,
  className,
}: {
  documents: DocumentSummary[];
  company: { id: string; name: string } | null;
  contactId?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DetailSection
      title="Proposals"
      className={className}
      action={
        company ? (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Create proposal
          </Button>
        ) : null
      }
    >
      {documents.length === 0 ? (
        <p className="caption-style text-subtle">{company ? "None yet." : "Link this contact to a company to send them a proposal."}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.slice(0, 6).map((item) => {
            const tag = statusTag(item.status);
            return (
              <li key={item.id} className="flex items-start gap-2">
                <Link href={item.href} className="flex min-w-0 flex-1 flex-col gap-0.5 hover:underline">
                  <span className="truncate text-[14px] leading-5">{item.title}</span>
                  <span className="caption-style text-subtle truncate">{[item.totalLabel, item.contactName].filter(Boolean).join(" · ")}</span>
                </Link>
                <Tag tone={tag.tone}>{tag.label}</Tag>
              </li>
            );
          })}
        </ul>
      )}
      {company && <CreateProposalDialog open={open} onOpenChange={setOpen} company={company} contactId={contactId ?? null} />}
    </DetailSection>
  );
}
