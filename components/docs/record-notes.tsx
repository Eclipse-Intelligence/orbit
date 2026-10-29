"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import DetailSection from "@/components/companies/detail/detail-section";
import { useDocsNavigate, useDocsNow } from "@/components/docs/use-docs";
import type { SearchHit } from "@/lib/docs/client-types";
import { docsConnected, docsData } from "@/lib/docs/connection";
import { whenLabel } from "@/lib/docs/format";
import type { MentionKind } from "@/lib/mentions";
import { pageHref } from "@/lib/docs/routes";
import { cn } from "@/lib/utils";
import { useDocsStore } from "@/stores/docs-store";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

const PREVIEW = 6;
const COMPACT_PREVIEW = 3;

type RecordRef = { kind: MentionKind; id: string; name: string };

function useRecordNotes(record: RecordRef) {
  const [hits, setHits] = useState<{ key: string; list: SearchHit[]; failed?: boolean } | null>(null);
  const { kind, id, name } = record;
  const key = `${kind}:${id}`;

  useEffect(() => {
    if (!docsConnected()) return;
    let live = true;
    void docsData()
      .recordMentions({ kind, id, name })
      .then((list) => {
        if (live) setHits({ key: `${kind}:${id}`, list });
      })
      .catch(() => {
        if (live) setHits({ key: `${kind}:${id}`, list: [], failed: true });
      });
    return () => {
      live = false;
    };
  }, [kind, id, name]);

  return { list: hits?.key === key ? hits.list : null, failed: hits?.key === key && Boolean(hits.failed) };
}

function useNewNote(record: RecordRef) {
  const navigate = useDocsNavigate();
  const createNote = useDocsStore((state) => state.createNote);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    const label = record.name.replace(/[[\]\n]/g, " ").trim() || record.kind;
    const page = await createNote({ body: `@[${label}](${record.kind}:${record.id}) ` });
    setCreating(false);
    if (page) navigate(pageHref(page.id));
    else setError("The note wasn't created. Try again.");
  }

  return { create, creating, error };
}

function Visibility({ shared }: { shared: boolean }) {
  return shared ? (
    <UsersIcon aria-label="Shared" role="img" className="size-3 shrink-0 text-(--tag-blue-text)/80" />
  ) : (
    <LockIcon aria-label="Private" role="img" className="text-faint size-3 shrink-0" />
  );
}

function NoteRow({ hit, now, compact }: { hit: SearchHit; now: string; compact: boolean }) {
  const Icon = hit.page.kind === "daily" ? SunIcon : DocIcon;
  const meta = `${hit.page.updatedBy.name} · ${whenLabel(hit.page.updatedAt, now)}`;
  return (
    <li>
      <Link href={pageHref(hit.page.id)} className="group focus-visible:ring-ring/60 flex min-w-0 items-start gap-2.5 rounded-md outline-none focus-visible:ring-2">
        <Icon aria-hidden className="text-subtle mt-[3px] size-3.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("text-foreground truncate group-hover:underline", compact ? "text-[13px] leading-5" : "text-[14px] leading-5")}>
              {hit.page.title || "Untitled"}
            </span>
            <Visibility shared={hit.page.shared} />
            {compact && <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{whenLabel(hit.page.updatedAt, now)}</span>}
          </span>
          {!compact && hit.snippet && <span className="caption-style text-soft line-clamp-2 break-words">{hit.snippet}</span>}
          {!compact && <span className="caption-style text-subtle truncate">{meta}</span>}
        </span>
      </Link>
    </li>
  );
}

function NoteList({ list, now, compact }: { list: SearchHit[]; now: string; compact: boolean }) {
  const [all, setAll] = useState(false);
  const limit = compact ? COMPACT_PREVIEW : PREVIEW;
  const shown = all ? list : list.slice(0, limit);
  return (
    <>
      <ul className={cn("flex flex-col", compact ? "gap-2" : "gap-3.5")}>
        {shown.map((hit) => (
          <NoteRow key={hit.page.id} hit={hit} now={now} compact={compact} />
        ))}
      </ul>
      {list.length > limit && (
        <Button variant="link" size="none" className="caption-style self-start" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${list.length}`}
        </Button>
      )}
    </>
  );
}

function Body({ list, failed, now, compact }: { list: SearchHit[] | null; failed: boolean; now: string; compact: boolean }) {
  if (list === null) {
    return (
      <p role="status" className="caption-style text-subtle">
        Loading notes
      </p>
    );
  }
  if (failed) {
    return (
      <p role="alert" className="caption-style text-danger">
        Notes didn&apos;t load. Reload to try again.
      </p>
    );
  }
  if (list.length === 0) return <p className="caption-style text-subtle">No notes yet.</p>;
  return <NoteList list={list} now={now} compact={compact} />;
}

function noteCountTitle(list: SearchHit[] | null) {
  return list?.length ? `Notes · ${list.length}` : "Notes";
}

export default function RecordNotes({ record, className, compact = false }: { record: RecordRef; className?: string; compact?: boolean }) {
  const now = useDocsNow();
  const { list, failed } = useRecordNotes(record);
  const note = useNewNote(record);
  const title = noteCountTitle(list);
  const action = (
    <Button variant={compact ? "ghost" : "secondary"} size="sm" disabled={note.creating} aria-label={`New note about ${record.name}`} onClick={() => void note.create()}>
      New note
    </Button>
  );
  const error = note.error && (
    <p role="alert" className="caption-style text-danger">
      {note.error}
    </p>
  );

  if (compact) {
    return (
      <section aria-label={`Notes about ${record.name}`} className={cn("flex flex-col gap-2", className)}>
        <div className="flex h-7 items-center justify-between gap-2">
          <h4 className="eyebrow-style text-subtle font-normal">{title}</h4>
          {action}
        </div>
        {error}
        <Body list={list} failed={failed} now={now} compact />
      </section>
    );
  }

  return (
    <DetailSection title={title} className={className} action={action}>
      {error}
      <Body list={list} failed={failed} now={now} compact={false} />
    </DetailSection>
  );
}
