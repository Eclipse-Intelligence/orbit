import { chatLabel, type ChatKind, type ChatSidebar } from "@/lib/chat/types";

export type ChatJump = {
  id: string;
  kind: ChatKind;
  name: string;
  unread: number;
  archived: boolean;
  workspaceName: string | null;
};

const JUMPS_SHOWN = 8;
const UNREAD_SHOWN = 5;

function words(text: string) {
  return text.trim().toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
}

function matches(item: ChatJump, wanted: string[], multi: boolean) {
  const haystack = `${item.name} ${multi ? (item.workspaceName ?? "") : ""}`.toLowerCase();
  return wanted.every((word) => haystack.includes(word));
}

function newest(left: string | null, right: string | null) {
  return (right ?? "").localeCompare(left ?? "");
}

export function chatJumps(sidebar: ChatSidebar | null, text: string, multi: boolean): ChatJump[] {
  if (!sidebar) return [];
  const wanted = words(text);
  const live = [...sidebar.conversations]
    .sort((left, right) => Number(right.unread > 0) - Number(left.unread > 0) || Number(right.mentions > 0) - Number(left.mentions > 0) || newest(left.lastMessageAt, right.lastMessageAt) || left.name.localeCompare(right.name))
    .map<ChatJump>((conversation) => ({
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      unread: conversation.unread,
      archived: false,
      workspaceName: conversation.workspaceName,
    }));
  if (wanted.length === 0) return live.filter((item) => item.unread > 0).slice(0, UNREAD_SHOWN);
  const old = (sidebar.archived ?? []).map<ChatJump>((room) => ({ id: room.id, kind: "room", name: room.name, unread: 0, archived: true, workspaceName: room.workspaceName }));
  return [...live, ...old].filter((item) => matches(item, wanted, multi)).slice(0, JUMPS_SHOWN);
}

export function jumpLabel(item: Pick<ChatJump, "kind" | "name">) {
  return chatLabel(item);
}
