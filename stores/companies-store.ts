import { create } from "zustand";

type CompaniesState = {
  profileOpen: boolean;
  newCompanyOpen: boolean;
  sidebarOpen: boolean;
  openProfile: () => void;
  closeProfile: () => void;
  setNewCompanyOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
};

export const useCompaniesStore = create<CompaniesState>((set) => ({
  profileOpen: false,
  newCompanyOpen: false,
  sidebarOpen: false,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setNewCompanyOpen: (newCompanyOpen) => set({ newCompanyOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
