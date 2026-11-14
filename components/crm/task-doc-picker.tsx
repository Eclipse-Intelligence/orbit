"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { searchTaskDocsAction } from "@/app/(crm)/task-docs";
import type { DocPick } from "@/lib/docs/client-types";
import { whenLabel } from "@/lib/docs/format";
import { docPickHeading, docPickNotice, privateDocWarning } from "@/lib/task-doc-picks";
import { cn } from "@/lib/utils";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";

export type DocPicks = { docs: DocPick[] | null; failed: boolean; loading: boolean };

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

  if (query === null || !results) return { docs: null, failed: false, loading: query !== null };
  const fresh = results.key === key;
  if (fresh && results.failed) return { docs: null, failed: true, loading: false };
  return { docs: results.failed ? null : results.docs, failed: false, loading: !fresh };
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

function DocPickRow({ doc, query, warn, now }: { doc: DocPick; query: string; warn: boolean; now: string }) {
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

const OPTION = "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left [@media(pointer:coarse)]:min-h-11";

export function DocPickOptions({
  id,
  docs,
  query,
  active,
  warn,
  onHover,
  onPick,
  buttons,
}: {
  id: string;
  docs: DocPick[];
  query: string;
  active: number;
  warn: boolean;
  onHover: (index: number) => void;
  onPick: (doc: DocPick) => void;
  buttons?: boolean;
}) {
  const [now] = useState(() => new Date().toISOString());
  const marker = (index: number) =>
    index === active && (
      <kbd aria-hidden className="text-subtle font-sans text-[11px] [@media(pointer:coarse)]:hidden">
        ↵
      </kbd>
    );
  if (buttons) {
    return (
      <ul id={`${id}-list`} aria-label="Docs" className="flex max-h-72 flex-col overflow-y-auto">
        {docs.map((doc, index) => (
          <li key={doc.id}>
            <button
              type="button"
              aria-current={index === active || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(doc)}
              className={cn(OPTION, index === active ? "bg-white/[0.07]" : "hover:bg-white/5")}
            >
              <DocPickRow doc={doc} query={query} warn={warn} now={now} />
              {marker(index)}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul id={`${id}-list`} role="listbox" aria-label="Docs" className="flex max-h-72 flex-col overflow-y-auto">
      {docs.map((doc, index) => (
        <li
          key={doc.id}
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(doc)}
          className={cn(OPTION, index === active ? "bg-white/[0.07]" : "hover:bg-white/5")}
        >
          <DocPickRow doc={doc} query={query} warn={warn} now={now} />
          {marker(index)}
        </li>
      ))}
    </ul>
  );
}

export function DocPickHeader({ query, docs, loading }: { query: string; docs: DocPick[] | null; loading: boolean }) {
  return (
    <div className="caption-style text-subtle flex items-center gap-2 px-2.5 pt-1.5 pb-1">
      <span>Link a doc</span>
      <span role="status" className="ml-auto">
        {loading && !docs ? "" : docPickHeading(query, docs)}
      </span>
    </div>
  );
}

export function DocPickNotice({ query, docs, failed }: { query: string; docs: DocPick[] | null; failed: boolean }) {
  const notice = docPickNotice(query, docs, failed);
  if (!notice) return null;
  return (
    <p role={failed ? "alert" : undefined} className={cn("caption-style px-2.5 py-2", failed ? "text-danger" : "text-subtle")}>
      {notice}
    </p>
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
            aria-expanded={Boolean(docs && docs.length > 0)}
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
              if (event.nativeEvent.isComposing) return;
              const picks = event.key === "Enter" || (event.key === "Tab" && !event.shiftKey);
              if (picks && found.loading) {
                event.preventDefault();
                return;
              }
              if (!docs || docs.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + docs.length) % docs.length);
              } else if (picks && active >= 0) {
                event.preventDefault();
                choose(docs[active]);
              }
            }}
            className="h-8 px-2.5 text-[13px] max-md:h-10"
          />
        </div>
        <DocPickHeader query={query} docs={docs} loading={found.loading} />
        <DocPickNotice query={query} docs={docs} failed={found.failed} />
        {docs && docs.length > 0 && <DocPickOptions id={id} docs={docs} query={query} active={active} warn={warn} onHover={setHighlight} onPick={choose} />}
      </PopoverContent>
    </Popover>
  );
}
