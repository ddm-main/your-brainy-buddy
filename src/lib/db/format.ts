// Small display helpers used by HUD widgets.

export function inr(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return "₹ " + v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
