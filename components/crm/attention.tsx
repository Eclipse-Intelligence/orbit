"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Task } from "@/lib/crm/types";
import type { Notification } from "@/lib/workflows/store";

export type AttentionItem = {
  id: string;
  title: string;
  companyName: string | null;
  companyId: string | null;
  dueAt: string | null;
  overdue: boolean;
};

const AttentionContext = createContext<AttentionItem[]>([]);
const NotificationsContext = createContext<Notification[]>([]);

export function AttentionProvider({
  overdue,
  today,
  notifications = [],
  children,
}: {
  overdue: Task[];
  today: Task[];
  notifications?: Notification[];
  children: ReactNode;
}) {
  const items: AttentionItem[] = [
    ...overdue
      .filter((task) => task.dueAt !== null)
      .map((task) => toItem(task, true)),
    ...today
      .filter(
        (task) =>
          task.dueAt !== null && !overdue.some((item) => item.id === task.id),
      )
      .map((task) => toItem(task, false)),
  ].slice(0, 8);
  return (
    <AttentionContext.Provider value={items}>
      <NotificationsContext.Provider value={notifications}>{children}</NotificationsContext.Provider>
    </AttentionContext.Provider>
  );
}

export function useAttention() {
  return useContext(AttentionContext);
}

export function useNotifications() {
  return useContext(NotificationsContext);
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
