"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { ConnectionMark, EntityChip, Monogram } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import ContactActivities from "@/components/crm/contact-activities";
import ContactEditor from "@/components/crm/contact-editor";
import FindDetailButton from "@/components/crm/find-detail";
import CheckEmailButton from "@/components/crm/check-email";
import { contactRecipient } from "@/lib/crm/personalise";
import InviteDialog, { InviteNotice } from "@/components/crm/invite-dialog";
import MeetingsCard from "@/components/crm/meetings-card";
import ProposalsCard from "@/components/proposals/proposals-card";
import type { DocumentSummary } from "@/lib/proposals/documents";
import type { Relationship } from "@/lib/crm/relationship-score";
import { useQuickAddRecord } from "@/components/crm/quick-add";
import MergeRecordMenu from "@/components/crm/merge-record";
import RecordLayout from "@/components/crm/record-layout";
import { CallLink, DetailList } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import RunWorkflowButton from "@/components/workflows/run-workflow-button";
import RecordSequence from "@/components/shortcuts/record-sequence";
import InlineField from "@/components/crm/inline-field";
import { RelationshipError, RelationshipSelect, RelationshipSource, useRelationshipPicker } from "@/components/crm/relationship-picker";
import { patchContactAction } from "@/app/(crm)/records";
import ExternalIcon from "@/public/assets/images/booking/external.svg";
import RecordTags from "@/components/crm/tags";
import type { Viewer } from "@/components/crm/viewer";
import type { MeetingsSummary } from "@/lib/crm/calendar";
import type { InviteSetup } from "@/lib/crm/invites";
import type { ContactLookups } from "@/lib/enrichment/contacts";
import type { EmailCheck } from "@/lib/enrichment/email-check";
import type { EnrichmentAvailability } from "@/lib/enrichment/settings";
import { companyHref } from "@/lib/crm/hrefs";
import type {
  Activity,
  CallInsight,
  Company,
  Contact,
  ContactWrite,
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
  enrichment,
  workflows = [],
  proposals = [],
  relationship,
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
  enrichment: {
    available: EnrichmentAvailability;
    lookups: ContactLookups[string];
    canCheckEmail?: boolean;
    emailCheck?: EmailCheck | null;
  };
  workflows?: { id: string; name: string }[];
  proposals?: DocumentSummary[];
  relationship?: Relationship;
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
  const picker = useRelationshipPicker("contact", contact.id);

  async function patch(input: ContactWrite) {
    const result = await patchContactAction(shown.id, input);
    if (result.error || !result.contact) return result.error ?? "That didn't save. Try again.";
    setFresh(result.contact);
    router.refresh();
    return null;
  }
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
      <RecordSequence />
      <SectionHeader
        title={shown.name}
        viewer={viewer}
        list="contacts"
        action={
          <div className="flex items-center gap-1">
            <RunWorkflowButton object="contact" recordId={shown.id} workflows={workflows} />
            {!shown.archivedAt && <MergeRecordMenu kind="contact" id={shown.id} name={shown.name} />}
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
                title={shown.email ? "Invite to a meeting (I)" : undefined}
                disabled={!shown.email}
                data-shortcut="invite"
                onClick={() => setInvitingAt(Date.now())}
              >
                <CalendarIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
            {callUrl && (
              <a
                href={callUrl}
                data-shortcut="call"
                title="Call in Teams (⇧C)"
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
                data-shortcut="edit"
                title="Edit (E)"
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
        activityCount={activities.length}
        summary={
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
                {relationship && (
                  <span className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <ConnectionMark relationship={relationship} className="text-soft" />
                      <RelationshipSelect
                        relationship={relationship}
                        pending={picker.pending}
                        disabled={Boolean(shown.archivedAt)}
                        onChange={picker.change}
                        className="h-7"
                      />
                    </span>
                    {(!relationship.override || relationship.override.reason) && (
                      <span className="caption-style text-subtle leading-[1.45]">{relationship.reason}</span>
                    )}
                    <RelationshipSource relationship={relationship} viewerId={viewer.id} />
                    <RelationshipError error={picker.error} />
                  </span>
                )}
                <RecordTags
                  kind="contact"
                  id={shown.id}
                  tags={shown.tags}
                  suggestions={tags}
                />
              </div>
            </div>
        }
        details={
          <>
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
                  <InlineField
                    label="Phone"
                    value={shown.phone ?? ""}
                    accessory={
                      shown.phone ? (
                        <CallLink phone={shown.phone} />
                      ) : enrichment.available.phone ? (
                        <FindDetailButton contactId={shown.id} field="phone" lookup={enrichment.lookups?.phone} variant="text" />
                      ) : null
                    }
                    onSave={(value) => patch({ phone: value || null })}
                  />
                  <InlineField
                    label="Email"
                    value={shown.email ?? ""}
                    accessory={
                      shown.email ? (
                        enrichment.canCheckEmail ? (
                          <CheckEmailButton contactId={shown.id} email={shown.email} check={enrichment.emailCheck ?? null} />
                        ) : null
                      ) : enrichment.available.email ? (
                        <FindDetailButton contactId={shown.id} field="email" lookup={enrichment.lookups?.email} variant="text" />
                      ) : null
                    }
                    onSave={(value) => patch({ email: value || null })}
                  />
                  <InlineField
                    label="LinkedIn"
                    value={shown.linkedinUrl ?? ""}
                    display={shown.linkedinUrl ? shown.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "") : undefined}
                    accessory={
                      shown.linkedinUrl ? (
                        <a
                          href={shown.linkedinUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open LinkedIn"
                          title="Open LinkedIn"
                          className="text-subtle hover:text-foreground focus-visible:ring-ring/60 inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 hover:bg-white/6 focus-visible:ring-2"
                        >
                          <ExternalIcon aria-hidden className="size-3.5" />
                        </a>
                      ) : enrichment.available.linkedin ? (
                        <FindDetailButton contactId={shown.id} field="linkedin" lookup={enrichment.lookups?.linkedin} variant="text" />
                      ) : null
                    }
                    onSave={(value) => patch({ linkedinUrl: value || null })}
                  />
                  <InlineField
                    label="Owner"
                    type="select"
                    value={shown.ownerId ?? ""}
                    display={owner?.name ?? shown.ownerName ?? undefined}
                    options={[{ value: "", label: "Unassigned" }, ...members.map((member) => ({ value: member.id, label: member.name }))]}
                    emptyLabel="Unassigned"
                    onSave={(value) => patch({ ownerId: value || null })}
                  />
                  <InlineField label="Source" value={shown.source ?? ""} onSave={(value) => patch({ source: value || null })} />
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
            <ProposalsCard
              documents={proposals}
              company={shown.companyId ? { id: shown.companyId, name: shown.companyName ?? "Company" } : null}
              contactId={shown.id}
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
            viewerRole={viewer.role}
            activities={activities}
            insights={insights}
          />
        }
      />
    </section>
  );
}
