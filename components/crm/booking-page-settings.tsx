"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import { SettingsCard } from "@/components/crm/settings-ui";
import Switch from "@/components/_ui/switch";
import { checkBookingSlugAction, saveBookingPageAction } from "@/app/(crm)/settings/actions";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";
import type { BookingPageSettings as Settings, BookingSetup } from "@/lib/booking/pages";
import {
  BOOKING_BUFFER_MAX,
  BOOKING_DURATIONS,
  BOOKING_HORIZON_MAX,
  BOOKING_IMAGE_MAX_BYTES,
  BOOKING_IMAGE_TYPES,
  BOOKING_INTRO_MAX,
  BOOKING_SLUG_MAX,
  BOOKING_TITLE_MAX,
  BOOKING_VIDEO_URL_MAX,
  bookingPath,
  checkSlug,
  checkVideoUrl,
  checkWeeklyHours,
  DEFAULT_HOURS,
  durationLabel,
  initials,
  noticeLabel,
  BOOKING_NOTICE_OPTIONS,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type BookingImageKind,
  type Weekday,
  type WeeklyHours,
} from "@/lib/booking/rules";
import { TIME_OPTIONS } from "@/lib/invite-rules";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import CopyIcon from "@/public/assets/images/booking/copy.svg";
import ExternalIcon from "@/public/assets/images/booking/external.svg";

type Draft = {
  slug: string;
  enabled: boolean;
  title: string;
  intro: string;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: string;
  weeklyHours: WeeklyHours;
  videoUrl: string;
};

type SlugState = { slug: string; state: "idle" | "checking" | "available" | "taken"; message: string | null };

const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60].filter((value) => value <= BOOKING_BUFFER_MAX);
const END_OPTIONS = [...TIME_OPTIONS.slice(1), "24:00"];
const ACCEPT = BOOKING_IMAGE_TYPES.join(",");

function draftFrom(page: Settings): Draft {
  return {
    slug: page.slug,
    enabled: page.enabled,
    title: page.title ?? "",
    intro: page.intro ?? "",
    durationMinutes: page.durationMinutes,
    bufferMinutes: page.bufferMinutes,
    minNoticeMinutes: page.minNoticeMinutes,
    horizonDays: String(page.horizonDays),
    weeklyHours: page.weeklyHours,
    videoUrl: page.videoUrl ?? "",
  };
}


function Notice({ tone, children }: { tone: "warning" | "danger"; children: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "caption-style rounded-lg border px-3 py-2.5 leading-[1.45]",
        tone === "warning"
          ? "border-[var(--tag-amber-border)] bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)]"
          : "border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] text-[var(--tag-red-text)]",
      )}
    >
      {children}
    </div>
  );
}

function ChoiceSelect({
  id,
  value,
  options,
  onChange,
  label,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ImagePicker({
  kind,
  title,
  hint,
  has,
  version,
  disabled,
  round,
  fallback,
  onChanged,
}: {
  kind: BookingImageKind;
  title: string;
  hint: string;
  has: boolean;
  version: string;
  disabled: boolean;
  round: boolean;
  fallback: ReactNode;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = has ? `/api/booking-page/image?kind=${kind}&v=${encodeURIComponent(version)}` : null;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!(BOOKING_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setError("Use a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > BOOKING_IMAGE_MAX_BYTES) {
      setError("Use an image under 1 MB.");
      return;
    }
    setError(null);
    setPending(true);
    const body = new FormData();
    body.set("file", file);
    const response = await fetch(`/api/booking-page/image?kind=${kind}`, { method: "POST", body }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(payload?.error?.message ?? "Could not upload the image.");
      return;
    }
    onChanged();
  }

  async function remove() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/booking-page/image?kind=${kind}`, { method: "DELETE" }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      setError("Could not remove the image.");
      return;
    }
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        {src ? (
          <div
            role="img"
            aria-label={`Current ${title.toLowerCase()}`}
            style={{ "--image": `url("${src}")` } as CSSProperties}
            className={cn(
              "shrink-0 bg-(image:--image) bg-cover bg-center outline-1 -outline-offset-1 outline-white/10",
              round ? "size-14 rounded-full" : "aspect-video w-24 rounded-lg",
            )}
          />
        ) : (
          fallback
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[14px] leading-5">{title}</span>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || pending}
              onClick={() => input.current?.click()}
            >
              {pending ? "Saving…" : has ? "Replace" : "Upload"}
            </Button>
            {has && (
              <Button variant="ghost" size="sm" disabled={disabled || pending} onClick={remove}>
                Remove
              </Button>
            )}
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label={`Upload ${title.toLowerCase()}`}
          onChange={upload}
        />
      </div>
      {error ? (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      ) : (
        <p className="caption-style text-subtle leading-[1.4]">{hint}</p>
      )}
    </div>
  );
}

export default function BookingPageSettings({
  page,
  setup,
  origin,
}: {
  page: Settings;
  setup: BookingSetup;
  origin: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(page);
  const [draft, setDraft] = useState(() => draftFrom(page));
  if (saved !== page) {
    const changed = JSON.stringify(draftFrom(saved)) !== JSON.stringify(draftFrom(page));
    setSaved(page);
    if (changed) setDraft(draftFrom(page));
  }
  const [slugState, setSlugState] = useState<SlugState>({ slug: "", state: "idle", message: null });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const slug = draft.slug.trim().toLowerCase();
  const url = `${origin}${bookingPath(slug || page.slug)}`;
  const liveUrl = `${origin}${bookingPath(page.slug)}`;
  const dirty = JSON.stringify(draftFrom(page)) !== JSON.stringify(draft);
  const anyDay = WEEKDAYS.some((day) => draft.weeklyHours[day].length > 0);

  useEffect(() => {
    if (slug === page.slug && page.exists) return;
    const local = checkSlug(slug);
    if (!local.ok) return;
    let active = true;
    const timer = setTimeout(() => {
      setSlugState({ slug, state: "checking", message: null });
      checkBookingSlugAction(slug)
        .then((result) => {
          if (!active) return;
          setSlugState(
            result.available
              ? { slug, state: "available", message: "Available" }
              : { slug, state: "taken", message: result.error ?? "That link is taken. Pick another." },
          );
        })
        .catch(() => active && setSlugState({ slug, state: "idle", message: null }));
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [slug, page.slug, page.exists]);

  const localSlug = checkSlug(slug);
  const slugCheck = slugState.slug === slug ? slugState.state : "idle";
  const slugMessage = !localSlug.ok
    ? slug
      ? localSlug.error
      : "Choose the link people will use."
    : slug === page.slug && page.exists
      ? null
      : slugCheck === "taken"
        ? slugState.message
        : null;
  const slugHint =
    localSlug.ok && !(slug === page.slug && page.exists)
      ? slugCheck === "checking"
        ? "Checking…"
        : slugCheck === "available"
          ? "Available"
          : undefined
      : undefined;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      delete next.form;
      return next;
    });
    setMessage(null);
  }

  function setDay(day: Weekday, ranges: WeeklyHours[Weekday]) {
    update("weeklyHours", { ...draft.weeklyHours, [day]: ranges });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const found: Record<string, string> = {};
    if (!localSlug.ok) found.slug = localSlug.error;
    else if (slugCheck === "taken" && !(slug === page.slug && page.exists)) {
      found.slug = slugState.message ?? "That link is taken.";
    }
    const video = checkVideoUrl(draft.videoUrl);
    if (!video.ok) found.videoUrl = video.error;
    const hours = checkWeeklyHours(draft.weeklyHours);
    if (!hours.ok) found.weeklyHours = hours.error;
    else if (draft.enabled && !anyDay) found.weeklyHours = "Turn on at least one day before you switch the page on.";
    const horizon = Number(draft.horizonDays);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > BOOKING_HORIZON_MAX) {
      found.horizonDays = `Pick between 1 and ${BOOKING_HORIZON_MAX} days.`;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    const result = await saveBookingPageAction({
      slug,
      enabled: draft.enabled,
      title: draft.title,
      intro: draft.intro,
      durationMinutes: draft.durationMinutes,
      bufferMinutes: draft.bufferMinutes,
      minNoticeMinutes: draft.minNoticeMinutes,
      horizonDays: horizon,
      weeklyHours: draft.weeklyHours,
      videoUrl: draft.videoUrl,
    }).catch((error: unknown) => ({
      error: reloadIfStaleDeploy(error)
        ? "Orbit was just updated. Reloading…"
        : "Could not save the booking page. Check your connection and try again.",
      field: undefined,
      page: undefined,
    }));
    setPending(false);
    if (result.error || !result.page) {
      setErrors({ [result.field ?? "form"]: result.error ?? "Could not save the booking page." });
      return;
    }
    setMessage(result.page.enabled ? "Saved. Your page is live." : "Saved. Your page is off.");
    router.refresh();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const warnings: ReactNode[] = [];
  if (!setup.connected) {
    warnings.push(
      <>
        Microsoft isn&apos;t connected, so bookings can&apos;t create meetings.{" "}
        <a href="/capture" className="underline underline-offset-2">
          Connect Microsoft in Capture
        </a>
        .
      </>,
    );
  } else if (!setup.canWriteCalendar) {
    warnings.push(
      <>
        Orbit can read your calendar but can&apos;t create meetings yet.{" "}
        <a href="/capture" className="underline underline-offset-2">
          Reconnect Microsoft in Capture
        </a>{" "}
        to allow it.
      </>,
    );
  }
  if (!setup.meetingLink) {
    warnings.push(
      <>
        No meeting link is set, so invites won&apos;t include a video call.{" "}
        <a href={`${SETTINGS_PATHS.general}#meeting-link`} className="underline underline-offset-2">
          Add your Whereby link in General
        </a>
        .
      </>,
    );
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={save}>
      {(warnings.length > 0 || page.lastError) && (
        <div className="flex flex-col gap-2">
          {page.lastError && (
            <Notice tone="danger">
              The last booking attempt failed: {page.lastError}
              {page.lastErrorAt && (
                <span className="opacity-75">
                  {" "}
                  (
                  {new Intl.DateTimeFormat("en-GB", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "Europe/London",
                  }).format(new Date(page.lastErrorAt))}
                  )
                </span>
              )}
            </Notice>
          )}
          {warnings.map((warning, index) => (
            <Notice key={index} tone="warning">
              {warning}
            </Notice>
          ))}
        </div>
      )}

      <SettingsCard
        id="booking-link"
        title="Public page"
        description={
          page.exists
            ? page.enabled
              ? "Your page is live. Anyone with the link can book time with you."
              : "Your page is off. Visitors see a not-found page."
            : "Choose a link, then save to create your page."
        }
        action={
          <label className="flex items-center gap-2 text-[14px] leading-none">
            <span className="text-soft">{draft.enabled ? "On" : "Off"}</span>
            <Switch checked={draft.enabled} onChange={(value) => update("enabled", value)} label="Booking page on" />
          </label>
        }
      >
        <Field
          label="Link"
          htmlFor="booking-slug"
          error={errors.slug ?? slugMessage ?? undefined}
          hint={slugHint ?? "Lowercase letters, numbers and hyphens."}
        >
          <div className="border-line-strong bg-secondary focus-within:border-ring flex h-9 items-center overflow-hidden rounded-lg border transition-[border-color] duration-150">
            <span className="text-subtle hidden shrink-0 pl-3 text-[14px] leading-none whitespace-nowrap sm:block">
              {origin.replace(/^https?:\/\//, "")}
              {bookingPath("")}
            </span>
            <input
              id="booking-slug"
              value={draft.slug}
              maxLength={BOOKING_SLUG_MAX}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={errors.slug || slugMessage ? true : undefined}
              aria-describedby={errors.slug || slugMessage ? "booking-slug-error" : "booking-slug-hint"}
              onChange={(event) => update("slug", event.target.value.toLowerCase().replace(/\s+/g, "-"))}
              className="text-foreground h-full min-w-0 flex-1 bg-transparent px-3 text-[14px] leading-none outline-none sm:pl-0.5"
            />
          </div>
        </Field>
        {page.exists && (
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-soft bg-muted min-w-0 flex-1 truncate rounded-md px-2.5 py-2 text-[13px] leading-none">
              {liveUrl}
            </code>
            <Button variant="secondary" size="sm" onClick={copy}>
              <CopyIcon aria-hidden className="size-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
            {page.enabled ? (
              <a
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <ExternalIcon aria-hidden className="size-3.5" />
                Open
              </a>
            ) : (
              <Button variant="secondary" size="sm" disabled title="Turn the page on to open it">
                <ExternalIcon aria-hidden className="size-3.5" />
                Open
              </Button>
            )}
            <span role="status" className="sr-only">
              {copied ? "Link copied" : ""}
            </span>
          </div>
        )}
        {page.exists && slug !== page.slug && localSlug.ok && (
          <p className="caption-style text-subtle leading-[1.4]">
            After you save, the page moves to {url}. The old link stops working.
          </p>
        )}
      </SettingsCard>

      <SettingsCard title="What people see" description="Shown at the top of the page, next to your photo.">
        <Field label="Title" htmlFor="booking-title" error={errors.title}>
          <Input
            id="booking-title"
            value={draft.title}
            maxLength={BOOKING_TITLE_MAX}
            placeholder={page.defaultTitle}
            onChange={(event) => update("title", event.target.value)}
          />
        </Field>
        <Field
          label="Intro"
          htmlFor="booking-intro"
          error={errors.intro}
          hint={`${draft.intro.length}/${BOOKING_INTRO_MAX}`}
        >
          <textarea
            id="booking-intro"
            rows={3}
            value={draft.intro}
            maxLength={BOOKING_INTRO_MAX}
            placeholder="A line or two about what the call is for."
            aria-describedby="booking-intro-hint"
            onChange={(event) => update("intro", event.target.value)}
            className="border-line-strong bg-secondary text-foreground placeholder:text-subtle focus-visible:border-ring min-h-20 w-full resize-y rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none transition-[border-color] duration-150 ease-power3-out"
          />
        </Field>
        <ImagePicker
          kind="avatar"
          title="Photo"
          hint={page.exists ? "Square works best. JPEG, PNG or WebP, up to 1 MB." : "Save the page first, then add a photo."}
          has={page.hasAvatar}
          version={page.version}
          disabled={!page.exists}
          round
          fallback={
            <div
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#4124fb,#16c89e)] text-[16px] font-semibold text-white"
            >
              {initials(page.defaultTitle.replace(/^Book a call with /, ""))}
            </div>
          }
          onChanged={() => router.refresh()}
        />
      </SettingsCard>

      <SettingsCard title="Availability" description="When people can book you. All times are London time.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Meeting length" htmlFor="booking-duration">
            <ChoiceSelect
              id="booking-duration"
              value={String(draft.durationMinutes)}
              options={BOOKING_DURATIONS.map((value) => ({ value: String(value), label: durationLabel(value) }))}
              onChange={(value) => update("durationMinutes", Number(value))}
            />
          </Field>
          <Field label="Buffer around meetings" htmlFor="booking-buffer">
            <ChoiceSelect
              id="booking-buffer"
              value={String(draft.bufferMinutes)}
              options={BUFFERS.map((value) => ({ value: String(value), label: value === 0 ? "None" : `${value} min` }))}
              onChange={(value) => update("bufferMinutes", Number(value))}
            />
          </Field>
          <Field label="Minimum notice" htmlFor="booking-notice">
            <ChoiceSelect
              id="booking-notice"
              value={String(draft.minNoticeMinutes)}
              options={[
                ...new Set<number>([...BOOKING_NOTICE_OPTIONS, draft.minNoticeMinutes]),
              ]
                .sort((a, b) => a - b)
                .map((value) => ({ value: String(value), label: noticeLabel(value) }))}
              onChange={(value) => update("minNoticeMinutes", Number(value))}
            />
          </Field>
          <Field
            label="Book up to"
            htmlFor="booking-horizon"
            error={errors.horizonDays}
            hint="Days ahead, up to 90."
          >
            <Input
              id="booking-horizon"
              type="number"
              inputMode="numeric"
              min={1}
              max={BOOKING_HORIZON_MAX}
              value={draft.horizonDays}
              aria-describedby={errors.horizonDays ? "booking-horizon-error" : "booking-horizon-hint"}
              onChange={(event) => update("horizonDays", event.target.value)}
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-soft mb-2">Weekly hours</legend>
          <ul className="divide-border border-border flex flex-col divide-y rounded-lg border">
            {WEEKDAYS.map((day) => {
              const range = draft.weeklyHours[day][0];
              const on = Boolean(range);
              return (
                <li key={day} className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2">
                  <Switch
                    id={`booking-day-${day}`}
                    checked={on}
                    label={`Available on ${WEEKDAY_LABELS[day]}`}
                    onChange={(value) => setDay(day, value ? [DEFAULT_HOURS] : [])}
                  />
                  <span className={cn("w-24 text-[14px] leading-none", !on && "text-subtle")}>{WEEKDAY_LABELS[day]}</span>
                  {range ? (
                    <div className="flex flex-1 items-center gap-2">
                      <div className="w-28">
                        <ChoiceSelect
                          id={`booking-${day}-start`}
                          label={`${WEEKDAY_LABELS[day]} start`}
                          value={range.start}
                          options={TIME_OPTIONS.map((value) => ({ value, label: value }))}
                          onChange={(value) => setDay(day, [{ start: value, end: range.end }])}
                        />
                      </div>
                      <span aria-hidden className="text-subtle">
                        –
                      </span>
                      <div className="w-28">
                        <ChoiceSelect
                          id={`booking-${day}-end`}
                          label={`${WEEKDAY_LABELS[day]} end`}
                          value={range.end}
                          options={END_OPTIONS.map((value) => ({ value, label: value }))}
                          onChange={(value) => setDay(day, [{ start: range.start, end: value }])}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-subtle text-[13px] leading-none">Unavailable</span>
                  )}
                </li>
              );
            })}
          </ul>
          {errors.weeklyHours && (
            <p role="alert" className="caption-style text-danger">
              {errors.weeklyHours}
            </p>
          )}
        </fieldset>
      </SettingsCard>

      <SettingsCard
        title="Background"
        description="A looping, muted video behind the booking panel. Without one, the page shows a soft animated gradient."
      >
        <Field
          label="Video link"
          htmlFor="booking-video"
          error={errors.videoUrl}
          hint="Paste a direct https link to an .mp4 you host, for example on Vercel Blob, S3 or Cloudflare R2. Stock sites like Pixabay block playback on other websites, so their links can stop working without warning."
        >
          <div className="flex gap-2">
            <Input
              id="booking-video"
              type="url"
              inputMode="url"
              spellCheck={false}
              maxLength={BOOKING_VIDEO_URL_MAX}
              value={draft.videoUrl}
              placeholder="https://…/loop.mp4"
              aria-describedby={errors.videoUrl ? "booking-video-error" : "booking-video-hint"}
              onChange={(event) => {
                update("videoUrl", event.target.value);
                setPreviewError(false);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!checkVideoUrl(draft.videoUrl).ok || !draft.videoUrl.trim()}
              aria-expanded={preview}
              aria-controls="booking-video-preview"
              onClick={() => {
                setPreview((value) => !value);
                setPreviewError(false);
              }}
            >
              {preview ? "Hide preview" : "Preview"}
            </Button>
          </div>
        </Field>
        {preview && draft.videoUrl.trim() && (
          <div id="booking-video-preview" className="flex flex-col gap-2">
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black outline-1 -outline-offset-1 outline-white/10">
              {!previewError && (
                <video
                  key={draft.videoUrl}
                  src={draft.videoUrl.trim()}
                  autoPlay
                  muted
                  loop
                  playsInline
                  onError={() => setPreviewError(true)}
                  className="absolute inset-0 size-full object-cover"
                />
              )}
              {previewError && (
                <p className="text-soft absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] leading-5">
                  This link didn&apos;t play. Check it opens the video file directly and allows other sites to show it.
                </p>
              )}
            </div>
          </div>
        )}
        <ImagePicker
          kind="poster"
          title="Still image"
          hint={
            page.exists
              ? "Optional. Shown while the video loads, for visitors who prefer less motion, and instead of the gradient when there's no video. Up to 1 MB."
              : "Save the page first, then add a still image."
          }
          has={page.hasPoster}
          version={page.version}
          disabled={!page.exists}
          round={false}
          fallback={<div aria-hidden className="bg-muted aspect-video w-24 shrink-0 rounded-lg" />}
          onChanged={() => router.refresh()}
        />
      </SettingsCard>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {errors.form && (
          <p role="alert" className="caption-style text-danger mr-auto">
            {errors.form}
          </p>
        )}
        <p role="status" className="caption-style text-subtle">
          {message ?? (dirty ? "Unsaved changes" : "")}
        </p>
        <Button
          variant="primary"
          size="md"
          type="submit"
          disabled={pending || (page.exists && !dirty)}
          data-shortcut="save"
          title="Save (⌘S)"
        >
          {pending ? "Saving…" : page.exists ? "Save changes" : "Create page"}
        </Button>
      </div>
    </form>
  );
}
