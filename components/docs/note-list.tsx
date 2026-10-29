"use client";

import { memo, useRef, type ComponentType, type KeyboardEvent, type MouseEvent, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { PresenceStack } from "@/components/docs/presence";
import { NOTE_TYPE } from "@/components/docs/use-docs";
import type { PageSort, PageSummary, Participant } from "@/lib/docs/client-types";
import { whenLabel } from "@/lib/docs/format";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";

const SORTS: { value: PageSort; label: string }[] = [
  { value: "edited", label: "Edited" },
  { value: "created", label: "Created" },
  { value: "title", label: "Title" },
];

export function SortMenu() {
  const sort = useDocsStore((state) => state.sort);
  const setSort = useDocsStore((state) => state.setSort);
  const label = SORTS.find((item) => item.value === sort)?.label ?? "Edited";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Sort by ${label.toLowerCase()}`} className="data-[state=open]:text-foreground h-[30px] px-2.5">
          {label}
          <ChevronDownIcon aria-hidden className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as PageSort)}>
          {SORTS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SharedGlyph({ label = "Shared with workspace" }: { label?: string }) {
  return (
    <span title={label} className="flex shrink-0 items-center">
      <UsersIcon aria-hidden className="size-3 text-(--tag-blue-text)/80" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function PrivateGlyph({ label = "Private" }: { label?: string }) {
  return (
    <span title={label} className="flex shrink-0 items-center">
      <LockIcon aria-hidden className="text-faint size-3" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export const NoteRow = memo(function NoteRow({
  summary,
  href,
  active,
  wideOnly,
  tabbable,
  writers,
  now,
  folderShared,
  onOpen,
  onPrefetch,
}: {
  summary: PageSummary;
  href: string;
  active: boolean;
  wideOnly?: boolean;
  tabbable: boolean;
  writers: Participant[];
  now: string;
  folderShared: boolean;
  onOpen: (id: string, href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onPrefetch: (id: string) => void;
}) {
  const agent = writers.find((writer) => writer.kind !== "person");
  const editor = agent ?? writers[0];
  const when = whenLabel(summary.updatedAt, now);
  const sharedAlone = summary.visibility === "shared" && !folderShared;
  return (
    <li>
      <Link
        href={href}
        data-docs-row={summary.id}
        tabIndex={tabbable ? 0 : -1}
        aria-current={active && !wideOnly ? "page" : undefined}
        onClick={(event) => onOpen(summary.id, href, event)}
        onPointerEnter={() => onPrefetch(summary.id)}
        draggable={summary.kind === "note"}
        onDragStart={(event) => {
          event.dataTransfer.setData(NOTE_TYPE, summary.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onFocus={() => onPrefetch(summary.id)}
        className={cn(
          "ease-power3-out focus-visible:ring-ring/60 flex w-full flex-col gap-1 rounded-xl text-left transition-colors duration-150 outline-none focus-visible:ring-2",
          "px-3 py-2.5 max-md:px-4 max-md:py-3",
          active ? (wideOnly ? "hover:bg-white/[0.035] md:bg-white/[0.07]" : "bg-white/[0.07]") : "hover:bg-white/[0.035]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-[14px] leading-5 font-medium max-md:text-[15px]", active ? "text-foreground" : "text-[#e3e5ea]", !summary.title && "text-subtle")}>
            {summary.title || "Untitled"}
          </span>
          {sharedAlone && <SharedGlyph label="Shared on its own" />}
          {!summary.shared && folderShared && <PrivateGlyph />}
          <span className={cn("ml-auto shrink-0 text-[12px] tabular-nums", agent ? "text-[#b9b0ff]" : "text-subtle")}>{agent ? "Now" : when}</span>
        </span>
        {summary.snippet && <span className="text-subtle line-clamp-2 text-[13px] leading-[1.45] max-md:text-[14px]">{summary.snippet}</span>}
        {editor ? (
          <span className="flex items-center gap-1.5 pt-0.5">
            <PresenceStack participants={writers} size="xs" label={`In this note: ${writers.map((writer) => writer.name).join(", ")}`} />
            <span className={cn("caption-style", agent ? "text-[#b9b0ff]" : "text-subtle")}>
              {editor.short} is {agent ? "writing" : "editing"}
            </span>
          </span>
        ) : (
          summary.tags.length > 0 && (
            <span className="caption-style text-faint flex min-w-0 items-center gap-2 overflow-hidden pt-0.5">
              {summary.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="truncate">
                  #{tag}
                </span>
              ))}
            </span>
          )
        )}
      </Link>
    </li>
  );
});

export function ListPane({
  icon: Icon,
  title,
  count,
  control,
  children,
  hiddenOnPhone,
  header = true,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  count?: number;
  control?: ReactNode;
  children: ReactNode;
  hiddenOnPhone?: boolean;
  header?: boolean;
}) {
  return (
    <div className={cn("flex min-h-0 w-full flex-col md:w-[19rem] md:shrink-0 xl:w-[20.5rem] docs-focus:hidden", hiddenOnPhone && "max-md:hidden")}>
      {header && (
        <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4 max-md:hidden">
          <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <h2 className="truncate text-[15px] leading-none">{title}</h2>
          {count !== undefined && <span className="caption-style text-subtle shrink-0 tabular-nums">{count}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">{control}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-28">{children}</div>
    </div>
  );
}

export function RowList({ children, label, onMove }: { children: ReactNode; label: string; onMove: (id: string) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1, Home: -Infinity, End: Infinity };
    const delta = keys[event.key];
    if (delta === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-docs-row]") ?? [])];
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    const current = rows.findIndex((row) => row === document.activeElement);
    const next = delta === -Infinity ? 0 : delta === Infinity ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (current < 0 ? -1 : current) + delta));
    rows[next].focus();
    rows[next].scrollIntoView({ block: "nearest" });
    const id = rows[next].dataset.docsRow;
    if (id) onMove(id);
  }
  return (
    <ul ref={ref} aria-label={label} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
      {children}
    </ul>
  );
}
