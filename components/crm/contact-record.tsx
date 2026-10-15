"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import ContactActivities from "@/components/crm/contact-activities";
import ContactEditor from "@/components/crm/contact-editor";
import { contactRecipient } from "@/lib/crm/personalise";
import InviteDialog, { InviteNotice } from "@/components/crm/invite-dialog";
import MeetingsCard from "@/components/crm/meetings-card";
import { useQuickAddRecord } from "@/components/crm/quick-add";
import RecordLayout from "@/components/crm/record-layout";
import { CallLink, Detail, DetailList } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import RecordTags from "@/components/crm/tags";
import type { Viewer } from "@/components/crm/viewer";
import type { MeetingsSummary } from "@/lib/crm/calendar";
import type { InviteSetup } from "@/lib/crm/invites";
import { companyHref } from "@/lib/crm/hrefs";
import type {
  Activity,
  CallInsight,
  Company,
  Contact,
  Member,
  TagCount,
  Task,
} from "@/lib/crm/types";
import { ClickUpBadge } from "@/components/crm/clickup";
import { formatWhen } from "@/lib/companies";
import { teamsCallUrl } from "@/lib/phone";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";

export default function ContactRecord({
  viewer,
  contact,
  companies,
  members,
  mailboxConnected,
  activities,
  insights,
  meetings,
  tasks,
  tags,
  invite,
}: {
  viewer: Viewer;
  contact: Contact;
  companies: Pick<Company, "id" | "name">[];
  members: Member[];
  mailboxConnected: boolean;
  activities: Activity[];
  insights: Record<string, CallInsight>;
  meetings: MeetingsSummary | null;
  tasks: Task[];
  tags: TagCount[];
  invite: InviteSetup;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [fresh, setFresh] = useState<Contact | null>(null);
  const [invitingAt, setInvitingAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const shown =
    fresh && fresh.id === contact.id && fresh.updatedAt > contact.updatedAt
      ? fresh
      : contact;
  const callUrl = teamsCallUrl(shown.phone);
  const owner = members.find((member) => member.id === shown.ownerId);
  useQuickAddRecord({
    type: "contact",
    id: shown.id,
    name: shown.name,
    company:
      shown.companyId && shown.companyName
        ? { id: shown.companyId, name: shown.companyName }
        : null,
  });

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
            <span
              title={
                shown.email
                  ? undefined
                  : `Add an email address to invite ${shown.name} to a meeting`
              }
            >
              <Button
                variant="secondary"
                size="icon"
                aria-label="Invite to a meeting"
                title={shown.email ? "Invite to a meeting" : undefined}
                disabled={!shown.email}
                onClick={() => setInvitingAt(Date.now())}
              >
                <CalendarIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
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
              <Button
                variant="primary"
                size="sm"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )}
          </div>
        }
      />
      {shown.email && (
        <InviteDialog
          open={invitingAt !== null}
          onOpenChange={(open) => !open && setInvitingAt(null)}
          setup={invite}
          prefill={{
            guests: [
              {
                email: shown.email,
                name: shown.name,
                contactId: shown.id,
                company: shown.companyName,
              },
            ],
          }}
          now={invitingAt ?? 0}
          onSent={setNotice}
        />
      )}
      <InviteNotice message={notice} onDone={clearNotice} />
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
                        href={
                          shown.companyId
                            ? companyHref(shown.companyId)
                            : undefined
                        }
                      />
                    )}
                  </div>
                )}
                <RecordTags
                  kind="contact"
                  id={shown.id}
                  tags={shown.tags}
                  suggestions={tags}
                />
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
                      <a
                        href={`mailto:${shown.email}`}
                        className="hover:underline"
                      >
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
                  <Detail label="Owner">
                    {owner?.name ?? shown.ownerName}
                  </Detail>
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
            <DetailSection
              title="Tasks"
              className="shadow-[inset_0_1px_0_var(--line-strong)]"
            >
              {tasks.length === 0 ? (
                <p className="caption-style text-subtle">No open tasks.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {tasks.map((task) => (
                    <li key={task.id} className="flex flex-col gap-1">
                      <span className="text-[14px] leading-5">
                        {task.title}
                      </span>
                      <span className="caption-style text-subtle flex flex-wrap items-center gap-2">
                        {task.dueAt
                          ? `Due ${formatWhen(task.dueAt)}`
                          : "No due date"}
                        <ClickUpBadge task={task} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
            <MeetingsCard
              meetings={meetings}
              className="shadow-[inset_0_1px_0_var(--line-strong)]"
            />
          </>
        }
        activity={
          <ContactActivities
            contactId={shown.id}
            email={shown.email}
            recipient={contactRecipient(shown)}
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
