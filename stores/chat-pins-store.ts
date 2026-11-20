import { create } from "zustand";
import { chatApi } from "@/lib/chat/client";
import type { ChatMessage, ChatPerson, ChatPin } from "@/lib/chat/types";

type ChatPinsState = {
  rooms: Record<string, ChatPin[] | undefined>;
  failed: Record<string, string | undefined>;
  load: (conversationId: string, options?: { force?: boolean }) => void;
  add: (message: ChatMessage, by: ChatPerson) => void;
  remove: (conversationId: string, messageId: string) => void;
  edit: (message: ChatMessage) => void;
  forget: (conversationId: string) => void;
};

const running = new Map<string, { again: boolean }>();

export const useChatPins = create<ChatPinsState>((set, get) => ({
  rooms: {},
  failed: {},
  load: (conversationId, options = {}) => {
    const active = running.get(conversationId);
    if (active) {
      if (options.force) active.again = true;
      return;
    }
    if (get().rooms[conversationId] && !options.force) return;
    const state = { again: false };
    running.set(conversationId, state);
    chatApi
      .pins(conversationId)
      .then((result) => set((current) => ({ rooms: { ...current.rooms, [conversationId]: result.pins }, failed: { ...current.failed, [conversationId]: undefined } })))
      .catch((error: Error) => set((current) => ({ failed: { ...current.failed, [conversationId]: error.message } })))
      .finally(() => {
        running.delete(conversationId);
        if (state.again) get().load(conversationId, { force: true });
      });
  },
  add: (message, by) =>
    set((current) => {
      const pins = current.rooms[message.conversationId];
      if (!pins || pins.some((pin) => pin.message.id === message.id)) return current;
      return { rooms: { ...current.rooms, [message.conversationId]: [{ message, pinnedBy: by }, ...pins] } };
    }),
  remove: (conversationId, messageId) =>
    set((current) => {
      const pins = current.rooms[conversationId];
      if (!pins?.some((pin) => pin.message.id === messageId)) return current;
      return { rooms: { ...current.rooms, [conversationId]: pins.filter((pin) => pin.message.id !== messageId) } };
    }),
  edit: (message) =>
    set((current) => {
      const pins = current.rooms[message.conversationId];
      if (!pins?.some((pin) => pin.message.id === message.id)) return current;
      return { rooms: { ...current.rooms, [message.conversationId]: pins.map((pin) => (pin.message.id === message.id ? { ...pin, message } : pin)) } };
    }),
  forget: (conversationId) =>
    set((current) => {
      const rooms = { ...current.rooms };
      delete rooms[conversationId];
      return { rooms };
    }),
}));
