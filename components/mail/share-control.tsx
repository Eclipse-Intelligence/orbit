"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { removeFromShareAction, shareThreadAction } from "@/app/(crm)/mail/share-actions";
import Button from "@/components/_ui/button";
import { inputClass } from "@/components/_ui/field-styles";
import HoldButton from "@/components/_ui/hold-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Sheet, SheetCloseButton, SheetContent, SheetTitle } from "@/components/_ui/sheet";
import { matchPeople } from "@/components/chat/people-field";
import { ParticipantAvatar, type AvatarSize } from "@/components/docs/presence";
import { useMedia } from "@/components/docs/use-docs";
import { cachedSharePeople, fetchShareControl, fetchSharePeople, storeSharePeople } from "@/components/mail/share-client";
import { useMailShareEvents } from "@/components/mail/share-live";
import { useShortcut, useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import type { ChatPerson } from "@/lib/chat/types";
import { personParticipant } from "@/lib/docs/participants";
import type { MailShareCandidate, MailShareControl, MailSharePerson } from "@/lib/mail/share-types";
import { SHARE_REACH, candidateDetail, joinNames, personFirstName } from "@/lib/mail/share-view";
import { cn } from "@/lib/utils";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";

const MAX_OPTIONS = 6;
const ADD_FAILED = "Couldn't share the thread. Try again.";
const REMOVE_FAILED = "Couldn't remove them. Try again.";

export function PersonAvatar({ person, viewerId, size = "md", ring, className }: { person: ChatPerson; viewerId: string; size?: AvatarSize; ring?: boolean; className?: string }) {
  return <ParticipantAvatar participant={personParticipant(person, viewerId)} size={size} ring={ring} className={className} />;
}

export function PeopleStack({ people, viewerId, size = "xs", className }: { people: ChatPerson[]; viewerId: string; size?: AvatarSize; className?: string }) {
  if (people.length === 0) return null;
  return (
    <span aria-hidden className={cn("flex items-center -space-x-1", className)}>
      {people.map((person) => (
        <PersonAvatar key={person.id} person={person} viewerId={viewerId} size={size} ring />
      ))}
    </span>
  );
}

export type ShareState = { shareId: string | null; people: MailSharePerson[]; candidates: MailShareCandidate[] | null };

type Held = { key: string; state: ShareState | null; error: string | null };

export function useThreadShare(threadKey: string | null) {
  const [held, setHeld] = useState<Held | null>(() => {
    const cached = threadKey ? cachedSharePeople(threadKey) : null;
    return threadKey ? { key: threadKey, state: cached ? { ...cached, candidates: null } : null, error: null } : null;
  });
  const current = held?.key === threadKey ? held : null;
  const state = current?.state ?? null;
  const wantCandidates = useRef(false);

  const loadPeople = useCallback(
    (signal?: AbortSignal) => {
      if (!threadKey) return;
      fetchSharePeople(threadKey, signal)
        .then((people) =>
          setHeld((existing) => ({
            key: threadKey,
            state: { ...people, candidates: existing?.key === threadKey ? (existing.state?.candidates ?? null) : null },
            error: null,
          })),
        )
        .catch((error: Error) => {
          if (signal?.aborted) return;
          setHeld((existing) => ({ key: threadKey, state: existing?.key === threadKey ? existing.state : null, error: error.message }));
        });
    },
    [threadKey],
  );

  const loadAll = useCallback(() => {
    if (!threadKey) return;
    wantCandidates.current = true;
    fetchShareControl(threadKey)
      .then((control) => setHeld({ key: threadKey, state: control, error: null }))
      .catch((error: Error) => setHeld((existing) => ({ key: threadKey, state: existing?.key === threadKey ? existing.state : null, error: error.message })));
  }, [threadKey]);

  useEffect(() => {
    wantCandidates.current = false;
    const controller = new AbortController();
    loadPeople(controller.signal);
    return () => controller.abort();
  }, [loadPeople]);

  const shareId = state?.shareId ?? null;
  useMailShareEvents((event) => {
    if (event.type !== "people" || event.shareId !== shareId) return;
    if (wantCandidates.current) loadAll();
    else loadPeople();
  });

  const update = useCallback(
    (change: (state: ShareState) => ShareState) => {
      if (!threadKey) return;
      setHeld((existing) => {
        if (existing?.key !== threadKey || !existing.state) return existing;
        const next = change(existing.state);
        storeSharePeople(threadKey, next);
        return { key: threadKey, state: next, error: null };
      });
    },
    [threadKey],
  );

  const apply = useCallback(
    (control: MailShareControl) => {
      if (!threadKey) return;
      storeSharePeople(threadKey, control);
      setHeld({ key: threadKey, state: control, error: null });
    },
    [threadKey],
  );

  return { state, error: current?.error ?? null, loadAll, update, apply };
}

export type ThreadShare = ReturnType<typeof useThreadShare>;

export function shareLabel(members: ChatPerson[]) {
  if (members.length === 0) return "Share this thread";
  return `Shared with ${joinNames(members.map((person) => personFirstName(person.name)))}. Change who can see it`;
}

function SharePanel({ share, threadKey, viewer, phone }: { share: ThreadShare; threadKey: string; viewer: ChatPerson; phone: boolean }) {
  const inputId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(0);
  const overlapped = useRef(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const state = share.state!;
  const candidates = state.candidates;
  const options = candidates ? matchPeople(candidates, query, new Set()).slice(0, MAX_OPTIONS) : [];
  const active = Math.min(highlight, Math.max(0, options.length - 1));
  const activeId = options[active] ? `${listId}-${options[active].id}` : undefined;

  function begin() {
    if (pending.current > 0) overlapped.current = true;
    pending.current += 1;
  }

  function settle() {
    pending.current -= 1;
    if (pending.current > 0 || !overlapped.current) return;
    overlapped.current = false;
    share.loadAll();
  }

  async function add(person: MailShareCandidate) {
    setError(null);
    setQuery("");
    setHighlight(0);
    begin();
    share.update((current) => ({
      ...current,
      people: [...current.people.filter((item) => item.id !== person.id), { id: person.id, name: person.name, email: person.email, owner: false, addedAt: new Date().toISOString() }],
      candidates: current.candidates?.filter((item) => item.id !== person.id) ?? null,
    }));
    setStatus(`Added ${person.name}.`);
    input.current?.focus();
    const result = await shareThreadAction(threadKey, [person.id]).catch(() => ({ error: ADD_FAILED }));
    if (!("ok" in result && result.ok)) {
      share.update((current) => ({
        ...current,
        people: current.people.filter((item) => item.id !== person.id),
        candidates: current.candidates && !current.candidates.some((item) => item.id === person.id) ? [...current.candidates, person].sort((a, b) => a.name.localeCompare(b.name)) : current.candidates,
      }));
      setStatus(null);
      setError("error" in result ? result.error : ADD_FAILED);
    } else if (pending.current === 1 && !overlapped.current) {
      share.apply(result.share);
    }
    settle();
  }

  async function remove(person: MailSharePerson) {
    if (!state.shareId) return;
    setError(null);
    begin();
    share.update((current) => ({
      ...current,
      people: current.people.filter((item) => item.id !== person.id),
      candidates: current.candidates ? [...current.candidates.filter((item) => item.id !== person.id), { id: person.id, name: person.name, email: person.email, role: null }].sort((a, b) => a.name.localeCompare(b.name)) : null,
    }));
    setStatus(`Removed ${person.name}.`);
    input.current?.focus();
    const result = await removeFromShareAction(state.shareId, person.id).catch(() => ({ error: REMOVE_FAILED }));
    if (!("ok" in result && result.ok)) {
      share.update((current) => ({
        ...current,
        people: current.people.some((item) => item.id === person.id) ? current.people : [...current.people, person],
        candidates: current.candidates?.filter((item) => item.id !== person.id) ?? null,
      }));
      setStatus(null);
      setError("error" in result ? result.error : REMOVE_FAILED);
    }
    settle();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Enter") {
      if (!options[active]) return;
      event.preventDefault();
      void add(options[active]);
    }
  }

  const people = state.people.length ? state.people : [{ id: viewer.id, name: viewer.name, email: null, owner: true, addedAt: "" }];
  const nobodyLeft = candidates !== null && candidates.length === 0;

  return (
    <div className="flex flex-col">
      <div className={cn("flex items-center gap-2.5 px-4 pt-4 pb-3", phone && "pt-3 pr-2")}>
        <UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />
        {phone ? <SheetTitle className="flex-1">Share this thread</SheetTitle> : <h3 className="flex-1">Share this thread</h3>}
        {phone && <SheetCloseButton className="size-11" />}
      </div>
      <div className="px-3">
        <label htmlFor={inputId} className="sr-only">
          Add people
        </label>
        <input
          id={inputId}
          ref={input}
          value={query}
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          placeholder={candidates === null ? "Loading people…" : nobodyLeft ? "Everyone here is in" : "Add people…"}
          disabled={nobodyLeft}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          className={cn(inputClass, "h-9 pointer-coarse:h-11 max-md:text-[16px]")}
        />
      </div>
      {options.length > 0 && (
        <div className="px-2 pt-1.5">
          <p className="caption-style text-subtle px-2 py-1">Add</p>
          <ul id={listId} role="listbox" aria-label="People to add" className="flex max-h-48 flex-col overflow-y-auto overscroll-contain">
            {options.map((person, index) => (
              <li
                key={person.id}
                id={`${listId}-${person.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => void add(person)}
                className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 pointer-coarse:min-h-11", index === active ? "bg-surface-active" : "hover:bg-surface-hover")}
              >
                <PersonAvatar person={person} viewerId={viewer.id} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13.5px] leading-5">{person.name}</span>
                  {candidateDetail(person) && <span className="caption-style text-subtle truncate">{candidateDetail(person)}</span>}
                </span>
                {index === active && !phone && <span className="caption-style text-subtle">Enter</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {query.trim() && candidates && options.length === 0 && <p className="caption-style text-subtle px-4 pt-2">No one matches.</p>}
      <div className="border-line-strong mt-2 flex flex-col border-t px-2 pt-2">
        <p className="caption-style text-subtle px-2 py-1">In this thread</p>
        <ul aria-label="In this thread" className="flex flex-col">
          {people.map((person) => (
            <li key={person.id} className="flex min-h-9 items-center gap-2.5 px-2 py-1 pointer-coarse:min-h-11">
              <PersonAvatar person={person} viewerId={viewer.id} />
              <span className="ui-style min-w-0 flex-1 truncate">{person.name}</span>
              {person.owner ? (
                <span className="caption-style text-subtle shrink-0">{person.id === viewer.id ? "You · Owner" : "Owner"}</span>
              ) : (
                <HoldButton tone="neutral" holding="Keep holding" onConfirm={() => void remove(person)} className="shrink-0 pointer-coarse:h-11 pointer-coarse:px-4">
                  Remove<span className="sr-only"> {person.name}</span>
                </HoldButton>
              )}
            </li>
          ))}
        </ul>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger px-4 pt-2">
          {error}
        </p>
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
      <p className="caption-style text-soft bg-surface-field mx-3 mt-2.5 mb-3 rounded-lg px-3 py-2.5">{SHARE_REACH}</p>
    </div>
  );
}

export default function ShareControl({
  threadKey,
  viewer,
  share,
  open,
  onOpenChange,
}: {
  threadKey: string;
  viewer: ChatPerson;
  share: ThreadShare;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phone = useMedia("(max-width: 47.99rem)");
  const hint = useShortcutHint("mail-share");
  const { state, error, loadAll } = share;
  const members = state?.people.filter((person) => !person.owner) ?? [];

  useEffect(() => {
    if (open) loadAll();
  }, [open, loadAll]);

  useShortcut("mail-share", () => onOpenChange(!open));

  const trigger = (
    <Button
      variant={members.length ? "secondary" : "ghost"}
      size="sm"
      aria-label={shareLabel(members)}
      aria-expanded={open}
      title={hint ? `Share (${hint})` : "Share"}
      onClick={() => onOpenChange(!open)}
      className={cn("h-[30px] gap-1.5 max-sm:hidden pointer-coarse:h-11", members.length ? "pr-2.5 pl-1.5 pointer-coarse:pl-2.5" : "px-2.5 pointer-coarse:px-3")}
    >
      {members.length ? <PeopleStack people={members.slice(0, 3)} viewerId={viewer.id} size="sm" /> : <UsersIcon aria-hidden className="size-3.5" />}
      {members.length ? "Shared" : "Share"}
    </Button>
  );

  const body = state ? (
    <SharePanel share={share} threadKey={threadKey} viewer={viewer} phone={phone} />
  ) : (
    <div className="flex flex-col gap-2 p-4">
      {error ? (
        <>
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
          <Button variant="secondary" size="sm" onClick={loadAll} className="self-start pointer-coarse:h-11">
            Try again
          </Button>
        </>
      ) : (
        <p role="status" className="caption-style text-subtle">
          Loading…
        </p>
      )}
    </div>
  );

  if (phone) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" aria-describedby={undefined} className="overflow-y-auto">
            {!state && <SheetTitle className="sr-only">Share this thread</SheetTitle>}
            {body}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0" aria-label="Share this thread">
        {body}
      </PopoverContent>
    </Popover>
  );
}
