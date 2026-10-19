import { create } from "zustand";

type CompaniesState = {
  profileOpen: boolean;
  sidebarOpen: boolean;
  openProfile: () => void;
  closeProfile: () => void;
  setSidebarOpen: (open: boolean) => void;
};

export const useCompaniesStore = create<CompaniesState>((set) => ({
  profileOpen: false,
  sidebarOpen: false,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
