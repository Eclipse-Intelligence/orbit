"use client";

import { useEffect, useState } from "react";
import ActionTask from "@/components/beautifui/action-task";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import { canChangeTaskAs } from "@/components/crm/task-fields";
import TaskPanel from "@/components/crm/task-panel";
import { useTaskDone } from "@/components/crm/use-task-done";
import type { Viewer } from "@/components/crm/viewer";
import { taskTaggedAction } from "@/app/(crm)/discussions";
import type { TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";

export default function RecordTasks({
  tasks,
  viewer,
  members = [],
  here,
  empty = "No tasks",
}: {
  tasks: Task[];
  viewer: Viewer;
  members?: { id: string; name: string }[];
  here: TitleHere;
  empty?: string;
}) {
  const { done, message, complete, remind } = useTaskDone();
  const [now] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [kept, setKept] = useState<Task | null>(null);
  const team: AssignableMember[] = members.length > 1 ? members.map((member) => ({ id: member.id, name: member.name })) : [];
  const shown = tasks.filter((task) => !done.has(task.id));
  const listed = panelId ? (tasks.find((task) => task.id === panelId) ?? null) : null;
  if (listed && listed !== kept) setKept(listed);
  const panelTask = listed ?? (kept && kept.id === panelId ? kept : null);
  const [tagged, setTagged] = useState<{ id: string; people: string[] } | null>(null);

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
          {shown.map((task) => {
            const canChange = canChangeTaskAs(viewer, task) && !task.completedAt;
            return (
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
                onToggle={() => setExpandedId((current) => (current === task.id ? null : task.id))}
                onComplete={canChange ? () => finish(task) : undefined}
                onRemind={canChange ? () => remind(task) : undefined}
                onOpen={() => setPanelId(task.id)}
                canLink={canChange}
                here={here}
              />
            );
          })}
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
        onComplete={(task) => finish(task)}
      />
    </>
  );
}
