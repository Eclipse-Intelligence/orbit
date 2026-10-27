"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from "react";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import BookingBackground from "@/components/booking/booking-background";
import BookingCalendar from "@/components/booking/booking-calendar";
import type { BookingConfirmation, SlotMonth } from "@/lib/booking/book";
import { allZones, browserZone, dayTitle, fullWhen, timeOf, todayKey, zoneLabel } from "@/lib/booking/format";
import type { PublicBookingPage } from "@/lib/booking/pages";
import { BOOKING_NAME_MAX, BOOKING_NOTE_MAX, durationLabel, initials } from "@/lib/booking/rules";
import { shiftMonth } from "@/lib/booking/slots";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/booking/check.svg";
import ClockIcon from "@/public/assets/images/booking/clock.svg";
import GlobeIcon from "@/public/assets/images/booking/globe.svg";
import VideoIcon from "@/public/assets/images/booking/video.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";

type Loaded = { ok: true; data: SlotMonth } | { ok: false; error: string };
type FieldName = "name" | "email" | "note";
type Errors = Partial<Record<FieldName | "form" | "slot", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = new Set<string>(["name", "email", "note"]);

function noop() {
  return () => undefined;
}

function useBrowserZone() {
  return useSyncExternalStore(noop, browserZone, () => null);
}

function MeetingChips({ page }: { page: PublicBookingPage }) {
  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.06] px-2.5 text-[12px] leading-none text-soft";
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Meeting details">
      <li className={chip}>
        <ClockIcon aria-hidden className="size-3.5" />
        {durationLabel(page.durationMinutes)}
      </li>
      {page.meetingKind && (
        <li className={chip}>
          <VideoIcon aria-hidden className="size-3.5" />
          {page.meetingKind === "whereby" ? "Whereby video call" : "Video call"}
        </li>
      )}
    </ul>
  );
}

function OwnerAvatar({ page }: { page: PublicBookingPage }) {
  if (page.avatarUrl) {
    return (
      <div
        role="img"
        aria-label={page.ownerName}
        style={{ "--avatar": `url("${page.avatarUrl}")` } as CSSProperties}
        className="size-16 shrink-0 rounded-full bg-(image:--avatar) bg-cover bg-center shadow-[0px_0px_0px_1px_rgba(255,255,255,0.14),0px_8px_24px_0px_rgba(0,0,0,0.45)]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex size-16 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#4124fb,#16c89e)] text-[20px] font-semibold text-white shadow-[0px_0px_0px_1px_rgba(255,255,255,0.14),0px_8px_24px_0px_rgba(0,0,0,0.45)]"
    >
      {initials(page.ownerName)}
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
}

function Confirmation({ booking, embedded }: { booking: BookingConfirmation; embedded: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const sameZone = booking.timeZone === booking.pageTimeZone;
  const Heading = embedded ? "h3" : "h1";
  return (
    <div className="animate-rise-in flex flex-col items-center gap-6 py-6 text-center motion-reduce:animate-none">
      <div className="bg-success/15 text-success flex size-14 items-center justify-center rounded-full shadow-[inset_0px_0px_0px_1px_rgba(34,197,94,0.35),0px_0px_32px_0px_rgba(34,197,94,0.25)]">
        <CheckIcon aria-hidden className="size-6" />
      </div>
      <div className="flex flex-col gap-2">
        <Heading ref={heading} tabIndex={-1} className="text-[24px] leading-tight font-semibold outline-none">
          You&apos;re booked
        </Heading>
        <p className="text-soft text-[15px] leading-5">{booking.subject}</p>
      </div>
      <div className="flex w-full flex-col gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4 text-left">
        <div className="flex items-start gap-3">
          <CalendarIcon aria-hidden className="text-soft mt-0.5 size-4 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-[14px] leading-5 font-medium">{fullWhen(booking.startsAt, booking.endsAt, booking.timeZone)}</p>
            <p className="caption-style text-subtle leading-4">{zoneLabel(booking.timeZone, new Date(booking.startsAt))}</p>
            {!sameZone && (
              <p className="caption-style text-subtle leading-4">
                {timeOf(booking.startsAt, booking.pageTimeZone)} to {timeOf(booking.endsAt, booking.pageTimeZone)}{" "}
                {zoneLabel(booking.pageTimeZone, new Date(booking.startsAt))} for {booking.ownerName.split(" ")[0]}
              </p>
            )}
          </div>
        </div>
        {booking.meetingKind && (
          <div className="flex items-center gap-3">
            <VideoIcon aria-hidden className="text-soft size-4 shrink-0" />
            <p className="text-soft text-[14px] leading-5">
              {booking.meetingKind === "whereby" ? "Whereby video call" : "Video call"}, link in the invitation
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-soft text-[14px] leading-5">
          An invitation is on its way to <span className="text-foreground font-medium break-all">{booking.email}</span>.
        </p>
        {!embedded && <p className="caption-style text-subtle leading-4">You can close this page.</p>}
      </div>
    </div>
  );
}

export function BookingPanel({
  page,
  defaults,
  className,
  embedded = false,
}: {
  page: PublicBookingPage;
  defaults?: { name?: string; email?: string };
  className?: string;
  embedded?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const detected = useBrowserZone();
  const [chosenZone, setChosenZone] = useState<string | null>(null);
  const zone = chosenZone ?? detected;
  const [month, setMonth] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Loaded>>({});
  const [reload, setReload] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState(defaults?.name ?? "");
  const [email, setEmail] = useState(defaults?.email ?? "");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [booking, setBooking] = useState<BookingConfirmation | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const loadedKeys = useRef(new Set<string>());
  const idBase = useId();
  const fieldId = (field: FieldName | "website") => `${idBase}-booking-${field}`;
  const Title = embedded ? "h3" : "h1";
  const Subheading = embedded ? "h4" : "h2";

  const key = zone ? `${zone}|${month ?? ""}` : null;
  const loaded = key ? results[key] : undefined;
  const data = loaded?.ok ? loaded.data : null;
  const loading = !loaded;

  useEffect(() => {
    const requested = loadedKeys.current;
    if (!zone || !key || requested.has(key)) return;
    requested.add(key);
    let done = false;
    const controller = new AbortController();
    const params = new URLSearchParams({ tz: zone });
    if (month) params.set("month", month);
    fetch(`/api/book/${encodeURIComponent(page.slug)}/slots?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (SlotMonth & { error?: { message?: string } }) | null;
        if (!response.ok || !body || body.error) {
          throw new Error(body?.error?.message ?? "Couldn't load times. Try again.");
        }
        return body;
      })
      .then((body) => {
        done = true;
        requested.add(`${zone}|${body.month}`);
        setResults((current) => ({
          ...current,
          [key]: { ok: true, data: body },
          [`${zone}|${body.month}`]: { ok: true, data: body },
        }));
      })
      .catch((error: unknown) => {
        done = true;
        if (controller.signal.aborted) return;
        requested.delete(key);
        setResults((current) => ({
          ...current,
          [key]: { ok: false, error: error instanceof Error ? error.message : "Couldn't load times. Try again." },
        }));
      });
    return () => {
      if (done) return;
      controller.abort();
      requested.delete(key);
    };
  }, [zone, key, month, page.slug, reload]);

  const shownMonth = data?.month ?? month;
  const days = data?.days ?? {};
  const openDays = Object.keys(days).filter((day) => days[day].length > 0).sort();
  const activeDay = selectedDay && days[selectedDay]?.length ? selectedDay : (openDays[0] ?? null);
  const times = activeDay ? days[activeDay] : [];
  const activeSlot = slot && times.includes(slot) ? slot : null;
  const slotEnd = activeSlot ? new Date(Date.parse(activeSlot) + page.durationMinutes * 60_000).toISOString() : null;

  function refresh() {
    if (!key) return;
    loadedKeys.current.clear();
    setResults({});
    setReload((value) => value + 1);
  }

  function changeMonth(step: number) {
    if (!shownMonth) return;
    setMonth(shiftMonth(shownMonth, step));
    setSelectedDay(null);
    setSlot(null);
  }

  function pickSlot(value: string) {
    setSlot(value);
    setErrors((current) => ({ ...current, slot: undefined, form: undefined }));
    requestAnimationFrame(() => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      formRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    });
  }

  function validate() {
    const found: Errors = {};
    if (!name.trim()) found.name = "Enter your name.";
    else if (name.trim().length > BOOKING_NAME_MAX) found.name = `Keep your name under ${BOOKING_NAME_MAX + 1} characters.`;
    if (!EMAIL.test(email.trim())) found.email = "Enter a valid email address.";
    if (note.trim().length > BOOKING_NOTE_MAX) found.note = `Keep the note under ${BOOKING_NOTE_MAX + 1} characters.`;
    return found;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSlot || pending) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = (["name", "email", "note"] as const).find((field) => found[field]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    setPending(true);
    try {
      const response = await fetch(`/api/book/${encodeURIComponent(page.slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: activeSlot, name, email, note, website, timeZone: zone }),
      });
      const body = (await response.json().catch(() => null)) as {
        booking?: BookingConfirmation;
        error?: { code?: string; message?: string; details?: { field?: string } | null };
      } | null;
      if (response.ok && body?.booking) {
        setBooking(body.booking);
        if (embedded) panel.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        else window.scrollTo({ top: 0 });
        return;
      }
      const message = body?.error?.message ?? "Something went wrong. Try again.";
      const field = body?.error?.details?.field;
      if (response.status === 409) {
        setSlot(null);
        setErrors({ slot: message });
        refresh();
        return;
      }
      if (field && FIELDS.has(field)) {
        setErrors({ [field]: message });
        document.getElementById(fieldId(field as FieldName))?.focus();
        return;
      }
      setErrors({ form: message });
    } catch {
      setErrors({ form: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  const today = zone ? todayKey(zone) : "";
  const zones = zone ? allZones(zone) : [];

  return (
    <div ref={panel} className={cn("flex flex-1 scroll-mt-32 flex-col gap-7 px-5 pt-7 pb-8 sm:px-8", className)}>
      {booking ? (
        <Confirmation booking={booking} embedded={embedded} />
      ) : (
        <>
          <header className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <OwnerAvatar page={page} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="text-soft text-[13px] leading-4">{page.ownerName}</p>
                <Title className="text-[22px] leading-[1.15] font-semibold tracking-[-0.01em] text-balance">{page.title}</Title>
              </div>
            </div>
            {page.intro && (
              <p className="text-soft text-[14px] leading-[1.5] whitespace-pre-line text-pretty">{page.intro}</p>
            )}
            <MeetingChips page={page} />
          </header>

          <div className="h-px bg-white/[0.08]" />

          {loaded && !loaded.ok ? (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4">
              <p className="text-soft text-[14px] leading-5">{loaded.error}</p>
              <Button variant="secondary" size="md" onClick={refresh}>
                Try again
              </Button>
            </div>
          ) : (
            <BookingCalendar
              embedded={embedded}
              month={shownMonth ?? todayKey(page.timeZone).slice(0, 7)}
              days={days}
              loading={loading}
              selected={activeDay}
              today={today}
              canPrev={Boolean(data && shownMonth && shownMonth > data.first)}
              canNext={Boolean(data && shownMonth && shownMonth < data.last)}
              onMonth={changeMonth}
              onSelect={(day) => {
                setSelectedDay(day);
                setSlot(null);
              }}
            />
          )}

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <Subheading className="text-[15px] leading-5 font-medium">
                {activeDay ? dayTitle(activeDay) : loading ? "Available times" : "No times this month"}
              </Subheading>
              <div className="text-subtle hover:text-soft relative flex h-7 max-w-[60%] items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 text-[12px] leading-none transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring/80">
                <GlobeIcon aria-hidden className="size-3.5 shrink-0" />
                <span aria-hidden className="truncate">
                  {zone ? zoneLabel(zone) : "Detecting time zone…"}
                </span>
                {zone && (
                  <select
                    aria-label="Time zone"
                    value={zone}
                    onChange={(event) => {
                      setChosenZone(event.target.value);
                      setMonth(null);
                      setSelectedDay(null);
                      setSlot(null);
                    }}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  >
                    {zones.map((item) => (
                      <option key={item} value={item}>
                        {item.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
            {errors.slot && (
              <p role="alert" className="text-danger text-[13px] leading-5">
                {errors.slot}
              </p>
            )}
            {loading ? (
              <div aria-hidden className="grid grid-cols-3 gap-2">
                {Array.from({ length: 9 }, (_, index) => (
                  <span key={index} className="h-10 animate-pulse rounded-full bg-white/[0.05]" />
                ))}
              </div>
            ) : times.length > 0 ? (
              <ul aria-label={activeDay ? `Times on ${dayTitle(activeDay)}` : "Times"} className="grid grid-cols-3 gap-2">
                {times.map((time) => {
                  const active = time === activeSlot;
                  return (
                    <li key={time}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => pickSlot(time)}
                        className={cn(
                          "focus-visible:ring-ring/80 flex h-10 w-full cursor-pointer items-center justify-center rounded-full border text-[13px] leading-none font-medium tabular-nums transition-[background-color,border-color,color,box-shadow] duration-150 ease-power3-out outline-none focus-visible:ring-2",
                          active
                            ? "bg-primary border-transparent text-white shadow-[0px_4px_14px_0px_rgba(65,36,251,0.45),inset_0px_1px_0px_0px_rgba(255,255,255,0.2)]"
                            : "text-foreground border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]",
                        )}
                      >
                        {timeOf(time, zone ?? page.timeZone)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4">
                <p className="text-soft text-[14px] leading-5">
                  Every slot this month is taken or out of range.
                </p>
                {data && shownMonth && shownMonth < data.last && (
                  <Button variant="secondary" size="md" onClick={() => changeMonth(1)}>
                    See next month
                  </Button>
                )}
              </div>
            )}
          </div>

          {activeSlot && slotEnd && (
            <form
              ref={formRef}
              noValidate
              onSubmit={submit}
              aria-label="Your details"
              className="animate-rise-in flex scroll-mt-6 flex-col gap-4 motion-reduce:animate-none"
            >
              <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
                <CalendarIcon aria-hidden className="text-soft size-4 shrink-0" />
                <p className="text-[14px] leading-5">
                  <span className="font-medium">{fullWhen(activeSlot, slotEnd, zone ?? page.timeZone)}</span>
                </p>
              </div>
              <Field label="Name" htmlFor={fieldId("name")} required error={errors.name}>
                <Input
                  id={fieldId("name")}
                  name="name"
                  autoComplete="name"
                  maxLength={BOOKING_NAME_MAX}
                  value={name}
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={errors.name ? `${fieldId("name")}-error` : undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                    setErrors((current) => ({ ...current, name: undefined }));
                  }}
                  className="h-11 rounded-xl border-white/10 bg-white/[0.04] focus-visible:border-white/40"
                />
              </Field>
              <Field label="Email" htmlFor={fieldId("email")} required error={errors.email}>
                <Input
                  id={fieldId("email")}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  maxLength={200}
                  value={email}
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? `${fieldId("email")}-error` : undefined}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setErrors((current) => ({ ...current, email: undefined }));
                  }}
                  className="h-11 rounded-xl border-white/10 bg-white/[0.04] focus-visible:border-white/40"
                />
              </Field>
              <Field
                label="Note"
                htmlFor={fieldId("note")}
                hint="Optional. Anything you'd like to cover?"
                error={errors.note}
              >
                <textarea
                  id={fieldId("note")}
                  name="note"
                  rows={3}
                  maxLength={BOOKING_NOTE_MAX}
                  value={note}
                  aria-invalid={errors.note ? true : undefined}
                  aria-describedby={errors.note ? `${fieldId("note")}-error` : `${fieldId("note")}-hint`}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setErrors((current) => ({ ...current, note: undefined }));
                  }}
                  className="text-foreground placeholder:text-subtle min-h-[88px] w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[14px] leading-5 outline-none transition-[border-color] duration-150 ease-power3-out focus-visible:border-white/40"
                />
              </Field>
              <div aria-hidden className="absolute -left-[9999px] size-px overflow-hidden">
                <label htmlFor={fieldId("website")}>Website</label>
                <input
                  id={fieldId("website")}
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </div>
              {errors.form && (
                <p role="alert" className="text-danger text-[13px] leading-5">
                  {errors.form}
                </p>
              )}
              <Button
                variant="primary"
                size="md"
                type="submit"
                disabled={pending}
                aria-busy={pending}
                className="h-12 w-full text-[15px]"
              >
                {pending && <Spinner />}
                {pending ? "Booking…" : "Book"}
              </Button>
            </form>
          )}
        </>
      )}
      {!embedded && <p className="caption-style text-soft mt-auto pt-2 text-center">Scheduling by Orbit from Eclipse</p>}
    </div>
  );
}

export default function BookingScreen({ page }: { page: PublicBookingPage }) {
  return (
    <main className="relative min-h-dvh">
      <BookingBackground videoUrl={page.videoUrl} posterUrl={page.posterUrl} />
      <div className="relative flex min-h-dvh flex-col max-lg:pt-[22svh] lg:block">
        <section
          aria-label={page.title}
          className="animate-panel-in flex min-h-0 flex-1 flex-col rounded-t-[28px] border border-white/10 bg-[#0b0b10]/65 shadow-[0px_24px_80px_0px_rgba(0,0,0,0.55),inset_0px_1px_0px_0px_rgba(255,255,255,0.08)] backdrop-blur-2xl backdrop-saturate-150 motion-reduce:animate-none max-lg:border-b-0 lg:fixed lg:inset-y-6 lg:right-6 lg:w-[440px] lg:rounded-[28px]"
        >
          <BookingPanel page={page} className="lg:overflow-y-auto lg:overscroll-contain" />
        </section>
      </div>
    </main>
  );
}
