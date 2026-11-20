"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { searchMentionsAction } from "@/app/(crm)/search";
import type { MentionOption } from "@/lib/crm/mention-search";
import { roomOfferPlace, type MentionKind } from "@/lib/mentions";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<MentionKind, string> = {
  contact: "Contact",
  company: "Company",
  task: "Task",
  opportunity: "Opportunity",
  proposal: "Proposal",
  member: "Teammate",
};

export type MentionQuery = { start: number; end: number; query: string };

export const MENTION_CLASS = "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]";

export const ROOM_OPTION: MentionOption = {
  kind: "member",
  id: "room",
  name: "room",
  detail: "Notify everyone in this room",
};

export function useMentionOptions(open: MentionQuery | null, kinds: MentionKind[] | undefined, roomMention: boolean | undefined) {
  const [found, setFound] = useState<{
    query: string;
    options: MentionOption[];
  }>({ query: "", options: [] });
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchMentionsAction(open.query)
        .then((options) => {
          if (!live) return;
          setFound({
            query: open.query,
            options: kinds ? options.filter((option) => kinds.includes(option.kind)) : options,
          });
          setHighlight(0);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, kinds]);

  const searchedNow = Boolean(open && found.query === open.query);
  const searched = searchedNow ? found.options : [];
  const roomPlace = roomMention && open ? roomOfferPlace(open.query, searchedNow) : null;
  const options = roomPlace === "first" ? [ROOM_OPTION, ...searched] : roomPlace === "last" ? [...searched, ROOM_OPTION] : searched;
  return {
    options,
    highlight,
    setHighlight,
    clear: () => setFound({ query: "", options: [] }),
  };
}

export function MentionList({
  id,
  anchor,
  options,
  highlight,
  kinds,
  listPlacement,
  onPick,
}: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  options: MentionOption[];
  highlight: number;
  kinds?: MentionKind[];
  listPlacement: "above" | "below";
  onPick: (option: MentionOption) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const indexed = options.map((option, index) => ({ option, index }));
  const groups = [
    {
      id: "people",
      label: "People",
      items: indexed.filter(({ option }) => option.kind === "member"),
    },
    {
      id: "records",
      label: "Records",
      items: indexed.filter(({ option }) => option.kind !== "member"),
    },
  ];
  const grouped = groups.every((group) => group.items.length > 0);

  useLayoutEffect(() => {
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const dialog = anchor.current?.closest<HTMLElement>("[role='dialog']") ?? null;
      setHost((current) => (current === dialog ? current : dialog));
      const width = Math.round(Math.min(352, Math.max(rect.width, 240), window.innerWidth - 16));
      const left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)));
      const next =
        listPlacement === "above"
          ? {
              left,
              width,
              top: undefined,
              bottom: Math.round(window.innerHeight - rect.top + 8),
              maxHeight: Math.round(Math.min(288, rect.top - 16)),
            }
          : {
              left,
              width,
              top: Math.round(rect.bottom + 8),
              bottom: undefined,
              maxHeight: Math.round(Math.min(288, window.innerHeight - rect.bottom - 16)),
            };
      setPlace((current) =>
        current && current.left === next.left && current.width === next.width && current.top === next.top && current.bottom === next.bottom && current.maxHeight === next.maxHeight ? current : next,
      );
    };
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && list.current?.contains(event.target)) return;
      measure();
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", scrolled, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, [anchor, listPlacement]);

  function optionRow(option: MentionOption, index: number) {
    return (
      <li key={`${option.kind}-${option.id}`} role="option" aria-selected={index === Math.min(highlight, options.length - 1)}>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(option)}
          className={cn(
            "flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left",
            index === Math.min(highlight, options.length - 1) ? "bg-white/[0.07]" : "hover:bg-white/5",
          )}
        >
          <span className="text-foreground w-full truncate text-[13.5px] leading-5">{option === ROOM_OPTION ? "@room" : option.name}</span>
          <span className="caption-style text-subtle w-full truncate">
            {option.kind === "member" && option.detail ? option.detail : `${KIND_LABELS[option.kind]}${option.detail ? ` · ${option.detail}` : ""}`}
          </span>
        </button>
      </li>
    );
  }

  if (!place) return null;
  return createPortal(
    <ul
      ref={list}
      id={id}
      role="listbox"
      aria-label={kinds ? "Tag a contact or company" : "Tag a person or record"}
      style={place}
      className="bg-popover border-line-strong shadow-overlay pointer-events-auto fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border p-1"
    >
      {grouped
        ? groups.map((group) => (
            <li key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
              <div id={`${id}-${group.id}`} className="caption-style text-subtle px-2.5 pt-1.5 pb-0.5">
                {group.label}
              </div>
              <ul role="presentation">{group.items.map(({ option, index }) => optionRow(option, index))}</ul>
            </li>
          ))
        : options.map((option, index) => optionRow(option, index))}
    </ul>,
    host ?? document.body,
  );
}
