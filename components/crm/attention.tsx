"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Task } from "@/lib/crm/types";

export type AttentionItem = {
  id: string;
  title: string;
  companyName: string | null;
  companyId: string | null;
  dueAt: string | null;
  overdue: boolean;
};

const AttentionContext = createContext<AttentionItem[]>([]);

export function AttentionProvider({
  overdue,
  today,
  children,
}: {
  overdue: Task[];
  today: Task[];
  children: ReactNode;
}) {
  const items: AttentionItem[] = [
    ...overdue.map((task) => toItem(task, true)),
    ...today
      .filter((task) => !overdue.some((item) => item.id === task.id))
      .map((task) => toItem(task, false)),
  ].slice(0, 8);
  return <AttentionContext.Provider value={items}>{children}</AttentionContext.Provider>;
}

export function useAttention() {
  return useContext(AttentionContext);
}

function toItem(task: Task, overdue: boolean): AttentionItem {
  return {
    id: task.id,
    title: task.title,
    companyName: task.companyName,
    companyId: task.companyId,
    dueAt: task.dueAt,
    overdue,
  };
}
