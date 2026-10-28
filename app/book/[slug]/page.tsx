import StandaloneBack from "@/components/_common/standalone-back";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import BookingScreen from "@/components/booking/booking-screen";
import { loadBookingPage, publicView } from "@/lib/booking/pages";

export const dynamic = "force-dynamic";

const ROBOTS = { index: false, follow: false, nocache: true };

const loadPage = cache(loadBookingPage);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (!page) return { title: "Booking page not found", robots: ROBOTS };
  return {
    title: page.title,
    description: page.intro ?? `Pick a time for a ${page.durationMinutes}-minute call with ${page.ownerName}.`,
    robots: ROBOTS,
    alternates: null,
    openGraph: null,
    twitter: null,
  };
}

export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (!page) notFound();
  return (
    <>
      <BookingScreen page={publicView(page)} />
      <StandaloneBack />
    </>
  );
}
