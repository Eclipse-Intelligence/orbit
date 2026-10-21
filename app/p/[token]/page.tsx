import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import ProposalPage from "@/components/proposals/proposal-page";
import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { openDocument } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

const ROBOTS = { index: false, follow: false, nocache: true };

export const metadata: Metadata = { title: "Proposal", robots: ROBOTS, alternates: null, openGraph: null, twitter: null };

export default async function PublicProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = await headers();
  const viewer = await getUserActor().catch(() => null);
  const document = await openDocument(token, {
    track: !viewer,
    ip: clientIp(store),
    userAgent: store.get("user-agent"),
  }).catch((error) => {
    console.error("Opening a proposal failed", error);
    return null;
  });
  if (!document) notFound();
  return <ProposalPage token={token} initial={document} preview={Boolean(viewer)} />;
}
