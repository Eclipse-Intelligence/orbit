"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { addRoomMembersAction, leaveRoomAction, removeRoomMemberAction, updateRoomAction } from "@/app/(crm)/chat/actions";
import { ChatAvatar, useChat } from "@/components/chat/chat-context";
import { refreshChatSidebar } from "@/components/chat/chat-live";
import { usePeople } from "@/components/chat/chat-dialogs";
import { workspaceRolesAction } from "@/app/(crm)/chat/roles";
import type { WorkspaceRole } from "@/lib/crm/types";
import PeopleField, { pickerOpen, type ChatCandidate } from "@/components/chat/people-field";
import RoomHooks, { type HookSecrets } from "@/components/chat/room-hooks";
import { CHAT_ROOM_NAME_MAX, type ChatRoom } from "@/lib/chat/types";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const ROLE_LABELS: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function useRoles(open: boolean, workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ workspaceId: string; roles: Record<string, WorkspaceRole> } | null>(null);
  useEffect(() => {
    if (!open || !workspaceId) return;
    let live = true;
    void workspaceRolesAction(workspaceId)
      .then((result) => {
        if (live && "roles" in result) setLoaded({ workspaceId, roles: result.roles });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, workspaceId]);
  return loaded && loaded.workspaceId === workspaceId ? loaded.roles : {};
}

export default function RoomSettings({
  open,
  onOpenChange,
  room,
  adding,
  onLeft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: ChatRoom;
  adding: boolean;
  onLeft: () => void;
}) {
  const { viewer, multi, workspaces, loadRoom } = useChat();
  const ids = { name: useId(), workspace: useId(), people: useId() };
  const conversation = room.conversation;
  const [name, setName] = useState(conversation.name);
  const [workspaceId, setWorkspaceId] = useState(conversation.workspaceId ?? "");
  const [seen, setSeen] = useState({ open, id: conversation.id, name: conversation.name, workspaceId: conversation.workspaceId });
  const [addOpen, setAddOpen] = useState(adding);
  const [picked, setPicked] = useState<ChatCandidate[]>([]);
  const [error, setError] = useState<{ area: "members" | "room"; text: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [hookSecrets, setHookSecrets] = useState<{ roomId: string; secrets: Record<string, string> }>({ roomId: conversation.id, secrets: {} });
  const secrets: HookSecrets = {
    secrets: hookSecrets.roomId === conversation.id ? hookSecrets.secrets : {},
    set: (roomId, hookId, secret) =>
      setHookSecrets((current) => {
        const kept = current.roomId === roomId ? { ...current.secrets } : {};
        if (secret) kept[hookId] = secret;
        else delete kept[hookId];
        return { roomId, secrets: kept };
      }),
  };
  if (seen.open !== open || seen.id !== conversation.id || seen.name !== conversation.name || seen.workspaceId !== conversation.workspaceId) {
    setSeen({ open, id: conversation.id, name: conversation.name, workspaceId: conversation.workspaceId });
    setName(conversation.name);
    setWorkspaceId(conversation.workspaceId ?? "");
    if (seen.open !== open) {
      setAddOpen(adding);
      setPicked([]);
      setError(null);
      setStatus(null);
    }
  }
  const people = usePeople(open && addOpen, conversation.workspaceId);
  const roles = useRoles(open, conversation.workspaceId);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);
  const memberIds = new Set(room.members.map((member) => member.id));
  const candidates = people.people.filter((person) => !memberIds.has(person.id));
  const linked = workspaces.find((workspace) => workspace.id === workspaceId);
  const last = room.members.length <= 1;
  const changed = name.trim() !== conversation.name || (multi && (workspaceId || null) !== conversation.workspaceId);

  async function run<T>(work: () => Promise<T>, done: (result: T) => void) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      done(await work());
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || busy) return;
    const input: { name?: string; workspaceId?: string | null } = {};
    if (name.trim() !== conversation.name) input.name = name;
    if (multi && (workspaceId || null) !== conversation.workspaceId) input.workspaceId = workspaceId || null;
    void run(
      () => updateRoomAction(conversation.id, input).catch(() => ({ error: "Couldn't save the room. Try again." })),
      (result) => {
        if ("ok" in result && result.ok) {
          setStatus("Saved");
          loadRoom(conversation.id);
          refreshChatSidebar();
        } else setError({ area: "room", text: "error" in result ? result.error : "Couldn't save the room. Try again." });
      },
    );
  }

  function add() {
    if (picked.length === 0 || busy) return;
    void run(
      () => addRoomMembersAction(conversation.id, picked.map((person) => person.id)).catch(() => ({ error: "Couldn't add them. Try again." })),
      (result) => {
        if ("ok" in result && result.ok) {
          setPicked([]);
          setAddOpen(false);
          loadRoom(conversation.id);
        } else setError({ area: "members", text: "error" in result ? result.error : "Couldn't add them. Try again." });
      },
    );
  }

  function remove(userId: string) {
    void run(
      () => removeRoomMemberAction(conversation.id, userId).catch(() => ({ error: "Couldn't remove them. Try again." })),
      (result) => {
        if ("ok" in result && result.ok) loadRoom(conversation.id);
        else setError({ area: "members", text: "error" in result ? result.error : "Couldn't remove them. Try again." });
      },
    );
  }

  function leave() {
    void run(
      () => leaveRoomAction(conversation.id).catch(() => ({ error: "Couldn't leave the room. Try again." })),
      (result) => {
        if ("ok" in result && result.ok) {
          onOpenChange(false);
          refreshChatSidebar();
          onLeft();
        } else setError({ area: "room", text: "error" in result ? result.error : "Couldn't leave the room. Try again." });
      },
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full md:w-[480px] md:max-w-[480px]"
        onEscapeKeyDown={(event) => {
          if (pickerOpen()) event.preventDefault();
        }}
      >
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" data-shortcut-scope>
          <SheetHeader className="max-md:pt-[env(safe-area-inset-top)] max-md:h-auto max-md:min-h-14">
            <SheetTitle className="h3-style truncate">#{conversation.name}</SheetTitle>
            <SheetDescription className="sr-only">Room settings</SheetDescription>
            <SheetCloseButton label="Close" className="max-md:size-11" />
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-6 pt-5 pb-6 max-md:px-4">
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.name} className="lead-style font-medium">
                Name
              </label>
              <Input id={ids.name} value={name} maxLength={CHAT_ROOM_NAME_MAX} onChange={(event) => setName(event.target.value)} className="max-md:h-11" />
            </div>
            {multi && (
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.workspace} className="lead-style font-medium">
                  Workspace
                </label>
                <NativeSelect id={ids.workspace} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className="max-md:h-11">
                  <option value="">Not linked</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </NativeSelect>
                <span className="caption-style text-subtle">
                  {linked ? `Only ${linked.name} members can join. Leaving ${linked.name} removes people from this room.` : "Anyone who shares a workspace with you can be added."}
                </span>
              </div>
            )}
            <section aria-labelledby="room-members" className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h3 id="room-members" className="flex-1">
                  Members
                </h3>
                <span className="caption-style text-subtle mr-2 tabular-nums">{room.members.length}</span>
                <Button variant="secondary" size="sm" onClick={() => setAddOpen((value) => !value)} aria-expanded={addOpen} className="max-md:h-11">
                  <PlusIcon aria-hidden className="size-3" />
                  Add people
                </Button>
              </div>
              {addOpen && (
                <div className="flex flex-col gap-2">
                  <label htmlFor={ids.people} className="sr-only">
                    People to add
                  </label>
                  <PeopleField inputId={ids.people} people={candidates} selected={picked} onChange={setPicked} loading={people.loading} autoFocus />
                  {people.error && (
                    <span role="alert" className="caption-style text-danger">
                      {people.error}
                    </span>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)} className="max-md:h-11">
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" disabled={picked.length === 0 || busy} onClick={add} className="max-md:h-11">
                      Add
                    </Button>
                  </div>
                </div>
              )}
              {error?.area === "members" && (
                <p role="alert" className="caption-style text-danger">
                  {error.text}
                </p>
              )}
              <ul className="flex flex-col">
                {room.members.map((member) => {
                  const you = member.id === viewer.id;
                  const role = roles[member.id];
                  const notes = [you ? "You" : null, member.id === room.createdBy ? "Created the room" : null, role ? ROLE_LABELS[role] : null].filter(Boolean).join(" · ");
                  return (
                    <li key={member.id} className="flex items-center gap-2.5 py-1.5">
                      <ChatAvatar person={{ id: member.id, name: member.name }} size="lg" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="ui-style truncate">{member.name}</span>
                        {(notes || member.email) && <span className="caption-style text-subtle truncate">{notes || member.email}</span>}
                      </span>
                      {!you && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(member.id)} aria-label={`Remove ${member.name}`} className="max-md:h-11">
                          Remove
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
            <RoomHooks open={open} roomId={conversation.id} roomName={conversation.name} secrets={secrets} />
          </div>
          {error?.area === "room" && (
            <p role="alert" className="caption-style text-danger border-line-strong border-t px-6 pt-3 max-md:px-4">
              {error.text}
            </p>
          )}
          <p role="status" className="sr-only">
            {status ?? ""}
          </p>
          <SheetFooter className="max-md:px-4">
            <Button variant="ghost" size="md" className="text-danger hover:text-danger max-md:h-11" onClick={() => setLeaving(true)}>
              Leave room
            </Button>
            <span className="flex items-center gap-3">
              {status && (
                <span aria-hidden className="caption-style text-subtle">
                  {status}
                </span>
              )}
              <Button type="submit" variant="primary" size="md" disabled={!changed || !name.trim() || busy} data-shortcut-submit className="max-md:h-11">
                Save
              </Button>
            </span>
          </SheetFooter>
        </form>
        <ConfirmDialog
          open={leaving}
          onOpenChange={setLeaving}
          title={`Leave #${conversation.name}?`}
          description={last ? "You're the last member, so the room and its messages are deleted." : "Anyone in the room can add you back."}
          confirmLabel={last ? "Leave and delete" : "Leave room"}
          onConfirm={leave}
        />
      </SheetContent>
    </Sheet>
  );
}
