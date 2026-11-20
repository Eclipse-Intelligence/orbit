"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { Label } from "@/components/_ui/label";
import { NativeSelect } from "@/components/_ui/native-select";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import ActivityPad from "@/components/crm/activity-pad";
import Pager from "@/components/crm/pager";
import { RecordRow } from "@/components/crm/record-form";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ListSearch from "@/components/shortcuts/list-search";
import { formatWhen } from "@/lib/companies";
import { ACTIVITY_TYPE_LABELS, AGENT_PREFIX, EVERYONE } from "@/lib/crm/activity-log";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { ACTIVITY_TYPES, type Activity, type Member } from "@/lib/crm/types";

const FILTER_KEYS = ["person", "type", "from", "to"] as const;

export default function ActivityLog({
  viewerId,
  members,
  agents,
  person,
  type,
  from,
  to,
  query,
  activities,
  total,
  page,
}: {
  viewerId: string;
  members: Member[];
  agents: { id: string; name: string }[];
  person: string;
  type: string;
  from: string;
  to: string;
  query: string;
  activities: Activity[];
  total: number;
  page: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const adding = searchParams.get("add") === "1";
  const id = useId();
  const everyone = person === EVERYONE;
  const others = members.filter((member) => member.id !== viewerId);
  const filtered = Boolean(type || from || to || query);

  function update(key: (typeof FILTER_KEYS)[number], value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    params.delete("add");
    if (value && !(key === "person" && value === viewerId)) params.set(key, value);
    else params.delete(key);
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [...FILTER_KEYS, "q", "page", "add"]) {
      if (key !== "person") params.delete(key);
    }
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-5">
      <ActivityPad suggestions shortcut="add-record" autoFocus={adding} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[10em] flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor={`${id}-person`}>Person</Label>
          <NativeSelect id={`${id}-person`} value={person} onChange={(event) => update("person", event.target.value)}>
            <option value={viewerId}>You</option>
            {others.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
            {agents.length > 0 && (
              <optgroup label="Agents">
                {agents.map((agent) => (
                  <option key={agent.id} value={`${AGENT_PREFIX}${agent.id}`}>
                    {agent.name}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={EVERYONE}>Everyone</option>
          </NativeSelect>
        </div>
        <div className="flex min-w-[8em] flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <NativeSelect id={`${id}-type`} value={type} onChange={(event) => update("type", event.target.value)}>
            <option value="">Any type</option>
            {ACTIVITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {ACTIVITY_TYPE_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex min-w-[9em] flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor={`${id}-from`}>From</Label>
          <Input id={`${id}-from`} type="date" value={from} max={to || undefined} onChange={(event) => update("from", event.target.value)} />
        </div>
        <div className="flex min-w-[9em] flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor={`${id}-to`}>To</Label>
          <Input id={`${id}-to`} type="date" value={to} min={from || undefined} onChange={(event) => update("to", event.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ListSearch noun="activities" />
        <div className="flex items-center gap-2">
          <p role="status" className="caption-style text-subtle">
            {total} {total === 1 ? "activity" : "activities"}
          </p>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      <KeyboardList className="flex flex-col">
        {activities.length === 0 ? (
          <p className="caption-style text-subtle py-8">
            {filtered ? "No matches" : "No activities"}
          </p>
        ) : (
          <ul className="border-border flex flex-col border-t">
            {activities.map((activity) => (
              <RecordRow
                key={activity.id}
                mark={<Monogram name={activity.companyName || activity.contactName || ACTIVITY_TYPE_LABELS[activity.type] || activity.type} />}
                title={`${ACTIVITY_TYPE_LABELS[activity.type] ?? activity.type}${activity.title ? ` · ${activity.title}` : ""}`}
                meta={[everyone ? activity.actorName : null, activity.contactName, activity.body, formatWhen(activity.occurredAt)].filter(Boolean).join(" · ")}
                href={activity.contactId ? contactHref(activity.contactId) : activity.companyId ? companyHref(activity.companyId) : undefined}
                action={
                  activity.companyName && activity.companyId ? (
                    <EntityChip name={activity.companyName} href={companyHref(activity.companyId)} />
                  ) : null
                }
              />
            ))}
          </ul>
        )}
      </KeyboardList>
      <Pager page={page} count={activities.length} total={total} noun={["activity", "activities"]} />
    </div>
  );
}
