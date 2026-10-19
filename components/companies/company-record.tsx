"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Asset from "@/components/_ui/asset";
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
import { useQuickAddRecord } from "@/components/crm/quick-add";
import RecordLayout from "@/components/crm/record-layout";
import { Detail, DetailList } from "@/components/crm/record-form";
import CompanyEnrichButton from "@/components/companies/detail/company-enrich-button";
import CompanyLogo from "@/components/companies/company-logo";
import { QuickLinks, SocialLinks, employeesLabel, sectorLabel } from "@/components/companies/detail/company-brand";
import RunWorkflowButton from "@/components/workflows/run-workflow-button";
import SectionHeader from "@/components/crm/section-header";
import RecordSequence from "@/components/shortcuts/record-sequence";
import RecordTags from "@/components/crm/tags";
import type { Viewer } from "@/components/crm/viewer";
import { archiveCompanyAction } from "@/app/(crm)/actions";
import { formatDate, LIFECYCLE_LABELS } from "@/lib/companies";
import CompanyHealth from "@/components/companies/detail/company-health";
import type { MeetingsSummary } from "@/lib/crm/calendar";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { Company, CompanyContext, Member, TagCount } from "@/lib/crm/types";
import type { EnrichmentAvailability } from "@/lib/enrichment/settings";
import { cn } from "@/lib/utils";

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
  enrichment,
  workflows = [],
}: {
  viewer: Viewer;
  context: CompanyContext;
  members: Member[];
  mailboxConnected: boolean;
  clickup: ClickUpPicker | null;
  meetings: MeetingsSummary | null;
  tags: TagCount[];
  enrichment: EnrichmentAvailability;
  workflows?: { id: string; name: string }[];
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
  useQuickAddRecord({ type: "company", id: company.id, name: company.name });
  const brandColor = company.brand?.colors[0] ?? null;

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
      <RecordSequence />
      <SectionHeader
        title={company.name}
        viewer={viewer}
        list="companies"
        action={
          <div className="flex items-center gap-1">
            {!company.archivedAt && <RunWorkflowButton object="company" recordId={company.id} workflows={workflows} />}
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
                  autoFocus
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
                data-shortcut="archive"
                title="Archive (Delete)"
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
                data-shortcut="edit"
                title="Edit (E)"
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
            <div
              style={brandColor ? ({ "--brand": brandColor } as CSSProperties) : undefined}
              className={cn(
                "relative flex flex-col shadow-[inset_0_-1px_0_var(--line-strong)]",
                brandColor && "bg-[linear-gradient(160deg,color-mix(in_srgb,var(--brand)_26%,transparent)_0%,transparent_55%)]",
              )}
            >
              {company.brand?.backdropUrl && (
                <Asset
                  type="image"
                  src={company.brand.backdropUrl}
                  alt=""
                  width={4}
                  height={1}
                  sizes="(min-width: 1024px) 480px, 100vw"
                  unoptimized
                  className="h-20 w-full opacity-70 [mask-image:linear-gradient(to_bottom,black,transparent)]"
                />
              )}
              <div className="flex items-start gap-3 p-5">
              <span className="bg-muted flex size-[50px] shrink-0 items-center justify-center overflow-hidden rounded-[12.5px] shadow-[0px_6.25px_6.25px_0px_rgba(15,15,15,0.24),0px_0px_0px_1.563px_#232323]">
                <CompanyLogo
                  company={company}
                  clientId={enrichment.logoClientId}
                  sizes="50px"
                  className="size-full rounded-none outline-0"
                  fallback={
                    <span aria-hidden className="h2-style text-soft">
                      {company.name.slice(0, 1).toUpperCase()}
                    </span>
                  }
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <h2 className="truncate leading-6">{company.name}</h2>
                {company.brand?.slogan && <p className="caption-style text-soft leading-[1.4]">{company.brand.slogan}</p>}
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
                <SocialLinks socials={company.brand?.socials ?? []} fallbackLinkedin={company.linkedinUrl} />
                <RecordTags
                  kind="company"
                  id={company.id}
                  tags={company.tags}
                  suggestions={tags}
                />
              </div>
              </div>
            </div>

            {archiveError && (
              <p role="alert" className="caption-style text-danger px-5 pt-4">
                {archiveError}
              </p>
            )}

            <CompanyHealth company={company} />

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
                  {company.brand && company.brand.industries.length > 0 && (
                    <Detail label="Sectors">{sectorLabel(company.brand.industries)}</Detail>
                  )}
                  <Detail label="Size">{company.sizeCategory}</Detail>
                  {company.brand?.employees && <Detail label="Employees">{employeesLabel(company.brand.employees)}</Detail>}
                  <Detail label="LinkedIn">
                    {company.linkedinUrl ? (
                      <a href={company.linkedinUrl} target="_blank" rel="noreferrer" className="block truncate hover:underline">
                        {bareUrl(company.linkedinUrl)}
                      </a>
                    ) : null}
                  </Detail>
                  <Detail label="Phone">{company.phone}</Detail>
                  {company.brand?.email && (
                    <Detail label="Email">
                      <a href={`mailto:${company.brand.email}`} className="block truncate hover:underline">
                        {company.brand.email}
                      </a>
                    </Detail>
                  )}
                  <Detail label="Address">{company.address}</Detail>
                  {company.brand?.stock && (
                    <Detail label="Stock">{[company.brand.stock.ticker, company.brand.stock.exchange].filter(Boolean).join(" · ")}</Detail>
                  )}
                  {company.brand && Object.keys(company.brand.links).length > 0 && (
                    <Detail label="Links">
                      <QuickLinks links={company.brand.links} />
                    </Detail>
                  )}
                  <Detail label="Owner">{company.ownerName ?? "Unassigned"}</Detail>
                  <Detail label="Source">{company.source}</Detail>
                </DetailList>
                {enrichment.company && (company.domain || company.website) && !company.archivedAt && (
                  <CompanyEnrichButton companyId={company.id} enrichedAt={company.enrichedAt} />
                )}
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

            <RelationshipPanel context={context} clickup={clickup} findEmail={enrichment.email} />
          </>
        }
        activity={
          <CompanyActivity
            companyId={company.id}
            companyName={company.name}
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
