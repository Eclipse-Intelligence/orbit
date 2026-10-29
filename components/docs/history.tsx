"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
import { ParticipantAvatar } from "@/components/docs/presence";
import { useDocsNow } from "@/components/docs/use-docs";
import type { Page, Version } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { wordDiff } from "@/lib/docs/diff";
import { diffDecorations, noteExtensions } from "@/lib/docs/editor/setup";
import { clockTime, versionDayLabel, whenLabel } from "@/lib/docs/format";
import { cn } from "@/lib/utils";
import ClockIcon from "@/public/assets/images/companies/detail/clock.svg";
import UndoIcon from "@/public/assets/images/docs/undo.svg";

export type Selected = { version: Version; previous: Version | null };

export function useVersions(pageId: string, revision: number) {
  const [state, setState] = useState<{ key: string; versions: Version[] } | null>(null);
  const key = `${pageId}:${revision}`;
  useEffect(() => {
    let live = true;
    void docsData()
      .listVersions(pageId)
      .then((versions) => {
        if (live) setState({ key, versions });
      });
    return () => {
      live = false;
    };
  }, [pageId, key]);
  return state && state.key.startsWith(`${pageId}:`) ? state.versions : null;
}

export function HistoryRail({ versions, selected, onSelect }: { versions: Version[] | null; selected: string | null; onSelect: (value: Selected | null) => void }) {
  const now = useDocsNow();
  const groups = useMemo(() => {
    const result: { day: string; items: { version: Version; index: number }[] }[] = [];
    (versions ?? []).forEach((version, index) => {
      const day = versionDayLabel(version.createdAt, now);
      const group = result[result.length - 1];
      if (group && group.day === day) group.items.push({ version, index });
      else result.push({ day, items: [{ version, index }] });
    });
    return result;
  }, [versions, now]);

  return (
    <div className="flex flex-col pb-28">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h3 className="flex-1">Version history</h3>
        {versions && (
          <span className="caption-style text-subtle">
            {versions.length} {versions.length === 1 ? "version" : "versions"}
          </span>
        )}
      </div>
      {versions === null && (
        <p role="status" className="caption-style text-faint px-4">
          Loading
        </p>
      )}
      {versions?.length === 0 && <p className="caption-style text-subtle px-4">No versions yet. Orbit saves one as you write.</p>}
      {groups.map((group) => (
        <section key={group.day} className="flex flex-col px-2 pb-2">
          <h4 className="eyebrow-style text-faint px-2 pt-2 pb-1.5 text-[11px]">{group.day}</h4>
          <ol className="flex flex-col gap-0.5">
            {group.items.map(({ version, index }) => {
              const current = index === 0;
              const active = selected === version.id;
              return (
                <li key={version.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(current || active ? null : { version, previous: versions?.[index + 1] ?? null })}
                    className={cn(
                      "ease-power3-out focus-visible:ring-ring/60 flex w-full cursor-pointer items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors duration-150 outline-none focus-visible:ring-2",
                      active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
                    )}
                  >
                    <ParticipantAvatar participant={version.author} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("truncate text-[13px] leading-4 font-medium", version.author.kind === "assistant" ? "text-[#c9c2ff]" : "text-foreground")}>{version.author.name}</span>
                        <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{current ? whenLabel(version.createdAt, now) : clockTime(version.createdAt)}</span>
                      </span>
                      <span className="caption-style text-soft">{version.summary}</span>
                      {version.askedBy && <span className="caption-style text-faint">{version.askedBy}</span>}
                      {current && (
                        <span className="caption-style flex items-center gap-1.5 text-(--tag-green-text)">
                          <span aria-hidden className="bg-success size-1.5 rounded-full" />
                          Live
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <p className="caption-style text-faint px-4 pt-2">Orbit saves a version every 10 minutes while you write, and before every agent edit.</p>
    </div>
  );
}

export function VersionBanner({
  selected,
  showChanges,
  onShowChanges,
  onRestore,
  onBack,
  pending,
  error,
}: {
  selected: Selected;
  showChanges: boolean;
  onShowChanges: (value: boolean) => void;
  onRestore: () => void;
  onBack: () => void;
  pending: boolean;
  error: string | null;
}) {
  const now = useDocsNow();
  const when = whenLabel(selected.version.createdAt, now);
  const label = /^\d{2}:\d{2}$/.test(when) ? `${when} today` : when;
  return (
    <div className="mx-3 mb-1 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.04] py-2 pr-2 pl-3.5">
      <ClockIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
      <p className="ui-style text-soft min-w-0 flex-1 truncate">
        <span className="text-foreground">{label}</span> by {selected.version.author.name}
        {selected.previous ? ", compared with the version before" : ""}
      </p>
      {selected.previous && (
        <label className="caption-style text-soft flex shrink-0 items-center gap-2">
          Show changes
          <Switch checked={showChanges} onChange={onShowChanges} label="Show changes" />
        </label>
      )}
      <Button variant="secondary" size="sm" onClick={onRestore} disabled={pending}>
        <UndoIcon aria-hidden className="size-3.5" />
        {pending ? "Restoring" : "Restore"}
      </Button>
      <Button variant="ghost" size="sm" shortcut={["Esc"]} onClick={onBack}>
        Back to live
      </Button>
      {error && (
        <p role="alert" className="caption-style text-danger w-full">
          {error}
        </p>
      )}
    </div>
  );
}

function useVersionBodies(pageId: string, selected: Selected) {
  const key = `${selected.version.id}:${selected.previous?.id ?? ""}`;
  const [state, setState] = useState<{ key: string; body: string; previous: string | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    const versionId = selected.version.id;
    const previousId = selected.previous?.id ?? null;
    void Promise.all([docsData().versionBody(pageId, versionId), previousId ? docsData().versionBody(pageId, previousId) : Promise.resolve(null)])
      .then(([current, previous]) => {
        if (live) setState({ key, body: current.body, previous: previous?.body ?? null, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState({ key, body: "", previous: null, error: error instanceof Error ? error.message : "That version didn't load. Try again." });
      });
    return () => {
      live = false;
    };
  }, [pageId, key, selected.version.id, selected.previous?.id]);
  return state?.key === key ? state : null;
}

export function VersionPreview({ page, selected, showChanges }: { page: Page; selected: Selected; showChanges: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const loaded = useVersionBodies(page.id, selected);
  const body = loaded?.body ?? null;
  const previous = loaded?.previous ?? null;
  const decorations = useMemo(() => {
    if (!showChanges || previous === null || body === null) return null;
    return wordDiff(previous, body);
  }, [showChanges, previous, body]);

  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent || body === null) return;
    const state = EditorState.create({
      doc: body,
      extensions: [
        noteExtensions({ daily: page.kind === "daily", readOnly: true, label: "Earlier version" }),
        decorations ? EditorView.decorations.of((view) => diffDecorations(view.state.doc, decorations)) : [],
      ],
    });
    const view = new EditorView({ state, parent });
    return () => view.destroy();
  }, [body, decorations, page.kind]);

  if (loaded?.error) {
    return (
      <p role="alert" className="caption-style text-danger">
        {loaded.error}
      </p>
    );
  }
  return (
    <>
      {!loaded && (
        <p role="status" className="caption-style text-faint">
          Loading the version
        </p>
      )}
      <div ref={host} />
    </>
  );
}
