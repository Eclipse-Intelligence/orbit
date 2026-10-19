import { create } from "zustand";

type CompaniesState = {
  profileOpen: boolean;
  sidebarOpen: boolean;
  mailUnread: number | null;
  openProfile: () => void;
  closeProfile: () => void;
  setSidebarOpen: (open: boolean) => void;
  setMailUnread: (count: number) => void;
};

export const useCompaniesStore = create<CompaniesState>((set) => ({
  profileOpen: false,
  sidebarOpen: false,
  mailUnread: null,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMailUnread: (mailUnread) => set({ mailUnread }),
}));
