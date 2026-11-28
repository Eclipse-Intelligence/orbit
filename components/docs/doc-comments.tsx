"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { deleteCommentAction, docCommentsAction, replyToCommentAction, resolveCommentAction } from "@/app/(crm)/docs/actions";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Sheet, SheetContent, SheetTitle } from "@/components/_ui/sheet";
import { agoLabel, Avatar, Composer } from "@/components/docs/comment-cards";
import { paintComments, shownBody } from "@/components/docs/note-editor";
import { COMMENT_PARAM } from "@/lib/docs/comment-params";
import { placeThreads } from "@/lib/docs/comment-layout";
import type { DocComment } from "@/lib/docs/comments";
import { onCommentDocChange, type CommentMark } from "@/lib/docs/editor/comment-highlights";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import CommentIcon from "@/public/assets/images/docs/comment.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const REFRESH_MS = 30_000;
const BODY_DEBOUNCE_MS = 300;

type Thread = { root: DocComment; replies: DocComment[] };

function threadsOf(comments: DocComment[]): Thread[] {
  return comments.filter((comment) => comment.parentId === null).map((root) => ({ root, replies: comments.filter((comment) => comment.parentId === root.id) }));
}

export function CommentsButton({ open, total, pressed, compact, onClick }: { open: number; total: number; pressed: boolean; compact?: boolean; onClick: () => void }) {
  const label = open > 0 ? `Comments, ${open} open` : total > 0 ? "Comments, none open" : "Comments";
  if (compact) {
    return (
      <Button variant="secondary" size="icon" aria-label={label} aria-pressed={pressed} title="Comments" onClick={onClick} className="relative size-11">
        <CommentIcon aria-hidden className="size-3.5" />
        {open > 0 && <span className="caption-style text-subtle absolute right-1 bottom-0.5 tabular-nums">{open}</span>}
      </Button>
    );
  }
  return (
    <Button
      variant={pressed ? "secondary" : "ghost"}
      size="sm"
      aria-label={label}
      aria-pressed={pressed}
      title="Comments"
      onClick={onClick}
      className={cn("h-[30px] gap-1.5 px-2.5", pressed && "text-foreground")}
    >
      <CommentIcon aria-hidden className="size-3.5" />
      Comments
      {open > 0 && <span className="text-subtle tabular-nums">{open}</span>}
    </Button>
  );
}

function useComments(pageId: string) {
  const [loaded, setLoaded] = useState<{ pageId: string; comments: DocComment[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const setCounts = useDocsStore((state) => state.setCommentCounts);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await docCommentsAction(pageId);
    if (ticket !== latest.current) return;
    if (result.error !== undefined) {
      setFailed(result.error);
      return;
    }
    setFailed(null);
    const roots = result.data.comments.filter((comment) => comment.parentId === null);
    setCounts(pageId, roots.filter((comment) => !comment.resolved).length, roots.length);
    setLoaded({ pageId, comments: result.data.comments });
  }, [pageId, setCounts]);

  useEffect(() => {
    const first = window.setTimeout(() => void reload(), 0);
    const tick = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      latest.current += 1;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [reload]);

  return { comments: loaded && loaded.pageId === pageId ? loaded.comments : null, failed, reload };
}

function useEditorBody(pageId: string, fallback: string) {
  const read = useCallback(() => shownBody(pageId) ?? fallback, [pageId, fallback]);
  const [state, setState] = useState(() => ({ pageId, body: read() }));
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setState({ pageId, body: read() }), BODY_DEBOUNCE_MS);
    };
    refresh();
    const stop = onCommentDocChange(refresh);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [pageId, read]);
  return state.pageId === pageId ? state.body : fallback;
}

function OneComment({ comment, canDelete, onDelete }: { comment: DocComment; canDelete: boolean; onDelete: (id: string) => Promise<string | null> }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Avatar name={comment.authorName} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{comment.authorName}</span>
        {comment.authorKind === "visitor" && <span className="caption-style text-subtle shrink-0">Reader</span>}
        <span className="text-subtle shrink-0 text-[11px]">
          {agoLabel(comment.createdAt)}
          {comment.editedAt ? " (edited)" : ""}
        </span>
      </div>
      <p className="text-foreground/90 text-[13px] leading-[1.5] break-words whitespace-pre-wrap">{comment.body}</p>
      {canDelete && (
        <div className="flex items-center">
          <HoldButton size="sm" onConfirm={async () => setProblem(await onDelete(comment.id))} holding="Keep holding" className="px-2 py-1.5">
            Hold to delete
          </HoldButton>
        </div>
      )}
      {problem && (
        <p role="alert" className="caption-style text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

function Card({
  thread,
  active,
  orphaned,
  viewerName,
  onActivate,
  onReply,
  onToggle,
  onDelete,
}: {
  thread: Thread;
  active: boolean;
  orphaned: boolean;
  viewerName: string;
  onActivate: () => void;
  onReply: (rootId: string, body: string) => Promise<string | null>;
  onToggle: (rootId: string, resolved: boolean) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { root, replies } = thread;
  const quote = root.anchor?.quote ?? "";
  return (
    <div
      data-thread={root.id}
      onClick={onActivate}
      className={cn("bg-popover flex flex-col gap-2 rounded-xl p-3 ring-1 ring-white/6 transition-shadow duration-150 ease-power3-out", active && "shadow-overlay ring-white/12")}
    >
      {quote && (
        <p className={cn("text-soft line-clamp-3 border-l-2 pl-2 text-[12px] leading-[1.45]", orphaned ? "border-faint line-through decoration-white/25" : "border-yellow-400/55")}>{quote}</p>
      )}
      <OneComment comment={root} canDelete={active} onDelete={onDelete} />
      {replies.map((reply) => (
        <div key={reply.id} className="border-border border-t pt-2">
          <OneComment comment={reply} canDelete={active} onDelete={onDelete} />
        </div>
      ))}
      {active && (
        <div className="border-border border-t pt-2">
          <Composer label={`Reply as ${viewerName}`} placeholder="Reply" submitLabel="Reply" name={viewerName} onSubmit={(_name, body) => onReply(root.id, body)} />
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {!active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onActivate();
            }}
            className="hit mr-auto px-2 py-1.5"
          >
            Reply
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={async (event) => {
            event.stopPropagation();
            setBusy(true);
            setProblem(await onToggle(root.id, !root.resolved));
            setBusy(false);
          }}
          className="hit"
        >
          {root.resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
      {problem && (
        <p role="alert" className="caption-style text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

export function DocCommentsPanel({ pageId, fallbackBody, viewerName, phone, onClose }: { pageId: string; fallbackBody: string; viewerName: string; phone?: boolean; onClose: () => void }) {
  const { comments, failed, reload } = useComments(pageId);
  const body = useEditorBody(pageId, fallbackBody);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [active, setActive] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ id: string; n: number } | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const scrolled = useRef(0);
  const asked = useSearchParams().get(COMMENT_PARAM);

  const threads = useMemo(() => threadsOf(comments ?? []), [comments]);
  const layout = useMemo(() => placeThreads(body, threads.map((thread) => ({ id: thread.root.id, anchor: thread.root.anchor, resolved: thread.root.resolved }))), [body, threads]);
  const orphaned = useMemo(() => new Set(layout.orphaned), [layout]);
  const placement = useMemo(() => new Map(layout.placed.map((item) => [item.id, item])), [layout]);

  const open = threads.filter((thread) => !thread.root.resolved);
  const resolved = threads.filter((thread) => thread.root.resolved);
  const openPlaced = open.filter((thread) => !orphaned.has(thread.root.id)).sort((left, right) => (placement.get(left.root.id)?.from ?? 0) - (placement.get(right.root.id)?.from ?? 0));
  const openOrphaned = open.filter((thread) => orphaned.has(thread.root.id));

  const arrival = asked && comments && arrived !== asked ? threads.find((thread) => thread.root.id === asked) : null;
  if (arrival && asked) {
    setArrived(asked);
    setTab(arrival.root.resolved ? "resolved" : "open");
    setActive(asked);
    setScrollRequest((current) => ({ id: asked, n: (current?.n ?? 0) + 1 }));
  }

  useEffect(() => {
    const marks: CommentMark[] = layout.placed
      .filter((item) => item.id === active || threads.some((thread) => thread.root.id === item.id && !thread.root.resolved))
      .map((item) => ({ from: item.from, to: item.to, active: item.id === active }));
    const request = scrollRequest && scrollRequest.n !== scrolled.current ? scrollRequest : null;
    const target = request ? placement.get(request.id) : null;
    paintComments(pageId, marks, target ? target.from : null);
    if (request && target) scrolled.current = request.n;
  }, [layout, active, scrollRequest, placement, threads, pageId]);

  useEffect(
    () => () => {
      paintComments(pageId, [], null);
    },
    [pageId],
  );

  useEffect(() => {
    if (!active) return;
    document.querySelector(`[data-thread="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, tab]);

  function activate(id: string) {
    setActive(id);
    if (!phone) setScrollRequest((current) => ({ id, n: (current?.n ?? 0) + 1 }));
  }

  const actions = {
    reply: async (rootId: string, text: string) => {
      const result = await replyToCommentAction(pageId, rootId, text);
      if (result.error !== undefined) return result.error;
      await reload();
      return null;
    },
    toggle: async (rootId: string, next: boolean) => {
      const result = await resolveCommentAction(pageId, rootId, next);
      if (result.error !== undefined) return result.error;
      if (next) setActive((current) => (current === rootId ? null : current));
      await reload();
      return null;
    },
    remove: async (id: string) => {
      const result = await deleteCommentAction(pageId, id);
      if (result.error !== undefined) return result.error;
      await reload();
      return null;
    },
  };

  const card = (thread: Thread, stale: boolean) => (
    <Card
      key={thread.root.id}
      thread={thread}
      active={active === thread.root.id}
      orphaned={stale}
      viewerName={viewerName}
      onActivate={() => activate(thread.root.id)}
      onReply={actions.reply}
      onToggle={actions.toggle}
      onDelete={actions.remove}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center gap-2 px-5 pt-3 pb-2", phone && "px-3.5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2.5")}>
        <h3 className="flex-1">Comments</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" title="Close comments" onClick={onClose} className="max-md:size-11">
          <XIcon aria-hidden className="size-4" />
        </Button>
      </div>
      <div className={cn("flex shrink-0 items-center gap-1 px-4 pb-2", phone && "px-3")}>
        <Button variant="chip" size="sm" data-active={tab === "open"} aria-pressed={tab === "open"} onClick={() => setTab("open")} className="hit">
          Open {open.length}
        </Button>
        <Button variant="chip" size="sm" data-active={tab === "resolved"} aria-pressed={tab === "resolved"} onClick={() => setTab("resolved")} className="hit">
          Resolved {resolved.length}
        </Button>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 pb-4", phone && "px-3")}>
        {failed && comments === null && (
          <p role="alert" className="caption-style text-danger">
            {failed}
          </p>
        )}
        {comments === null && !failed && (
          <p role="status" className="caption-style text-subtle">
            Loading comments
          </p>
        )}
        {comments !== null && tab === "open" && (
          <>
            {openPlaced.map((thread) => card(thread, false))}
            {openOrphaned.length > 0 && (
              <>
                <h4 className="caption-style text-subtle pt-2">On text that&apos;s since changed</h4>
                {openOrphaned.map((thread) => card(thread, true))}
              </>
            )}
            {open.length === 0 && <p className="caption-style text-subtle">No open comments.</p>}
          </>
        )}
        {comments !== null && tab === "resolved" && (
          <>
            {resolved.map((thread) => card(thread, orphaned.has(thread.root.id)))}
            {resolved.length === 0 && <p className="caption-style text-subtle">Nothing resolved yet.</p>}
          </>
        )}
      </div>
    </div>
  );
}

export function PhoneCommentsSheet({ open, pageId, fallbackBody, viewerName, onClose }: { open: boolean; pageId: string; fallbackBody: string; viewerName: string; onClose: () => void }) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full" aria-describedby={undefined}>
        <SheetTitle className="sr-only">Comments</SheetTitle>
        <DocCommentsPanel key={pageId} pageId={pageId} fallbackBody={fallbackBody} viewerName={viewerName} phone onClose={onClose} />
      </SheetContent>
    </Sheet>
  );
}
