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
import { useDocsStore } from "@/stores/docs-store";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

export default function RecordNotes({ record, className }: { record: { kind: MentionKind; id: string; name: string }; className?: string }) {
  const now = useDocsNow();
  const navigate = useDocsNavigate();
  const createNote = useDocsStore((state) => state.createNote);
  const [hits, setHits] = useState<{ key: string; list: SearchHit[] } | null>(null);
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
        if (live) setHits({ key: `${kind}:${id}`, list: [] });
      });
    return () => {
      live = false;
    };
  }, [kind, id, name]);

  async function newNote() {
    const label = name.replace(/[[\]\n]/g, " ").trim();
    const page = await createNote({ body: `@[${label}](${kind}:${id}) ` });
    if (page) navigate(pageHref(page.id));
  }

  const list = hits?.key === key ? hits.list : null;

  return (
    <DetailSection
      title="Notes"
      className={className}
      action={
        <Button variant="secondary" size="sm" onClick={() => void newNote()}>
          New note
        </Button>
      }
    >
      {list === null ? (
        <p role="status" className="caption-style text-faint">
          Loading
        </p>
      ) : list.length === 0 ? (
        <p className="caption-style text-subtle">No notes mention {record.name} yet. Type @ in any note to mention them.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.slice(0, 6).map((hit) => {
            const Icon = hit.page.kind === "daily" ? SunIcon : DocIcon;
            return (
              <li key={hit.page.id}>
                <Link href={pageHref(hit.page.id)} className="group flex min-w-0 items-start gap-2.5">
                  <Icon aria-hidden className="text-subtle mt-[3px] size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[14px] leading-5 group-hover:underline">{hit.page.title || "Untitled"}</span>
                      {hit.page.shared ? (
                        <UsersIcon aria-label="Shared" role="img" className="size-3 shrink-0 text-(--tag-blue-text)/80" />
                      ) : (
                        <LockIcon aria-label="Private" role="img" className="text-faint size-3 shrink-0" />
                      )}
                      <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{whenLabel(hit.page.updatedAt, now)}</span>
                    </span>
                    <span className="caption-style text-subtle line-clamp-2">{hit.snippet}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>
  );
}
