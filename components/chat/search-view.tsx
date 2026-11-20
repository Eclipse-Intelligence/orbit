"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { DatePicker } from "@/components/_ui/date-picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import FilterChip from "@/components/_ui/filter-chip";
import { Label } from "@/components/_ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { PhoneBack } from "@/components/chat/room-view";
import SearchField, { SearchHint, type SearchBox } from "@/components/chat/search-field";
import { chatApi } from "@/lib/chat/client";
import { stampWhen } from "@/lib/chat/format";
import { parseChatLocation } from "@/lib/chat/routes";
import { searchFilterCount, searchParts, searchReady, writeSearchQuery } from "@/lib/chat/search";
import type { ChatPerson, ChatSearchHit, ChatSearchQuery } from "@/lib/chat/types";
import { formatDateLabel } from "@/lib/date-input";
import { useCompaniesStore } from "@/stores/companies-store";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";

const FILES_SHOWN = 3;
const ANY = "any";

type Results = { key: string; hits: ChatSearchHit[]; next: string | null; error: string | null };

function Highlight({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {searchParts(text, needle).map((part, index) =>
        part.match ? (
          <mark key={index} className="bg-warning/25 text-foreground rounded-[3px] px-px">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function where(hit: ChatSearchHit, multi: boolean) {
  const { conversation, subject } = hit;
  if (subject) {
    const noun = subject.kind === "task" ? "Task" : subject.kind === "doc" ? "Doc" : "Shared email";
    return subject.title ? `${noun}: ${subject.title}` : noun;
  }
  if (conversation.kind === "dm") return `Direct message with ${conversation.name}`;
  return `#${conversation.name}${multi && conversation.workspaceName ? ` · ${conversation.workspaceName}` : ""}`;
}

function HitRow({ hit, needle }: { hit: ChatSearchHit; needle: string }) {
  const { go, now, multi } = useChat();
  const place = where(hit, multi);
  const shown = hit.files.slice(0, FILES_SHOWN);
  const className =
    "hover:bg-surface-hover focus-visible:bg-surface-hover flex gap-3 px-5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 max-md:px-3 max-md:py-3.5";
  const body = (
    <>
      <ChatAvatar person={{ id: hit.author.id ?? hit.id, name: hit.author.name }} size="md" className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="caption-style text-subtle flex flex-wrap items-center gap-x-1.5">
          <span className="ui-style text-foreground font-medium">{hit.author.name}</span>
          <span className="min-w-0 truncate">{place}</span>
          {hit.conversation.archived && <span>Archived</span>}
          {hit.parentId && <span>In a thread</span>}
          <time dateTime={hit.createdAt}>{stampWhen(hit.createdAt, now)}</time>
        </span>
        {hit.excerpt && (
          <span className="ui-style text-soft block break-words">
            <Highlight text={hit.excerpt} needle={needle} />
          </span>
        )}
        {shown.length > 0 && (
          <span className="mt-0.5 flex flex-wrap gap-1.5">
            {shown.map((file) => (
              <span key={file.id} className="caption-style bg-surface-raised text-soft inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1">
                <PaperclipIcon aria-hidden className="text-subtle size-3 shrink-0" />
                <span className="truncate">
                  <Highlight text={file.name} needle={needle} />
                </span>
              </span>
            ))}
            {hit.files.length > shown.length && <span className="caption-style text-subtle py-1">+{hit.files.length - shown.length} more</span>}
          </span>
        )}
      </span>
    </>
  );

  if (hit.subject) {
    return (
      <li className="border-border border-b last:border-b-0">
        <Link href={hit.href} className={className}>
          {body}
        </Link>
      </li>
    );
  }

  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const url = new URL(hit.href, window.location.origin);
    const target = parseChatLocation(url.pathname, url.searchParams);
    if (!target) return;
    event.preventDefault();
    go(target);
  }

  return (
    <li className="border-border border-b last:border-b-0">
      <a href={hit.href} onClick={open} className={className}>
        {body}
      </a>
    </li>
  );
}

function usePeople(wanted: boolean) {
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!wanted || people || failed) return;
    let stale = false;
    chatApi
      .people()
      .then((found) => {
        if (!stale) setPeople(found.people.map((person) => ({ id: person.id, name: person.name })));
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [wanted, people, failed]);
  return { people, failed };
}

function Filters({ query, onChange }: { query: ChatSearchQuery; onChange: (query: ChatSearchQuery) => void }) {
  const { viewer } = useChat();
  const sidebar = useCompaniesStore((store) => store.chat);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const { people, failed } = usePeople(peopleOpen || Boolean(query.from));
  const conversations = useMemo(() => sidebar?.conversations ?? [], [sidebar]);
  const archived = useMemo(() => sidebar?.archived ?? [], [sidebar]);
  const rooms = conversations.filter((item) => item.kind === "room");
  const dms = conversations.filter((item) => item.kind === "dm");
  const inLabel = useMemo(() => {
    if (!query.in) return null;
    const found = conversations.find((item) => item.id === query.in);
    if (found) return found.kind === "dm" ? found.name : `#${found.name}`;
    const old = archived.find((item) => item.id === query.in);
    return old ? `#${old.name}` : "A conversation";
  }, [query.in, conversations, archived]);
  const fromLabel = query.from ? (query.from === viewer.id ? "You" : (people?.find((person) => person.id === query.from)?.name ?? "Someone")) : null;
  const dates = [query.after ? `After ${formatDateLabel(query.after)}` : null, query.before ? `Before ${formatDateLabel(query.before)}` : null].filter(Boolean);
  const set = (change: Partial<ChatSearchQuery>) => onChange({ ...query, ...change });
  const active = searchFilterCount(query) > 0;

  return (
    <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1.5 px-5 pb-3 max-md:px-3">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <FilterChip active={Boolean(query.in)} trailing={<ChevronDownIcon aria-hidden className="size-3" />} className="hit max-md:h-11">
            {inLabel ? `In ${inLabel}` : "In"}
          </FilterChip>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuRadioGroup value={query.in ?? ANY} onValueChange={(value) => set({ in: value === ANY ? null : value })}>
            <DropdownMenuRadioItem value={ANY}>Every conversation</DropdownMenuRadioItem>
            {rooms.length > 0 && <DropdownMenuLabel>Rooms</DropdownMenuLabel>}
            {rooms.map((room) => (
              <DropdownMenuRadioItem key={room.id} value={room.id}>
                <span className="truncate">#{room.name}</span>
              </DropdownMenuRadioItem>
            ))}
            {dms.length > 0 && <DropdownMenuLabel>Direct messages</DropdownMenuLabel>}
            {dms.map((dm) => (
              <DropdownMenuRadioItem key={dm.id} value={dm.id}>
                <span className="truncate">{dm.name}</span>
              </DropdownMenuRadioItem>
            ))}
            {archived.length > 0 && <DropdownMenuLabel>Archived rooms</DropdownMenuLabel>}
            {archived.map((room) => (
              <DropdownMenuRadioItem key={room.id} value={room.id}>
                <span className="truncate">#{room.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu modal={false} onOpenChange={setPeopleOpen}>
        <DropdownMenuTrigger asChild>
          <FilterChip active={Boolean(query.from)} trailing={<ChevronDownIcon aria-hidden className="size-3" />} className="hit max-md:h-11">
            {fromLabel ? `From ${fromLabel}` : "From"}
          </FilterChip>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuRadioGroup value={query.from ?? ANY} onValueChange={(value) => set({ from: value === ANY ? null : value })}>
            <DropdownMenuRadioItem value={ANY}>Anyone</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={viewer.id}>You</DropdownMenuRadioItem>
            {(people ?? []).map((person) => (
              <DropdownMenuRadioItem key={person.id} value={person.id}>
                <span className="truncate">{person.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {!people && !failed && (
            <p role="status" className="caption-style text-subtle px-2 py-2">
              Loading people…
            </p>
          )}
          {failed && (
            <p role="alert" className="caption-style text-danger px-2 py-2">
              Couldn&apos;t load people. Try again.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <FilterChip active={query.file} aria-pressed={query.file} onClick={() => set({ file: !query.file })} className="hit max-md:h-11">
        Has file
      </FilterChip>

      <Popover>
        <PopoverTrigger asChild>
          <FilterChip active={dates.length > 0} trailing={<ChevronDownIcon aria-hidden className="size-3" />} className="hit max-w-[20em] max-md:h-11">
            {dates.length > 0 ? dates.join(" · ") : "Date"}
          </FilterChip>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-search-after">After</Label>
            <DatePicker id="chat-search-after" value={query.after ?? ""} onChange={(value) => set({ after: value || null })} placeholder="Any date" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-search-before">Before</Label>
            <DatePicker id="chat-search-before" value={query.before ?? ""} onChange={(value) => set({ before: value || null })} placeholder="Any date" />
          </div>
          {dates.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => set({ after: null, before: null })} className="hit self-start max-md:h-11">
              Clear dates
            </Button>
          )}
        </PopoverContent>
      </Popover>

      {active && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...query, in: null, from: null, file: false, after: null, before: null })} className="hit max-md:h-11">
          Clear filters
        </Button>
      )}
    </div>
  );
}

export default function SearchView({ query, box, hintId, onQuery }: { query: ChatSearchQuery; box: SearchBox; hintId: string; onQuery: (query: ChatSearchQuery) => void }) {
  const { back } = useChat();
  const key = writeSearchQuery(query).toString();
  const ready = searchReady(query.q);
  const [results, setResults] = useState<Results | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const current = results?.key === key ? results : null;

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    chatApi
      .search(query)
      .then((found) => {
        if (!stale) setResults({ key, hits: found.hits, next: found.next, error: null });
      })
      .catch((failure: Error) => {
        if (!stale) setResults({ key, hits: [], next: null, error: failure.message });
      });
    return () => {
      stale = true;
    };
  }, [query, key, ready, attempt]);

  function more() {
    if (!current?.next || loadingMore) return;
    const cursor = current.next;
    setLoadingMore(true);
    setMoreError(null);
    chatApi
      .search(query, cursor)
      .then((found) => setResults((latest) => (latest?.key === key ? { ...latest, hits: [...latest.hits, ...found.hits], next: found.next } : latest)))
      .catch((failure: Error) => setMoreError(failure.message))
      .finally(() => setLoadingMore(false));
  }

  const count = current && !current.error ? `${current.hits.length}${current.next ? "+" : ""} ${current.hits.length === 1 && !current.next ? "result" : "results"}` : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-5 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="min-w-0 truncate max-md:sr-only">{ready ? `Results for “${query.q.trim()}”` : "Search Chat"}</h2>
        <div className="min-w-0 flex-1 md:hidden">
          <SearchField box={box} hintId={`${hintId}-pane`} />
        </div>
        {count && (
          <span role="status" className="caption-style text-subtle ml-auto shrink-0 max-md:hidden">
            {count}
          </span>
        )}
      </header>
      <SearchHint id={`${hintId}-pane`} value={box.value} />
      <Filters query={query} onChange={onQuery} />
      <div className="border-border flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain border-t">
        {!ready && <p className="caption-style text-subtle px-5 py-10 text-center">Type at least 3 characters.</p>}
        {ready && !current && (
          <p role="status" className="caption-style text-subtle px-5 py-10 text-center">
            Searching…
          </p>
        )}
        {current?.error && (
          <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <p role="alert" className="text-danger">
              {current.error}
            </p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)} className="hit max-md:h-11">
              Try again
            </Button>
          </div>
        )}
        {current && !current.error && current.hits.length === 0 && (
          <p className="text-soft px-6 py-16 text-center">{searchFilterCount(query) > 0 ? `No messages match “${query.q.trim()}” with those filters.` : `No messages match “${query.q.trim()}”.`}</p>
        )}
        {current && current.hits.length > 0 && (
          <ul aria-label="Search results" className="flex flex-col">
            {current.hits.map((hit) => (
              <HitRow key={hit.id} hit={hit} needle={query.q} />
            ))}
          </ul>
        )}
        {current?.next && (
          <div className="flex flex-col items-center gap-2 px-5 py-4">
            {moreError && (
              <p role="alert" className="caption-style text-danger">
                {moreError}
              </p>
            )}
            <Button variant="secondary" size="sm" onClick={more} disabled={loadingMore} className="hit max-md:h-11">
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
