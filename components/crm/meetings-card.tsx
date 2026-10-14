import { buttonVariants } from "@/components/_ui/button";
import DetailSection from "@/components/companies/detail/detail-section";
import { formatMeetingWhen } from "@/lib/companies";
import type { Meeting, MeetingsSummary } from "@/lib/crm/calendar";

const LINK = "underline decoration-white/35 underline-offset-[3px] hover:decoration-current";

function meetingTitle(meeting: Meeting) {
  return meeting.subject || "Untitled meeting";
}

function peopleLine(meeting: Meeting) {
  const parts = [];
  if (meeting.organizer) parts.push(`Organised by ${meeting.organizer.name ?? meeting.organizer.email}`);
  if (meeting.attendeeCount > 0) {
    parts.push(`${meeting.attendeeCount} ${meeting.attendeeCount === 1 ? "attendee" : "attendees"}`);
  }
  return parts.join(" · ");
}

function joinLabel(url: string) {
  try {
    return new URL(url).hostname.endsWith("teams.microsoft.com") ? "Teams link" : "Join link";
  } catch {
    return "Join link";
  }
}

function MeetingLinks({ meeting, upcoming }: { meeting: Meeting; upcoming: boolean }) {
  const join = upcoming ? meeting.joinUrl : null;
  if (!join && !meeting.webLink && !meeting.granolaActivityId) return null;
  return (
    <span className="caption-style text-soft flex flex-wrap items-center gap-x-3 gap-y-1">
      {join && (
        <a href={join} target="_blank" rel="noreferrer" className={LINK}>
          Join
        </a>
      )}
      {meeting.webLink && (
        <a href={meeting.webLink} target="_blank" rel="noreferrer" className={LINK}>
          Open in Outlook
        </a>
      )}
      {meeting.granolaActivityId && (
        <a href={`#activity-${meeting.granolaActivityId}`} className={LINK}>
          Notes in Granola
        </a>
      )}
    </span>
  );
}

function MeetingItem({ meeting, upcoming }: { meeting: Meeting; upcoming: boolean }) {
  const people = peopleLine(meeting);
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[14px] leading-5">{meetingTitle(meeting)}</span>
      <span className="caption-style text-subtle">
        {formatMeetingWhen(meeting.startsAt, meeting.isAllDay)}
        {people ? ` · ${people}` : ""}
      </span>
      <MeetingLinks meeting={meeting} upcoming={upcoming} />
    </li>
  );
}

function MeetingGroup({
  label,
  meetings,
  upcoming,
}: {
  label: string;
  meetings: Meeting[];
  upcoming: boolean;
}) {
  if (meetings.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <span className="caption-style text-subtle">{label}</span>
      <ul className="flex flex-col gap-3">
        {meetings.map((meeting) => (
          <MeetingItem key={meeting.id} meeting={meeting} upcoming={upcoming} />
        ))}
      </ul>
    </div>
  );
}

export default function MeetingsCard({
  meetings,
  className,
}: {
  meetings: MeetingsSummary | null;
  className?: string;
}) {
  if (!meetings) return null;
  const [next, ...later] = meetings.upcoming;
  if (!next && meetings.recent.length === 0 && !meetings.scopeMissing) return null;

  return (
    <DetailSection title="Meetings" className={className}>
      {meetings.scopeMissing && (
        <p className="caption-style text-subtle flex flex-wrap items-center gap-2">
          Reconnect Microsoft to see meetings.
          <a
            href="/api/microsoft/connect"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Reconnect
          </a>
        </p>
      )}
      {next && (
        <div className="flex flex-col gap-1">
          <p className="text-[14px] leading-5">
            <span className="text-subtle">Next: </span>
            {formatMeetingWhen(next.startsAt, next.isAllDay)} · {meetingTitle(next)}
            {next.joinUrl && (
              <>
                {" ("}
                <a href={next.joinUrl} target="_blank" rel="noreferrer" className={LINK}>
                  {joinLabel(next.joinUrl)}
                </a>
                {")"}
              </>
            )}
          </p>
          {peopleLine(next) && (
            <span className="caption-style text-subtle">{peopleLine(next)}</span>
          )}
          <MeetingLinks meeting={{ ...next, joinUrl: null }} upcoming={false} />
        </div>
      )}
      <MeetingGroup label="Upcoming" meetings={later} upcoming />
      <MeetingGroup label="Recent" meetings={meetings.recent} upcoming={false} />
    </DetailSection>
  );
}
