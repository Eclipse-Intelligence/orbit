"use client";

import type { KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { useShortcutHint } from "@/components/shortcuts/shortcuts-provider";
import { CHAT_SEARCH_MIN, CHAT_SEARCH_TEXT_MAX } from "@/lib/chat/types";
import { searchLength } from "@/lib/chat/search";
import { cn } from "@/lib/utils";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import RemoveIcon from "@/public/assets/images/chat/remove.svg";

export type SearchBox = {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onEscape: () => void;
};

export function SearchHint({ value, id, className }: { value: string; id: string; className?: string }) {
  const length = searchLength(value);
  return (
    <p id={id} role="status" className={cn("caption-style text-subtle px-2 pt-1.5 empty:hidden", className)}>
      {length > 0 && length < CHAT_SEARCH_MIN ? `Type at least ${CHAT_SEARCH_MIN} characters.` : ""}
    </p>
  );
}

export default function SearchField({ box, hintId, className }: { box: SearchBox; hintId: string; className?: string }) {
  const shortcut = useShortcutHint("chat-search");

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      box.onSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      box.onEscape();
    }
  }

  return (
    <div className={cn("relative", className)}>
      <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        data-chat-search-input=""
        type="search"
        role="searchbox"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={box.value}
        maxLength={CHAT_SEARCH_TEXT_MAX}
        onChange={(event) => box.onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search Chat"
        aria-label="Search Chat"
        aria-describedby={hintId}
        aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
        className="h-[30px] pr-8 pl-8 text-[14px] max-md:h-11 max-md:text-[15px] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {box.value ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear search"
          title="Clear search"
          onClick={box.onEscape}
          className="hit absolute top-1/2 right-1 -translate-y-1/2 max-md:size-9"
        >
          <RemoveIcon aria-hidden className="size-3" />
        </Button>
      ) : (
        shortcut && (
          <span aria-hidden className="caption-style text-faint pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 pointer-coarse:hidden max-lg:hidden">
            {shortcut}
          </span>
        )
      )}
    </div>
  );
}
