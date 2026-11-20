"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { createRoomAction, openGroupAction } from "@/app/(crm)/chat/actions";
import { useChat } from "@/components/chat/chat-context";
import { refreshChatSidebar } from "@/components/chat/chat-live";
import PeopleField, { pickerOpen, type ChatCandidate } from "@/components/chat/people-field";
import { chatApi } from "@/lib/chat/client";
import { CHAT_GROUP_MAX, CHAT_ROOM_NAME_MAX, type ChatConversation } from "@/lib/chat/types";

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
  const [chosen, setChosen] = useState<ChatCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const people = usePeople(open, null);

  function reset(next: boolean) {
    if (!next) {
      setChosen([]);
      setError(null);
      setBusy(false);
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await openGroupAction(chosen.map((person) => person.id)).catch(() => ({ error: "Couldn't open the conversation. Try again." }));
    setBusy(false);
    if ("ok" in result && result.ok) {
      refreshChatSidebar();
      reset(false);
      onOpened(result.conversation);
    } else setError("error" in result ? result.error : "Couldn't open the conversation. Try again.");
  }

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
            <DialogTitle>New message</DialogTitle>
            <DialogDescription>Message anyone who shares a workspace with you.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6 py-5">
            <label htmlFor={inputId} className="sr-only">
              People
            </label>
            <PeopleField inputId={inputId} people={people.people} selected={chosen} onChange={setChosen} loading={people.loading} max={CHAT_GROUP_MAX - 1} autoFocus />
            <span className="caption-style text-subtle">Up to {CHAT_GROUP_MAX} people, including you. To add someone, start a new message with everyone.</span>
            {(error || people.error) && (
              <p role="alert" className="caption-style text-danger">
                {error ?? people.error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="md" className="hit max-md:h-11">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" size="md" disabled={chosen.length === 0 || busy} data-shortcut-submit className="hit max-md:h-11">
              {busy ? "Opening…" : "Open"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
