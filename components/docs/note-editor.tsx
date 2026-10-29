"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import NotePicker, { type PickerHandle } from "@/components/docs/note-picker";
import PhoneToolbar from "@/components/docs/phone-toolbar";
import StaticNote from "@/components/docs/static-note";
import { useDocsNavigate, useMedia } from "@/components/docs/use-docs";
import type { Page, PageFilter, Presence } from "@/lib/docs/client-types";
import { clearDraft, draftToRestore, readDraft } from "@/lib/docs/drafts";
import type { CachedLive } from "@/lib/docs/live/client";
import { refreshPreview } from "@/lib/docs/editor/preview";
import { setPresence } from "@/lib/docs/editor/presence";
import { bridge, external, noteExtensions, type ActiveTrigger } from "@/lib/docs/editor/setup";
import { createStateCache } from "@/lib/docs/editor/state-cache";
import { headingsIn } from "@/lib/docs/markdown";
import { listHref, pageHref, recordHref } from "@/lib/docs/routes";
import { adoptDraft, commitNow, onDocsReset, scheduleSave, useDocsStore } from "@/stores/docs-store";

type Cached = { state: EditorState; live: CachedLive | null };
type LiveModule = typeof import("@/lib/docs/live/client");

const MAX_CACHED = 24;
const states = createStateCache<Cached>(MAX_CACHED);
const titles = new Map<string, string>();
let liveView: EditorView | null = null;
let liveId: string | null = null;
let pendingHeading: { pageId: string; heading: string } | null = null;
let liveModule: LiveModule | null = null;
let attachToken = 0;
let attaching: { id: string; cached: CachedLive | null } | null = null;

onDocsReset(() => {
  states.clear();
  titles.clear();
  liveId = null;
  pendingHeading = null;
  attachToken += 1;
  attaching = null;
});

function remember(id: string, state: EditorState, epoch: number, live: CachedLive | null) {
  states.remember(id, { state, live }, epoch, liveId);
}

function startLive(view: EditorView, page: Page, cached: CachedLive | null) {
  if (!useDocsStore.getState().liveKind) return;
  const token = ++attachToken;
  const id = page.id;
  attaching = { id, cached };
  const isCurrent = () => token === attachToken && liveId === id && liveView === view;
  const run = () => {
    if (!isCurrent()) return;
    void import("@/lib/docs/live/client")
      .then((module) => {
        liveModule = module;
        if (!isCurrent()) return false;
        return module.attachLive({ view, page, title: titles.get(id) ?? page.title, cached, isCurrent });
      })
      .then((attached) => {
        if (attached && attaching?.id === id) attaching = null;
      })
      .catch(() => {});
  };
  requestAnimationFrame(() => setTimeout(run, 0));
}

function stopLive(id: string): CachedLive | null {
  attachToken += 1;
  const detached = liveModule?.detachLive(id) ?? null;
  const pending = attaching?.id === id ? attaching.cached : null;
  attaching = null;
  return detached ?? pending;
}

function currentEpoch(id: string) {
  return useDocsStore.getState().epochs[id] ?? 0;
}

export function noteTitle(id: string) {
  return titles.get(id);
}

export function setNoteTitle(id: string, title: string) {
  titles.set(id, title);
}

function noteBody(id: string) {
  if (liveView && liveId === id) return liveView.state.doc.toString();
  return states.peek(id)?.state.doc.toString() ?? null;
}

export function editorView() {
  return liveView;
}

export function focusNoteText(at: "start" | "end" = "start") {
  const view = liveView;
  if (!view) return;
  view.focus();
  view.dispatch({ selection: EditorSelection.cursor(at === "start" ? 0 : view.state.doc.length), scrollIntoView: true });
}

export function scheduleNoteSave(id: string, fallback: { title: string; body: string }) {
  if (liveModule?.isLive(id)) {
    liveModule.liveTitle(id, titles.get(id) ?? fallback.title);
    return;
  }
  scheduleSave(id, () => ({ title: titles.get(id) ?? fallback.title, body: noteBody(id) ?? fallback.body }));
}

function stateFor(page: Page, placeholder: string) {
  const draft = draftToRestore(readDraft(page.id), page);
  if (draft) adoptDraft(page, draft);
  titles.set(page.id, draft?.title ?? page.title);
  const state = EditorState.create({
    doc: draft?.body ?? page.body,
    extensions: noteExtensions({ daily: page.kind === "daily", placeholder, label: page.kind === "daily" ? "Daily note" : "Note text" }),
  });
  return { state, restored: Boolean(draft) };
}

export default function NoteEditor({
  page,
  presence,
  list,
  placeholder = "Start writing",
  onEscape,
  onTitleFocus,
}: {
  page: Page;
  presence: Presence[];
  list: PageFilter;
  placeholder?: string;
  onEscape: () => boolean;
  onTitleFocus: () => boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const picker = useRef<PickerHandle>(null);
  const [mounted, setMounted] = useState(false);
  const [triggerState, setTrigger] = useState<(ActiveTrigger & { pageId: string | null }) | null>(null);
  const trigger = triggerState && triggerState.pageId === page.id ? triggerState : null;
  const [focused, setFocused] = useState(false);
  const navigate = useDocsNavigate();
  const pageTitles = useDocsStore((state) => state.titles);
  const epoch = useDocsStore((state) => state.epochs[page.id] ?? 0);
  const createNote = useDocsStore((state) => state.createNote);
  const notify = useDocsStore((state) => state.notify);
  const phone = useMedia("(max-width: 767px)");
  const latest = useRef({ page, list, pageTitles, onEscape, onTitleFocus });
  const seenEpoch = useRef(epoch);
  const dismissed = useRef<number | null>(null);
  const closePicker = () => {
    dismissed.current = trigger?.at ?? null;
    setTrigger(null);
  };

  useLayoutEffect(() => {
    latest.current = { page, list, pageTitles, onEscape, onTitleFocus };
  });

  useLayoutEffect(() => {
    bridge.resolve = (target) => {
      const key = target.trim().toLowerCase();
      return Boolean(latest.current.pageTitles[key] ?? latest.current.pageTitles[target.trim()]);
    };
    bridge.openLink = (target, heading, newTab) => {
      const id = latest.current.pageTitles[target.trim().toLowerCase()] ?? latest.current.pageTitles[target.trim()];
      if (id) {
        if (heading) pendingHeading = { pageId: id, heading };
        navigate(pageHref(id, latest.current.list), { newTab });
        return;
      }
      void createNote({ title: target.trim(), folderId: latest.current.page.kind === "note" ? latest.current.page.folderId : null }).then((created) => {
        if (created) navigate(pageHref(created.id, latest.current.list), { newTab });
      });
    };
    bridge.openTag = (path, newTab) => navigate(listHref({ kind: "tag", path }), { newTab });
    bridge.openRecord = (kind, id, newTab) => navigate(recordHref(kind, id), { newTab });
    bridge.trigger = (value, typed) => {
      if (!value) dismissed.current = null;
      const next = value && dismissed.current === value.at ? null : value ? { ...value, pageId: liveId } : null;
      setTrigger((current) => {
        if (next && !typed && (!current || current.at !== next.at)) return null;
        return current?.at === next?.at && current?.query === next?.query && current?.kind === next?.kind && current?.pageId === next?.pageId ? current : next;
      });
    };
    bridge.pickerKey = (key) => picker.current?.key(key) ?? false;
    bridge.changed = () => {
      if (liveId) scheduleNoteSave(liveId, latest.current.page);
    };
    bridge.escape = () => latest.current.onEscape();
    bridge.focusTitle = () => latest.current.onTitleFocus();
  }, [navigate, createNote]);

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const id = latest.current.page.id;
    const epochNow = currentEpoch(id);
    const cached = states.take(id, epochNow);
    const { state, restored } = cached ? { state: cached.state, restored: false } : stateFor(latest.current.page, placeholder);
    const view = new EditorView({ state, parent });
    liveView = view;
    liveId = id;
    seenEpoch.current = epochNow;
    startLive(view, latest.current.page, cached?.live ?? null);
    const focusWatcher = () => setFocused(view.hasFocus);
    view.contentDOM.addEventListener("focus", focusWatcher);
    view.contentDOM.addEventListener("blur", focusWatcher);
    setMounted(true);
    if (restored) {
      scheduleNoteSave(liveId, latest.current.page);
      notify("Restored changes that hadn't saved yet.");
    }
    return () => {
      view.contentDOM.removeEventListener("focus", focusWatcher);
      view.contentDOM.removeEventListener("blur", focusWatcher);
      if (liveId) {
        const live = stopLive(liveId);
        remember(liveId, view.state, seenEpoch.current, live);
        if (!live) void commitNow(liveId);
      }
      view.destroy();
      if (liveView === view) {
        liveView = null;
        liveId = null;
      }
    };
  }, [placeholder, notify]);

  useLayoutEffect(() => {
    const view = liveView;
    if (!view || liveId === page.id) return;
    if (liveId) {
      const live = stopLive(liveId);
      remember(liveId, view.state, seenEpoch.current, live);
      if (!live) void commitNow(liveId);
    }
    const epochNow = currentEpoch(page.id);
    const cached = states.take(page.id, epochNow);
    let state = cached?.state ?? null;
    let restored = false;
    if (!state) {
      const created = stateFor(page, placeholder);
      state = created.state;
      restored = created.restored;
    }
    view.setState(state);
    liveId = page.id;
    seenEpoch.current = epochNow;
    if (restored) scheduleNoteSave(page.id, page);
    startLive(view, page, cached?.live ?? null);
    const heading = pendingHeading?.pageId === page.id ? pendingHeading.heading : null;
    pendingHeading = null;
    if (heading) {
      const found = headingsIn(view.state.doc.toString()).find((item) => item.text.toLowerCase() === heading.toLowerCase());
      if (found) {
        const pos = view.state.doc.line(found.line + 1).from;
        view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 96 }) });
      }
    }
  }, [page, placeholder]);

  useEffect(() => {
    const view = liveView;
    if (!view || liveId !== page.id || epoch === seenEpoch.current) return;
    seenEpoch.current = epoch;
    if (liveModule?.isLive(page.id)) {
      liveModule.pullLive(page.id);
      titles.set(page.id, page.title);
      return;
    }
    if (view.state.doc.toString() === page.body) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: page.body }, annotations: external.of(true) });
    titles.set(page.id, page.title);
    clearDraft(page.id);
  }, [epoch, page]);

  useEffect(() => {
    liveView?.dispatch({ effects: refreshPreview.of(null) });
  }, [pageTitles]);

  useEffect(() => {
    if (liveId === page.id) liveView?.dispatch({ effects: setPresence.of(presence) });
  }, [presence, page.id, mounted]);

  const daily = page.kind === "daily";

  return (
    <div className="relative">
      {!mounted && <StaticNote body={page.body} daily={daily} />}
      <div ref={host} className={mounted ? undefined : "hidden"} />
      {mounted && liveView && trigger && !phone && <NotePicker ref={picker} view={liveView} trigger={trigger} page={page} onClose={closePicker} />}
      {mounted && liveView && phone && focused && (
        <PhoneToolbar view={liveView}>
          {trigger && <NotePicker ref={picker} view={liveView} trigger={trigger} page={page} onClose={closePicker} sheet />}
        </PhoneToolbar>
      )}
    </div>
  );
}
