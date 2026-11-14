"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { searchTaskDocsAction } from "@/app/(crm)/task-docs";
import type { DocPick } from "@/lib/docs/client-types";
import { whenLabel } from "@/lib/docs/format";
import { cn } from "@/lib/utils";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";

export type DocPicks = { docs: DocPick[] | null; failed: boolean };

export function useDocPicks(query: string | null, taskId: string | null): DocPicks {
  const [results, setResults] = useState<{ key: string; docs: DocPick[]; failed?: boolean } | null>(null);
  const text = query?.trim() ?? "";
  const key = `${taskId ?? ""}|${text}`;

  useEffect(() => {
    if (query === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchTaskDocsAction(text, taskId).then(
        (found) => !cancelled && setResults({ key, docs: found.docs ?? [], failed: Boolean(found.error) }),
        () => !cancelled && setResults({ key, docs: [], failed: true }),
      );
    }, text ? 150 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, text, key, taskId]);

  const current = query !== null && results?.key === key ? results : null;
  return { docs: current && !current.failed ? current.docs : null, failed: Boolean(current?.failed) };
}

export function privateDocWarning(doc: Pick<DocPick, "folderPath">) {
  const folder = doc.folderPath?.split(" › ").pop() ?? "Top level";
  return `${folder}, private. Teammates will see "Doc" only`;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b className="text-foreground font-semibold">{text.slice(at, at + query.length)}</b>
      {text.slice(at + query.length)}
    </>
  );
}

export function DocVisibility({ shared, className }: { shared: boolean; className?: string }) {
  return shared ? (
    <UsersIcon aria-label="Shared" role="img" className={cn("size-3 shrink-0 text-(--tag-blue-text)/80", className)} />
  ) : (
    <LockIcon aria-label="Private" role="img" className={cn("text-faint size-3 shrink-0", className)} />
  );
}

export function DocPickRow({ doc, query, warn, now }: { doc: DocPick; query: string; warn: boolean; now: string }) {
  const caution = warn && !doc.shared;
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2.5">
      <DocIcon aria-hidden className="text-subtle mt-[3px] size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="ui-style text-soft truncate">
          <Highlight text={doc.title || "Untitled"} query={query.trim()} />
        </span>
        {caution ? (
          <span className="caption-style flex min-w-0 items-center gap-1.5 text-(--tag-amber-text)">
            <LockIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{privateDocWarning(doc)}</span>
          </span>
        ) : (
          <span className="caption-style text-subtle flex min-w-0 items-center gap-1.5">
            <DocVisibility shared={doc.shared} />
            <span className="truncate">
              {doc.folderPath ?? "Top level"} · {doc.updatedBy.short}, {whenLabel(doc.updatedAt, now)}
            </span>
          </span>
        )}
      </span>
    </span>
  );
}

export function docPickHeading(query: string, docs: DocPick[] | null) {
  if (!query.trim()) return "Recent";
  if (!docs) return "";
  return docs.length === 1 ? "1 match" : `${docs.length} matches`;
}

export function DocPickOptions({
  id,
  docs,
  query,
  active,
  warn,
  onHover,
  onPick,
  keepFocus,
}: {
  id: string;
  docs: DocPick[];
  query: string;
  active: number;
  warn: boolean;
  onHover: (index: number) => void;
  onPick: (doc: DocPick) => void;
  keepFocus?: boolean;
}) {
  const [now] = useState(() => new Date().toISOString());
  return (
    <ul id={`${id}-list`} role="listbox" aria-label="Docs" className="flex max-h-72 flex-col overflow-y-auto">
      {docs.map((doc, index) => (
        <li
          key={doc.id}
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => onHover(index)}
          onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
          onClick={() => onPick(doc)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 [@media(pointer:coarse)]:min-h-11",
            index === active ? "bg-white/[0.07]" : "hover:bg-white/5",
          )}
        >
          <DocPickRow doc={doc} query={query} warn={warn} now={now} />
          {index === active && (
            <kbd aria-hidden className="text-subtle font-sans text-[11px] [@media(pointer:coarse)]:hidden">
              ↵
            </kbd>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DocPickPopover({
  taskId,
  warn,
  exclude,
  onPick,
  onClosed,
  children,
  align = "start",
}: {
  taskId: string | null;
  warn: boolean;
  exclude: string[];
  onPick: (doc: DocPick) => void;
  onClosed?: () => void;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const found = useDocPicks(open ? query : null, taskId);
  const docs = found.docs ? found.docs.filter((doc) => !exclude.includes(doc.id)) : null;
  const active = docs && docs.length > 0 ? Math.min(highlight, docs.length - 1) : -1;
  const heading = docPickHeading(query, docs);

  function choose(doc: DocPick) {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    onPick(doc);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setHighlight(0);
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        aria-label="Link a doc"
        className="w-[min(21rem,calc(100vw-2rem))] p-1"
        onCloseAutoFocus={(event) => {
          if (!onClosed) return;
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="p-1">
          <label htmlFor={`${id}-search`} className="sr-only">
            Search docs
          </label>
          <Input
            id={`${id}-search`}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            placeholder="Search docs"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (!docs || docs.length === 0 || event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + docs.length) % docs.length);
              } else if ((event.key === "Enter" || event.key === "Tab") && active >= 0) {
                event.preventDefault();
                choose(docs[active]);
              }
            }}
            className="h-8 px-2.5 text-[13px] max-md:h-10"
          />
        </div>
        {heading && docs && docs.length > 0 && <p className="eyebrow-style text-subtle px-2.5 pt-1.5 pb-1 text-[11px]">{heading}</p>}
        {found.failed && (
          <p role="alert" className="caption-style text-danger px-2.5 py-2">
            Couldn&apos;t search. Try again.
          </p>
        )}
        {docs && docs.length > 0 && <DocPickOptions id={id} docs={docs} query={query} active={active} warn={warn} onHover={setHighlight} onPick={choose} />}
        {docs && docs.length === 0 && <p className="caption-style text-subtle px-2.5 py-2">No docs match</p>}
      </PopoverContent>
    </Popover>
  );
}
