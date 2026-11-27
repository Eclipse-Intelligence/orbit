"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { Composer, ThreadCard, type CommentActions } from "@/components/docs/comment-cards";
import { createAnchor, resolveAnchor, stackCards, type AnchorMatch, type CommentAnchor } from "@/lib/docs/comment-anchor";
import {
  fetchComments,
  loadVisitor,
  patchComment,
  postComment,
  removeComment,
  saveVisitor,
  threadsOf,
  type CommentThread,
  type PublicComment,
  type Visitor,
} from "@/lib/docs/comment-client";
import { BLOCK_SELECTOR, blockOffsets, mapText, offsetAtPoint, paintHighlight, pointInside, rangeOf, selectionOffsets, type TextMap } from "@/lib/docs/comment-dom";
import CommentIcon from "@/public/assets/images/docs/comment.svg";

const WIDE_QUERY = "(min-width: 1100px)";
const GAP = 8;
const GROUP_GAP = 24;
const FALLBACK_HEIGHT = 140;
const HIGHLIGHTS = ["doc-comment", "doc-comment-active", "doc-comment-draft"];
const ORPHANED: AnchorMatch = { status: "orphaned" };

type Draft = { anchor: CommentAnchor; start: number; end: number };
type Placed = { thread: CommentThread; match: AnchorMatch };
type Floating = { top: number; left: number };

function subscribeWide(notify: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

function startOf(placed: Placed) {
  return placed.match.status === "found" ? placed.match.start : Number.MAX_SAFE_INTEGER;
}

function Measured({ id, top, onHeight, children }: { id: string; top: number; onHeight: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const report = () => onHeight(id, element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onHeight]);
  return (
    <div ref={ref} style={{ top }} className="ease-power3-out absolute right-0 left-0 transition-[top] duration-200 motion-reduce:transition-none">
      {children}
    </div>
  );
}

export default function PublicComments({ token, children }: { token: string; children: ReactNode }) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const visitorRef = useRef<Visitor | null>(null);
  const rangesRef = useRef<Map<string, Range>>(new Map());
  const [name, setName] = useState("");
  const [comments, setComments] = useState<PublicComment[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [map, setMap] = useState<TextMap | null>(null);
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hovered, setHovered] = useState<(Floating & { block: HTMLElement; start: number; end: number }) | null>(null);
  const [selection, setSelection] = useState<(Floating & { start: number; end: number }) | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const key = visitorRef.current?.key;
    if (!key) return;
    const result = await fetchComments(token, key);
    if (result.ok) {
      setComments(result.value);
      setLoadError(null);
    } else if (result.gone) {
      setAvailable(false);
      setComments([]);
    } else {
      setLoadError(result.error);
    }
  }, [token]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const visitor = loadVisitor();
      visitorRef.current = visitor;
      setName(visitor.name);
      const note = articleRef.current?.querySelector<HTMLElement>(".note-public");
      if (note) setMap(mapText(note));
      void load();
    });
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const observer = new ResizeObserver(() => setLayoutTick((tick) => tick + 1));
    observer.observe(article);
    const fonts = document.fonts?.ready;
    if (fonts) void fonts.then(() => setLayoutTick((tick) => tick + 1));
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      for (const highlight of HIGHLIGHTS) paintHighlight(highlight, []);
    },
    [],
  );

  const remember = useCallback((who: string) => {
    const visitor = visitorRef.current;
    if (!visitor || !who || visitor.name === who) return;
    visitorRef.current = { ...visitor, name: who };
    saveVisitor(visitorRef.current);
    setName(who);
  }, []);

  const threads = useMemo(() => threadsOf(comments ?? []), [comments]);
  const placed = useMemo<Placed[]>(
    () =>
      map
        ? threads
            .filter((thread) => !thread.root.resolved)
            .map((thread) => ({ thread, match: thread.root.anchor ? resolveAnchor(map.flat.text, thread.root.anchor) : ORPHANED }))
        : [],
    [threads, map],
  );
  const anchored = useMemo(() => placed.filter((item) => item.match.status === "found").sort((a, b) => startOf(a) - startOf(b)), [placed]);
  const orphans = useMemo(() => placed.filter((item) => item.match.status !== "found"), [placed]);
  const resolved = useMemo(() => threads.filter((thread) => thread.root.resolved), [threads]);
  const openCount = anchored.length + orphans.length;

  useLayoutEffect(() => {
    if (!map) return;
    const ranges = new Map<string, Range>();
    for (const item of anchored) {
      if (item.match.status !== "found") continue;
      const range = rangeOf(map, item.match.start, item.match.end);
      if (range) ranges.set(item.thread.root.id, range);
    }
    rangesRef.current = ranges;
    const draftRange = draft ? rangeOf(map, draft.start, draft.end) : null;
    paintHighlight("doc-comment", [...ranges].filter(([id]) => id !== activeId).map(([, range]) => range));
    paintHighlight("doc-comment-active", activeId && ranges.has(activeId) ? [ranges.get(activeId) as Range] : []);
    paintHighlight("doc-comment-draft", draftRange ? [draftRange] : []);
    const origin = asideRef.current?.getBoundingClientRect().top;
    const next = new Map<string, number>();
    if (origin !== undefined && wide) {
      for (const [id, range] of ranges) next.set(id, range.getBoundingClientRect().top - origin);
      if (draftRange) next.set("draft", draftRange.getBoundingClientRect().top - origin);
    }
    const frame = window.requestAnimationFrame(() =>
      setTops((current) => {
        if (current.size === next.size && [...next].every(([id, top]) => Math.abs((current.get(id) ?? -1e9) - top) < 0.5)) return current;
        return next;
      }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [map, anchored, draft, activeId, wide, layoutTick]);

  const onHeight = useCallback((id: string, height: number) => setHeights((current) => (current[id] === height ? current : { ...current, [id]: height })), []);

  useEffect(() => {
    if (!map) return;
    let timer: number | null = null;
    const check = () => {
      timer = null;
      const selected = window.getSelection();
      const note = articleRef.current?.querySelector(".note-public");
      const wrapper = wrapperRef.current;
      if (!selected || selected.rangeCount === 0 || selected.isCollapsed || !note || !wrapper) {
        setSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      if (!note.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const offsets = selectionOffsets(map, range);
      if (!offsets || !createAnchor(map.flat.text, offsets.start, offsets.end)) {
        setSelection(null);
        return;
      }
      const box = range.getBoundingClientRect();
      const frame = wrapper.getBoundingClientRect();
      setSelection({
        ...offsets,
        top: Math.max(4, box.top - frame.top - 38),
        left: Math.max(4, Math.min(box.left - frame.left + box.width / 2 - 44, frame.width - 100)),
      });
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(check, 120);
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [map]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActiveId(null);
      setDraft(null);
      setHovered(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!sheetOpen || !activeId) return;
    const frame = window.requestAnimationFrame(() => document.querySelector(`[data-thread="${activeId}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, [sheetOpen, activeId]);

  function beginDraft(start: number, end: number) {
    if (!map) return;
    const anchor = createAnchor(map.flat.text, start, end);
    if (!anchor) return;
    setDraft({ anchor, start, end });
    setActiveId(null);
    setHovered(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    if (!wide) setSheetOpen(true);
  }

  function frameOf(block: HTMLElement): Floating | null {
    const wrapper = wrapperRef.current;
    if (!wrapper) return null;
    const frame = wrapper.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    return wide ? { top: box.top - frame.top, left: box.right - frame.left + 2 } : { top: box.top - frame.top - 14, left: box.right - frame.left - 30 };
  }

  function hover(block: HTMLElement | null) {
    if (!block || !map) return;
    if (hovered?.block === block) return;
    const offsets = blockOffsets(map, block);
    const place = frameOf(block);
    if (!offsets || !place) return;
    setHovered({ ...place, ...offsets, block });
  }

  function onPointerMove(event: ReactMouseEvent) {
    if (!wide || draft) return;
    const target = event.target as Element;
    const note = articleRef.current?.querySelector(".note-public");
    const block = target.closest?.(BLOCK_SELECTOR) as HTMLElement | null;
    if (block && note?.contains(block)) hover(block);
  }

  function onArticleClick(event: ReactMouseEvent) {
    const target = event.target as Element;
    if (target.closest("a, button")) return;
    if (!window.getSelection()?.isCollapsed) return;
    if (map) {
      const at = offsetAtPoint(map, event.clientX, event.clientY);
      if (at !== null) {
        let best: { id: string; size: number } | null = null;
        for (const item of anchored) {
          if (item.match.status !== "found" || at < item.match.start || at > item.match.end) continue;
          const range = rangesRef.current.get(item.thread.root.id);
          if (!range || !pointInside(range, event.clientX, event.clientY)) continue;
          const size = item.match.end - item.match.start;
          if (!best || size < best.size) best = { id: item.thread.root.id, size };
        }
        if (best) {
          setActiveId(best.id);
          setDraft(null);
          if (!wide) setSheetOpen(true);
          return;
        }
      }
    }
    setActiveId(null);
    const note = articleRef.current?.querySelector(".note-public");
    const block = target.closest?.(BLOCK_SELECTOR) as HTMLElement | null;
    if (block && note?.contains(block)) {
      setHovered(null);
      hover(block);
    }
  }

  const actions: CommentActions = {
    name,
    reply: async (parentId, who, body) => {
      const key = visitorRef.current?.key;
      if (!key) return "Couldn't comment. Try again.";
      const result = await postComment(token, key, { name: who, body, parentId });
      if (!result.ok) return result.error;
      remember(who);
      await load();
      return null;
    },
    edit: async (id, body) => {
      const key = visitorRef.current?.key;
      if (!key) return "Couldn't save the comment. Try again.";
      const result = await patchComment(token, key, id, body);
      if (!result.ok) return result.error;
      await load();
      return null;
    },
    remove: async (id) => {
      const key = visitorRef.current?.key;
      if (!key) return "Couldn't delete the comment. Try again.";
      const result = await removeComment(token, key, id);
      if (!result.ok) return result.error;
      if (activeId === id) setActiveId(null);
      await load();
      return null;
    },
  };

  async function submitDraft(who: string, body: string) {
    const key = visitorRef.current?.key;
    if (!key || !draft) return "Couldn't comment. Try again.";
    const result = await postComment(token, key, { name: who, body, anchor: draft.anchor });
    if (!result.ok) return result.error;
    remember(who);
    setDraft(null);
    setActiveId(result.value.id);
    await load();
    return null;
  }

  if (!available) {
    return (
      <article ref={articleRef} className="note-surface mx-auto flex w-full max-w-[46em] flex-col gap-4 px-4 pt-8 pb-20 md:px-6 md:pt-14">
        {children}
      </article>
    );
  }

  const slots = [
    ...anchored.filter((item) => tops.has(item.thread.root.id)).map((item) => ({ key: item.thread.root.id, top: tops.get(item.thread.root.id) ?? 0, height: heights[item.thread.root.id] ?? FALLBACK_HEIGHT })),
    ...(draft && tops.has("draft") ? [{ key: "draft", top: tops.get("draft") ?? 0, height: heights.draft ?? FALLBACK_HEIGHT }] : []),
  ].sort((a, b) => a.top - b.top);
  const stacked = stackCards(slots, GAP, draft ? "draft" : activeId);
  const stackEnd = slots.reduce((end, slot) => Math.max(end, (stacked.get(slot.key) ?? 0) + slot.height), 0);

  const draftCard = draft && (
    <div className="bg-popover shadow-overlay flex flex-col gap-2 rounded-xl p-3 ring-1 ring-white/6">
      <p className="text-soft line-clamp-3 border-l-2 border-yellow-400/55 pl-2 text-[12px] leading-[1.45]">{draft.anchor.quote}</p>
      <Composer label="Comment" placeholder="Comment" submitLabel="Comment" name={name} autoFocus onSubmit={submitDraft} onCancel={() => setDraft(null)} />
    </div>
  );

  const card = (item: Placed, orphaned: boolean) => (
    <ThreadCard
      key={item.thread.root.id}
      thread={item.thread}
      active={activeId === item.thread.root.id}
      orphaned={orphaned}
      quiet={false}
      actions={actions}
      onActivate={() => setActiveId(item.thread.root.id)}
    />
  );

  const resolvedBlock =
    resolved.length > 0 ? (
      <div className="flex flex-col gap-2">
        <Button type="button" variant="ghost" size="sm" aria-expanded={showResolved} onClick={() => setShowResolved((value) => !value)} className="hit self-start">
          {showResolved ? "Hide resolved" : `${resolved.length} resolved`}
        </Button>
        {showResolved &&
          resolved.map((thread) => (
            <ThreadCard key={thread.root.id} thread={thread} active={activeId === thread.root.id} orphaned={false} quiet actions={actions} onActivate={() => setActiveId(thread.root.id)} />
          ))}
      </div>
    ) : null;

  const orphanBlock =
    orphans.length > 0 ? (
      <div className="flex flex-col gap-2">
        <h2 className="caption-style text-subtle">On text that&apos;s since changed</h2>
        {orphans.map((item) => card(item, true))}
      </div>
    ) : null;

  return (
    <div ref={wrapperRef} data-doc-comments className="relative mx-auto flex w-full justify-center" onMouseLeave={() => setHovered(null)}>
      <article
        ref={articleRef}
        onMouseMove={onPointerMove}
        onClick={onArticleClick}
        className="note-surface flex w-full max-w-[46em] min-w-0 flex-col gap-4 px-4 pt-8 pb-20 md:px-6 md:pt-14"
      >
        {children}
      </article>
      <aside ref={asideRef} aria-label="Comments" className="relative ml-6 hidden w-[300px] shrink-0 min-[1100px]:block">
        {wide && (
          <>
            {slots.map((slot) => {
              const top = stacked.get(slot.key) ?? slot.top;
              if (slot.key === "draft") {
                return (
                  <Measured key="draft" id="draft" top={top} onHeight={onHeight}>
                    {draftCard}
                  </Measured>
                );
              }
              const item = anchored.find((entry) => entry.thread.root.id === slot.key);
              return item ? (
                <Measured key={slot.key} id={slot.key} top={top} onHeight={onHeight}>
                  {card(item, false)}
                </Measured>
              ) : null;
            })}
            <div className="absolute right-0 left-0 flex flex-col gap-4" style={{ top: stackEnd + (stackEnd > 0 ? GROUP_GAP : 0) }}>
              {orphanBlock}
              {resolvedBlock}
              {loadError && (
                <p role="alert" className="caption-style text-danger">
                  {loadError}
                </p>
              )}
            </div>
          </>
        )}
      </aside>
      {hovered && !draft && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Comment on this block"
          onClick={() => beginDraft(hovered.start, hovered.end)}
          style={{ top: hovered.top, left: hovered.left }}
          className={wide ? "hit text-subtle absolute z-20" : "hit text-subtle bg-popover absolute z-20 ring-1 ring-white/10"}
        >
          <CommentIcon aria-hidden className="size-4" />
        </Button>
      )}
      {selection && !draft && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => beginDraft(selection.start, selection.end)}
          style={{ top: selection.top, left: selection.left }}
          className="bg-popover shadow-overlay hit absolute z-20"
        >
          <CommentIcon aria-hidden className="size-3.5" />
          Comment
        </Button>
      )}
      {!wide && (
        <Button type="button" variant="secondary" size="sm" onClick={() => setSheetOpen(true)} className="bg-popover shadow-overlay hit fixed right-4 bottom-4 z-30 min-[1100px]:hidden">
          <CommentIcon aria-hidden className="size-3.5" />
          Comments{openCount > 0 ? ` ${openCount}` : ""}
        </Button>
      )}
      {!wide && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="h-[85dvh]">
            <SheetHeader>
              <SheetTitle>Comments</SheetTitle>
              <SheetCloseButton />
            </SheetHeader>
            <SheetDescription className="sr-only">Comments on this doc</SheetDescription>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
              {draftCard}
              {anchored.map((item) => card(item, false))}
              {orphanBlock}
              {resolvedBlock}
              {loadError && (
                <p role="alert" className="caption-style text-danger">
                  {loadError}
                </p>
              )}
              {openCount === 0 && !draft && resolved.length === 0 && <p className="caption-style text-subtle">No comments yet.</p>}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
