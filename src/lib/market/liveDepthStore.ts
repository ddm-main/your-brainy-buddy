// Push order-book state, fed by the Kotak WS relay (Apps/relay/kotak-ws-relay.mjs).
//
// WHY: the A2 Market Depth panel used to poll the `market-depth` edge function
// once a second while open — 3,600 invocations/hour per chart, for data Kotak
// already streams on the socket the relay is holding. When the relay is
// running and pushing a book for the symbol on screen, the REST poll is pure
// waste. This store is the push side; `useDepth` in hooks.ts backs its polling
// right off whenever a fresh pushed book exists.
import { create } from "zustand";

export interface DepthLevel { price: number; qty: number; orders: number }
export interface LiveDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
  ltp: number | null;
  receivedAt: number;
}

interface LiveDepthState {
  books: Record<string, LiveDepth>;
  applyDepth: (key: string, book: Omit<LiveDepth, "receivedAt">) => void;
}

export const useLiveDepthStore = create<LiveDepthState>((set) => ({
  books: {},
  applyDepth: (key, book) =>
    set((s) => ({ books: { ...s.books, [key]: { ...book, receivedAt: Date.now() } } })),
}));

// A book older than this is stale — the relay pushes on every change, and an
// active instrument changes constantly, so 6s of silence means either the
// relay died or the symbol is untraded. Either way, let REST take over.
export const DEPTH_FRESH_MS = 6_000;

export function isFreshDepth(d: LiveDepth | undefined): d is LiveDepth {
  return !!d && Date.now() - d.receivedAt < DEPTH_FRESH_MS;
}

/** Live book for one symbol, or undefined when nothing fresh has been pushed. */
export function useLiveDepth(key: string | null | undefined): LiveDepth | undefined {
  const book = useLiveDepthStore((s) => (key ? s.books[key] : undefined));
  return isFreshDepth(book) ? book : undefined;
}
