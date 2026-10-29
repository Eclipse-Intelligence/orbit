"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { Kbd } from "@/components/_ui/command";
import { useDocsNav, useDocsNow } from "@/components/docs/use-docs";
import type { LinkTarget, Page, RecordRef, TagNode } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { applyLink, applyMention, applyTag, type ActiveTrigger, type PickerKey } from "@/lib/docs/editor/setup";
import { agoLabel } from "@/lib/docs/format";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import HeadingIcon from "@/public/assets/images/docs/heading.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

export type PickerHandle = { key: (key: PickerKey) => boolean };

type Option =
  | { type: "target"; target: LinkTarget }
  | { type: "tag"; path: string; count: number }
  | { type: "record"; record: RecordRef };

const RECORD_LABELS: Record<RecordRef["kind"], string> = { contact: "Person", company: "Company", task: "Task", opportunity: "Opportunity", proposal: "Proposal" };

function flatten(tags: TagNode[]): TagNode[] {
  return tags.flatMap((tag) => [tag, ...flatten(tag.children)]);
}

function Highlight({ text, query }: { text: string; query: string }) {
  const clean = query.trim().toLowerCase();
  const index = clean ? text.toLowerCase().indexOf(clean) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <span className="text-foreground font-semibold">{text.slice(index, index + clean.length)}</span>
      {text.slice(index + clean.length)}
    </>
  );
}

function RecordIcon({ kind }: { kind: RecordRef["kind"] }) {
  if (kind === "company") return <BuildingIcon aria-hidden className="size-3.5" />;
  if (kind === "opportunity") return <ClipboardIcon aria-hidden className="size-3.5" />;
  if (kind === "task") return <TargetIcon aria-hidden className="size-3.5" />;
  if (kind === "proposal") return <FileSignatureIcon aria-hidden className="size-3.5" />;
  return <UsersIcon aria-hidden className="size-3.5" />;
}

const NotePicker = forwardRef<PickerHandle, { view: EditorView; trigger: ActiveTrigger; page: Page; onClose: () => void; sheet?: boolean }>(function NotePicker(
  { view, trigger, page, onClose, sheet = false },
  ref,
) {
  const nav = useDocsNav();
  const now = useDocsNow();
  const createNote = useDocsStore((state) => state.createNote);
  const viewerId = useDocsStore((state) => state.viewer?.id);
  const [found, setFound] = useState<{ key: string; options: Option[] }>({ key: "", options: [] });
  const [highlightState, setHighlightState] = useState({ key: "", index: 0 });
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const listId = useId();
  const query = trigger.query.trim();
  const key = `${trigger.kind}:${trigger.query}`;
  const highlight = highlightState.key === key ? highlightState.index : 0;
  const setHighlight = (index: number) => setHighlightState({ key, index });

  const tagOptions = useMemo<Option[]>(() => {
    if (trigger.kind !== "tag") return [];
    const wanted = trigger.query.toLowerCase();
    return flatten(nav?.tags ?? [])
      .filter((tag) => tag.path.includes(wanted))
      .sort((left, right) => Number(!left.path.startsWith(wanted)) - Number(!right.path.startsWith(wanted)) || right.count - left.count)
      .slice(0, 6)
      .map((tag) => ({ type: "tag", path: tag.path, count: tag.count }));
  }, [trigger.kind, trigger.query, nav]);

  useEffect(() => {
    if (trigger.kind === "tag") return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        const request =
          trigger.kind === "link"
            ? docsData()
                .linkTargets(trigger.query, page.id)
                .then((targets) => targets.map((target): Option => ({ type: "target", target })))
            : docsData()
                .searchRecords(trigger.query)
                .then((records) => records.map((record): Option => ({ type: "record", record })));
        void request.then((options) => {
          if (live) setFound({ key, options });
        });
      },
      trigger.kind === "link" ? 0 : 120,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [trigger.kind, trigger.query, page.id, key]);

  const options = trigger.kind === "tag" ? tagOptions : found.key === key ? found.options : [];
  const exact =
    trigger.kind === "link"
      ? options.some((option) => option.type === "target" && option.target.kind === "note" && option.target.title.toLowerCase() === query.toLowerCase())
      : trigger.kind === "tag"
        ? options.some((option) => option.type === "tag" && option.path === query.toLowerCase())
        : true;
  const canCreate = Boolean(query) && !exact && trigger.kind !== "mention";
  const total = options.length + (canCreate ? 1 : 0);
  const active = total ? Math.min(highlight, total - 1) : 0;
  const folderName = page.kind === "note" && page.folderId ? (nav?.folders.find((folder) => folder.id === page.folderId)?.name ?? null) : null;

  useLayoutEffect(() => {
    if (sheet) return;
    let frame = 0;
    const measure = () => {
      const coords = view.coordsAtPos(trigger.at);
      if (!coords) return setPlace(null);
      const width = Math.min(400, window.innerWidth - 16);
      const left = Math.round(Math.max(8, Math.min(coords.left - 56, window.innerWidth - width - 8)));
      const below = window.innerHeight - coords.bottom;
      setPlace(below > 340 || below > coords.top ? { left, top: Math.round(coords.bottom + 10) } : { left, bottom: Math.round(window.innerHeight - coords.top + 10) });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [view, trigger.at, sheet]);

  useEffect(() => {
    const content = view.contentDOM;
    if (total) {
      content.setAttribute("aria-controls", listId);
      content.setAttribute("aria-activedescendant", `${listId}-${active}`);
    }
    return () => {
      content.removeAttribute("aria-controls");
      content.removeAttribute("aria-activedescendant");
    };
  }, [view, listId, active, total]);

  function create() {
    if (!query) return;
    if (trigger.kind === "tag") {
      applyTag(view, trigger, query.toLowerCase());
      return;
    }
    void createNote({ title: query, folderId: page.kind === "note" ? page.folderId : null });
    applyLink(view, trigger, query);
  }

  function pick(index: number) {
    if (index >= options.length) return create();
    const option = options[index];
    if (option.type === "tag") applyTag(view, trigger, option.path);
    else if (option.type === "record") applyMention(view, trigger, option.record);
    else {
      const target = option.target;
      if (target.kind === "note") applyLink(view, trigger, target.title);
      else if (target.kind === "heading") applyLink(view, trigger, `${target.title}#${target.heading}`);
      else applyLink(view, trigger, `${target.dailyDate}|${target.title}`);
    }
    view.focus();
  }

  useImperativeHandle(ref, () => ({
    key(pressed) {
      if (pressed === "escape") {
        onClose();
        return true;
      }
      if (pressed === "shift-enter" || pressed === "mod-enter") {
        if (!canCreate) return false;
        create();
        return true;
      }
      if (!total) return false;
      if (pressed === "down" || pressed === "up") {
        setHighlight((active + (pressed === "down" ? 1 : -1) + total) % total);
        return true;
      }
      pick(active);
      return true;
    },
  }));

  const heading = trigger.kind === "link" ? "Link to a note" : trigger.kind === "tag" ? "Tags" : "Mention a record";
  const empty = trigger.kind === "mention" ? (found.key === key ? "Nothing matches" : "Searching…") : "Nothing matches";

  const rows: ReactNode[] = options.map((option, index) => {
    let icon: ReactNode;
    let title: ReactNode;
    let detail: ReactNode = null;
    let warn = false;
    if (option.type === "tag") {
      icon = <HashIcon aria-hidden className="size-3.5" />;
      title = <Highlight text={option.path} query={trigger.query} />;
      detail = `${option.count} ${option.count === 1 ? "note" : "notes"}`;
    } else if (option.type === "record") {
      icon = <RecordIcon kind={option.record.kind} />;
      title = <Highlight text={option.record.name} query={trigger.query} />;
      detail = [RECORD_LABELS[option.record.kind], option.record.detail].filter(Boolean).join(" · ");
    } else if (option.target.kind === "note") {
      const target = option.target;
      icon = <DocIcon aria-hidden className="size-3.5" />;
      title = <Highlight text={target.title} query={trigger.query} />;
      warn = page.shared && !target.shared;
      const who = target.updatedBy.id === viewerId ? "You" : target.updatedBy.short;
      detail = warn ? (
        <>
          <LockIcon aria-hidden className="size-3 shrink-0" />
          {target.folderName ? `${target.folderName}, private.` : "Private."} Teammates will see the title only
        </>
      ) : (
        <>
          {target.shared && <UsersIcon aria-hidden className="size-3 shrink-0 text-(--tag-blue-text)/80" />}
          {[target.folderName ?? "No folder", `${who}, ${agoLabel(target.updatedAt, now)}`].join(" · ")}
        </>
      );
    } else if (option.target.kind === "heading") {
      const target = option.target;
      icon = <HeadingIcon aria-hidden className="size-3.5" />;
      title = (
        <>
          {target.title} <span className="text-faint">›</span> <Highlight text={target.heading} query={trigger.query.split(" ")[trigger.query.split(" ").length - 1] ?? ""} />
        </>
      );
      detail = sheet ? "Heading" : `Heading in ${target.title}`;
    } else {
      const target = option.target;
      icon = <SunIcon aria-hidden className="size-3.5" />;
      title = target.title;
      detail = <>&ldquo;{target.snippet}&rdquo;</>;
    }
    const selected = index === active;
    return (
      <li key={index} id={`${listId}-${index}`} role="option" aria-selected={selected}>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => pick(index)}
          className={cn(
            "flex w-full cursor-pointer items-start gap-2.5 rounded-lg text-left transition-colors duration-150",
            sheet ? "min-h-12 items-center gap-3 rounded-xl px-3 py-2" : "px-2.5 py-2",
            selected ? "bg-white/[0.07]" : "hover:bg-white/5",
          )}
        >
          <span className={cn("text-subtle flex shrink-0 items-center justify-center", sheet ? "size-4" : "mt-[3px] size-3.5")}>{icon}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn("text-soft truncate leading-5", sheet ? "text-foreground text-[15px]" : "text-[13.5px]")}>{title}</span>
            {detail && <span className={cn("caption-style flex min-w-0 items-center gap-1 truncate", warn ? "text-(--tag-amber-text)/80" : "text-subtle")}>{detail}</span>}
          </span>
          {selected && !sheet && (
            <Kbd aria-hidden className="mt-0.5">
              ↵
            </Kbd>
          )}
        </button>
      </li>
    );
  });

  const createRow = canCreate && (
    <li id={`${listId}-${options.length}`} role="option" aria-selected={active === options.length} className={cn("bg-popover sticky bottom-0", !sheet && "border-line-strong -mx-1 -mb-1 mt-1 border-t p-1")}>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setHighlight(options.length)}
        onClick={() => create()}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-lg text-left transition-colors duration-150",
          sheet ? "min-h-12 gap-3 rounded-xl px-3 py-2" : "px-2.5 py-2",
          active === options.length ? "bg-white/[0.07]" : "hover:bg-white/5",
        )}
      >
        <PlusIcon aria-hidden className={cn("text-subtle shrink-0", sheet ? "size-4" : "size-3.5")} />
        <span className={cn("text-soft min-w-0 flex-1 truncate leading-5", sheet ? "text-[15px]" : "text-[13.5px]")}>
          Create <span className="text-foreground">&ldquo;{trigger.kind === "tag" ? `#${query.toLowerCase()}` : query}&rdquo;</span>
          {trigger.kind === "link" && folderName && !sheet ? ` in ${folderName}` : ""}
        </span>
        {!sheet && trigger.kind === "link" && (
          <span aria-hidden className="flex items-center gap-0.5">
            <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd>
          </span>
        )}
      </button>
    </li>
  );

  const body = (
    <>
      <div className={cn("flex items-center justify-between", sheet ? "px-4 pt-3 pb-1" : "px-3.5 pt-3 pb-1.5")}>
        <span className="eyebrow-style text-subtle text-[11px] font-medium">{heading}</span>
        <span role="status" className="caption-style text-faint">
          {options.length ? `${options.length} ${options.length === 1 ? "match" : "matches"}` : ""}
        </span>
      </div>
      <ul id={listId} role="listbox" aria-label={heading} className={cn("flex max-h-[min(20rem,45dvh)] flex-col overflow-y-auto overscroll-contain", sheet ? "px-1.5" : "p-1 pt-0")}>
        {rows}
        {!rows.length && !canCreate && <li className="caption-style text-subtle px-3 py-2">{trigger.query ? empty : trigger.kind === "mention" ? "Type a name" : "Start typing"}</li>}
        {createRow}
      </ul>
    </>
  );

  if (sheet) return <div className="pb-1">{body}</div>;
  if (!place) return null;
  return (
    <div
      className="bg-popover border-line-strong shadow-overlay animate-rise-in fixed z-50 w-[min(25rem,calc(100vw-1rem))] overflow-hidden rounded-xl border font-normal"
      style={{ left: place.left, top: place.top, bottom: place.bottom }}
    >
      {body}
    </div>
  );
});

export default NotePicker;
