"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  lifecycleTagBase,
  RecordTag,
} from "@/components/beautifui/record-marks";
import CompanyActivity from "@/components/companies/detail/company-activity";
import CompanyEditor from "@/components/companies/detail/company-editor";
import DetailSection from "@/components/companies/detail/detail-section";
import RelationshipPanel from "@/components/companies/detail/relationship-panel";
import { useListHref } from "@/components/crm/list-memory";
import MeetingsCard from "@/components/crm/meetings-card";
import RecordLayout from "@/components/crm/record-layout";
import { Detail, DetailList } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import RecordTags from "@/components/crm/tags";
import type { Viewer } from "@/components/crm/viewer";
import { archiveCompanyAction } from "@/app/(crm)/actions";
import { formatDate, LIFECYCLE_LABELS } from "@/lib/companies";
import type { MeetingsSummary } from "@/lib/crm/calendar";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { Company, CompanyContext, Member, TagCount } from "@/lib/crm/types";

function externalUrl(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function bareUrl(value: string) {
  return value.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

export default function CompanyRecord({
  viewer,
  context,
  members,
  mailboxConnected,
  clickup,
  meetings,
  tags,
}: {
  viewer: Viewer;
  context: CompanyContext;
  members: Member[];
  mailboxConnected: boolean;
  clickup: ClickUpPicker | null;
  meetings: MeetingsSummary | null;
  tags: TagCount[];
}) {
  const router = useRouter();
  const listHref = useListHref("companies");
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState<Company | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const company =
    fresh && fresh.id === context.company.id && fresh.updatedAt > context.company.updatedAt
      ? fresh
      : context.company;

  const saved = useCallback(
    (next: Company) => {
      setFresh(next);
      setEditing(false);
      router.refresh();
    },
    [router],
  );

  async function archive() {
    setArchiving(true);
    const result = await archiveCompanyAction(company.id);
    if (result.error) {
      setArchiving(false);
      setArchiveError(result.error);
      return;
    }
    router.push(listHref);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={company.name}
        viewer={viewer}
        list="companies"
        action={
          <div className="flex items-center gap-1">
            {company.archivedAt ? null : confirmArchive ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={archiving}
                  onClick={() => {
                    setConfirmArchive(false);
                    setArchiveError(null);
                  }}
                >
                  Keep
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger"
                  disabled={archiving}
                  onClick={archive}
                >
                  {archiving ? "Archiving…" : "Archive company"}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={editing}
                onClick={() => setConfirmArchive(true)}
              >
                Archive
              </Button>
            )}
            {!editing && (
              <Button
                variant="primary"
                size="sm"
                disabled={archiving}
                onClick={() => {
                  setConfirmArchive(false);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
          </div>
        }
      />
      <RecordLayout
        details={
          <>
            <div className="flex items-start gap-3 p-5 shadow-[inset_0_-1px_0_var(--line-strong)]">
              <span className="bg-muted flex size-[50px] shrink-0 items-center justify-center rounded-[12.5px] shadow-[0px_6.25px_6.25px_0px_rgba(15,15,15,0.24),0px_0px_0px_1.563px_#232323]">
                <span aria-hidden className="h2-style text-soft">
                  {company.name.slice(0, 1).toUpperCase()}
                </span>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <h2 className="truncate leading-6">{company.name}</h2>
                <span className="caption-style text-soft flex flex-wrap items-center gap-x-2 gap-y-1">
                  {company.domain && (
                    <a
                      href={externalUrl(company.domain)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-white/35 underline-offset-[3px] hover:decoration-current"
                    >
                      {company.domain}
                    </a>
                  )}
                  <span className="text-subtle">
                    {company.archivedAt
                      ? `Archived ${formatDate(company.archivedAt)}`
                      : `Updated ${formatDate(company.updatedAt)}`}
                  </span>
                </span>
                <RecordTags
                  kind="company"
                  id={company.id}
                  tags={company.tags}
                  suggestions={tags}
                />
              </div>
            </div>

            {archiveError && (
              <p role="alert" className="caption-style text-danger px-5 pt-4">
                {archiveError}
              </p>
            )}

            {editing ? (
              <CompanyEditor
                key={company.id}
                company={company}
                members={members}
                onSaved={saved}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <DetailSection title="Details">
                <DetailList>
                  <Detail label="Domain">{company.domain}</Detail>
                  <Detail label="Website">
                    {company.website ? (
                      <a
                        href={externalUrl(company.website)}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate hover:underline"
                      >
                        {bareUrl(company.website)}
                      </a>
                    ) : null}
                  </Detail>
                  <Detail label="Lifecycle">
                    <RecordTag
                      label={LIFECYCLE_LABELS[company.lifecycle]}
                      base={lifecycleTagBase(company.lifecycle)}
                    />
                  </Detail>
                  <Detail label="Industry">{company.industry}</Detail>
                  <Detail label="Size">{company.sizeCategory}</Detail>
                  <Detail label="Owner">{company.ownerName ?? "Unassigned"}</Detail>
                  <Detail label="Source">{company.source}</Detail>
                </DetailList>
                {company.description && (
                  <div className="flex flex-col gap-2">
                    <span className="caption-style text-subtle">Description</span>
                    <p className="text-[14px] leading-5 whitespace-pre-wrap">
                      {company.description}
                    </p>
                  </div>
                )}
              </DetailSection>
            )}

            <MeetingsCard meetings={meetings} />

            <RelationshipPanel context={context} clickup={clickup} />
          </>
        }
        activity={
          <CompanyActivity
            companyId={company.id}
            contacts={context.contacts}
            timeline={context.timeline}
            insights={context.insights}
            mailboxConnected={mailboxConnected}
            viewerId={viewer.id}
          />
        }
      />
    </section>
  );
}
