"use client";

import { createContext, useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { DatePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import { searchContactsToFileAction } from "@/app/(crm)/search";
import { sendInviteAction } from "@/app/(crm)/calendar/actions";
import type { InviteSetup } from "@/lib/crm/invites";
import type { Contact } from "@/lib/crm/types";
import {
  defaultInviteSlot,
  guestEmail,
  INVITE_DEFAULT_DURATION,
  INVITE_DURATIONS,
  INVITE_GUESTS_MAX,
  INVITE_NOTES_MAX,
  INVITE_TITLE_MAX,
  inviteTitle,
  TIME_OPTIONS,
} from "@/lib/invite-rules";
import { parseDateTime } from "@/lib/time";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import { textareaClass } from "@/components/_ui/field-styles";

export type InviteGuestDraft = {
  email: string;
  name: string | null;
  contactId: string | null;
  company: string | null;
};

export type InvitePrefill = { date?: string; time?: string; guests?: InviteGuestDraft[]; title?: string; durationMinutes?: number; notes?: string };

type ErrorKey = "title" | "startLocal" | "durationMinutes" | "attendees" | "notes" | "form";
type Errors = Partial<Record<ErrorKey, string>>;

const FIELD_ERRORS = new Set<string>(["title", "startLocal", "durationMinutes", "attendees", "notes"]);

const RESULTS_SHOWN = 6;

function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours} hours`;
}

function sentMessage(guests: { email: string; name: string | null }[]) {
  const names = guests.map((guest) => guest.name ?? guest.email);
  if (names.length === 0) return "Invite sent";
  if (names.length === 1) return `Invite sent to ${names[0]}`;
  if (names.length === 2) return `Invite sent to ${names[0]} and ${names[1]}`;
  return `Invite sent to ${names[0]} and ${names.length - 1} others`;
}

function guestLabel(guest: InviteGuestDraft) {
  return guest.name ?? guest.email;
}

function ConnectionNotice({ setup }: { setup: InviteSetup }) {
  if (setup.connected && setup.canWriteCalendar) return null;
  return (
    <div role="alert" className="border-danger/40 flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5">
      <Button variant="link" size="none" className="text-danger text-left whitespace-normal" href="/capture">
        {setup.connected ? "Reconnect Microsoft to send invites" : "Connect Microsoft in Capture to send invites"}
      </Button>
      <p className="caption-style text-subtle">
        {setup.connected
          ? "Orbit now needs permission to add events to your Outlook calendar."
          : "Invites go out from your Outlook calendar."}
      </p>
    </div>
  );
}

function InviteForm({
  setup,
  prefill,
  now,
  onClose,
  onSent,
}: {
  setup: InviteSetup;
  prefill: InvitePrefill;
  now: number;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const router = useRouter();
  const ids = useId();
  const [slot] = useState(() => defaultInviteSlot(now));
  const [titleDraft, setTitleDraft] = useState<string | null>(prefill.title ?? null);
  const [date, setDate] = useState(prefill.date ?? slot.date);
  const [time, setTime] = useState(
    prefill.time ?? (prefill.date && prefill.date !== slot.date ? "09:00" : slot.time),
  );
  const [duration, setDuration] = useState(String(prefill.durationMinutes ?? INVITE_DEFAULT_DURATION));
  const [guests, setGuests] = useState<InviteGuestDraft[]>(prefill.guests ?? []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; contacts: Contact[]; failed?: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [notes, setNotes] = useState(prefill.notes ?? "");
  const [includeLink, setIncludeLink] = useState(Boolean(setup.meetingLink));
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [transactionId, setTransactionId] = useState(() => crypto.randomUUID());
  const trimmed = query.trim();
  const firstContact = guests.find((guest) => guest.contactId);
  const title = titleDraft ?? inviteTitle(firstContact?.name ?? null);
  const own = new Set(setup.ownEmails);
  const blocked = !setup.connected || !setup.canWriteCalendar;
  const field = (name: string) => `${ids}-${name}`;

  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchContactsToFileAction(trimmed).then(
        (rows) => {
          if (!cancelled) setResults({ query: trimmed, contacts: rows.contacts });
        },
        () => {
          if (!cancelled) setResults({ query: trimmed, contacts: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed]);

  const added = new Set(guests.map((guest) => guest.email));
  const matches =
    trimmed && results?.query === trimmed
      ? results.contacts
          .filter((contact) => !contact.email || !added.has(contact.email.toLowerCase()))
          .slice(0, RESULTS_SHOWN)
      : [];
  const choosable = matches.filter((contact) => contact.email);
  const listOpen = trimmed.length > 0;
  const activeIndex = Math.min(active, Math.max(choosable.length - 1, 0));

  function setError(key: keyof Errors, message: string | undefined) {
    setErrors((current) => ({ ...current, [key]: message }));
  }

  function addGuest(next: InviteGuestDraft) {
    const email = guestEmail(next.email);
    if (!email) {
      setError("attendees", `“${next.email.trim().slice(0, 80)}” isn't a valid email address.`);
      return false;
    }
    if (own.has(email)) {
      setError("attendees", "That's your own address. You're the organiser, so you're already in the meeting.");
      return false;
    }
    if (added.has(email)) return true;
    if (guests.length >= INVITE_GUESTS_MAX) {
      setError("attendees", `Invite up to ${INVITE_GUESTS_MAX} guests at a time.`);
      return false;
    }
    setGuests((current) => [...current, { ...next, email }]);
    setError("attendees", undefined);
    return true;
  }

  function addContact(contact: Contact) {
    if (!contact.email) return;
    if (
      addGuest({
        email: contact.email,
        name: contact.name,
        contactId: contact.id,
        company: contact.companyName,
      })
    ) {
      setQuery("");
      setActive(0);
    }
  }

  function addTyped() {
    const tokens = query.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length === 0) return;
    if (tokens.length === 1 && !guestEmail(tokens[0])) {
      const pick = choosable[activeIndex];
      if (pick) {
        addContact(pick);
        return;
      }
    }
    const left: string[] = [];
    for (const token of tokens) {
      const email = guestEmail(token);
      const contact = results?.contacts.find((item) => item.email?.toLowerCase() === email);
      const ok = addGuest(
        contact
          ? { email: token, name: contact.name, contactId: contact.id, company: contact.companyName }
          : { email: token, name: null, contactId: null, company: null },
      );
      if (!ok) left.push(token);
    }
    setQuery(left.join(" "));
    setActive(0);
  }

  function onGuestKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || (event.key === "," && trimmed)) {
      event.preventDefault();
      addTyped();
      return;
    }
    if (event.key === "ArrowDown" && choosable.length > 0) {
      event.preventDefault();
      setActive((activeIndex + 1) % choosable.length);
      return;
    }
    if (event.key === "ArrowUp" && choosable.length > 0) {
      event.preventDefault();
      setActive((activeIndex - 1 + choosable.length) % choosable.length);
      return;
    }
    if (event.key === "Backspace" && !query && guests.length > 0) {
      setGuests((current) => current.slice(0, -1));
    }
  }

  function validate() {
    const next: Errors = {};
    if (!title.trim()) next.title = "Add a title.";
    const start = parseDateTime(`${date}T${time}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !start) next.startLocal = "Pick a date and start time.";
    else if (start.getTime() <= Date.now()) next.startLocal = "Pick a start time in the future.";
    if (guests.length === 0) {
      next.attendees = trimmed ? "Press Enter to add this guest first." : "Add at least one guest.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked || !validate()) return;
    setPending(true);
    const result = await sendInviteAction({
      title,
      startLocal: `${date}T${time}`,
      durationMinutes: Number(duration),
      attendees: guests.map((guest) => ({ email: guest.email, name: guest.name })),
      notes,
      includeMeetingLink: Boolean(setup.meetingLink) && includeLink,
      contactIds: guests.map((guest) => guest.contactId).filter((id): id is string => Boolean(id)),
      transactionId,
    });
    setPending(false);
    if (result.error) {
      const key = (result.field && FIELD_ERRORS.has(result.field) ? result.field : "form") as ErrorKey;
      setErrors({ [key]: result.error });
      return;
    }
    setTransactionId(crypto.randomUUID());
    const message = sentMessage(result.guests ?? guests);
    onSent(result.warning ? `${message}. ${result.warning}` : `${message}.`);
    router.refresh();
    onClose();
  }

  const listId = field("guest-results");

  return (
    <form noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New meeting</DialogTitle>
        <DialogDescription>
          Outlook sends the invite from your connected mailbox and adds it to your calendar.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-6 py-5">
        <ConnectionNotice setup={setup} />
        <Field label="Title" htmlFor={field("title")} required error={errors.title}>
          <Input
            id={field("title")}
            value={title}
            maxLength={INVITE_TITLE_MAX}
            autoComplete="off"
            placeholder="What's the meeting about?"
            aria-invalid={errors.title ? true : undefined}
            onChange={(event) => {
              setTitleDraft(event.target.value);
              setError("title", undefined);
            }}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_7em_8em]">
          <Field label="Date" htmlFor={field("date")} required>
            <DatePicker
              id={field("date")}
              value={date}
              aria-invalid={errors.startLocal ? true : undefined}
              aria-describedby={errors.startLocal ? field("when-error") : undefined}
              onChange={(next) => {
                setDate(next);
                setError("startLocal", undefined);
              }}
            />
          </Field>
          <Field label="Start" htmlFor={field("time")} required>
            <Select
              value={time}
              onValueChange={(value) => {
                setTime(value);
                setError("startLocal", undefined);
              }}
            >
              <SelectTrigger id={field("time")} aria-invalid={errors.startLocal ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {(TIME_OPTIONS.includes(time) ? TIME_OPTIONS : [...TIME_OPTIONS, time].sort()).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Duration" htmlFor={field("duration")} required error={errors.durationMinutes}>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger id={field("duration")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_DURATIONS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {durationLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {errors.startLocal ? (
          <p id={field("when-error")} role="alert" className="caption-style text-danger -mt-2">
            {errors.startLocal}
          </p>
        ) : (
          <p className="caption-style text-subtle -mt-2">London time.</p>
        )}
        <Field
          label="Guests"
          htmlFor={field("guests")}
          required
          error={errors.attendees}
          hint="Search your contacts, or type any email address and press Enter."
        >
          <div className="relative">
            <div
              className={cn(
                "border-line-strong bg-secondary focus-within:border-ring flex min-h-9 flex-wrap items-center gap-1 rounded-lg border px-1.5 py-1",
                errors.attendees && "border-danger",
              )}
            >
              {guests.map((guest) => (
                <span
                  key={guest.email}
                  className="bg-muted flex max-w-full items-center gap-1 rounded-full py-0.5 pr-0.5 pl-2.5 text-[13px] leading-5"
                  title={guest.email}
                >
                  <span className="truncate">{guestLabel(guest)}</span>
                  {guest.company && <span className="text-subtle truncate">· {guest.company}</span>}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    aria-label={`Remove ${guestLabel(guest)}`}
                    onClick={() => setGuests((current) => current.filter((item) => item.email !== guest.email))}
                  >
                    <XIcon aria-hidden className="size-3" />
                  </Button>
                </span>
              ))}
              <input
                id={field("guests")}
                role="combobox"
                aria-expanded={listOpen}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  listOpen && choosable[activeIndex] ? `${listId}-${choosable[activeIndex].id}` : undefined
                }
                aria-describedby={errors.attendees ? `${field("guests")}-error` : `${field("guests")}-hint`}
                aria-invalid={errors.attendees ? true : undefined}
                value={query}
                autoComplete="off"
                spellCheck={false}
                placeholder={guests.length === 0 ? "Name or email" : "Add another"}
                className="placeholder:text-subtle h-7 min-w-[10em] flex-1 bg-transparent px-1.5 text-[14px] outline-none"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  setError("attendees", undefined);
                }}
                onKeyDown={onGuestKey}
                onBlur={() => {
                  if (guestEmail(trimmed)) addTyped();
                }}
              />
            </div>
            {listOpen && (
              <ul
                id={listId}
                role="listbox"
                aria-label="Matching contacts"
                className="border-line-strong bg-popover shadow-overlay absolute inset-x-0 top-full z-10 mt-1 flex max-h-60 flex-col overflow-auto rounded-lg border p-1"
              >
                {results?.query !== trimmed ? (
                  <li className="caption-style text-subtle px-2 py-2">Searching…</li>
                ) : results.failed ? (
                  <li className="caption-style text-danger px-2 py-2">Search is unavailable right now.</li>
                ) : matches.length === 0 ? (
                  <li className="caption-style text-subtle px-2 py-2">
                    {guestEmail(trimmed) ? `Press Enter to invite ${trimmed}.` : `No contacts match “${trimmed}”.`}
                  </li>
                ) : (
                  matches.map((contact) => {
                    const selectable = Boolean(contact.email);
                    const selected = selectable && choosable[activeIndex]?.id === contact.id;
                    return (
                      <li
                        key={contact.id}
                        id={`${listId}-${contact.id}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={!selectable}
                        className={cn(
                          "flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5",
                          selected && "bg-white/6",
                          !selectable && "cursor-not-allowed opacity-50",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => addContact(contact)}
                      >
                        <span className="truncate text-[14px] leading-5">{contact.name}</span>
                        <span className="caption-style text-subtle truncate">
                          {[contact.email ?? "No email address", contact.companyName].filter(Boolean).join(" · ")}
                        </span>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>
        </Field>
        <Field label="Notes" htmlFor={field("notes")} error={errors.notes}>
          <textarea
            id={field("notes")}
            value={notes}
            maxLength={INVITE_NOTES_MAX}
            placeholder="Agenda or anything guests should know"
            onChange={(event) => setNotes(event.target.value)}
            className={cn(textareaClass, "min-h-24")}
          />
        </Field>
        <div className="flex items-start gap-2">
          <Checkbox
            id={field("link")}
            className="mt-0.5"
            checked={Boolean(setup.meetingLink) && includeLink}
            disabled={!setup.meetingLink}
            aria-describedby={field("link-detail")}
            onCheckedChange={(next) => setIncludeLink(next === true)}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <label
              htmlFor={field("link")}
              className={cn("text-[14px] leading-5", setup.meetingLink ? "cursor-pointer" : "text-subtle")}
            >
              Add meeting link
            </label>
            {setup.meetingLink ? (
              <span id={field("link-detail")} className="caption-style text-subtle truncate">
                {setup.meetingLink}
              </span>
            ) : (
              <span id={field("link-detail")} className="caption-style text-subtle">
                Add your meeting link in{" "}
                <Button variant="link" size="none" href={`${SETTINGS_PATHS.general}#meeting-link`}>
                  Settings
                </Button>{" "}
                first.
              </span>
            )}
          </div>
        </div>
        {errors.form && (
          <p role="alert" className="caption-style text-danger">
            {/Reconnect Microsoft|Connect Microsoft/.test(errors.form) ? (
              <Button variant="link" size="none" className="text-danger text-left whitespace-normal" href="/capture">
                {errors.form}
              </Button>
            ) : (
              errors.form
            )}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={pending || blocked}>
          {pending ? "Sending…" : "Send invites"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function InviteDialog({
  open,
  onOpenChange,
  setup,
  prefill,
  now,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setup: InviteSetup;
  prefill: InvitePrefill;
  now: number;
  onSent: (message: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        {open && (
          <InviteForm
            setup={setup}
            prefill={prefill}
            now={now}
            onClose={() => onOpenChange(false)}
            onSent={onSent}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export const NoticeContext = createContext<(message: string) => void>(() => {});

export function InviteNotice({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDone, 6000);
    return () => window.clearTimeout(timer);
  }, [message, onDone]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      {message && (
        <p className="bg-popover border-line-strong shadow-overlay pointer-events-auto max-w-[32em] rounded-full border px-4 py-2 text-[14px] leading-5">
          {message}
        </p>
      )}
    </div>
  );
}
