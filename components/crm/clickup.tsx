"use client";

import { recordSelectClass } from "@/components/crm/record-form";
import type { ClickUpListChoice } from "@/lib/clickup";
import type { ClickUpPicker } from "@/lib/crm/clickup";
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

export function ClickUpPickerField({
  picker,
  id,
  checked,
  onCheckedChange,
  listId,
  onListChange,
  className,
}: {
  picker: ClickUpPicker;
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  listId: string;
  onListChange: (listId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      <label className="caption-style text-soft flex shrink-0 items-center gap-2" htmlFor={`${id}-on`}>
        <input
          id={`${id}-on`}
          type="checkbox"
          name="clickup"
          checked={checked}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        Add to ClickUp
      </label>
      {checked && (
        <select
          aria-label="ClickUp list"
          name="clickupListId"
          value={listId}
          onChange={(event) => onListChange(event.target.value)}
          className={cn(recordSelectClass, "h-8 w-auto max-w-[18em] min-w-0 flex-1 text-[13px]")}
        >
          <ClickUpListOptions lists={picker.lists} />
        </select>
      )}
    </div>
  );
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
