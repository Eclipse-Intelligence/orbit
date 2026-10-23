"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import Button from "@/components/_ui/button";
import { Monogram } from "@/components/beautifui/record-marks";
import {
  createContactFromMeetingAction,
  hideAttendeeAction,
} from "@/app/(crm)/capture/actions";
import { formatMeetingWhen } from "@/lib/companies";
import type { MeetingRef, MetPerson } from "@/lib/crm/calendar";
import { contactHref } from "@/lib/crm/hrefs";

type CreatedNotice = { contactId: string; name: string };

function meetingLine(label: string, meeting: MeetingRef | null) {
  if (!meeting) return null;
  return `${label} ${formatMeetingWhen(meeting.startsAt)} · ${meeting.subject || "Untitled meeting"}`;
}

export default function PeopleMet({ people }: { people: MetPerson[] }) {
  const [notice, setNotice] = useState<CreatedNotice | null>(null);
  if (people.length === 0 && !notice) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="people-met-heading">
      <h3 id="people-met-heading" className="h4-style">
        People you&apos;ve met who aren&apos;t in Orbit
      </h3>
      <p role="status" className={notice ? "caption-style text-soft" : "sr-only"}>
        {notice && (
          <>
            Added{" "}
            <Button variant="link" size="none" href={contactHref(notice.contactId)}>
              {notice.name}
            </Button>
          </>
        )}
      </p>
      {people.length === 0 ? (
        <p className="caption-style text-subtle">Everyone from your recent meetings is in Orbit.</p>
      ) : (
        <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
          {people.map((person) => (
            <PersonItem key={person.email} person={person} onCreated={setNotice} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonItem({
  person,
  onCreated,
}: {
  person: MetPerson;
  onCreated: (notice: CreatedNotice) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"create" | "hide" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = person.name ?? person.email;
  const lines = [meetingLine("Last", person.lastMeeting), meetingLine("Next", person.nextMeeting)].filter(
    (line): line is string => Boolean(line),
  );

  async function create() {
    if (pending) return;
    setPending("create");
    setError(null);
    const result = await createContactFromMeetingAction(person.email);
    setPending(null);
    if (result.error || !result.contactId) {
      setError(result.error ?? "Could not add this person.");
      return;
    }
    onCreated({ contactId: result.contactId, name: result.contactName ?? label });
    router.refresh();
  }

  async function hide() {
    if (pending) return;
    setPending("hide");
    setError(null);
    const result = await hideAttendeeAction(person.email);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li data-list-row="" className={cn(KEYBOARD_ROW_CLASS, "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3")}>
      <Monogram name={label} />
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
        <span className="truncate text-[14px] leading-5">{label}</span>
        <span className="caption-style text-subtle truncate leading-[1.4]">
          {person.name ? `${person.email} · ` : ""}
          {person.meetings} {person.meetings === 1 ? "meeting" : "meetings"}
        </span>
        {lines.map((line) => (
          <span key={line} className="caption-style text-subtle truncate leading-[1.4]">
            {line}
          </span>
        ))}
        {error && (
          <span role="alert" className="caption-style text-danger leading-[1.4]">
            {error}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 max-sm:pl-11">
        <Button variant="secondary" size="sm" disabled={pending !== null} onClick={create} data-row-key="a" title="Create contact (A)">
          {pending === "create" ? "Creating…" : "Create contact"}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending !== null} onClick={hide} data-row-key="h" title="Hide (H)">
          {pending === "hide" ? "Hiding…" : "Hide"}
        </Button>
      </span>
    </li>
  );
}
