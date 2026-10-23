import { getBookingPage } from "@/lib/booking/pages";
import { bookingPath } from "@/lib/booking/rules";
import { getMeetingLink } from "@/lib/crm/invites";
import type { UserActor } from "@/lib/crm/types";
import { siteOrigin } from "@/lib/site-url";

export type UserLinks = {
  booking: { url: string; enabled: boolean; title: string; durationMinutes: number } | null;
  meetingLink: string | null;
};

function productionOrigin() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return host ? `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : null;
}

export function bookingUrl(slug: string) {
  const origin = siteOrigin() ?? productionOrigin();
  return origin ? `${origin}${bookingPath(slug)}` : bookingPath(slug);
}

export async function userLinks(actor: UserActor): Promise<UserLinks> {
  const [page, meetingLink] = await Promise.all([getBookingPage(actor), getMeetingLink(actor)]);
  return {
    booking: page.exists
      ? { url: bookingUrl(page.slug), enabled: page.enabled, title: page.title || page.defaultTitle, durationMinutes: page.durationMinutes }
      : null,
    meetingLink,
  };
}

export function linksSection(links: UserLinks | null) {
  if (!links) return "";
  const lines = [
    links.booking
      ? `- Booking page, where people pick a time with the user: ${links.booking.url} ("${links.booking.title}", ${links.booking.durationMinutes} minutes${links.booking.enabled ? "" : ", currently switched off, so don't send it until they switch it on in Settings, Booking page"}).`
      : "- No booking page yet. It can be set up in Settings, Booking page.",
    links.meetingLink ? `- Video meeting link for calls: ${links.meetingLink}. This is a meeting room, not the booking page.` : "",
  ].filter(Boolean);
  return `\n\n# The user's links\n${lines.join("\n")}\nWhen someone should choose a time, put the booking page link in the email exactly as written above. Never shorten it, change the address or make one up.`;
}
