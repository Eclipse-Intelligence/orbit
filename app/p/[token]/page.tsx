import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import StandaloneBack from "@/components/_common/standalone-back";
import ProposalPage from "@/components/proposals/proposal-page";
import { getUserActor } from "@/lib/auth/user";
import { clientIp } from "@/lib/booking/book";
import { openDocument } from "@/lib/proposals/public";

export const dynamic = "force-dynamic";

const ROBOTS = { index: false, follow: false, nocache: true };

const loadDocument = cache(async (token: string) => {
  const store = await headers();
  const viewer = await getUserActor().catch(() => null);
  const document = await openDocument(token, { track: !viewer, ip: clientIp(store), userAgent: store.get("user-agent") });
  return { document, preview: Boolean(viewer) };
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const { document } = await loadDocument(token);
  return { title: document?.content.title ?? "Proposal", robots: ROBOTS, alternates: null, openGraph: null, twitter: null };
}

export default async function PublicProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { document, preview } = await loadDocument(token);
  if (!document) notFound();
  return (
    <>
      <ProposalPage token={token} initial={document} preview={preview} />
      <StandaloneBack />
    </>
  );
}
