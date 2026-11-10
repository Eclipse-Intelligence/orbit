import { headers } from "next/headers";
import { redirect } from "next/navigation";
import BookingPageSettings from "@/components/crm/booking-page-settings";
import { SettingsPage } from "@/components/crm/settings-ui";
import { getUserActor } from "@/lib/auth/user";
import { getBookingPage, getBookingSetup } from "@/lib/booking/pages";
import { configuredSiteOrigin } from "@/lib/crm/conversations";

export const dynamic = "force-dynamic";

async function siteOrigin() {
  const configured = configuredSiteOrigin();
  if (configured) return configured;
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:4173";
  return `${headerStore.get("x-forwarded-proto") ?? "http"}://${host}`;
}

export default async function BookingPageSettingsPage() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [page, setup, origin] = await Promise.all([getBookingPage(user), getBookingSetup(user), siteOrigin()]);
  return (
    <SettingsPage title="Booking page">
      <BookingPageSettings page={page} setup={setup} origin={origin} />
    </SettingsPage>
  );
}
