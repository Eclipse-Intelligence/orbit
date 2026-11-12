"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActionTask from "@/components/beautifui/action-task";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import { canChangeTaskAs } from "@/components/crm/task-fields";
import { finePointer, hasOutcome, useTaskOutcome } from "@/components/crm/task-outcome";
import TaskPanel from "@/components/crm/task-panel";
import { useTaskDone } from "@/components/crm/use-task-done";
import type { Viewer } from "@/components/crm/viewer";
import { taskTaggedAction } from "@/app/(crm)/discussions";
import type { TaskOutcome } from "@/lib/crm/task-act";
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
  const { done, message, complete, completeWith, remind } = useTaskDone(tasks);
  const [now] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [kept, setKept] = useState<Task | null>(null);
  const team = useMemo<AssignableMember[]>(() => (members.length > 1 ? members.map((member) => ({ id: member.id, name: member.name })) : NO_MEMBERS), [members]);
  const place = useMemo<TitleHere>(() => ({ kind: here.kind, id: here.id }), [here.kind, here.id]);
  const remaining = tasks.filter((task) => !done.has(task.id));
  const shown = limit ? remaining.slice(0, limit) : remaining;
  const listed = panelId ? (tasks.find((task) => task.id === panelId) ?? null) : null;
  if (listed && listed !== kept) setKept(listed);
  const panelTask = listed ?? (kept && kept.id === panelId ? kept : null);
  const [tagged, setTagged] = useState<{ id: string; people: string[] } | null>(null);
  const openCount = remaining.filter((task) => !task.completedAt).length;

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

  const concluding = useTaskOutcome({ finish, completeWith });
  const outcome = concluding.outcome;

  function leaveOutcome(next: string | null) {
    if (!outcome || outcome.id === next) return;
    const left = tasks.find((task) => task.id === outcome.id);
    if (left) concluding.skip(left);
  }

  function conclude(task: Task, via?: "swipe") {
    if (done.has(task.id)) return;
    if (outcome?.id === task.id) {
      concluding.skip(task);
      return;
    }
    leaveOutcome(task.id);
    if (via !== "swipe" && hasOutcome(task)) {
      concluding.start(task, finePointer());
      setExpandedId(task.id);
      return;
    }
    finish(task);
  }

  function toggle(task: Task) {
    const next = expandedId === task.id ? null : task.id;
    leaveOutcome(next);
    setExpandedId(next);
  }

  const latest = useRef({ finish, conclude, toggle, remind, skip: concluding.skip, save: concluding.save });
  useEffect(() => {
    latest.current = { finish, conclude, toggle, remind, skip: concluding.skip, save: concluding.save };
  });
  const onToggle = useCallback((task: Task) => latest.current.toggle(task), []);
  const onComplete = useCallback((task: Task, via?: "swipe") => latest.current.conclude(task, via), []);
  const onSkip = useCallback((task: Task) => latest.current.skip(task), []);
  const onSaveOutcome = useCallback((task: Task, value: TaskOutcome) => latest.current.save(task, value), []);
  const onRemind = useCallback((task: Task) => latest.current.remind(task), []);
  const onOpen = useCallback((task: Task) => setPanelId(task.id), []);
  const onPanelComplete = useCallback((task: Task) => {
    setPanelId(null);
    latest.current.finish(task);
  }, []);

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
              completed={Boolean(task.completedAt)}
              dueBadge
              now={now}
              viewer={viewer}
              members={team}
              colleagues={team}
              expanded={expandedId === task.id}
              onToggle={onToggle}
              onComplete={onComplete}
              onRemind={onRemind}
              canComplete={canChangeTaskAs(viewer, task) && !task.completedAt}
              onOpen={onOpen}
              canLink={canChangeTaskAs(viewer, task) && !task.completedAt}
              here={place}
              outcome={outcome?.id === task.id ? outcome : null}
              onSkip={onSkip}
              onSaveOutcome={onSaveOutcome}
            />
          ))}
        </ul>
      )}
      <TaskPanel
        task={panelTask ?? kept}
        open={Boolean(panelTask)}
        onOpenChange={(open) => {
          if (!open) setPanelId(null);
        }}
        viewer={viewer}
        members={team}
        tagged={tagged && tagged.id === (panelTask ?? kept)?.id ? tagged.people : []}
        completed={done.has((panelTask ?? kept)?.id ?? "")}
        onComplete={onPanelComplete}
      />
    </>
  );
}
