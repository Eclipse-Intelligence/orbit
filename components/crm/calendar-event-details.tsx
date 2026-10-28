"use client";

import { useContext, useState } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { NoticeContext } from "@/components/crm/invite-dialog";
import {
  cancelInviteAction,
  createContactFromEventAction,
  moveInviteAction,
  respondToInviteAction,
} from "@/app/(crm)/calendar/actions";
import { Checkbox } from "@/components/_ui/checkbox";
import { DatePicker } from "@/components/_ui/date-picker";
import Field from "@/components/_ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import { appTimeZone, dateTimeInputValue, zoneLabel } from "@/lib/time";
import { contactHref } from "@/lib/crm/hrefs";
import type { CalendarProvider } from "@/lib/crm/calendar-accounts";
import type { CalendarItem, EventPerson } from "@/lib/crm/calendars";
import { INVITE_COMMENT_MAX, TIME_OPTIONS } from "@/lib/invite-rules";
import { textareaClass } from "@/components/_ui/field-styles";
import { cn } from "@/lib/utils";

const ATTENDEES_SHOWN = 25;

export type CalendarMeta = {
  name: string;
  color: string;
  account: string;
  provider: CalendarProvider;
};

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

export function formatTimeRange(
  item: Pick<CalendarItem, "startsAt" | "endsAt" | "isAllDay">,
) {
  if (item.isAllDay) return "All day";
  return `${formatTime(item.startsAt)} to ${formatTime(item.endsAt)}`;
}

function formatDay(iso: string, allDay: boolean) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: allDay ? "UTC" : appTimeZone(),
  }).format(new Date(iso));
}

function whenLine(item: CalendarItem) {
  if (item.isAllDay) {
    const last = new Date(new Date(item.endsAt).getTime() - 1).toISOString();
    const first = formatDay(item.startsAt, true);
    const end = formatDay(last, true);
    return first === end ? `${first} · All day` : `${first} to ${end} · All day`;
  }
  const first = formatDay(item.startsAt, false);
  const end = formatDay(item.endsAt, false);
  if (first === end) return `${first}, ${formatTimeRange(item)}`;
  return `${first} ${formatTime(item.startsAt)} to ${end} ${formatTime(item.endsAt)}`;
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
  const detail = [label, person.response ? RESPONSES[person.response] : null]
    .filter(Boolean)
    .join(" · ");

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
            <Button
              variant="link"
              size="none"
              className="justify-start truncate"
              href={contactHref(contactId)}
            >
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

function CancelMeeting({ item }: { item: CalendarItem }) {
  const router = useRouter();
  const notify = useContext(NoticeContext);
  const [confirming, setConfirming] = useState(false);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fieldId = `cancel-comment-${item.id}`;

  async function cancel() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await cancelInviteAction(item.id, comment);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const message =
      result.warning ??
      `Cancelled ${eventTitle(item)}. Outlook let your guests know.`;
    setDone(message);
    notify(message);
    router.refresh();
  }

  if (done) {
    return (
      <p role="status" className="caption-style text-soft">
        {done}
      </p>
    );
  }
  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-danger self-start"
        data-shortcut="cancel-meeting"
        title="Cancel meeting (Delete)"
        onClick={() => setConfirming(true)}
      >
        Cancel meeting
      </Button>
    );
  }
  return (
    <div className="border-line-strong flex basis-full flex-col gap-2 rounded-lg border p-3">
      <p className="text-[14px] leading-5">Cancel this meeting for everyone?</p>
      <label className="caption-style text-subtle" htmlFor={fieldId}>
        Message to guests (optional)
      </label>
      <textarea
        id={fieldId}
        value={comment}
        maxLength={INVITE_COMMENT_MAX}
        onChange={(event) => setComment(event.target.value)}
        className={cn(textareaClass, "min-h-16")}
      />
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="text-danger"
          disabled={pending}
          autoFocus
          onClick={cancel}
        >
          {pending ? "Cancelling…" : "Cancel meeting"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Keep meeting
        </Button>
      </div>
    </div>
  );
}

function MoveMeeting({ item }: { item: CalendarItem }) {
  const router = useRouter();
  const notify = useContext(NoticeContext);
  const current = dateTimeInputValue(item.startsAt, appTimeZone());
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(current.slice(0, 10));
  const [time, setTime] = useState(current.slice(11, 16));
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ids = `move-${item.id}`;
  const times = TIME_OPTIONS.includes(time) ? TIME_OPTIONS : [...TIME_OPTIONS, time].sort();

  async function move() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await moveInviteAction(item.id, { startLocal: `${date}T${time}`, message });
    setPending(false);
    if (result.gone && result.error) {
      notify(result.error);
      router.refresh();
      return;
    }
    if (result.error || !result.startsAt || !result.endsAt) {
      setError(result.error ?? "Could not move this meeting.");
      return;
    }
    const moved = whenLine({ ...item, startsAt: result.startsAt, endsAt: result.endsAt });
    const note = result.warning ?? `Moved ${eventTitle(item)} to ${moved}. Outlook let your guests know.`;
    setDone(note);
    setOpen(false);
    notify(note);
    router.refresh();
  }

  if (done && !open) {
    return (
      <p role="status" className="caption-style text-soft basis-full">
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpen(true)}>
        Move
      </Button>
    );
  }
  return (
    <div className="border-line-strong flex basis-full flex-col gap-3 rounded-lg border p-3">
      <p className="text-[14px] leading-5">Move this meeting</p>
      <div className="grid grid-cols-[1fr_7em] gap-2">
        <Field label="Date" htmlFor={`${ids}-date`}>
          <DatePicker id={`${ids}-date`} value={date} onChange={setDate} />
        </Field>
        <Field label="Start" htmlFor={`${ids}-time`}>
          <Select value={time} onValueChange={setTime}>
            <SelectTrigger id={`${ids}-time`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {times.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="caption-style text-subtle -mt-1">{zoneLabel()} time. Keeps the same length.</p>
      <label className="caption-style text-subtle" htmlFor={`${ids}-message`}>
        Message to guests (optional)
      </label>
      <textarea
        id={`${ids}-message`}
        value={message}
        maxLength={INVITE_COMMENT_MAX}
        onChange={(event) => setMessage(event.target.value)}
        className={cn(textareaClass, "min-h-16")}
      />
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending || !date || !time} onClick={move}>
          {pending ? "Moving…" : "Move meeting"}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
          Keep time
        </Button>
      </div>
    </div>
  );
}

const ANSWERS = [
  { response: "accept", status: "accepted", label: "Accept", done: "Accepted", busy: "Accepting…" },
  { response: "tentative", status: "tentativelyAccepted", label: "Maybe", done: "Said maybe to", busy: "Sending…" },
  { response: "decline", status: "declined", label: "Decline", done: "Declined", busy: "Declining…" },
] as const;

const MY_RESPONSE: Record<string, string> = {
  accepted: "Accepted",
  tentativelyAccepted: "Maybe",
  declined: "Declined",
};

function RespondToMeeting({ item }: { item: CalendarItem }) {
  const router = useRouter();
  const notify = useContext(NoticeContext);
  const [answered, setAnswered] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [tell, setTell] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ids = `respond-${item.id}`;
  const current = answered ?? item.myResponse;
  const organiser = item.organizer?.name ?? item.organizer?.email ?? "the organiser";

  async function respond(answer: (typeof ANSWERS)[number]) {
    if (pending) return;
    setPending(answer.response);
    setError(null);
    setDone(null);
    const result = await respondToInviteAction(item.id, {
      response: answer.response,
      note: tell ? note : "",
      sendResponse: tell,
    });
    setPending(null);
    if (result.gone && result.error) {
      notify(result.error);
      router.refresh();
      return;
    }
    if (result.error) {
      setError(result.error);
      return;
    }
    setAnswered(result.responseStatus ?? answer.status);
    const message =
      result.warning ??
      `${answer.done} ${eventTitle(item)}. ${tell ? `Outlook let ${organiser} know.` : "The organiser wasn't told."}`;
    setDone(message);
    setNote("");
    setNoteOpen(false);
    notify(message);
    router.refresh();
  }

  return (
    <div role="group" aria-labelledby={`${ids}-label`} className="flex flex-col gap-2">
      <p id={`${ids}-label`} className="caption-style text-subtle">
        Your response: <span className="text-soft">{(current && MY_RESPONSE[current]) || "Not answered"}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {ANSWERS.map((answer) => {
          const chosen = current === answer.status;
          return (
            <Button
              key={answer.response}
              variant={chosen ? "primary" : "secondary"}
              size="sm"
              aria-pressed={chosen}
              disabled={pending !== null}
              onClick={() => respond(answer)}
            >
              {pending === answer.response ? answer.busy : answer.label}
            </Button>
          );
        })}
        {!noteOpen && tell && (
          <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => setNoteOpen(true)}>
            Add note
          </Button>
        )}
      </div>
      {noteOpen && tell && (
        <div className="flex flex-col gap-1.5">
          <label className="caption-style text-subtle" htmlFor={`${ids}-note`}>
            Note to {organiser} (optional)
          </label>
          <textarea
            id={`${ids}-note`}
            value={note}
            maxLength={INVITE_COMMENT_MAX}
            autoFocus
            onChange={(event) => setNote(event.target.value)}
            className={cn(textareaClass, "min-h-16")}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${ids}-tell`}
          checked={tell}
          disabled={pending !== null}
          onCheckedChange={(next) => setTell(next === true)}
        />
        <label htmlFor={`${ids}-tell`} className="caption-style text-subtle cursor-pointer">
          Let {organiser} know
        </label>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <p role="status" className="caption-style text-soft empty:hidden">
        {done}
      </p>
    </div>
  );
}

export default function CalendarEventDetails({
  item,
  calendar,
  others,
  headingId,
}: {
  item: CalendarItem;
  calendar: CalendarMeta | null;
  others?: CalendarMeta[];
  headingId?: string;
}) {
  const [created, setCreated] = useState<Record<string, string>>({});
  const onCreated = (email: string, contactId: string) =>
    setCreated((current) => ({ ...current, [email]: contactId }));
  const organizerEmail = item.organizer?.email ?? null;
  const attendees = item.attendees.filter(
    (person) => person.email !== organizerEmail,
  );
  const shown = attendees.slice(0, ATTENDEES_SHOWN);
  const status = showAsLabel(item.showAs);
  const links = [
    item.joinUrl
      ? { href: item.joinUrl, label: "Join", variant: "primary" as const }
      : null,
    item.webLink
      ? {
          href: item.webLink,
          label:
            calendar?.provider === "ics" ? "Open event" : "Open in Outlook",
          variant: "secondary" as const,
        }
      : null,
  ].filter(
    (
      link,
    ): link is {
      href: string;
      label: string;
      variant: "primary" | "secondary";
    } => link !== null,
  );

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
        {calendar &&
          [calendar, ...(others ?? [])].map((entry, index) => (
            <p
              key={`${entry.account}-${entry.name}-${index}`}
              className="caption-style text-subtle flex items-center gap-1.5"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate">
                {entry.name} · {entry.account}
              </span>
            </p>
          ))}
        {item.location && (
          <p className="caption-style text-subtle">{item.location}</p>
        )}
      </div>
      {(links.length > 0 || item.granolaHref) && (
        <div className="flex flex-wrap items-center gap-2">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              data-shortcut={link.label === "Join" ? "join" : undefined}
              title={link.label === "Join" ? "Join (J)" : undefined}
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
      {item.canRespond && <RespondToMeeting item={item} />}
      {item.canCancel && (
        <div className="flex flex-wrap items-start gap-2">
          {!item.isAllDay && <MoveMeeting item={item} />}
          <CancelMeeting item={item} />
        </div>
      )}
      {item.organizer && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle">Organiser</span>
          <ul>
            <PersonRow
              eventId={item.id}
              person={item.organizer}
              created={created}
              onCreated={onCreated}
            />
          </ul>
        </div>
      )}
      {shown.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle">
            {attendees.length}{" "}
            {attendees.length === 1 ? "attendee" : "attendees"}
          </span>
          <ul className="flex flex-col gap-2.5">
            {shown.map((person) => (
              <PersonRow
                key={person.email}
                eventId={item.id}
                person={person}
                created={created}
                onCreated={onCreated}
              />
            ))}
          </ul>
          {attendees.length > shown.length && (
            <span className="caption-style text-subtle">
              and {attendees.length - shown.length} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
