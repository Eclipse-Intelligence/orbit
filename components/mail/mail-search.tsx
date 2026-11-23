"use client";

import { memo, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { cn } from "@/lib/utils";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";

export type SearchText = ReturnType<typeof createSearchText>;

export function createSearchText(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: string) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function SearchBox({
  place,
  text,
  asking,
  inputRef,
  onSubmit,
  onClear,
  onAsk,
}: {
  place: "header" | "list";
  text: SearchText;
  asking: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (text: string) => void;
  onClear: () => void;
  onAsk: (text: string) => void;
}) {
  const search = useSyncExternalStore(text.subscribe, text.get, text.get);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(search.trim());
  }

  return (
    <form role="search" onSubmit={submit} className={cn("relative", place === "header" && "w-full max-w-[26rem]")}>
      <label htmlFor={`mail-search-${place}`} className="sr-only">
        Search mail
      </label>
      <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
      <input
        ref={inputRef}
        id={`mail-search-${place}`}
        type="search"
        value={search}
        onChange={(event) => text.set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (search || asking)) {
            event.preventDefault();
            onClear();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && search.trim()) {
            event.preventDefault();
            event.stopPropagation();
            onSubmit(search.trim());
          }
        }}
        placeholder="Search, or ask a question"
        autoComplete="off"
        className={cn("placeholder:text-subtle text-foreground ease-power3-out bg-surface-field focus:bg-surface-raised w-full rounded-xl pr-24 pl-9 text-[14px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden", place === "header" ? "h-8" : "h-9")}
      />
      {search ? (
        <>
          <Button
            variant="ghost"
            size="none"
            onClick={() => onAsk(search.trim())}
            aria-label="Ask AI about your email"
            title="Ask AI"
            className="text-primary-foreground hover:text-primary-foreground absolute top-1/2 right-9 h-6 -translate-y-1/2 gap-1 bg-[color-mix(in_srgb,var(--primary)_22%,transparent)] px-2 text-[12px] font-normal hover:bg-[color-mix(in_srgb,var(--primary)_32%,transparent)]"
          >
            <SparkleIcon aria-hidden className="size-3" />
            Ask
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2">
            <CloseIcon aria-hidden className="size-2.5" />
          </Button>
        </>
      ) : (
        <Kbd aria-hidden className="absolute top-1/2 right-2 -translate-y-1/2">
          /
        </Kbd>
      )}
    </form>
  );
}

export default memo(SearchBox);
