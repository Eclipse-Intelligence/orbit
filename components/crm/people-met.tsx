"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Monogram } from "@/components/beautifui/record-marks";
import {
  createContactFromMeetingAction,
  hideAttendeeAction,
} from "@/app/(crm)/inbox/actions";
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
    <section className="flex flex-col gap-2 px-4 pb-4" aria-labelledby="people-met-heading">
      <h2 id="people-met-heading">People you&apos;ve met who aren&apos;t in Orbit</h2>
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
        <ul className="flex max-w-[640px] flex-col gap-2">
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
    <li className="border-border flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-start gap-2.5">
        <Monogram name={label} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] leading-5">{label}</span>
          <span className="caption-style text-subtle truncate">
            {person.name ? `${person.email} · ` : ""}
            {person.meetings} {person.meetings === 1 ? "meeting" : "meetings"}
          </span>
          {lines.map((line) => (
            <span key={line} className="caption-style text-subtle truncate">
              {line}
            </span>
          ))}
        </span>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending !== null} onClick={create}>
          {pending === "create" ? "Creating…" : "Create contact"}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending !== null} onClick={hide}>
          {pending === "hide" ? "Hiding…" : "Hide"}
        </Button>
      </div>
    </li>
  );
}
