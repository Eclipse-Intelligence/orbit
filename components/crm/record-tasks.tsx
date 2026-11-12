"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionTask from "@/components/beautifui/action-task";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import { canChangeTaskAs } from "@/components/crm/task-fields";
import { finePointer, hasOutcome, useTaskOutcome, type OutcomeHandlers, type OutcomePlace } from "@/components/crm/task-outcome";
import TaskPanel from "@/components/crm/task-panel";
import { useTaskDone } from "@/components/crm/use-task-done";
import type { Viewer } from "@/components/crm/viewer";
import { taskTaggedAction } from "@/app/(crm)/discussions";
import type { TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";

const NO_MEMBERS: AssignableMember[] = [];

export default function RecordTasks({
  tasks,
  viewer,
  members = NO_MEMBERS,
  here,
  empty = "No tasks",
  limit,
  onCount,
}: {
  tasks: Task[];
  viewer: Viewer;
  members?: { id: string; name: string }[];
  here: TitleHere;
  empty?: string;
  limit?: number;
  onCount?: (count: number) => void;
}) {
  const { done, message, complete, release, settle, abandon, remind } = useTaskDone(tasks);
  const concluding = useTaskOutcome({ done, complete, release, settle, abandon, onClosed: concluded, onFailed: restoreOutcome });
  const outcome = concluding.outcome;
  const [now] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [kept, setKept] = useState<Task | null>(null);
  const team = useMemo<AssignableMember[]>(() => (members.length > 1 ? members.map((member) => ({ id: member.id, name: member.name })) : NO_MEMBERS), [members]);
  const place = useMemo<TitleHere>(() => ({ kind: here.kind, id: here.id }), [here.kind, here.id]);
  const rowOutcome = outcome?.place === "row" ? outcome.task : null;
  const stillListed = tasks.filter((task) => !done.has(task.id) || task.id === rowOutcome?.id);
  const remaining = rowOutcome && !stillListed.some((task) => task.id === rowOutcome.id) ? [rowOutcome, ...stillListed] : stillListed;
  const shown = limit ? remaining.slice(0, limit) : remaining;
  const listed = panelId ? (tasks.find((task) => task.id === panelId) ?? null) : null;
  if (listed && listed !== kept) setKept(listed);
  const panelTask = listed ?? (kept && kept.id === panelId ? kept : null);
  const [tagged, setTagged] = useState<{ id: string; people: string[] } | null>(null);
  const openCount = tasks.filter((task) => !done.has(task.id) && !task.completedAt).length;

  useEffect(() => {
    onCount?.(openCount);
  }, [onCount, openCount]);

  useEffect(() => {
    if (!panelId || members.length < 2) return;
    let cancelled = false;
    void taskTaggedAction(panelId)
      .catch(() => ({ tagged: [] as string[] }))
      .then((result) => {
        if (!cancelled) setTagged({ id: panelId, people: result.tagged ?? [] });
      });
    return () => {
      cancelled = true;
    };
  }, [panelId, members.length, tasks]);

  function finish(task: Task) {
    setExpandedId((current) => (current === task.id ? null : current));
    complete(task);
  }

  function restoreOutcome(task: Task, where: OutcomePlace) {
    if (where === "row") setExpandedId(task.id);
    else setPanelId(task.id);
  }

  function concluded(task: Task, where: OutcomePlace) {
    setExpandedId((current) => (current === task.id ? null : current));
    if (where === "panel") setPanelId((current) => (current === task.id ? null : current));
  }

  function leaveOutcome(next: string | null) {
    if (!outcome || outcome.place !== "row" || outcome.task.id === next) return;
    concluding.leave(outcome.task, true);
  }

  function conclude(task: Task, via?: "swipe") {
    if (concluding.saving === task.id) return;
    if (outcome?.task.id === task.id) {
      concluding.leave(task);
      return;
    }
    if (done.has(task.id)) return;
    if (via !== "swipe" && hasOutcome(task)) {
      concluding.start(task, finePointer(), "row");
      setExpandedId(task.id);
      return;
    }
    if (outcome) concluding.leave(outcome.task, true);
    finish(task);
  }

  function concludeFromPanel(task: Task) {
    if (concluding.saving === task.id || done.has(task.id)) return;
    if (hasOutcome(task)) {
      setExpandedId((current) => (current === task.id ? null : current));
      concluding.start(task, finePointer(), "panel");
      return;
    }
    if (outcome) concluding.leave(outcome.task, true);
    setPanelId(null);
    finish(task);
  }

  function closePanel() {
    if (outcome?.place === "panel" && outcome.task.id === panelId) concluding.leave(outcome.task, true);
    setPanelId(null);
  }

  function toggle(task: Task) {
    const next = expandedId === task.id ? null : task.id;
    leaveOutcome(next);
    setExpandedId(next);
  }

  const latest = useRef({ conclude, concludeFromPanel, toggle, remind, concluding });
  useEffect(() => {
    latest.current = { conclude, concludeFromPanel, toggle, remind, concluding };
  });
  const onToggle = useCallback((task: Task) => latest.current.toggle(task), []);
  const onComplete = useCallback((task: Task, via?: "swipe") => latest.current.conclude(task, via), []);
  const outcomeHandlers = useMemo<OutcomeHandlers>(
    () => ({
      skip: (task) => latest.current.concluding.skip(task),
      save: (task) => latest.current.concluding.save(task),
      leave: (task, quiet) => latest.current.concluding.leave(task, quiet),
    }),
    [],
  );
  const onRemind = useCallback((task: Task) => latest.current.remind(task), []);
  const onOpen = useCallback((task: Task) => setPanelId(task.id), []);
  const onPanelComplete = useCallback((task: Task) => latest.current.concludeFromPanel(task), []);
  const panelShown = panelTask ?? kept;
  const panelOutcome = outcome?.place === "panel" && outcome.task.id === panelShown?.id ? { focus: outcome.focus, saving: concluding.saving === outcome.task.id, outcomeId: outcome.outcomeId } : null;

  return (
    <>
      {message && (
        <p role="alert" className="caption-style text-danger">
          {message}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="caption-style text-subtle">{empty}</p>
      ) : (
        <ul className="-mx-2.5 flex flex-col [&>li:last-child]:border-b-0">
          {shown.map((task) => (
            <ActionTask
              key={task.id}
              task={task}
              completed={Boolean(task.completedAt) || done.has(task.id)}
              dueBadge
              now={now}
              viewer={viewer}
              members={team}
              colleagues={team}
              expanded={expandedId === task.id || rowOutcome?.id === task.id}
              onToggle={onToggle}
              onComplete={onComplete}
              onRemind={onRemind}
              canComplete={canChangeTaskAs(viewer, task) && !task.completedAt}
              onOpen={onOpen}
              canLink={canChangeTaskAs(viewer, task) && !task.completedAt}
              here={place}
              outcome={outcome?.place === "row" && outcome.task.id === task.id ? { focus: outcome.focus, saving: concluding.saving === task.id, outcomeId: outcome.outcomeId } : null}
              outcomeHandlers={outcomeHandlers}
            />
          ))}
        </ul>
      )}
      <TaskPanel
        task={panelTask ?? kept}
        open={Boolean(panelTask)}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
        viewer={viewer}
        members={team}
        tagged={tagged && tagged.id === (panelTask ?? kept)?.id ? tagged.people : []}
        completed={done.has((panelTask ?? kept)?.id ?? "")}
        onComplete={onPanelComplete}
        outcome={panelOutcome}
        outcomeHandlers={outcomeHandlers}
      />
    </>
  );
}
