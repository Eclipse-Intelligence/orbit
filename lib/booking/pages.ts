import { withActor } from "@/lib/crm/context";
import { memberActor } from "@/lib/crm/conversations";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { getInviteSetup } from "@/lib/crm/invites";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import {
  BOOKING_BUFFER_MAX,
  BOOKING_DURATIONS,
  BOOKING_HORIZON_MAX,
  BOOKING_IMAGE_MAX_BYTES,
  BOOKING_INTRO_MAX,
  BOOKING_TIME_ZONE,
  BOOKING_TITLE_MAX,
  checkSlug,
  checkVideoUrl,
  checkWeeklyHours,
  DEFAULT_WEEKLY_HOURS,
  defaultTitle,
  imageType,
  readWeeklyHours,
  suggestSlug,
  type BookingImageKind,
  type WeeklyHours,
} from "@/lib/booking/rules";
import type { SlotRules } from "@/lib/booking/slots";
import { isTimeZone } from "@/lib/time";

const NOTICE_MAX = 20160;

export type MeetingKind = "whereby" | "link" | null;

export type BookingPageSettings = {
  exists: boolean;
  slug: string;
  enabled: boolean;
  title: string | null;
  defaultTitle: string;
  intro: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  weeklyHours: WeeklyHours;
  timeZone: string;
  videoUrl: string | null;
  hasAvatar: boolean;
  hasPoster: boolean;
  version: string;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type BookingSetup = {
  connected: boolean;
  canWriteCalendar: boolean;
  meetingLink: string | null;
};

export type BookingPageInput = {
  slug?: unknown;
  enabled?: unknown;
  title?: unknown;
  intro?: unknown;
  durationMinutes?: unknown;
  bufferMinutes?: unknown;
  minNoticeMinutes?: unknown;
  horizonDays?: unknown;
  weeklyHours?: unknown;
  videoUrl?: unknown;
};

export type PublicBookingPage = {
  slug: string;
  ownerName: string;
  title: string;
  intro: string | null;
  durationMinutes: number;
  timeZone: string;
  videoUrl: string | null;
  avatarUrl: string | null;
  posterUrl: string | null;
  meetingKind: MeetingKind;
};

export type LoadedBookingPage = PublicBookingPage & {
  pageId: string;
  userId: string;
  rules: SlotRules;
};

type PageRow = {
  slug: string;
  enabled: boolean;
  title: string | null;
  intro: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  horizon_days: number;
  weekly_hours: unknown;
  time_zone: string;
  background_video_url: string | null;
  has_avatar: boolean;
  has_poster: boolean;
  version: string;
  last_error: string | null;
  last_error_at: Date | string | null;
};

type PublicRow = {
  page_id: string;
  user_id: string;
  slug: string;
  owner_name: string | null;
  title: string;
  intro: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  horizon_days: number;
  weekly_hours: unknown;
  time_zone: string;
  background_video_url: string | null;
  has_avatar: boolean;
  has_poster: boolean;
  meeting_kind: string | null;
  version: string;
};

function invalid(message: string, field: string) {
  return new CrmError("invalid_input", message, 400, { field });
}

function pageZone(value: string | null | undefined) {
  return isTimeZone(value) ? value : BOOKING_TIME_ZONE;
}

function bookingImagePath(slug: string, kind: BookingImageKind, version: string) {
  return `/api/book/${encodeURIComponent(slug)}/image/${kind}?v=${encodeURIComponent(version)}`;
}

function defaults(actor: UserActor): BookingPageSettings {
  return {
    exists: false,
    slug: suggestSlug(actor.fullName || actor.email),
    enabled: false,
    title: null,
    defaultTitle: defaultTitle(actor.fullName || actor.email),
    intro: null,
    durationMinutes: 30,
    bufferMinutes: 10,
    minNoticeMinutes: 240,
    horizonDays: 21,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    timeZone: BOOKING_TIME_ZONE,
    videoUrl: null,
    hasAvatar: false,
    hasPoster: false,
    version: "0",
    lastError: null,
    lastErrorAt: null,
  };
}

const PAGE_COLUMNS = `slug, enabled, title, intro, duration_minutes, buffer_minutes, min_notice_minutes,
  horizon_days, weekly_hours, time_zone, background_video_url,
  avatar is not null as has_avatar, background_poster is not null as has_poster,
  substr(md5(updated_at::text), 1, 12) as version, last_error, last_error_at`;

function mapSettings(actor: UserActor, row: PageRow): BookingPageSettings {
  return {
    exists: true,
    slug: row.slug,
    enabled: row.enabled,
    title: row.title,
    defaultTitle: defaultTitle(actor.fullName || actor.email),
    intro: row.intro,
    durationMinutes: row.duration_minutes,
    bufferMinutes: row.buffer_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    horizonDays: row.horizon_days,
    weeklyHours: readWeeklyHours(row.weekly_hours),
    timeZone: pageZone(row.time_zone),
    videoUrl: row.background_video_url,
    hasAvatar: row.has_avatar,
    hasPoster: row.has_poster,
    version: row.version,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at ? new Date(row.last_error_at).toISOString() : null,
  };
}

export async function getBookingPage(actor: UserActor): Promise<BookingPageSettings> {
  return withActor(actor, async (db) => {
    const result = await db.query<PageRow>(
      `select ${PAGE_COLUMNS} from crm.booking_pages where user_id = $1 and workspace_id = $2`,
      [actor.userId, actor.workspaceId],
    );
    return result.rows[0] ? mapSettings(actor, result.rows[0]) : defaults(actor);
  });
}

export async function getBookingSetup(actor: UserActor): Promise<BookingSetup> {
  const setup = await getInviteSetup(actor);
  return { connected: setup.connected, canWriteCalendar: setup.canWriteCalendar, meetingLink: setup.meetingLink };
}

function cleanText(value: unknown, max: number, field: string, label: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid(`${label} must be text.`, field);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > max) throw invalid(`Keep the ${label.toLowerCase()} under ${max + 1} characters.`, field);
  return text || null;
}

function cleanInteger(value: unknown, field: string, check: (value: number) => boolean, message: string) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || !check(number)) throw invalid(message, field);
  return number;
}

function cleanBookingPage(input: BookingPageInput) {
  const slug = checkSlug(typeof input.slug === "string" ? input.slug : "");
  if (!slug.ok) throw invalid(slug.error, "slug");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw invalid("Choose whether the page is on.", "enabled");
  }
  const title = cleanText(input.title, BOOKING_TITLE_MAX, "title", "Title");
  if (title?.includes("\n")) throw invalid("Keep the title on one line.", "title");
  const hours = checkWeeklyHours(input.weeklyHours);
  if (!hours.ok) throw invalid(hours.error, "weeklyHours");
  const durationMinutes = cleanInteger(
    input.durationMinutes,
    "durationMinutes",
    (value) => (BOOKING_DURATIONS as readonly number[]).includes(value),
    "Pick a meeting length.",
  );
  const video = checkVideoUrl(typeof input.videoUrl === "string" ? input.videoUrl : "");
  if (!video.ok) throw invalid(video.error, "videoUrl");
  if (input.videoUrl !== null && input.videoUrl !== undefined && typeof input.videoUrl !== "string") {
    throw invalid("Enter the full link, starting with https://.", "videoUrl");
  }
  return {
    slug: slug.value,
    enabled: input.enabled === true,
    title,
    intro: cleanText(input.intro, BOOKING_INTRO_MAX, "intro", "Intro"),
    durationMinutes,
    bufferMinutes: cleanInteger(
      input.bufferMinutes,
      "bufferMinutes",
      (value) => value >= 0 && value <= BOOKING_BUFFER_MAX,
      `Pick a buffer between 0 and ${BOOKING_BUFFER_MAX} minutes.`,
    ),
    minNoticeMinutes: cleanInteger(
      input.minNoticeMinutes,
      "minNoticeMinutes",
      (value) => value >= 0 && value <= NOTICE_MAX,
      "Pick a minimum notice up to 14 days.",
    ),
    horizonDays: cleanInteger(
      input.horizonDays,
      "horizonDays",
      (value) => value >= 1 && value <= BOOKING_HORIZON_MAX,
      `Pick between 1 and ${BOOKING_HORIZON_MAX} days.`,
    ),
    weeklyHours: hours.value,
    videoUrl: video.value,
  };
}

export async function saveBookingPage(actor: UserActor, input: BookingPageInput) {
  const page = cleanBookingPage(input);
  if (page.enabled && !Object.values(page.weeklyHours).some((ranges) => ranges.length > 0)) {
    throw invalid("Turn on at least one day before you switch the page on.", "weeklyHours");
  }
  try {
    return await withActor(actor, async (db) => {
      const result = await db.query<PageRow>(
        `insert into crm.booking_pages (
           workspace_id, user_id, slug, enabled, title, intro, duration_minutes, buffer_minutes,
           min_notice_minutes, horizon_days, weekly_hours, background_video_url
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         on conflict (user_id) do update set
           slug = excluded.slug,
           enabled = excluded.enabled,
           title = excluded.title,
           intro = excluded.intro,
           duration_minutes = excluded.duration_minutes,
           buffer_minutes = excluded.buffer_minutes,
           min_notice_minutes = excluded.min_notice_minutes,
           horizon_days = excluded.horizon_days,
           weekly_hours = excluded.weekly_hours,
           background_video_url = excluded.background_video_url
         returning ${PAGE_COLUMNS}`,
        [
          actor.workspaceId,
          actor.userId,
          page.slug,
          page.enabled,
          page.title,
          page.intro,
          page.durationMinutes,
          page.bufferMinutes,
          page.minNoticeMinutes,
          page.horizonDays,
          JSON.stringify(page.weeklyHours),
          page.videoUrl,
        ],
      );
      return mapSettings(actor, result.rows[0]);
    });
  } catch (error) {
    if (isPgError(error) && error.code === "23505" && error.constraint === "booking_pages_slug_key") {
      throw new CrmError("conflict", "That link is taken. Pick another.", 409, { field: "slug" });
    }
    throw error;
  }
}

export async function checkSlugAvailable(actor: UserActor, raw: unknown) {
  const checked = checkSlug(typeof raw === "string" ? raw : "");
  if (!checked.ok) return { slug: null, available: false, error: checked.error };
  const result = await query<{ taken: boolean }>("select private.booking_slug_taken($1, $2) as taken", [
    checked.value,
    actor.userId,
  ]);
  const taken = result.rows[0]?.taken ?? false;
  return {
    slug: checked.value,
    available: !taken,
    error: taken ? "That link is taken. Pick another." : null,
  };
}

function imageColumns(kind: BookingImageKind) {
  return kind === "avatar"
    ? { data: "avatar", mime: "avatar_mime" }
    : { data: "background_poster", mime: "background_poster_mime" };
}

export function readImageKind(value: unknown): BookingImageKind | null {
  return value === "avatar" || value === "poster" ? value : null;
}

export async function saveBookingImage(actor: UserActor, kind: BookingImageKind, bytes: Uint8Array) {
  if (bytes.length === 0) throw invalid("Choose an image.", kind);
  if (bytes.length > BOOKING_IMAGE_MAX_BYTES) throw invalid("Use an image under 1 MB.", kind);
  const mime = imageType(bytes);
  if (!mime) throw invalid("Use a JPEG, PNG or WebP image.", kind);
  const columns = imageColumns(kind);
  return withActor(actor, async (db) => {
    const result = await db.query<{ version: string }>(
      `update crm.booking_pages set ${columns.data} = $3, ${columns.mime} = $4
       where user_id = $1 and workspace_id = $2
       returning substr(md5(updated_at::text), 1, 12) as version`,
      [actor.userId, actor.workspaceId, Buffer.from(bytes), mime],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "Save your booking page first.", 404);
    return { version: result.rows[0].version };
  });
}

export async function removeBookingImage(actor: UserActor, kind: BookingImageKind) {
  const columns = imageColumns(kind);
  return withActor(actor, async (db) => {
    const result = await db.query<{ version: string }>(
      `update crm.booking_pages set ${columns.data} = null, ${columns.mime} = null
       where user_id = $1 and workspace_id = $2
       returning substr(md5(updated_at::text), 1, 12) as version`,
      [actor.userId, actor.workspaceId],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "Save your booking page first.", 404);
    return { version: result.rows[0].version };
  });
}

export async function readOwnImage(actor: UserActor, kind: BookingImageKind) {
  const columns = imageColumns(kind);
  return withActor(actor, async (db) => {
    const result = await db.query<{ data: Buffer | null; mime: string | null }>(
      `select ${columns.data} as data, ${columns.mime} as mime from crm.booking_pages
       where user_id = $1 and workspace_id = $2`,
      [actor.userId, actor.workspaceId],
    );
    const row = result.rows[0];
    return row?.data && row.mime ? { data: row.data, mime: row.mime } : null;
  });
}

export async function recordBookingError(owner: UserActor, message: string | null) {
  await withActor(owner, async (db) => {
    await db.query(
      `update crm.booking_pages
       set last_error = $3, last_error_at = case when $3::text is null then null else now() end
       where user_id = $1 and workspace_id = $2 and last_error is distinct from $3`,
      [owner.userId, owner.workspaceId, message ? message.slice(0, 500) : null],
    );
  });
}

function lookupSlug(raw: string) {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const checked = checkSlug(decoded);
  return checked.ok ? checked.value : null;
}

function meetingKind(value: string | null): MeetingKind {
  return value === "whereby" || value === "link" ? value : null;
}

export async function loadBookingPage(raw: string): Promise<LoadedBookingPage | null> {
  const slug = lookupSlug(raw);
  if (!slug) return null;
  const result = await query<PublicRow>("select * from private.booking_page_public($1)", [slug]);
  const row = result.rows[0];
  if (!row) return null;
  const timeZone = pageZone(row.time_zone);
  return {
    pageId: row.page_id,
    userId: row.user_id,
    slug: row.slug,
    ownerName: row.owner_name?.trim() || "Orbit",
    title: row.title,
    intro: row.intro,
    durationMinutes: row.duration_minutes,
    timeZone,
    videoUrl: row.background_video_url,
    avatarUrl: row.has_avatar ? bookingImagePath(row.slug, "avatar", row.version) : null,
    posterUrl: row.has_poster ? bookingImagePath(row.slug, "poster", row.version) : null,
    meetingKind: meetingKind(row.meeting_kind),
    rules: {
      weeklyHours: readWeeklyHours(row.weekly_hours),
      durationMinutes: row.duration_minutes,
      bufferMinutes: row.buffer_minutes,
      minNoticeMinutes: row.min_notice_minutes,
      horizonDays: row.horizon_days,
      timeZone,
    },
  };
}

export function publicView(page: LoadedBookingPage): PublicBookingPage {
  return {
    slug: page.slug,
    ownerName: page.ownerName,
    title: page.title,
    intro: page.intro,
    durationMinutes: page.durationMinutes,
    timeZone: page.timeZone,
    videoUrl: page.videoUrl,
    avatarUrl: page.avatarUrl,
    posterUrl: page.posterUrl,
    meetingKind: page.meetingKind,
  };
}

export async function loadBookingImage(raw: string, kind: BookingImageKind) {
  const slug = lookupSlug(raw);
  if (!slug) return null;
  const result = await query<{ data: Buffer | null; mime: string | null }>(
    "select * from private.booking_page_image($1, $2)",
    [slug, kind],
  );
  const row = result.rows[0];
  return row?.data && row.mime ? { data: row.data, mime: row.mime } : null;
}

export async function loadBusy(userId: string, from: number, to: number) {
  const result = await query<{ starts_at: Date; ends_at: Date }>(
    "select starts_at, ends_at from private.booking_busy($1, $2, $3)",
    [userId, new Date(from).toISOString(), new Date(to).toISOString()],
  );
  return result.rows.map((row) => ({
    start: new Date(row.starts_at).getTime(),
    end: new Date(row.ends_at).getTime(),
  }));
}

export async function loadBookingOwner(raw: string): Promise<UserActor | null> {
  const slug = lookupSlug(raw);
  if (!slug) return null;
  const result = await query<{
    workspace_id: string;
    workspace_name: string;
    user_id: string;
    role: WorkspaceRole;
    email: string | null;
    full_name: string | null;
  }>("select * from private.booking_page_owner($1)", [slug]);
  const row = result.rows[0];
  return row ? memberActor(row) : null;
}
