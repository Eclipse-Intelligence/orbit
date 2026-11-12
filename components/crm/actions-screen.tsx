"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { activeRow, useShortcut, useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList, { activateRow } from "@/components/shortcuts/keyboard-list";
import ActionTask from "@/components/beautifui/action-task";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import TaskPad from "@/components/crm/task-pad";
import TaskPanel from "@/components/crm/task-panel";
import { canChangeTaskAs } from "@/components/crm/task-fields";
import { ConnectionMark, Monogram } from "@/components/beautifui/record-marks";
import { RecordList, RecordRow } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { assignTaskAction } from "@/app/(crm)/records";
import { useTaskDone } from "@/components/crm/use-task-done";
import { taskWindowAction, type TaskWindow } from "@/app/(crm)/tasks/actions";
import { relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import { TASK_PARAM } from "@/lib/chat/discussions";
import { companyHref } from "@/lib/crm/hrefs";
import { groupTasksByDue, tasksHref } from "@/lib/crm/task-views";
import type { Company, Task, TaskView } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const MAX_WINDOW_PAGES = 20;
const DESKTOP = "(min-width: 64rem) and (hover: hover)";

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(DESKTOP);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useDesktop() {
  return useSyncExternalStore<boolean | null>(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => null);
}

function inPanel() {
  return Boolean(document.activeElement?.closest("[data-nonmodal]"));
}

function inField() {
  return Boolean(document.activeElement?.closest("input, textarea, select, [contenteditable='true']"));
}

const NO_TAGS: string[] = [];
const FOLLOW_MS = 160;

const STRIP: { keys: string[][]; label: string; changes?: boolean }[] = [
  { keys: [["J"], ["K"]], label: "Move" },
  { keys: [["↵"], ["Space"]], label: "Expand" },
  { keys: [["⇧↵"], ["O"]], label: "Open" },
  { keys: [["E"]], label: "Done", changes: true },
  { keys: [["H"]], label: "Remind me", changes: true },
  { keys: [["Z"]], label: "Undo", changes: true },
  { keys: [["Esc"]], label: "Close" },
];

function KeyStrip({ completed }: { completed: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[4.5rem] z-10 hidden justify-center px-4 lg:flex [@media(hover:none)]:hidden">
      <div className="bg-popover border-line-strong shadow-overlay caption-style text-soft flex flex-wrap items-center gap-x-4 gap-y-1 rounded-full border px-4 py-2">
        {STRIP.filter((item) => !(completed && item.changes)).map((item) => (
          <span key={item.label} className="flex items-center gap-1.5">
            {item.keys.map((keys, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="text-subtle">or</span>}
                {keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </Fragment>
            ))}
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function unique<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

const VIEWS: { id: TaskView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
  { id: "none", label: "Without tasks" },
];

export default function ActionsScreen({
  viewer,
  view,
  counts,
  tasks,
  companies,
  clickup,
  now,
  who = "mine",
  shared = false,
  members = [],
  tagged = {},
  taggedCount = 0,
  discussions = {},
  openTask = null,
  admins = [],
  switchTo = null,
  total = 0,
}: {
  viewer: Viewer;
  view: TaskView;
  counts: Record<TaskView, number>;
  tasks: Task[];
  companies: Company[];
  clickup: ClickUpPicker | null;
  now: number;
  who?: "mine" | "tagged" | "everyone";
  shared?: boolean;
  members?: AssignableMember[];
  tagged?: Record<string, string[]>;
  taggedCount?: number;
  discussions?: Record<string, number>;
  openTask?: Task | null;
  admins?: string[];
  switchTo?: string | null;
  total?: number;
}) {
  const team = members.length > 1;
  const href = (target: TaskView, person = who) => {
    const base = tasksHref(target);
    if (person === "mine" || (person === "everyone" && !shared) || (person === "tagged" && !team)) return base;
    return `${base}${base.includes("?") ? "&" : "?"}who=${person}`;
  };
  const views = who === "tagged" ? VIEWS.filter((item) => item.id !== "none") : VIEWS;
  const router = useRouter();
  const pageKey = `${view}|${who}`;
  const [windowed, setWindowed] = useState<{ key: string; data: TaskWindow } | null>(null);
  const [loading, startLoading] = useTransition();
  const [moreError, setMoreError] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState(pageKey);
  if (shownKey !== pageKey) {
    setShownKey(pageKey);
    setWindowed(null);
    setMoreError(null);
  }
  const current = windowed && windowed.key === pageKey && windowed.data.pages > 1 ? windowed.data : null;
  const allTasks = unique(current ? current.tasks : tasks);
  const allCompanies = unique(current ? current.companies : companies);
  const allTagged = current ? { ...tagged, ...current.tagged } : tagged;
  const allDiscussions = current ? { ...discussions, ...current.discussions } : discussions;
  const pages = current?.pages ?? 1;
  const latestTotal = current?.total ?? total;
  const shown = view === "none" ? allCompanies.length : allTasks.length;
  const canLoadMore = shown < latestTotal && pages < MAX_WINDOW_PAGES;
  const freshness = useRef({ tasks, companies });
  useEffect(() => {
    if (freshness.current.tasks === tasks && freshness.current.companies === companies) return;
    freshness.current = { tasks, companies };
    if (!current) return;
    let cancelled = false;
    const key = pageKey;
    void taskWindowAction({ view, who, pages: current.pages })
      .catch(() => ({ error: "Couldn't load more. Try again." }))
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          setWindowed(null);
          setMoreError(`${result.error} Showing the first 100.`);
          return;
        }
        setWindowed({ key, data: result });
      });
    return () => {
      cancelled = true;
    };
  }, [tasks, companies, current, pageKey, view, who]);
  function loadMore() {
    setMoreError(null);
    const key = pageKey;
    startLoading(async () => {
      const result = await taskWindowAction({ view, who, pages: pages + 1 }).catch(() => ({ error: "Couldn't load more. Try again." }));
      if ("error" in result) {
        setMoreError(result.error);
        return;
      }
      setWindowed({ key, data: result });
    });
  }
  const more =
    canLoadMore || moreError ? (
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        {canLoadMore && (
          <Button variant="secondary" size="md" onClick={loadMore} disabled={loading} aria-busy={loading || undefined} className="max-md:h-11">
            {loading ? "Loading…" : "Show more"}
          </Button>
        )}
        <span role="status" className="caption-style text-subtle tabular-nums">
          {shown} of {latestTotal}
        </span>
        {moreError && (
          <span role="alert" className="caption-style text-danger">
            {moreError}
          </span>
        )}
      </div>
    ) : undefined;
  const colleagues = useMemo(() => members.map((member) => ({ id: member.id, name: member.name })), [members]);
  const { done, message, setMessage, complete: markDone, undoLast, remind } = useTaskDone(allTasks);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { singleKeys } = useShortcuts();
  const desktop = useDesktop();
  const [assigningIds, setAssigningIds] = useState<Set<string>>(() => new Set());
  const search = useSearchParams();
  const panelId = search.get(TASK_PARAM);
  const listed = panelId ? (allTasks.find((task) => task.id === panelId) ?? (openTask?.id === panelId ? openTask : null)) : null;
  const [kept, setKept] = useState<Task | null>(null);
  if (listed && listed !== kept) setKept(listed);
  const panelTask = listed ?? (kept && kept.id === panelId ? kept : null);
  const missing = Boolean(panelId) && !panelTask && !switchTo;

  useEffect(() => {
    if (switchTo) window.location.replace(switchTo);
  }, [switchTo]);
  const openedHere = useRef(false);

  const openPanel = useCallback((id: string) => {
    const params = new URLSearchParams(window.location.search);
    const switching = params.has(TASK_PARAM);
    params.set(TASK_PARAM, id);
    const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    if (switching) {
      window.history.replaceState(null, "", url);
      return;
    }
    openedHere.current = true;
    window.history.pushState(null, "", url);
  }, []);

  const dropParam = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete(TASK_PARAM);
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, []);

  const closePanel = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false;
      window.history.back();
      return;
    }
    dropParam();
  }, [dropParam]);

  const shownPanel = useRef(panelId);
  useEffect(() => {
    if (!panelId) openedHere.current = false;
    if (shownPanel.current && !panelId) router.refresh();
    shownPanel.current = panelId;
  }, [panelId, router]);

  useEffect(() => {
    if (!missing) return;
    dropParam();
  }, [missing, dropParam]);
  const [notFound, setNotFound] = useState(false);
  if (missing && !notFound) setNotFound(true);

  function complete(task: Task) {
    if (done.has(task.id)) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-task-id="${task.id}"]`);
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])];
    const index = row ? rows.indexOf(row) : -1;
    const following = index >= 0 ? (rows[index + 1] ?? rows[index - 1] ?? null) : null;
    const wasActive = row?.dataset.kbActive === "true";
    setExpandedId((current) => (current === task.id ? null : current));
    markDone(task);
    if (wasActive && following) window.requestAnimationFrame(() => activateRow(following));
  }

  async function assign(id: string, ownerId: string) {
    if (assigningIds.has(id)) return;
    setMessage(null);
    setAssigningIds((current) => new Set(current).add(id));
    const result = await assignTaskAction(id, ownerId);
    setAssigningIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    router.refresh();
  }

  const canChange = (task: Task) => canChangeTaskAs(viewer, task);
  const shownTasks = view === "completed" ? allTasks : allTasks.filter((task) => !done.has(task.id));
  const entries =
    view === "all"
      ? groupTasksByDue(shownTasks, now).flatMap((group) => [
          { kind: "heading" as const, key: `heading:${group.kind}`, group: group.kind, label: group.label, count: group.tasks.length },
          ...group.tasks.map((task) => ({ kind: "task" as const, key: task.id, task })),
        ])
      : shownTasks.map((task) => ({ kind: "task" as const, key: task.id, task }));
  const panelOpen = Boolean(panelTask);
  const beside = desktop === true;

  function activeTask() {
    if (inPanel()) return null;
    const row = activeRow();
    if (!row || !listRef.current?.contains(row)) return null;
    return shownTasks.find((task) => task.id === row.dataset.taskId) ?? null;
  }

  function toggle(task: Task) {
    if (panelOpen && beside) {
      openPanel(task.id);
      return;
    }
    setExpandedId((current) => (current === task.id ? null : task.id));
  }

  const latest = useRef({ toggle, complete, remind, openPanel, assign });
  useEffect(() => {
    latest.current = { toggle, complete, remind, openPanel, assign };
  });
  const onToggle = useCallback((task: Task) => latest.current.toggle(task), []);
  const onComplete = useCallback((task: Task) => latest.current.complete(task), []);
  const onRemind = useCallback((task: Task) => latest.current.remind(task), []);
  const onOpen = useCallback((task: Task) => latest.current.openPanel(task.id), []);
  const onAssign = useCallback((task: Task, ownerId: string) => void latest.current.assign(task.id, ownerId), []);
  const onPanelComplete = useCallback((task: Task) => latest.current.complete(task), []);

  const follow = useRef(0);
  useEffect(() => () => window.clearTimeout(follow.current), []);
  function followRow(row: HTMLElement) {
    const id = row.dataset.taskId;
    if (!id) return;
    window.clearTimeout(follow.current);
    follow.current = window.setTimeout(() => {
      if (panelOpen && beside) openPanel(id);
      else if (expandedId) setExpandedId(id);
    }, FOLLOW_MS);
  }

  useShortcut("task-open", () => {
    const task = activeTask();
    if (!task) return false;
    openPanel(task.id);
  });
  useShortcut("task-done", () => {
    const task = activeTask();
    if (!task || view === "completed" || !canChange(task)) return false;
    complete(task);
  });
  useShortcut("task-remind", () => {
    const task = activeTask();
    if (!task || view === "completed" || !canChange(task)) return false;
    remind(task);
  });
  useShortcut("task-undo", () => {
    if (inPanel() || inField()) return false;
    return undoLast();
  });
  useShortcut("task-collapse", () => {
    if (!expandedId || inPanel()) return false;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-task-id="${expandedId}"]`);
    setExpandedId(null);
    if (row && row.contains(document.activeElement) && document.activeElement !== row) activateRow(row);
  });

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Tasks"
        viewer={viewer}
        action={
          <span className="flex items-center gap-1">
            {team && (
              <>
                <Button variant={who === "mine" ? "secondary" : "ghost"} size="sm" href={href(view, "mine")} aria-current={who === "mine" ? "page" : undefined}>
                  Mine
                </Button>
                <Button
                  variant={who === "tagged" ? "secondary" : "ghost"}
                  size="sm"
                  href={href(view === "none" ? "all" : view, "tagged")}
                  aria-current={who === "tagged" ? "page" : undefined}
                >
                  Tagged
                  {taggedCount > 0 && <span className="text-subtle tabular-nums">{taggedCount}</span>}
                </Button>
                {shared && (
                  <Button
                    variant={who === "everyone" ? "secondary" : "ghost"}
                    size="sm"
                    href={href(view, "everyone")}
                    aria-current={who === "everyone" ? "page" : undefined}
                  >
                    Everyone
                  </Button>
                )}
              </>
            )}
            <RecordTransfer resource="tasks" />
          </span>
        }
      />
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        {views.map((item, index) => (
          <Button
            key={item.id}
            variant={item.id === view ? "secondary" : "ghost"}
            size="sm"
            href={href(item.id)}
            aria-current={item.id === view ? "page" : undefined}
            data-shortcut={`tab-${index + 1}`}
            title={`${item.label} (${index + 1})`}
          >
            {item.label}
            <span className="text-subtle tabular-nums">{counts[item.id]}</span>
          </Button>
        ))}
      </div>
      <TaskPad clickup={clickup} members={members} viewerId={viewer.id} className="border-border border-b px-4 py-3" />
      {message && (
        <p role="alert" className="caption-style text-danger px-4 pt-3">
          {message}
        </p>
      )}
      {notFound && !message && (
        <p role="status" className="caption-style text-soft flex items-center gap-2 px-4 pt-3">
          Task not found.
          <Button variant="ghost" size="sm" onClick={() => setNotFound(false)} className="max-md:h-11">
            Dismiss
          </Button>
        </p>
      )}
      <div
        ref={listRef}
        className="relative flex min-h-0 flex-1 flex-col"
        onFocus={(event) => setSelected(Boolean((event.target as HTMLElement).closest("[data-task-id]")))}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSelected(false);
        }}
      >
      <KeyboardList
        className="flex min-h-0 flex-1 flex-col"
        onMove={followRow}
      >
      {view === "none" ? (
        <RecordList
          count={allCompanies.length}
          empty="No companies without tasks"
          footer={more}
        >
          {allCompanies.map((company) => (
            <RecordRow
              key={company.id}
              mark={<Monogram name={company.name} />}
              title={company.name}
              meta={[relativeWhen(company.lastInteractionAt, now), company.domain].filter(Boolean).join(" · ")}
              action={
                <span className="flex items-center gap-3">
                  <ConnectionMark relationship={company.relationship} />
                  <Button variant="ghost" size="sm" href={companyHref(company.id)}>
                    Open
                  </Button>
                </span>
              }
            />
          ))}
        </RecordList>
      ) : (
        <RecordList count={shownTasks.length} empty={who === "tagged" ? "No tasks you're tagged in" : "No tasks"} footer={more}>
          {entries.map((entry) =>
            entry.kind === "heading" ? (
              <li key={entry.key}>
                <h2 className={cn("eyebrow-style flex items-center gap-2 px-4 pt-4 pb-1.5", entry.group === "overdue" ? "text-danger" : "text-subtle")}>
                  {entry.label}
                  <span className="text-subtle tabular-nums">{entry.count}</span>
                </h2>
              </li>
            ) : (
              <ActionTask
                key={entry.key}
                task={entry.task}
                completed={view === "completed" || done.has(entry.task.id)}
                dueBadge={view === "all"}
                now={now}
                viewer={viewer}
                members={members}
                tagged={allTagged[entry.task.id] ?? NO_TAGS}
                expanded={expandedId === entry.task.id}
                onToggle={onToggle}
                onComplete={onComplete}
                onRemind={onRemind}
                canComplete={view !== "completed" && canChange(entry.task)}
                onOpen={onOpen}
                comments={allDiscussions[entry.task.id] ?? 0}
                onAssign={team ? onAssign : undefined}
                canAssign={canChange(entry.task)}
                assignPending={assigningIds.has(entry.task.id)}
                colleagues={colleagues}
                canLink={canChange(entry.task)}
                keyboard
              />
            ),
          )}
        </RecordList>
      )}
      </KeyboardList>
      {selected && singleKeys && view !== "none" && <KeyStrip completed={view === "completed"} />}
      </div>
      <TaskPanel
        task={panelTask ?? kept}
        open={Boolean(panelTask) && desktop !== null}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
        viewer={viewer}
        members={members}
        tagged={allTagged[(panelTask ?? kept)?.id ?? ""] ?? []}
        admins={admins}
        modal={false}
        dimmed={!beside}
        completed={done.has((panelTask ?? kept)?.id ?? "")}
        onComplete={onPanelComplete}
      />
    </section>
  );
}
