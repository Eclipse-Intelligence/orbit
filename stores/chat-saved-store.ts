import { create } from "zustand";
import { chatApi } from "@/lib/chat/client";

type ChatSavedState = {
  ids: Set<string>;
  loaded: boolean;
  loading: boolean;
  changed: Map<string, boolean>;
  load: () => void;
  mark: (messageId: string, saved: boolean) => void;
};

export const useChatSaved = create<ChatSavedState>((set, get) => ({
  ids: new Set(),
  loaded: false,
  loading: false,
  changed: new Map(),
  load: () => {
    const { loaded, loading } = get();
    if (loading || loaded) return;
    set({ loading: true, changed: new Map() });
    chatApi
      .savedIds()
      .then((result) => {
        const ids = new Set(result.ids);
        for (const [id, saved] of get().changed) {
          if (saved) ids.add(id);
          else ids.delete(id);
        }
        set({ ids, loaded: true, loading: false, changed: new Map() });
      })
      .catch(() => set({ loading: false, changed: new Map() }));
  },
  mark: (messageId, saved) => {
    const { ids, loading, changed } = get();
    const next = new Set(ids);
    if (saved) next.add(messageId);
    else next.delete(messageId);
    set({ ids: next, changed: loading ? new Map(changed).set(messageId, saved) : changed });
  },
}));
