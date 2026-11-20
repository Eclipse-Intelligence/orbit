import { create } from "zustand";
import type { ChatMessage } from "@/lib/chat/types";

type ChatShareState = {
  message: ChatMessage | null;
  open: (message: ChatMessage) => void;
  close: () => void;
};

export const useChatShare = create<ChatShareState>((set) => ({
  message: null,
  open: (message) => set({ message }),
  close: () => set({ message: null }),
}));
