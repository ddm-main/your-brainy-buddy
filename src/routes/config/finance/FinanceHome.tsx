import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { supabase } from "@/integrations/supabase/client";
import { Wallet, CreditCard, Banknote, Target, Repeat, type LucideIcon } from "lucide-react";

type Card = { to: string; label: string; desc: string; table: string; icon: LucideIcon };

const CARDS: Card[] = [
  { to: "/config/finance/accounts",      label: "Accounts",      desc: "Bank + investment accounts (bank picker included)", table: "financial_accounts", icon: Wallet },
  { to: "/config/finance/cards",         label: "Cards",         desc: "Credit cards, cycles, limits",          table: "credit_cards",       icon: CreditCard },
  { to: "/config/finance/loans",         label: "Loans",         desc: "Personal, home, auto loans",            table: "loans",              icon: Banknote },
  { to: "/config/finance/goals",         label: "Goals",         desc: "Financial targets and progress",        table: "financial_goals",    icon: Target },
  { to: "/config/finance/subscriptions", label: "Subscriptions", desc: "Recurring services and renewals",       table: "subscriptions",      icon: Repeat },
];

export default function FinanceHome() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [errored, setErrored] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // allSettled + per-card try/catch so one denied/erroring table can't
      // wedge every card at "…" with no signal to the user.
      const results = await Promise.allSettled(
        CARDS.map(async (c) => {
          const { count, error } = await supabase.from(c.table as any).select("id", { count: "exact", head: true });
          if (error) throw error;
          return [c.table, count ?? 0] as const;
        }),
      );
      if (cancelled) return;
      const nextCounts: Record<string, number> = {};
      const nextErr: Record<string, boolean> = {};
      results.forEach((r, i) => {
        const t = CARDS[i].table;
        if (r.status === "fulfilled") nextCounts[t] = r.value[1];
        else nextErr[t] = true;
      });
      setCounts(nextCounts);
      setErrored(nextErr);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <HudPanel title="Finance" index="FIN" live="ok" bodyClass="overflow-auto">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
        {CARDS.map((c) => {
          const Icon = c.icon;
          const n = counts[c.table];
          return (
            <NavLink
              key={c.to}
              to={c.to}
              style={{
                display: "flex", flexDirection: "column", gap: 8,
                padding: "14px 14px 12px",
                border: "1px solid var(--edge)",
                background: "rgba(53,214,237,0.03)",
                color: "var(--text)",
                textDecoration: "none",
                transition: "border-color 160ms, background 160ms",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--edge-strong)";
                (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.07)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--edge)";
                (e.currentTarget as HTMLElement).style.background = "rgba(53,214,237,0.03)";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--accent)" }}><Icon size={16} /></span>
                <div className="hud-label" style={{ color: "var(--accent)", fontSize: 11 }}>{c.label}</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: errored[c.table] ? "var(--warn, #e0a458)" : "var(--text-muted)" }}>
                  {errored[c.table] ? "load failed" : n === undefined ? "…" : `${n} ${n === 1 ? "entry" : "entries"}`}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim, var(--text))", lineHeight: 1.4 }}>{c.desc}</div>
            </NavLink>
          );
        })}
      </div>
    </HudPanel>
  );
}
