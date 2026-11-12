"use client";

import { useContext, useId, useState, type KeyboardEvent } from "react";
import { removeFromShareAction } from "@/app/(crm)/mail/share-actions";
import Button from "@/components/_ui/button";
import { inputClass } from "@/components/_ui/field-styles";
import HoldButton from "@/components/_ui/hold-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { matchPeople } from "@/components/chat/people-field";
import { DocsContext } from "@/components/docs/use-docs";
import { PeopleStack, PersonAvatar } from "@/components/mail/share-control";
import { fetchDraftCandidates, shareDraftWith } from "@/components/mail/shared-draft-client";
import type { MailShareCandidate, MailSharePerson } from "@/lib/mail/share-types";
import { candidateDetail, draftShareLabel, joinNames, personFirstName } from "@/lib/mail/share-view";
import { cn } from "@/lib/utils";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";

const MAX_OPTIONS = 6;
const SHARE_FAILED = "Couldn't share the draft. Try again.";
const REMOVE_FAILED = "Couldn't remove them. Try again.";
export const DRAFT_SHARE_REACH = "They can edit the subject and message. Only you can change recipients, attachments and send.";

export function useComposeViewer() {
  return useContext(DocsContext)?.seed.viewer ?? null;
}

export default function DraftShare({
  mode,
  shareId,
  people,
  threadPeople,
  ensureSaved,
  onShared,
  onPeople,
}: {
  mode: "new" | "reply" | "reply_all" | "forward";
  shareId: string | null;
  people: MailSharePerson[];
  threadPeople: MailSharePerson[];
  ensureSaved: () => Promise<{ id: string } | { error: string }>;
  onShared: (shareId: string, people: MailSharePerson[]) => void;
  onPeople: (people: MailSharePerson[]) => void;
}) {
  const viewer = useComposeViewer();
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MailShareCandidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const fresh = mode === "new";
  const threadMembers = threadPeople.filter((person) => !person.owner);
  if (!viewer || (!fresh && threadMembers.length === 0 && !shareId)) return null;

  const members = people.filter((person) => !person.owner);
  const inside = new Set([viewer.id, ...people.map((person) => person.id)]);
  const options = fresh && candidates ? matchPeople(candidates, query, inside).slice(0, MAX_OPTIONS) : [];
  const active = Math.min(highlight, Math.max(0, options.length - 1));

  async function share(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      const saved = await ensureSaved();
      if ("error" in saved) {
        setError(saved.error);
        return;
      }
      const result = await shareDraftWith(saved.id, ids);
      onShared(result.shareId, result.people);
      setQuery("");
      setHighlight(0);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : SHARE_FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function remove(person: MailSharePerson) {
    if (!shareId) return;
    setError(null);
    const before = people;
    onPeople(people.filter((item) => item.id !== person.id));
    const result = await removeFromShareAction(shareId, person.id).catch(() => ({ error: REMOVE_FAILED }));
    if (!("ok" in result && result.ok)) {
      onPeople(before);
      setError("error" in result ? result.error : REMOVE_FAILED);
    }
  }

  function openPanel(next: boolean) {
    setOpen(next);
    setError(null);
    if (next && fresh && candidates === null) fetchDraftCandidates().then(setCandidates, (problem: Error) => setError(problem.message));
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
      void share([options[active].id]);
    }
  }

  const label = draftShareLabel(members);
  const listed = shareId ? members : fresh ? [] : threadMembers;

  return (
    <Popover open={open} onOpenChange={openPanel}>
      <PopoverTrigger asChild>
        <Button
          variant={members.length ? "secondary" : "ghost"}
          size={members.length ? "sm" : "icon"}
          aria-label={label}
          title={label}
          aria-expanded={open}
          className={cn(members.length ? "gap-1.5 pr-2.5 pl-1.5" : "", "pointer-coarse:h-11 pointer-coarse:min-w-11")}
        >
          {members.length ? <PeopleStack people={members.slice(0, 3)} viewerId={viewer.id} size="sm" /> : <UsersIcon aria-hidden className="size-3.5" />}
          {members.length > 0 && <span className="max-sm:sr-only">Shared</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0" aria-label="Share this draft">
        <div className="flex flex-col pb-3">
          <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
            <UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />
            <h3 className="flex-1">Share this draft</h3>
          </div>
          {fresh && (
            <div className="px-3">
              <label htmlFor={inputId} className="sr-only">
                Add people
              </label>
              <input
                id={inputId}
                value={query}
                role="combobox"
                aria-expanded={options.length > 0}
                aria-controls={options.length > 0 ? listId : undefined}
                aria-autocomplete="list"
                aria-activedescendant={options[active] ? `${listId}-${options[active].id}` : undefined}
                autoComplete="off"
                disabled={busy}
                placeholder={candidates === null ? "Loading people…" : "Add people…"}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                className={cn(inputClass, "h-9 pointer-coarse:h-11 max-md:text-[16px]")}
              />
            </div>
          )}
          {options.length > 0 && (
            <ul id={listId} role="listbox" aria-label="People to add" className="flex max-h-48 flex-col overflow-y-auto overscroll-contain px-2 pt-1.5">
              {options.map((person, index) => (
                <li
                  key={person.id}
                  id={`${listId}-${person.id}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => void share([person.id])}
                  className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 pointer-coarse:min-h-11", index === active ? "bg-surface-active" : "hover:bg-surface-hover")}
                >
                  <PersonAvatar person={person} viewerId={viewer.id} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] leading-5">{person.name}</span>
                    {candidateDetail(person) && <span className="caption-style text-subtle truncate">{candidateDetail(person)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {listed.length > 0 && (
            <div className="border-line-strong mt-2 flex flex-col border-t px-2 pt-2">
              <p className="caption-style text-subtle px-2 py-1">{shareId ? "In this draft" : "Shares with the thread"}</p>
              <ul aria-label={shareId ? "In this draft" : "Shares with the thread"} className="flex flex-col">
                {listed.map((person) => (
                  <li key={person.id} className="flex min-h-9 items-center gap-2.5 px-2 py-1 pointer-coarse:min-h-11">
                    <PersonAvatar person={person} viewerId={viewer.id} />
                    <span className="ui-style min-w-0 flex-1 truncate">{person.name}</span>
                    {fresh && shareId && (
                      <HoldButton tone="neutral" holding="Keep holding" onConfirm={() => void remove(person)} className="shrink-0 pointer-coarse:h-11 pointer-coarse:px-4">
                        Remove<span className="sr-only"> {person.name}</span>
                      </HoldButton>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!fresh && !shareId && (
            <div className="px-4 pt-3">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void share([])} className="pointer-coarse:h-11">
                Share with {joinNames(threadMembers.map((person) => personFirstName(person.name)))}
              </Button>
            </div>
          )}
          {!fresh && <p className="caption-style text-subtle px-4 pt-2">Change who&apos;s in it with Share on the thread.</p>}
          {error && (
            <p role="alert" className="caption-style text-danger px-4 pt-2">
              {error}
            </p>
          )}
          <p className="caption-style text-soft bg-surface-field mx-3 mt-2.5 rounded-lg px-3 py-2.5">{DRAFT_SHARE_REACH}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
