import { create } from "zustand";

export type ContentCard =
  | {
      id: string;
      type: "news" | "search";
      title: string;
      query: string;
      createdAt: number;
      results: Array<{ title: string; url: string; snippet: string; source: string; publishedAt?: string }>;
    }
  | {
      id: string;
      type: "weather";
      title: string;
      createdAt: number;
      location: string;
      current: { temperature_2m?: number; wind_speed_10m?: number; relative_humidity_2m?: number; weather_code?: number };
      hourly: { time: string[]; temperature: number[]; precipitation_probability: number[] };
    }
  | {
      id: string;
      type: "flight";
      title: string;
      createdAt: number;
      note: string;
      results?: Array<{ title: string; url: string; snippet: string; source: string }>;
    }
  | { id: string; type: "memory"; createdAt: number; topic: string; action: "created" | "updated" }
  | { id: string; type: "reminder"; createdAt: number; text: string; fireAt: string }
  | { id: string; type: "vision"; createdAt: number; kind: "screen" | "camera"; thumbUrl: string; description?: string }
  | { id: string; type: "file"; createdAt: number; filename: string; summary: string }
  | { id: string; type: "error"; createdAt: number; message: string };

interface ContentStore {
  cards: ContentCard[];
  addCard: (card: Omit<ContentCard, "id" | "createdAt"> & Partial<Pick<ContentCard, "id" | "createdAt">>) => string;
  updateCard: (id: string, patch: Partial<ContentCard>) => void;
  clear: () => void;
}

const CAP = 20;
let seq = 0;

export const useContent = create<ContentStore>((set) => ({
  cards: [],
  addCard: (card) => {
    const id = card.id ?? `card_${Date.now()}_${++seq}`;
    const createdAt = card.createdAt ?? Date.now();
    set((s) => {
      const next = [{ ...(card as ContentCard), id, createdAt }, ...s.cards];
      return { cards: next.slice(0, CAP) };
    });
    return id;
  },
  updateCard: (id, patch) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === id ? ({ ...c, ...patch } as ContentCard) : c)),
    })),
  clear: () => set({ cards: [] }),
}));