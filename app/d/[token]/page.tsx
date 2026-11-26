import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import Button from "@/components/_ui/button";
import { PublicNote } from "@/components/docs/static-note";
import { openPublicDoc } from "@/lib/docs/public";
import { updatedLabel } from "@/lib/docs/public-link";

export const dynamic = "force-dynamic";

const ROBOTS = { index: false, follow: false, nocache: true };

const loadDoc = cache((token: string) => openPublicDoc(token));

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const doc = await loadDoc(token);
  return { title: doc?.title ?? "Not found", description: null, robots: ROBOTS, alternates: null, openGraph: null, twitter: null, appleWebApp: null, manifest: null, applicationName: null };
}

export default async function PublicDocPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const doc = await loadDoc(token);
  if (!doc) notFound();
  return (
    <main className="bg-background min-h-dvh">
      <article className="note-surface mx-auto flex w-full max-w-[46em] flex-col gap-4 px-4 pt-8 pb-20 md:px-6 md:pt-14">
        <div className="flex items-center gap-3">
          <span className="caption-style text-subtle flex-1">{updatedLabel(doc.updatedAt)}</span>
          {doc.allowDownload && (
            <Button variant="secondary" size="sm" href={`/api/d/${token}/pdf`} className="hit">
              Download PDF
            </Button>
          )}
        </div>
        <h1 className="note-title note-public-title">{doc.title}</h1>
        <PublicNote body={doc.content} />
      </article>
    </main>
  );
}
