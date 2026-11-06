"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Notification } from "@/lib/workflows/store";

const NotificationsContext = createContext<Notification[]>([]);

export function AttentionProvider({ notifications = [], children }: { notifications?: Notification[]; children: ReactNode }) {
  return <NotificationsContext.Provider value={notifications}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext);
}
