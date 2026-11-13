import { create } from "zustand";
import type { TaskPreparation } from "@/lib/crm/task-preparation";

export type PreparationEntry = { preparation: TaskPreparation | null; loaded: boolean; pending: boolean; error: string | null; settledAt: number };

const EMPTY: PreparationEntry = { preparation: null, loaded: false, pending: false, error: null, settledAt: 0 };

type PreparationState = {
  entries: Record<string, PreparationEntry>;
  loaded: (taskId: string, preparation: TaskPreparation | null, requestedAt: number) => void;
  start: (taskId: string) => boolean;
  finish: (taskId: string, result: { preparation?: TaskPreparation; error?: string }) => void;
};

export const useTaskPreparations = create<PreparationState>((set, get) => ({
  entries: {},
  loaded: (taskId, preparation, requestedAt) => {
    const entry = get().entries[taskId] ?? EMPTY;
    if (entry.pending || entry.settledAt > requestedAt) {
      if (!entry.loaded) set({ entries: { ...get().entries, [taskId]: { ...entry, loaded: true } } });
      return;
    }
    set({ entries: { ...get().entries, [taskId]: { ...entry, preparation, loaded: true } } });
  },
  start: (taskId) => {
    const entry = get().entries[taskId] ?? EMPTY;
    if (entry.pending) return false;
    set({ entries: { ...get().entries, [taskId]: { ...entry, pending: true, error: null } } });
    return true;
  },
  finish: (taskId, result) => {
    const entry = get().entries[taskId] ?? EMPTY;
    set({
      entries: {
        ...get().entries,
        [taskId]: {
          ...entry,
          pending: false,
          loaded: true,
          preparation: result.preparation ?? entry.preparation,
          error: result.preparation ? null : (result.error ?? "Couldn't prepare it. Try again."),
          settledAt: Date.now(),
        },
      },
    });
  },
}));

export function preparationEntry(entries: Record<string, PreparationEntry>, taskId: string) {
  return entries[taskId] ?? EMPTY;
}
