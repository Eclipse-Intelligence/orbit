"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { createContactFromEventAction } from "@/app/(crm)/calendar/actions";
import { appTimeZone } from "@/lib/time";
import { contactHref } from "@/lib/crm/hrefs";
import type { CalendarProvider } from "@/lib/crm/calendar-accounts";
import type { CalendarItem, EventPerson } from "@/lib/crm/calendars";

const ATTENDEES_SHOWN = 25;

export type CalendarMeta = { name: string; color: string; account: string; provider: CalendarProvider };

const RESPONSES: Record<string, string> = {
  accepted: "Accepted",
  tentativelyAccepted: "Tentative",
  declined: "Declined",
  organizer: "Organiser",
};

const SHOW_AS: Record<string, string> = {
  free: "Free",
  tentative: "Tentative",
  oof: "Out of office",
  workingElsewhere: "Working elsewhere",
};

export function formatTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: appTimeZone(),
  }).format(new Date(iso));
}

export function formatTimeRange(item: Pick<CalendarItem, "startsAt" | "endsAt" | "isAllDay">) {
  if (item.isAllDay) return "All day";
  return `${formatTime(item.startsAt)} – ${formatTime(item.endsAt)}`;
}

function formatDay(iso: string, allDay: boolean) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: allDay ? "UTC" : appTimeZone(),
  }).format(new Date(iso));
}

export function whenLine(item: CalendarItem) {
  if (item.isAllDay) {
    const last = new Date(new Date(item.endsAt).getTime() - 1).toISOString();
    const first = formatDay(item.startsAt, true);
    const end = formatDay(last, true);
    return first === end ? `${first} · All day` : `${first} – ${end} · All day`;
  }
  const first = formatDay(item.startsAt, false);
  const end = formatDay(item.endsAt, false);
  if (first === end) return `${first}, ${formatTimeRange(item)}`;
  return `${first} ${formatTime(item.startsAt)} – ${end} ${formatTime(item.endsAt)}`;
}

export function eventTitle(item: Pick<CalendarItem, "subject">) {
  return item.subject || "Untitled event";
}

export function showAsLabel(value: string | null) {
  return value ? (SHOW_AS[value] ?? null) : null;
}

function PersonRow({
  eventId,
  person,
  label,
  created,
  onCreated,
}: {
  eventId: string;
  person: EventPerson;
  label?: string;
  created: Record<string, string>;
  onCreated: (email: string, contactId: string) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contactId = person.contactId ?? created[person.email] ?? null;
  const name = person.name ?? person.email;
  const detail = [label, person.response ? RESPONSES[person.response] : null].filter(Boolean).join(" · ");

  async function create() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await createContactFromEventAction(eventId, person.email);
    setPending(false);
    if (result.error || !result.contactId) {
      setError(result.error ?? "Could not add this person.");
      return;
    }
    onCreated(person.email, result.contactId);
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-1">
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          {contactId ? (
            <Button variant="link" size="none" className="justify-start truncate" href={contactHref(contactId)}>
              {name}
            </Button>
          ) : (
            <span className="truncate text-[14px] leading-5">{name}</span>
          )}
          <span className="caption-style text-subtle truncate">
            {person.name ? person.email : null}
            {person.name && detail ? " · " : null}
            {detail}
          </span>
        </span>
        {!contactId && !person.internal && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={create}>
            {pending ? "Creating…" : "Create contact"}
          </Button>
        )}
      </span>
      {error && (
        <span role="alert" className="caption-style text-danger">
          {error}
        </span>
      )}
    </li>
  );
}

export default function CalendarEventDetails({
  item,
  calendar,
  headingId,
}: {
  item: CalendarItem;
  calendar: CalendarMeta | null;
  headingId?: string;
}) {
  const [created, setCreated] = useState<Record<string, string>>({});
  const onCreated = (email: string, contactId: string) =>
    setCreated((current) => ({ ...current, [email]: contactId }));
  const organizerEmail = item.organizer?.email ?? null;
  const attendees = item.attendees.filter((person) => person.email !== organizerEmail);
  const shown = attendees.slice(0, ATTENDEES_SHOWN);
  const status = showAsLabel(item.showAs);
  const links = [
    item.joinUrl ? { href: item.joinUrl, label: "Join", variant: "primary" as const } : null,
    item.webLink
      ? {
          href: item.webLink,
          label: calendar?.provider === "ics" ? "Open event" : "Open in Outlook",
          variant: "secondary" as const,
        }
      : null,
  ].filter((link): link is { href: string; label: string; variant: "primary" | "secondary" } => link !== null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 id={headingId} className="text-[16px] leading-6 font-medium">
          {eventTitle(item)}
        </h3>
        <p className="caption-style text-soft">
          {whenLine(item)}
          {status ? ` · ${status}` : ""}
        </p>
        {calendar && (
          <p className="caption-style text-subtle flex items-center gap-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} />
            <span className="truncate">
              {calendar.name} · {calendar.account}
            </span>
          </p>
        )}
        {item.location && <p className="caption-style text-subtle">{item.location}</p>}
      </div>
      {(links.length > 0 || item.granolaHref) && (
        <div className="flex flex-wrap items-center gap-2">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: link.variant, size: "sm" })}
            >
              {link.label}
            </a>
          ))}
          {item.granolaHref && (
            <Button variant="ghost" size="sm" href={item.granolaHref}>
              Notes in Granola
            </Button>
          )}
        </div>
      )}
      {item.organizer && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle">Organiser</span>
          <ul>
            <PersonRow eventId={item.id} person={item.organizer} created={created} onCreated={onCreated} />
          </ul>
        </div>
      )}
      {shown.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle">
            {attendees.length} {attendees.length === 1 ? "attendee" : "attendees"}
          </span>
          <ul className="flex flex-col gap-2.5">
            {shown.map((person) => (
              <PersonRow key={person.email} eventId={item.id} person={person} created={created} onCreated={onCreated} />
            ))}
          </ul>
          {attendees.length > shown.length && (
            <span className="caption-style text-subtle">and {attendees.length - shown.length} more</span>
          )}
        </div>
      )}
    </div>
  );
}
