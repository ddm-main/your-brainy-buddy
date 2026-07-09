const BASE = "/api";

async function req<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return (await res.text()) as unknown as T;
}

export const api = {
  state: () => req<any>("/state"),
  focus: () => req<any>("/focus"),
  toggleFocus: (id: string) =>
    req<any>("/focus/toggle", { method: "POST", body: JSON.stringify({ id }) }),
  addFocus: (title: string) =>
    req<any>("/focus", { method: "POST", body: JSON.stringify({ title }) }),
  inbox: () => req<any>("/inbox"),
  addInbox: (text: string) =>
    req<any>("/inbox", { method: "POST", body: JSON.stringify({ text }) }),
  projects: () => req<any>("/projects"),
  gmailMessages: () => req<any>("/gmail/messages"),
  finance: () => req<any>("/finance"),
  finScan: () => req<any>("/finance/scan", { method: "POST" }),
  jarvis: (text: string) =>
    req<any>("/jarvis", { method: "POST", body: JSON.stringify({ text }) }),
  actions: () => req<any>("/actions"),
  areas: () => req<any>("/areas"),
  memories: () => req<any>("/memories"),
  settings: () => req<any>("/settings"),
};

export function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}
