"use client";

import { useSearchParams } from "next/navigation";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import Pager from "@/components/crm/pager";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ListSearch from "@/components/shortcuts/list-search";
import ActivityPad from "@/components/crm/activity-pad";
import { RecordList, RecordRow } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { formatWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import type { Activity } from "@/lib/crm/types";

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
  page,
  query,
}: {
  viewer: Viewer;
  activities: Activity[];
  total: number;
  page: number;
  query: string;
}) {
  const adding = useSearchParams().get("add") === "1";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Activities" viewer={viewer} action={<RecordTransfer resource="activities" />} />
      <div className="border-border border-b px-4 py-4">
        <ActivityPad suggestions shortcut="add-record" autoFocus={adding} />
      </div>
      <div className="flex items-center gap-2 px-4 py-4">
        <ListSearch noun="activities" />
      </div>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {total === 1 ? "activity" : "activities"}
      </p>
      <KeyboardList className="flex min-h-0 flex-1 flex-col">
      <RecordList count={activities.length} empty={query ? "No activities match the search." : "No interactions recorded yet."}>
        {activities.map((activity) => (
          <RecordRow
            key={activity.id}
            mark={<Monogram name={activity.companyName || activity.contactName || LABELS[activity.type] || activity.type} />}
            title={`${LABELS[activity.type] ?? activity.type}${activity.title ? ` · ${activity.title}` : ""}`}
            meta={[activity.contactName, activity.body, formatWhen(activity.occurredAt)].filter(Boolean).join(" · ")}
            action={
              activity.companyName && activity.companyId ? (
                <EntityChip name={activity.companyName} href={companyHref(activity.companyId)} />
              ) : null
            }
          />
        ))}
      </RecordList>
      </KeyboardList>
      <Pager
        page={page}
        count={activities.length}
        total={total}
        noun={["activity", "activities"]}
      />
    </section>
  );
}
