"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useShortcut, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { Kbd } from "@/components/_ui/command";
import { listSearchHref } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import SearchIcon from "@/public/assets/images/_common/search.svg";

export default function ListSearch({
  noun,
  param = "q",
  className,
}: {
  noun: string;
  param?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openPalette, setListSearch } = useShortcuts();
  const value = searchParams.get(param) ?? "";
  const paramsText = searchParams.toString();

  const config = useMemo(
    () => ({
      noun,
      value,
      hrefFor: (query: string) => listSearchHref(pathname, new URLSearchParams(paramsText), param, query),
    }),
    [noun, value, pathname, paramsText, param],
  );

  useEffect(() => {
    setListSearch(config);
    return () => setListSearch(null);
  }, [config, setListSearch]);

  useShortcut("search-list", () => openPalette("list"));
  useShortcut("list-clear", () => {
    const view = searchParams.get("view");
    router.push(view ? `${pathname}?view=${encodeURIComponent(view)}` : pathname);
  });

  if (value) {
    return (
      <span
        className={cn(
          "border-line-strong bg-secondary inline-flex h-8 max-w-full min-w-0 items-center gap-1 rounded-full border pr-1 pl-3 text-[13px]",
          className,
        )}
      >
        <button
          type="button"
          onClick={() => openPalette("list")}
          className="text-foreground flex min-w-0 cursor-pointer items-center gap-1.5 truncate outline-none focus-visible:underline"
          title={`Change the search (/)`}
        >
          <SearchIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="truncate">“{value}”</span>
        </button>
        <Link
          href={config.hrefFor("")}
          aria-label="Clear search"
          className="text-subtle hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </Link>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openPalette("list")}
      aria-keyshortcuts="/"
      data-shortcut="list-search"
      className={cn(
        "border-line-strong text-subtle hover:text-foreground ease-power3-out inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border pr-1.5 pl-3 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      <SearchIcon aria-hidden className="size-3.5 shrink-0" />
      <span>Search {noun}</span>
      <Kbd aria-hidden>/</Kbd>
    </button>
  );
}
