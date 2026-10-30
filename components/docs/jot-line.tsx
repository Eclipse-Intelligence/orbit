"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorView, holdPendingEntry } from "@/components/docs/note-editor";
import NotePicker, { type PickerHandle } from "@/components/docs/note-picker";
import PhoneToolbar from "@/components/docs/phone-toolbar";
import { useMedia } from "@/components/docs/use-docs";
import type { Page } from "@/lib/docs/client-types";
import { localTime } from "@/lib/docs/daily";
import { refreshPreview } from "@/lib/docs/editor/preview";
import { clearJot, entryBlock, jotExtensions, jotLabel, jotLabelAttributes } from "@/lib/docs/editor/jot";
import type { ActiveTrigger } from "@/lib/docs/editor/setup";
import { commitNow, useDocsStore } from "@/stores/docs-store";

const PLACEHOLDER = "Jot something down";
const LEAVE_GRACE_MS = 300;

export default function JotLine({ page }: { page: Page }) {
  const host = useRef<HTMLDivElement>(null);
  const picker = useRef<PickerHandle>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dismissed = useRef<number | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
  const [focused, setFocused] = useState(false);
  const [time, setTime] = useState(() => localTime(new Date()));
  const [started, setStarted] = useState<string | null>(null);
  const startedRef = useRef<string | null>(null);
  const triggerRef = useRef<ActiveTrigger | null>(null);
  const pageId = useRef(page.id);
  const titles = useDocsStore((state) => state.titles);
  const phone = useMedia("(max-width: 767px)");
  const latest = useRef({ titles });

  useLayoutEffect(() => {
    latest.current = { titles };
    triggerRef.current = trigger;
    pageId.current = page.id;
  });

  useEffect(() => {
    const timer = window.setInterval(() => setTime(localTime(new Date())), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const add = () => {
      const jot = viewRef.current;
      const main = editorView();
      if (!jot) return true;
      const block = entryBlock(jot.state.doc.toString(), startedRef.current ?? localTime(new Date()));
      if (!block) {
        if (jot.state.doc.length) clearJot(jot);
        return true;
      }
      if (!main) return true;
      const current = main.state.doc.toString();
      const end = current.replace(/\s+$/, "").length;
      main.dispatch({ changes: { from: end, to: main.state.doc.length, insert: `${end ? "\n\n" : ""}${block}` }, userEvent: "input.type", scrollIntoView: !document.hidden });
      clearJot(jot);
      setTime(localTime(new Date()));
      return true;
    };
    const keep = () => {
      const jot = viewRef.current;
      if (!jot || !jot.state.doc.toString().trim()) return;
      add();
      void commitNow(pageId.current, true);
    };
    let leaving: number | null = null;
    const onBlur = () => {
      if (leaving !== null) window.clearTimeout(leaving);
      leaving = window.setTimeout(() => {
        leaving = null;
        if (!created.hasFocus && !triggerRef.current) keep();
      }, LEAVE_GRACE_MS);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") keep();
    };
    const created = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const empty = !update.state.doc.toString().trim();
            if (empty && startedRef.current) {
              startedRef.current = null;
              setStarted(null);
            } else if (!empty && !startedRef.current) {
              const stamp = localTime(new Date());
              startedRef.current = stamp;
              setStarted(stamp);
            }
          }),
          jotExtensions({
          label: `New entry at ${localTime(new Date())}`,
          placeholder: PLACEHOLDER,
          handlers: {
            resolve: (target) => {
              const key = target.trim();
              return Boolean(latest.current.titles[key.toLowerCase()] ?? latest.current.titles[key]);
            },
            trigger: (value, typed) => {
              if (!value) dismissed.current = null;
              const next = value && dismissed.current === value.at ? null : value;
              setTrigger((current) => {
                if (next && !typed && (!current || current.at !== next.at)) return null;
                return current?.at === next?.at && current?.query === next?.query && current?.kind === next?.kind ? current : next;
              });
            },
            pickerKey: (key) => picker.current?.key(key) ?? false,
            submit: add,
          },
          }),
        ],
      }),
    });
    const watch = () => setFocused(created.hasFocus);
    created.contentDOM.addEventListener("focus", watch);
    created.contentDOM.addEventListener("blur", watch);
    created.contentDOM.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", keep);
    const release = holdPendingEntry(keep);
    viewRef.current = created;
    setView(created);
    return () => {
      if (leaving !== null) window.clearTimeout(leaving);
      keep();
      release();
      created.contentDOM.removeEventListener("focus", watch);
      created.contentDOM.removeEventListener("blur", watch);
      created.contentDOM.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", keep);
      created.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    view?.dispatch({ effects: jotLabel.reconfigure(jotLabelAttributes(`New entry at ${started ?? time}`)) });
  }, [view, time, started]);

  useEffect(() => {
    view?.dispatch({ effects: refreshPreview.of(null) });
  }, [view, titles]);

  const close = () => {
    dismissed.current = trigger?.at ?? null;
    setTrigger(null);
  };

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[4.75rem_1fr] items-baseline">
        <span aria-hidden className="text-subtle pt-[0.32em] text-[13px] leading-[1.6] tabular-nums">
          {started ?? time}
        </span>
        <div ref={host} className="col-start-2 min-w-0" />
      </div>
      <p className="caption-style text-subtle mt-6 pl-[4.75rem]">Saved when you leave the line. Enter starts another entry. Daily notes are always private.</p>
      {view && trigger && !phone && <NotePicker ref={picker} view={view} trigger={trigger} page={page} onClose={close} />}
      {view && phone && focused && (
        <PhoneToolbar view={view} entry>
          {trigger && <NotePicker ref={picker} view={view} trigger={trigger} page={page} onClose={close} sheet />}
        </PhoneToolbar>
      )}
    </div>
  );
}
