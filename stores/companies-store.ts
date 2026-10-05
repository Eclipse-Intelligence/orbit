import { create } from "zustand";
import type { Company } from "@/lib/crm/types";

type CompaniesState = {
  selectedIds: string[];
  detailId: string | null;
  detailCompany: Company | null;
  detailOpen: boolean;
  profileOpen: boolean;
  newCompanyOpen: boolean;
  sidebarOpen: boolean;
  searchOpen: boolean;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  openDetail: (id: string) => void;
  openCompany: (company: Company) => void;
  closeDetail: () => void;
  openProfile: () => void;
  closeProfile: () => void;
  setNewCompanyOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
};

export const useCompaniesStore = create<CompaniesState>((set) => ({
  selectedIds: [],
  detailId: null,
  detailCompany: null,
  detailOpen: false,
  profileOpen: false,
  newCompanyOpen: false,
  sidebarOpen: false,
  searchOpen: false,
  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((selected) => selected !== id)
        : [...state.selectedIds, id],
    })),
  setSelected: (selectedIds) => set({ selectedIds }),
  openDetail: (detailId) =>
    set({
      detailId,
      detailOpen: true,
      profileOpen: false,
      detailCompany: null,
    }),
  openCompany: (company) =>
    set({
      detailId: company.id,
      detailCompany: company,
      detailOpen: true,
      profileOpen: false,
    }),
  closeDetail: () => set({ detailOpen: false }),
  openProfile: () => set({ profileOpen: true, detailOpen: false }),
  closeProfile: () => set({ profileOpen: false }),
  setNewCompanyOpen: (newCompanyOpen) => set({ newCompanyOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}));
