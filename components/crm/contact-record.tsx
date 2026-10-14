"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import ContactActivities from "@/components/crm/contact-activities";
import ContactEditor from "@/components/crm/contact-editor";
import RecordLayout from "@/components/crm/record-layout";
import { CallLink, Detail, DetailList } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { companyHref } from "@/lib/crm/hrefs";
import type { Activity, CallInsight, Company, Contact, Member } from "@/lib/crm/types";
import { teamsCallUrl } from "@/lib/phone";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";

export default function ContactRecord({
  viewer,
  contact,
  companies,
  members,
  mailboxConnected,
  activities,
  insights,
}: {
  viewer: Viewer;
  contact: Contact;
  companies: Pick<Company, "id" | "name">[];
  members: Member[];
  mailboxConnected: boolean;
  activities: Activity[];
  insights: Record<string, CallInsight>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState<Contact | null>(null);
  const shown =
    fresh && fresh.id === contact.id && fresh.updatedAt > contact.updatedAt
      ? fresh
      : contact;
  const callUrl = teamsCallUrl(shown.phone);
  const owner = members.find((member) => member.id === shown.ownerId);

  const saved = useCallback(
    (next: Contact | undefined) => {
      if (next) setFresh(next);
      setEditing(false);
      router.refresh();
    },
    [router],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={shown.name}
        viewer={viewer}
        list="contacts"
        action={
          <div className="flex items-center gap-1">
            {callUrl && (
              <a
                href={callUrl}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <PhoneIcon aria-hidden className="size-3" />
                Call in Teams
              </a>
            )}
            {!editing && (
              <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
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
              <Monogram
                name={shown.name}
                className="size-[50px] rounded-full text-[18px]"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <h2 className="truncate leading-6">{shown.name}</h2>
                {(shown.jobTitle || shown.companyName) && (
                  <div className="caption-style text-subtle flex flex-wrap items-center gap-1.5">
                    {shown.jobTitle && <span>{shown.jobTitle}</span>}
                    {shown.jobTitle && shown.companyName && <span>at</span>}
                    {shown.companyName && (
                      <EntityChip
                        name={shown.companyName}
                        href={shown.companyId ? companyHref(shown.companyId) : undefined}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
            {editing ? (
              <ContactEditor
                key={shown.id}
                editing={shown}
                companies={companies}
                members={members}
                onSaved={saved}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <DetailSection title="Details" className="gap-5 shadow-none">
                <DetailList>
                  <Detail label="Phone">
                    {shown.phone ? (
                      <span className="flex items-center gap-1">
                        <span>{shown.phone}</span>
                        <CallLink phone={shown.phone} className="-my-1" />
                      </span>
                    ) : null}
                  </Detail>
                  <Detail label="Email">
                    {shown.email ? (
                      <a href={`mailto:${shown.email}`} className="hover:underline">
                        {shown.email}
                      </a>
                    ) : null}
                  </Detail>
                  <Detail label="LinkedIn">
                    {shown.linkedinUrl ? (
                      <a
                        href={shown.linkedinUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate hover:underline"
                      >
                        {shown.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    ) : null}
                  </Detail>
                  <Detail label="Owner">{owner?.name ?? shown.ownerName}</Detail>
                  <Detail label="Source">{shown.source}</Detail>
                </DetailList>
                {shown.notes && (
                  <div className="flex flex-col gap-2">
                    <span className="caption-style text-subtle">Notes</span>
                    <p className="text-[14px] leading-5 whitespace-pre-wrap">
                      {shown.notes}
                    </p>
                  </div>
                )}
              </DetailSection>
            )}
          </>
        }
        activity={
          <ContactActivities
            contactId={shown.id}
            email={shown.email}
            mailboxConnected={mailboxConnected}
            viewerId={viewer.id}
            activities={activities}
            insights={insights}
            className="border-t-0 p-5"
          />
        }
      />
    </section>
  );
}
