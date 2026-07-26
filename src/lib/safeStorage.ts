// Tiny wrapper around window.localStorage that swallows SecurityError / quota
// exceptions from private-browsing modes, disabled storage, or quota-full
// scenarios. Every call is best-effort — return values fall back to the
// supplied default rather than throwing.
export const safeStorage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
  getJSON<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed as T;
    } catch { return fallback; }
  },
  setJSON(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// Same best-effort contract for sessionStorage — used for per-session UI
// dismissals (banners), where a throwing storage must never break render.
export const safeSessionStorage = {
  getItem(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
  },
  removeItem(key: string): void {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  },
};

