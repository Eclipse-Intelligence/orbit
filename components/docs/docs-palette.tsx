"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CommandGroup, CommandItem, CommandSeparator, Kbd } from "@/components/_ui/command";
import { ParticipantAvatar } from "@/components/docs/presence";
import { useDocsNav, useDocsNow } from "@/components/docs/use-docs";
import type { PageSummary, SearchHit, SearchResults } from "@/lib/docs/client-types";
import { docsConnected, docsData } from "@/lib/docs/connection";
import { clockTime, londonDay, whenLabel } from "@/lib/docs/format";
import type { MentionKind } from "@/lib/mentions";
import { dailyHref, pageHref, recordHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

export type PaletteRecord = { kind: MentionKind; id: string; name: string };

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <span className="text-foreground font-semibold">{text.slice(index, index + query.length)}</span>
      {text.slice(index + query.length)}
    </>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span aria-hidden className="ml-auto flex shrink-0 items-center gap-1">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

function Where({ summary }: { summary: PageSummary }) {
  const nav = useDocsNav();
  if (summary.kind === "daily") {
    return (
      <span className="caption-style text-subtle flex shrink-0 items-center gap-1.5">
        <LockIcon aria-hidden className="size-3" />
        Daily
      </span>
    );
  }
  const folder = summary.folderId ? nav?.folders.find((item) => item.id === summary.folderId) : undefined;
  const foreign = folder && folder.owner.id !== nav?.viewer.id && folder.shared;
  return (
    <span className="caption-style text-subtle flex shrink-0 items-center gap-1.5">
      {foreign ? (
        <ParticipantAvatar participant={folder.owner} size="xs" />
      ) : summary.shared ? (
        <UsersIcon aria-hidden className="size-3 text-(--tag-blue-text)/80" />
      ) : (
        <LockIcon aria-hidden className="size-3" />
      )}
      <span className="max-w-[10rem] truncate">{folder?.name ?? (summary.shared ? "Shared" : "Private")}</span>
      <span className="sr-only">{summary.shared ? ", shared" : ", private"}</span>
    </span>
  );
}

function NoteItem({ summary, query, onSelect, snippet }: { summary: PageSummary; query: string; onSelect: () => void; snippet?: ReactNode }) {
  const now = useDocsNow();
  const daily = summary.kind === "daily";
  const when = daily && londonDay(summary.updatedAt) === londonDay(now) ? clockTime(summary.updatedAt) : whenLabel(summary.updatedAt, now);
  const title = summary.title || "Untitled";
  return (
    <CommandItem value={`doc-${summary.id}`} onSelect={onSelect} className={snippet ? "h-auto py-2" : undefined}>
      <span className="text-subtle flex size-4 shrink-0 items-center justify-center">
        {daily ? <SunIcon aria-hidden className="size-3.5" /> : <DocIcon aria-hidden className="size-3.5" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate">
          <Highlight text={title} query={query} />
        </span>
        {snippet && <span className="caption-style text-subtle truncate">{snippet}</span>}
      </span>
      <Where summary={summary} />
      {!snippet && <span className="caption-style text-faint w-16 shrink-0 text-right tabular-nums">{when}</span>}
    </CommandItem>
  );
}

function hitSnippet(hit: SearchHit) {
  return (
    <>
      {hit.snippet.slice(0, hit.matchFrom)}
      <span className="text-foreground">{hit.snippet.slice(hit.matchFrom, hit.matchTo)}</span>
      {hit.snippet.slice(hit.matchTo)}
    </>
  );
}

export default function DocsPaletteGroups({
  query,
  record,
  go,
  open,
}: {
  query: string;
  record: PaletteRecord | null;
  go: (href: string) => void;
  open: boolean;
}) {
  const recent = useDocsStore((state) => state.recent);
  const summaries = useDocsStore((state) => state.summaries);
  const createNote = useDocsStore((state) => state.createNote);
  const nav = useDocsNav();
  const [fallback, setFallback] = useState<PageSummary[]>([]);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [mentions, setMentions] = useState<{ key: string; hits: SearchHit[] } | null>(null);
  const trimmed = query.trim();
  const recordKey = record ? `${record.kind}:${record.id}` : "";

  useEffect(() => {
    if (!open || !docsConnected()) return;
    let live = true;
    void docsData()
      .recent(8)
      .then((list) => {
        if (live) setFallback(list);
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!trimmed || !docsConnected()) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void docsData()
        .search(trimmed)
        .then((value) => {
          if (live) setResults(value);
        });
    }, 60);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  useEffect(() => {
    if (!record || !docsConnected()) return;
    let live = true;
    void docsData()
      .recordMentions(record)
      .then((hits) => {
        if (live) setMentions({ key: `${record.kind}:${record.id}`, hits });
      });
    return () => {
      live = false;
    };
  }, [record, recordKey]);

  async function create(title?: string) {
    const page = await createNote(title ? { title } : {});
    if (page) go(pageHref(page.id));
  }

  if (!trimmed) {
    const seen = new Set<string>();
    const rows = [...recent.map((id) => summaries[id]).filter((item): item is PageSummary => Boolean(item)), ...fallback]
      .filter((summary) => {
        if (seen.has(summary.id)) return false;
        seen.add(summary.id);
        return true;
      })
      .slice(0, 5);
    return (
      <>
        {rows.length > 0 && (
          <CommandGroup heading="Recent">
            {rows.map((summary) => (
              <NoteItem key={summary.id} summary={summary} query="" onSelect={() => go(pageHref(summary.id))} />
            ))}
          </CommandGroup>
        )}
        <CommandSeparator />
        <CommandGroup heading="Notes">
          <CommandItem value="docs-new" onSelect={() => void create()}>
            <PlusIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <span className="truncate">New note</span>
            <Keys keys={["C", "N"]} />
          </CommandItem>
          {nav && (
            <CommandItem value="docs-daily" onSelect={() => go(dailyHref(nav.today))}>
              <SunIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
              <span className="truncate">Today&apos;s daily note</span>
              <Keys keys={["G", "D"]} />
            </CommandItem>
          )}
          <CommandItem value="docs-search" onSelect={() => go("/docs?search=1")}>
            <SearchIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <span className="truncate">Search all docs</span>
            <Keys keys={["⌘", "⇧", "F"]} />
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
      </>
    );
  }

  const current = results?.query === trimmed ? results : null;
  const titleRows = current?.titles.slice(0, 5) ?? [];
  const mentionHits = record && mentions?.key === recordKey ? mentions.hits.slice(0, 4) : [];
  const mentionIds = new Set(mentionHits.map((hit) => hit.page.id));
  const textRows = (current?.text ?? []).filter((hit) => !mentionIds.has(hit.page.id)).slice(0, Math.max(0, 4 - titleRows.length));
  const RecordIcon = record?.kind === "company" ? BuildingIcon : record?.kind === "opportunity" ? ClipboardIcon : UsersIcon;
  const recordList = record?.kind === "company" ? "Companies" : record?.kind === "contact" ? "Contacts" : "Opportunities";

  return (
    <>
      {(titleRows.length > 0 || textRows.length > 0) && (
        <CommandGroup heading="Notes">
          {titleRows.map((summary) => (
            <NoteItem key={summary.id} summary={summary} query={trimmed} onSelect={() => go(pageHref(summary.id))} />
          ))}
          {textRows.map((hit) => (
            <NoteItem key={hit.page.id} summary={hit.page} query="" snippet={hitSnippet(hit)} onSelect={() => go(pageHref(hit.page.id))} />
          ))}
        </CommandGroup>
      )}
      {record && mentionHits.length > 0 && (
        <CommandGroup heading={`Mentions ${record.name}`}>
          {mentionHits.map((hit) => (
            <NoteItem key={hit.page.id} summary={hit.page} query="" snippet={hitSnippet(hit)} onSelect={() => go(pageHref(hit.page.id))} />
          ))}
        </CommandGroup>
      )}
      <CommandSeparator />
      <CommandGroup heading="Actions">
        <CommandItem value="docs-new-titled" onSelect={() => void create(trimmed)}>
          <PlusIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="truncate">New note &ldquo;{trimmed}&rdquo;</span>
          <Keys keys={["⌘", "↵"]} />
        </CommandItem>
        <CommandItem value="docs-search-all" onSelect={() => go(`/docs?q=${encodeURIComponent(trimmed)}`)}>
          <SearchIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="truncate">Search all docs for &ldquo;{trimmed}&rdquo;</span>
          <Keys keys={["⌘", "⇧", "F"]} />
        </CommandItem>
        {record && (
          <CommandItem value="docs-open-record" onSelect={() => go(recordHref(record.kind, record.id))}>
            <RecordIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <span className="truncate">
              Open {record.name} in {recordList}
            </span>
          </CommandItem>
        )}
      </CommandGroup>
      <CommandSeparator />
    </>
  );
}
