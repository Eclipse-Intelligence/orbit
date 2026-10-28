"use client";

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/_ui/select";
import { addActivityAction } from "@/app/(crm)/records";
import DetailSection from "@/components/companies/detail/detail-section";
import {
  ActivityComposer,
  ActivityTimeline,
  useActivityDraft,
} from "@/components/crm/contact-activities";
import ActivityPad from "@/components/crm/activity-pad";
import ContactEmail from "@/components/crm/contact-email";
import { contactRecipient } from "@/lib/crm/personalise";
import type { Activity, CallInsight, Contact } from "@/lib/crm/types";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const NONE = "none";
const ALL = "all";

export default function CompanyActivity({
  companyId,
  companyName,
  contacts,
  timeline,
  insights,
  mailboxConnected,
  viewerId,
  viewerRole,
}: {
  companyId: string;
  companyName: string;
  contacts: Contact[];
  timeline: Activity[];
  insights: Record<string, CallInsight>;
  mailboxConnected: boolean;
  viewerId?: string | null;
  viewerRole?: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState(ALL);
  const about =
    picked !== null &&
    (picked === NONE || contacts.some((contact) => contact.id === picked))
      ? picked
      : contacts.length === 1
        ? contacts[0].id
        : NONE;
  const contact = contacts.find((item) => item.id === about) ?? null;
  const draft = useActivityDraft((kind, title, body) =>
    addActivityAction(
      { companyId, contactId: contact?.id ?? null },
      kind,
      title,
      body,
    ),
  );
  const emailing = draft.kind === "email";
  const reachable = contacts.filter((item) => item.email);
  const recipient = contact?.email ? contact : null;

  const listed = draft.withAdded(timeline);
  const people: { id: string; name: string }[] = [];
  for (const activity of listed) {
    if (
      activity.contactId &&
      !people.some((person) => person.id === activity.contactId)
    ) {
      people.push({
        id: activity.contactId,
        name:
          activity.contactName ??
          contacts.find((item) => item.id === activity.contactId)?.name ??
          "Contact",
      });
    }
  }
  const active =
    filter !== ALL && people.some((person) => person.id === filter)
      ? filter
      : ALL;
  const shown =
    active === ALL
      ? listed
      : listed.filter((activity) => activity.contactId === active);
  const aboutId = `activity-about-${companyId}`;

  return (
    <DetailSection title="Activity" className="shadow-none">
      <ActivityComposer
        idPrefix={companyId}
        draft={draft}
        pad={<ActivityPad fixedCompany={{ id: companyId, name: companyName }} onAdded={draft.push} />}
        about={
          <div className="flex flex-col gap-2">
            <label className="caption-style text-subtle" htmlFor={aboutId}>
              About
            </label>
            {emailing ? (
              <Select
                value={recipient?.id ?? ""}
                onValueChange={setPicked}
                disabled={reachable.length === 0}
              >
                <SelectTrigger id={aboutId}>
                  <SelectValue placeholder="Choose a contact" />
                </SelectTrigger>
                <SelectContent>
                  {reachable.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Select value={about} onValueChange={setPicked}>
                <SelectTrigger id={aboutId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No specific contact</SelectItem>
                  {contacts.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        }
        email={
          <ContactEmail
            contactId={recipient?.id ?? null}
            companyId={companyId}
            email={recipient?.email ?? null}
            recipient={recipient ? contactRecipient(recipient) : null}
            mailboxConnected={mailboxConnected}
            idPrefix={companyId}
            unavailable={
              reachable.length === 0
                ? "No one at this company has an email address yet."
                : "Choose who to email."
            }
          />
        }
      />
      <ActivityTimeline
        activities={shown}
        insights={insights}
        showContact
        viewerId={viewerId}
        viewerRole={viewerRole}
        empty="No activity yet."
        filters={
          people.length > 1 && (
            <span className="relative flex items-center">
              <label htmlFor={`${aboutId}-filter`} className="sr-only">
                Show activity with
              </label>
              <select
                id={`${aboutId}-filter`}
                value={active}
                onChange={(event) => setFilter(event.target.value)}
                className="text-soft hover:text-foreground focus-visible:ring-ring/60 h-8 max-w-[14em] cursor-pointer appearance-none truncate rounded-full bg-white/[0.04] pr-7 pl-3 text-[13px] outline-none hover:bg-white/[0.07] focus-visible:ring-2"
              >
                <option value={ALL}>Everyone</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon aria-hidden className="text-subtle pointer-events-none absolute right-2.5 size-3" />
            </span>
          )
        }
      />
    </DetailSection>
  );
}
