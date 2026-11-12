"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ActionTask from "@/components/beautifui/action-task";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import TaskPad from "@/components/crm/task-pad";
import TaskPanel from "@/components/crm/task-panel";
import { ConnectionMark, Monogram } from "@/components/beautifui/record-marks";
import { RecordList, RecordRow } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { assignTaskAction, completeTaskAction } from "@/app/(crm)/records";
import { taskWindowAction, type TaskWindow } from "@/app/(crm)/tasks/actions";
import { relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import { TASK_PARAM } from "@/lib/chat/discussions";
import { companyHref } from "@/lib/crm/hrefs";
import { tasksHref } from "@/lib/crm/task-views";
import type { Company, Task, TaskView } from "@/lib/crm/types";

const MAX_WINDOW_PAGES = 20;

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
      .then((result) => {
        if (!cancelled && !("error" in result)) setWindowed({ key, data: result });
      })
      .catch(() => undefined);
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
  const colleagues = members.map((member) => ({ id: member.id, name: member.name }));
  const admin = viewer.role === "owner" || viewer.role === "admin";
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
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
    params.set(TASK_PARAM, id);
    openedHere.current = true;
    window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}${window.location.hash}`);
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

  async function complete(id: string) {
    setDone((current) => new Set(current).add(id));
    setMessage(null);
    const result = await completeTaskAction(id);
    if (result.error) {
      setDone((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setMessage(result.error);
      return;
    }
    router.refresh();
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

  function assigning(task: Task) {
    if (!team) return undefined;
    return {
      members,
      viewerId: viewer.id,
      tagged: allTagged[task.id] ?? [],
      canAssign: admin || task.ownerId === viewer.id || task.createdByUserId === viewer.id,
      pending: assigningIds.has(task.id),
      onAssign: (ownerId: string) => void assign(task.id, ownerId),
    };
  }

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
      <KeyboardList className="flex min-h-0 flex-1 flex-col">
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
        <RecordList count={allTasks.length} empty={who === "tagged" ? "No tasks you're tagged in" : "No tasks"} footer={more}>
          {allTasks.map((task) => (
            <ActionTask
              key={task.id}
              task={task}
              completed={view === "completed" || done.has(task.id)}
              dueBadge={view === "all"}
              now={now}
              onComplete={view === "completed" || (who === "tagged" && !admin && task.createdByUserId !== viewer.id) ? undefined : () => complete(task.id)}
              onOpen={() => openPanel(task.id)}
              comments={allDiscussions[task.id] ?? 0}
              assigning={assigning(task)}
              colleagues={colleagues}
              viewerId={viewer.id}
              canLink={admin || task.ownerId === viewer.id || task.createdByUserId === viewer.id}
            />
          ))}
        </RecordList>
      )}
      </KeyboardList>
      <TaskPanel
        task={panelTask ?? kept}
        open={Boolean(panelTask)}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
        viewer={viewer}
        members={members}
        tagged={allTagged[(panelTask ?? kept)?.id ?? ""] ?? []}
        admins={admins}
      />
    </section>
  );
}
