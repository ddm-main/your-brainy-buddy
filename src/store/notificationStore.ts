import { create } from "zustand";

export interface NotificationItem {
  id: string;
  text: string;
  at: string;
  read: boolean;
}

const MAX_ITEMS = 20;

interface NotificationStore {
  items: NotificationItem[];
  unreadCount: number;
  add: (text: string) => void;
  markAllRead: () => void;
}

export const useNotifications = create<NotificationStore>((set, get) => ({
  items: [],
  unreadCount: 0,
  add: (text) => {
    const item: NotificationItem = {
      id: Math.random().toString(36).slice(2),
      text,
      at: new Date().toISOString(),
      read: false,
    };
    const items = [item, ...get().items].slice(0, MAX_ITEMS);
    set({ items, unreadCount: items.filter((i) => !i.read).length });
  },
  markAllRead: () => {
    const items = get().items.map((i) => ({ ...i, read: true }));
    set({ items, unreadCount: 0 });
  },
}));
