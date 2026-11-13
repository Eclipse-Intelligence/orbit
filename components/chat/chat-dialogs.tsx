"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { createRoomAction, openDmAction } from "@/app/(crm)/chat/actions";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { refreshChatSidebar } from "@/components/chat/chat-live";
import PeopleField, { matchPeople, pickerOpen, type ChatCandidate } from "@/components/chat/people-field";
import { chatApi } from "@/lib/chat/client";
import { CHAT_ROOM_NAME_MAX, type ChatConversation } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export function usePeople(open: boolean, workspaceId: string | null) {
  const [state, setState] = useState<{ key: string; people: ChatCandidate[]; error: string | null; loading: boolean }>({ key: "", people: [], error: null, loading: false });
  const key = `${open}:${workspaceId ?? ""}`;
  if (open && state.key !== key) setState({ key, people: [], error: null, loading: true });
  useEffect(() => {
    if (!open) return;
    let live = true;
    chatApi
      .people(workspaceId)
      .then((result) => {
        if (live) setState({ key: `${open}:${workspaceId ?? ""}`, people: result.people, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (live) setState({ key: `${open}:${workspaceId ?? ""}`, people: [], error: error.message, loading: false });
      });
    return () => {
      live = false;
    };
  }, [open, workspaceId]);
  return state;
}

export function NewRoomDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (conversation: ChatConversation) => void }) {
  const { multi, workspaces } = useChat();
  const ids = { name: useId(), workspace: useId(), people: useId() };
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [members, setMembers] = useState<ChatCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const people = usePeople(open, workspaceId || null);

  function reset(next: boolean) {
    if (!next) {
      setName("");
      setWorkspaceId("");
      setMembers([]);
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const allowed = new Set(people.people.map((person) => person.id));
    const result = await createRoomAction({ name, workspaceId: workspaceId || null, memberIds: members.filter((member) => allowed.has(member.id)).map((member) => member.id) }).catch(() => ({
      error: "Couldn't create the room. Try again.",
    }));
    setSaving(false);
    if ("ok" in result && result.ok) {
      refreshChatSidebar();
      reset(false);
      onCreated(result.conversation);
    } else setError("error" in result ? result.error : "Couldn't create the room. Try again.");
  }

  const linked = workspaces.find((workspace) => workspace.id === workspaceId);

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        className="pointer-coarse:[&>button[aria-label=Close]]:top-2 pointer-coarse:[&>button[aria-label=Close]]:right-2 pointer-coarse:[&>button[aria-label=Close]]:size-11"
        onEscapeKeyDown={(event) => {
          if (pickerOpen()) event.preventDefault();
        }}
      >
        <form onSubmit={submit} data-shortcut-scope>
          <DialogHeader className="pr-12">
            <DialogTitle>New room</DialogTitle>
            <DialogDescription className="sr-only">Name the room and add people.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.name} className="lead-style font-medium">
                Name
              </label>
              <Input id={ids.name} value={name} maxLength={CHAT_ROOM_NAME_MAX} placeholder="pricing" autoFocus onChange={(event) => setName(event.target.value)} className="max-md:h-11" />
            </div>
            {multi && (
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.workspace} className="lead-style font-medium">
                  Workspace
                </label>
                <NativeSelect
                  id={ids.workspace}
                  value={workspaceId}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                    setMembers([]);
                  }}
                  className="max-md:h-11"
                >
                  <option value="">Not linked</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </NativeSelect>
                <span className="caption-style text-subtle">
                  {linked ? `Only ${linked.name} members can join.` : "Anyone who shares a workspace with you can be added."}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.people} className="lead-style font-medium">
                People
              </label>
              <PeopleField inputId={ids.people} people={people.people} selected={members} onChange={setMembers} loading={people.loading} />
              {people.error && (
                <span role="alert" className="caption-style text-danger">
                  {people.error}
                </span>
              )}
            </div>
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md" className="hit max-md:h-11">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" size="md" disabled={!name.trim() || saving} data-shortcut-submit className="hit max-md:h-11">
              {saving ? "Creating…" : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function NewMessageDialog({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange: (open: boolean) => void; onOpened: (conversation: ChatConversation) => void }) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const people = usePeople(open, null);
  const options = matchPeople(people.people, query, new Set());
  const active = Math.min(highlight, Math.max(0, options.length - 1));

  function reset(next: boolean) {
    if (!next) {
      setQuery("");
      setHighlight(0);
      setError(null);
      setBusy(null);
    }
    onOpenChange(next);
  }

  async function pick(person: ChatCandidate) {
    if (busy) return;
    setBusy(person.id);
    setError(null);
    const result = await openDmAction(person.id).catch(() => ({ error: "Couldn't open the conversation. Try again." }));
    setBusy(null);
    if ("ok" in result && result.ok) {
      refreshChatSidebar();
      reset(false);
      onOpened(result.conversation);
    } else setError("error" in result ? result.error : "Couldn't open the conversation. Try again.");
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="pointer-coarse:[&>button[aria-label=Close]]:top-2 pointer-coarse:[&>button[aria-label=Close]]:right-2 pointer-coarse:[&>button[aria-label=Close]]:size-11">
        <DialogHeader className="pr-12">
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>Message anyone who shares a workspace with you.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 py-5">
          <label htmlFor={inputId} className="sr-only">
            Find a person
          </label>
          <Input
            id={inputId}
            value={query}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options[active] ? `${listId}-${options[active].id}` : undefined}
            autoComplete="off"
            autoFocus
            placeholder="Find a person"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
                event.preventDefault();
                setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
              } else if (event.key === "Enter" && options[active]) {
                event.preventDefault();
                void pick(options[active]);
              }
            }}
            className="max-md:h-11"
          />
          <ul id={listId} role="listbox" aria-label="People" className="-mx-2 flex max-h-[min(20rem,50dvh)] flex-col overflow-y-auto">
            {options.map((person, index) => (
              <li key={person.id} id={`${listId}-${person.id}`} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => void pick(person)}
                  onMouseEnter={() => setHighlight(index)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left max-md:min-h-11", index === active && "bg-white/[0.07]")}
                >
                  <ChatAvatar person={person} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] leading-5">{person.name}</span>
                    {person.email && <span className="caption-style text-subtle truncate">{person.email}</span>}
                  </span>
                  {busy === person.id && <span className="caption-style text-subtle">Opening…</span>}
                </button>
              </li>
            ))}
            {options.length === 0 && (
              <li role="presentation" className="caption-style text-subtle px-2 py-2">
                {people.loading ? "Loading people…" : people.people.length === 0 ? "No one shares a workspace with you yet." : "No one matches."}
              </li>
            )}
          </ul>
          {(error || people.error) && (
            <p role="alert" className="caption-style text-danger">
              {error ?? people.error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
