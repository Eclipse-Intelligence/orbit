"use client";

import { useMemo, useSyncExternalStore } from "react";
import { readRecentEmojiText, readSkinTone, recentEmoji, subscribeEmojiPrefs } from "@/lib/chat/client";
import { CHAT_REACTION_MAX, type ChatMessage, type ChatPerson, type ChatReaction } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import SmilePlusIcon from "@/public/assets/images/chat/smile-plus.svg";

const NAMES_SHOWN = 10;

export function reactorNames(people: ChatPerson[], viewerId: string) {
  const ordered = [...people.filter((person) => person.id === viewerId), ...people.filter((person) => person.id !== viewerId)];
  const names = ordered.slice(0, NAMES_SHOWN).map((person) => (person.id === viewerId ? "You" : person.name));
  const rest = ordered.length - names.length;
  if (rest > 0) return `${names.join(", ")} and ${rest === 1 ? "1 other" : `${rest} others`}`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type EmojiPrefs = { recent: string[]; tone: number };

export function useEmojiPrefs(userId: string): EmojiPrefs {
  const text = useSyncExternalStore(
    subscribeEmojiPrefs,
    () => readRecentEmojiText(userId),
    () => "",
  );
  const tone = useSyncExternalStore(
    subscribeEmojiPrefs,
    () => readSkinTone(userId),
    () => 0,
  );
  return useMemo(() => ({ recent: recentEmoji(text), tone }), [text, tone]);
}

function Pill({ reaction, viewerId, readOnly, onToggle }: { reaction: ChatReaction; viewerId: string; readOnly: boolean; onToggle: () => void }) {
  const names = reactorNames(reaction.people, viewerId);
  return (
    <span className="group/pill relative">
      <button
        type="button"
        aria-pressed={reaction.mine}
        aria-label={`${reaction.emoji} ${reaction.count}: ${names}`}
        aria-disabled={readOnly || undefined}
        onClick={readOnly ? undefined : onToggle}
        className={cn(
          "hit inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-9 pointer-coarse:min-w-11 pointer-coarse:justify-center",
          reaction.mine ? "bg-surface-selected text-violet shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_60%,transparent)]" : "bg-surface-raised text-soft hover:bg-surface-active",
        )}
      >
        <span className="text-[14px] leading-none">{reaction.emoji}</span>
        <span className="tabular-nums">{reaction.count}</span>
      </button>
      <span
        aria-hidden
        className="bg-popover border-line-strong shadow-overlay pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-max max-w-[22em] rounded-lg border px-2.5 py-1.5 text-[12px] group-focus-within/pill:block group-hover/pill:block [@media(pointer:coarse)]:!hidden"
      >
        {reaction.emoji} {names}
      </span>
    </span>
  );
}

export default function Reactions({
  message,
  viewerId,
  readOnly = false,
  onToggle,
  onAdd,
}: {
  message: ChatMessage;
  viewerId: string;
  readOnly?: boolean;
  onToggle: (emoji: string) => void;
  onAdd: () => void;
}) {
  if (message.reactions.length === 0) return null;
  const full = message.reactions.length >= CHAT_REACTION_MAX;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 pointer-coarse:gap-2">
      {message.reactions.map((reaction) => (
        <Pill key={reaction.emoji} reaction={reaction} viewerId={viewerId} readOnly={readOnly} onToggle={() => onToggle(reaction.emoji)} />
      ))}
      {!full && !readOnly && (
        <button
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          onClick={onAdd}
          className="hit bg-surface-raised text-faint hover:text-soft hover:bg-surface-active grid h-6 w-7 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-9 pointer-coarse:w-11"
        >
          <SmilePlusIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
