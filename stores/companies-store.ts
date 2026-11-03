import { create } from "zustand";

type CaptureBadge = { waiting: number; fresh: number; newestAt: string | null };

type CompaniesState = {
  profileOpen: boolean;
  sidebarOpen: boolean;
  mailUnread: number | null;
  capture: CaptureBadge | null;
  captureSeen: string | null;
  openProfile: () => void;
  closeProfile: () => void;
  setSidebarOpen: (open: boolean) => void;
  setMailUnread: (count: number) => void;
  setCapture: (capture: CaptureBadge | null) => void;
  setCaptureSeen: (newestAt: string | null) => void;
};

export function captureHasNew(capture: CaptureBadge | null, seen: string | null) {
  if (!capture || capture.fresh === 0) return false;
  return !seen || !capture.newestAt || capture.newestAt > seen;
}

export const useCompaniesStore = create<CompaniesState>((set) => ({
  profileOpen: false,
  sidebarOpen: false,
  mailUnread: null,
  capture: null,
  captureSeen: null,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMailUnread: (mailUnread) => set({ mailUnread }),
  setCapture: (capture) => set({ capture }),
  setCaptureSeen: (captureSeen) => set({ captureSeen: captureSeen ?? new Date().toISOString() }),
}));
