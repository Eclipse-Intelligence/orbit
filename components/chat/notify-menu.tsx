"use client";

import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { useChat } from "@/components/chat/chat-context";
import { chatLevel, type ChatConversation, type ChatLevel } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import BellIcon from "@/public/assets/images/chat/bell.svg";
import BellOffIcon from "@/public/assets/images/chat/bell-off.svg";
import StarIcon from "@/public/assets/images/chat/star.svg";

export const LEVEL_LABELS: Record<ChatLevel, string> = { all: "All messages", mentions: "Mentions", mute: "Muted" };

export function conversationLevel(conversation: Pick<ChatConversation, "kind" | "notify">) {
  return chatLevel(conversation.kind, conversation.notify);
}

function Choice({ value, label, detail }: { value: ChatLevel; label: string; detail?: string }) {
  return (
    <DropdownMenuRadioItem value={value} className="ui-style">
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground">{label}</span>
        {detail && <span className="caption-style text-subtle">{detail}</span>}
      </span>
    </DropdownMenuRadioItem>
  );
}

export function NotifyItems({ conversation }: { conversation: ChatConversation }) {
  const { setNotify } = useChat();
  const dm = conversation.kind === "dm";
  const level = conversationLevel(conversation);
  return (
    <>
      <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={level} onValueChange={(value) => setNotify(conversation.id, { notify: value as ChatLevel })}>
        <Choice value="all" label="All messages" detail={dm ? "The default for direct messages" : undefined} />
        {!dm && <Choice value="mentions" label="Mentions" detail="The default for rooms" />}
        <Choice value="mute" label="Nothing (mute)" detail="Still bold when there's something new" />
      </DropdownMenuRadioGroup>
      {!dm && level === "mute" && (
        <DropdownMenuCheckboxItem
          checked={conversation.muteMentions}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => setNotify(conversation.id, { muteMentions: checked === true })}
        >
          Mute mentions too
        </DropdownMenuCheckboxItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => setNotify(conversation.id, { starred: !conversation.starred })}>
        <StarIcon aria-hidden className={cn("size-3.5", conversation.starred ? "text-foreground" : "text-subtle")} />
        {conversation.starred ? (dm ? "Unstar conversation" : "Unstar room") : dm ? "Star conversation" : "Star room"}
      </DropdownMenuItem>
    </>
  );
}

export function NotifyButton({ conversation }: { conversation: ChatConversation }) {
  const level = conversationLevel(conversation);
  const Icon = level === "mute" ? BellOffIcon : BellIcon;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Notifications: ${LEVEL_LABELS[level]}`} title="Notifications" className="hit text-soft gap-1.5 px-2 max-md:size-11 max-md:px-0">
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="max-md:hidden">{LEVEL_LABELS[level]}</span>
          <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0 max-md:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[248px]">
        <NotifyItems conversation={conversation} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
