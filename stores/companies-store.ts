import { create } from "zustand";
import type { ChatSidebar } from "@/lib/chat/types";

export const CAPTURE_SECTIONS = ["approvals", "followUps", "replies", "toFile"] as const;

export type CaptureSectionId = (typeof CAPTURE_SECTIONS)[number];

export type CaptureCounts = Record<CaptureSectionId, number>;

export type CaptureBadge = { waiting: number; fresh: number; newestAt: string | null; sections: CaptureCounts };

export const NO_CAPTURE_COUNTS: CaptureCounts = { approvals: 0, followUps: 0, replies: 0, toFile: 0 };

type CompaniesState = {
  profileOpen: boolean;
  sidebarOpen: boolean;
  mailUnread: number | null;
  campaignsWaiting: number | null;
  chat: ChatSidebar | null;
  capture: CaptureBadge | null;
  captureCleared: CaptureCounts;
  captureLive: boolean;
  captureSeen: string | null;
  remindersOpen: boolean;
  remindersAsked: number;
  remindersFocus: boolean;
  remindersDue: number | null;
  openReminders: (focus?: boolean) => void;
  setRemindersOpen: (open: boolean) => void;
  setRemindersDue: (count: number) => void;
  openProfile: () => void;
  closeProfile: () => void;
  setSidebarOpen: (open: boolean) => void;
  setMailUnread: (count: number) => void;
  setCampaignsWaiting: (count: number) => void;
  setChat: (chat: ChatSidebar | ((current: ChatSidebar | null) => ChatSidebar | null)) => void;
  setCapture: (capture: CaptureBadge | null) => void;
  setCaptureCleared: (cleared: CaptureCounts) => void;
  setCaptureLive: (live: boolean) => void;
  setCaptureSeen: (newestAt: string | null) => void;
};

export function captureHasNew(capture: CaptureBadge | null, seen: string | null) {
  if (!capture || capture.fresh === 0) return false;
  return !seen || !capture.newestAt || capture.newestAt > seen;
}

export function captureLeft(capture: CaptureBadge | null, cleared: CaptureCounts) {
  const sections = Object.fromEntries(
    CAPTURE_SECTIONS.map((id) => [id, Math.max(0, (capture?.sections[id] ?? 0) - cleared[id])]),
  ) as CaptureCounts;
  return { total: CAPTURE_SECTIONS.reduce((sum, id) => sum + sections[id], 0), sections };
}

export const useCompaniesStore = create<CompaniesState>((set) => ({
  profileOpen: false,
  sidebarOpen: false,
  mailUnread: null,
  campaignsWaiting: null,
  chat: null,
  capture: null,
  captureCleared: NO_CAPTURE_COUNTS,
  captureLive: false,
  captureSeen: null,
  remindersOpen: false,
  remindersAsked: 0,
  remindersFocus: false,
  remindersDue: null,
  openReminders: (focus = true) => set((state) => ({ remindersOpen: true, remindersAsked: state.remindersAsked + 1, remindersFocus: focus })),
  setRemindersOpen: (remindersOpen) => set({ remindersOpen }),
  setRemindersDue: (remindersDue) => set({ remindersDue }),
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMailUnread: (mailUnread) => set({ mailUnread }),
  setCampaignsWaiting: (campaignsWaiting) => set({ campaignsWaiting }),
  setChat: (chat) => set((state) => ({ chat: typeof chat === "function" ? chat(state.chat) : chat })),
  setCapture: (capture) => set((state) => (state.captureLive ? { capture } : { capture, captureCleared: NO_CAPTURE_COUNTS })),
  setCaptureCleared: (captureCleared) => set({ captureCleared }),
  setCaptureLive: (captureLive) => set({ captureLive }),
  setCaptureSeen: (captureSeen) => set({ captureSeen: captureSeen ?? new Date().toISOString() }),
}));
