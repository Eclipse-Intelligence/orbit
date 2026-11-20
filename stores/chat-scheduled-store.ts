import { create } from "zustand";
import { chatApi } from "@/lib/chat/client";
import type { ChatScheduledItem } from "@/lib/chat/types";

type ChatScheduledState = {
  items: ChatScheduledItem[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  generation: number;
  load: (options?: { force?: boolean }) => void;
  upsert: (item: ChatScheduledItem) => void;
  remove: (id: string) => void;
};

function byTime(items: ChatScheduledItem[]) {
  return [...items].sort((left, right) => left.sendAt.localeCompare(right.sendAt) || left.id.localeCompare(right.id));
}

export const useChatScheduled = create<ChatScheduledState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  generation: 0,
  load: (options) => {
    const { loaded, loading } = get();
    if (loading || (loaded && !options?.force)) return;
    const started = get().generation;
    set({ loading: true });
    chatApi
      .scheduled()
      .then((result) => {
        if (get().generation !== started) {
          set({ loading: false });
          get().load({ force: true });
          return;
        }
        set({ items: byTime(result.items), loaded: true, loading: false, error: null });
      })
      .catch((failure: Error) => set({ loading: false, error: failure.message }));
  },
  upsert: (item) =>
    set((state) => ({
      items: byTime([...state.items.filter((known) => known.id !== item.id), item]),
      generation: state.generation + 1,
    })),
  remove: (id) =>
    set((state) => ({
      items: state.items.filter((known) => known.id !== id),
      generation: state.generation + 1,
    })),
}));
