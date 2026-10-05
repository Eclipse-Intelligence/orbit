"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { saveActivityAction, type RecordActionState } from "@/app/(crm)/records";
import { formatWhen } from "@/lib/companies";
import { ACTIVITY_TYPES, type Activity, type Company, type Contact } from "@/lib/crm/types";

const LABELS: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  call: "Call",
  note: "Note",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Other",
};

export default function ActivitiesScreen({
  viewer,
  activities,
  total,
  query,
  companies,
  contacts,
}: {
  viewer: Viewer;
  activities: Activity[];
  total: number;
  query: string;
  companies: Company[];
  contacts: Contact[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveActivityAction, {} as RecordActionState);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Activities" viewer={viewer} action={<RecordTransfer resource="activities" />} />
      <form action={action} className="border-border flex flex-col gap-3 border-b px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <RecordSelect id="activity-type" name="type" label="Type" defaultValue="note">
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {LABELS[type]}
              </option>
            ))}
          </RecordSelect>
          <label className="flex flex-col gap-2" htmlFor="activity-title">
            <span className="caption-style text-subtle">Title</span>
            <Input id="activity-title" name="title" placeholder="Intro call" />
          </label>
        </div>
        <label className="flex flex-col gap-2" htmlFor="activity-body">
          <span className="caption-style text-subtle">What happened</span>
          <textarea
            id="activity-body"
            name="body"
            placeholder="What was discussed"
            className="border-line-strong bg-secondary min-h-20 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <RecordSelect id="activity-company" name="companyId" label="Company" defaultValue="none">
            <option value="none">No company</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </RecordSelect>
          <RecordSelect id="activity-contact" name="contactId" label="Contact" defaultValue="none">
            <option value="none">No contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </RecordSelect>
        </div>
        {state.error && (
          <p role="alert" className="caption-style text-danger">
            {state.error}
          </p>
        )}
        <Button variant="primary" size="sm" type="submit" className="self-start" disabled={pending}>
          {pending ? "Saving…" : "Add activity"}
        </Button>
      </form>
      <form action="/activities" className="flex items-center gap-2 px-4 py-4">
        <label className="sr-only" htmlFor="activity-search">
          Search activities
        </label>
        <Input
          id="activity-search"
          name="q"
          defaultValue={query}
          placeholder="Search notes"
          className="w-[240px]"
        />
      </form>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {total === 1 ? "activity" : "activities"}
      </p>
      <RecordList count={activities.length} empty="No interactions recorded yet.">
        {activities.map((activity) => (
          <RecordRow
            key={activity.id}
            title={`${LABELS[activity.type] ?? activity.type}${activity.title ? ` · ${activity.title}` : ""}`}
            meta={[activity.companyName, activity.contactName, activity.body, formatWhen(activity.occurredAt)]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
      </RecordList>
    </section>
  );
}
