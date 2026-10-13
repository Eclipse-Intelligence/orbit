"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
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
import ContactEmail from "@/components/crm/contact-email";
import type { Activity, CallInsight, Contact } from "@/lib/crm/types";

const NONE = "none";
const ALL = "all";

export default function CompanyActivity({
  companyId,
  contacts,
  timeline,
  insights,
  mailboxConnected,
}: {
  companyId: string;
  contacts: Contact[];
  timeline: Activity[];
  insights: Record<string, CallInsight>;
  mailboxConnected: boolean;
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
      <div className="flex flex-col gap-3">
        <ActivityComposer
          idPrefix={companyId}
          draft={draft}
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
      </div>
      {people.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Filter activity by contact"
        >
          <Button
            variant={active === ALL ? "primary" : "subtle"}
            size="sm"
            type="button"
            aria-pressed={active === ALL}
            onClick={() => setFilter(ALL)}
          >
            All
          </Button>
          {people.map((person) => (
            <Button
              key={person.id}
              variant={active === person.id ? "primary" : "subtle"}
              size="sm"
              type="button"
              aria-pressed={active === person.id}
              onClick={() => setFilter(person.id)}
            >
              {person.name}
            </Button>
          ))}
        </div>
      )}
      <ActivityTimeline
        activities={shown}
        insights={insights}
        showContact
        empty="No activity yet."
      />
    </DetailSection>
  );
}
