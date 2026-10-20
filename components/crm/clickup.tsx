"use client";

import type { ClickUpListChoice } from "@/lib/clickup";

import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import ClickUpIcon from "@/public/assets/images/_common/clickup.svg";

export function listGroups(lists: ClickUpListChoice[]) {
  const groups = new Map<string, ClickUpListChoice[]>();
  for (const list of lists) {
    const label = list.folderName ? `${list.spaceName} › ${list.folderName}` : list.spaceName || "Lists";
    groups.set(label, [...(groups.get(label) ?? []), list]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, lists: items }));
}

export function ClickUpListOptions({ lists }: { lists: ClickUpListChoice[] }) {
  return listGroups(lists).map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.lists.map((list) => (
        <option key={list.id} value={list.id}>
          {list.name}
        </option>
      ))}
    </optgroup>
  ));
}

export function ClickUpBadge({ task, className }: { task: Task; className?: string }) {
  const base = cn(
    "bg-secondary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[12px] leading-5",
    className,
  );
  if (task.clickupUrl) {
    return (
      <a
        href={task.clickupUrl}
        target="_blank"
        rel="noreferrer"
        title={task.clickupError ?? "Open in ClickUp"}
        className={cn(base, task.clickupError ? "text-danger" : "text-soft hover:text-foreground")}
      >
        <ClickUpIcon aria-hidden className="size-3" />
        ClickUp
      </a>
    );
  }
  if (!task.clickupListId) return null;
  return (
    <span title={task.clickupError ?? "Waiting to reach ClickUp"} className={cn(base, task.clickupError ? "text-danger" : "text-subtle")}>
      <ClickUpIcon aria-hidden className="size-3" />
      {task.clickupError ? "ClickUp failed" : "ClickUp pending"}
    </span>
  );
}
