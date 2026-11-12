import { create } from "zustand";

type ColleagueMessageState = {
  pending: string | null;
  error: { source: string; message: string } | null;
  start: (source: string) => boolean;
  finish: (error?: { source: string; message: string }) => void;
  dismiss: () => void;
};

export const useColleagueMessage = create<ColleagueMessageState>((set, get) => ({
  pending: null,
  error: null,
  start: (source) => {
    if (get().pending) return false;
    set({ pending: source, error: null });
    return true;
  },
  finish: (error) => set({ pending: null, error: error ?? null }),
  dismiss: () => set({ error: null }),
}));
