"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Input } from "@/components/_ui/input";
import { readRecentEmojiText, readSkinTone, recentEmoji, subscribeEmojiPrefs, writeSkinTone } from "@/lib/chat/client";
import { CHAT_EMOJI, EMOJI_GROUPS, emojiName, searchEmoji, SKIN_TONE_LABELS, withTone } from "@/lib/chat/emoji";
import { cn } from "@/lib/utils";

const RECENT_SHOWN = 9;
const TONE_SWATCHES = ["bg-[#ffcc4d]", "bg-[#f7dece]", "bg-[#e0bb95]", "bg-[#bf8f68]", "bg-[#9b643d]", "bg-[#594539]"];

const GROUPED = EMOJI_GROUPS.map((group) => ({ ...group, items: CHAT_EMOJI.filter((item) => item.group === group.id) }));

function Cell({ emoji, onPick, onShow }: { emoji: string; onPick: (emoji: string) => void; onShow: (emoji: string) => void }) {
  const name = emojiName(emoji);
  return (
    <button
      type="button"
      aria-label={name ? `:${name}:` : emoji}
      onClick={() => onPick(emoji)}
      onMouseEnter={() => onShow(emoji)}
      onFocus={() => onShow(emoji)}
      className="hover:bg-surface-active focus-visible:bg-surface-active grid h-[34px] place-items-center rounded-[7px] text-[20px] leading-none outline-none"
    >
      {emoji}
    </button>
  );
}

function Grid({ label, emojis, onPick, onShow }: { label: string; emojis: string[]; onPick: (emoji: string) => void; onShow: (emoji: string) => void }) {
  if (emojis.length === 0) return null;
  return (
    <section aria-label={label}>
      <div aria-hidden className="caption-style text-subtle px-1 pt-1.5 pb-1">
        {label}
      </div>
      <div className="grid grid-cols-9 gap-0.5">
        {emojis.map((emoji) => (
          <Cell key={emoji} emoji={emoji} onPick={onPick} onShow={onShow} />
        ))}
      </div>
    </section>
  );
}

export default function EmojiPicker({ userId, onPick }: { userId: string; onPick: (emoji: string) => void }) {
  const recentText = useSyncExternalStore(
    subscribeEmojiPrefs,
    () => readRecentEmojiText(userId),
    () => "",
  );
  const tone = useSyncExternalStore(
    subscribeEmojiPrefs,
    () => readSkinTone(userId),
    () => 0,
  );
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const recent = useMemo(() => recentEmoji(recentText).slice(0, RECENT_SHOWN), [recentText]);
  const results = useMemo(() => (query.trim() ? searchEmoji(query, 90) : null), [query]);
  const toned = (emoji: string) => withTone(emoji, tone);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const timer = window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const preview = shown ?? recent[0] ?? null;
  const previewName = preview ? emojiName(preview) : null;

  return (
    <div className="flex w-[340px] max-w-[calc(100vw-32px)] flex-col p-2">
      <Input
        ref={search}
        type="search"
        value={query}
        placeholder="Search emoji"
        aria-label="Search emoji"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results?.[0]) {
            event.preventDefault();
            onPick(toned(results[0].emoji));
          }
        }}
        className="mb-1.5 h-8 text-[13px] pointer-coarse:h-11 pointer-coarse:text-[16px]"
      />
      <div className="-mx-1 h-[288px] overflow-y-auto overscroll-contain px-1">
        {results ? (
          results.length > 0 ? (
            <Grid label="Results" emojis={results.map((item) => toned(item.emoji))} onPick={onPick} onShow={setShown} />
          ) : (
            <p role="status" className="caption-style text-subtle py-8 text-center">
              No emoji found
            </p>
          )
        ) : (
          <>
            <Grid label="Recent" emojis={recent} onPick={onPick} onShow={setShown} />
            {GROUPED.map((group) => (
              <Grid key={group.id} label={group.label} emojis={group.items.map((item) => toned(item.emoji))} onPick={onPick} onShow={setShown} />
            ))}
          </>
        )}
      </div>
      <div className="border-line-strong mt-1.5 flex items-center gap-2 border-t px-1 pt-2">
        <span className="caption-style text-subtle flex min-w-0 flex-1 items-center gap-2 truncate">
          {preview && <span className="text-[16px] leading-none">{preview}</span>}
          {previewName && <span className="truncate">:{previewName}:</span>}
        </span>
        <div role="group" aria-label="Skin tone" className="flex shrink-0 items-center gap-1 pointer-coarse:gap-0">
          {TONE_SWATCHES.map((swatch, index) => (
            <button
              key={swatch}
              type="button"
              aria-label={SKIN_TONE_LABELS[index]}
              aria-pressed={tone === index}
              onClick={() => writeSkinTone(userId, index)}
              className="hit grid size-[18px] place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11"
            >
              <span className={cn("block size-3.5 rounded-full", swatch, tone === index && "ring-foreground ring-2 ring-offset-1 ring-offset-[var(--popover)]")} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
