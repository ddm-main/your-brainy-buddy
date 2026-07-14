import { useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn } from "@/components/hud/HudControls";
import { db } from "@/lib/db";
import { useUi } from "@/store/uiStore";

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
}

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const REPORTS = [
  { key: "transactions", label: "Transactions", hint: "full transaction history" },
  { key: "cashflow", label: "Cash Flow Trend", hint: "monthly spend/income/net, last 12 months" },
  { key: "categories", label: "Category Breakdown", hint: "this month's spend by category" },
  { key: "investments", label: "Investment Holdings", hint: "current positions, value, gain/loss" },
  { key: "netWorth", label: "Net Worth Snapshot", hint: "accounts, cards, loans, investments as of today" },
] as const;

// ---------- Reports ----------
// CSV only this round — no PDF export engine (scope-trimmed, CSV covers the
// core need of getting data out for spreadsheets/CAs/backups).
export default function Reports() {
  const push = useUi((s) => s.push);
  const [exporting, setExporting] = useState<string | null>(null);

  const runExport = async (key: string) => {
    setExporting(key);
    try {
      if (key === "transactions") {
        const rows = await db.transactions.list(2000);
        downloadCsv("transactions.csv", rows.map((r: any) => ({
          date: r.txn_date, type: r.txn_type, merchant: r.merchant, category: r.category,
          amount: r.amount, account: r.financial_accounts?.nickname ?? "", card: r.credit_cards?.card_name ?? "",
          payment_mode: r.payment_mode, reference_number: r.reference_number,
        })));
      } else if (key === "cashflow") {
        const rows = await db.transactions.trend(12);
        downloadCsv("cash-flow-trend.csv", rows);
      } else if (key === "categories") {
        const rows = await db.transactions.categorySummary(50);
        downloadCsv("category-breakdown.csv", rows);
      } else if (key === "investments") {
        const rows = await db.investmentHoldings.list();
        downloadCsv("investment-holdings.csv", rows.map((h: any) => ({
          name: h.name, asset_type: h.asset_type, units: h.units, avg_cost: h.avg_cost,
          invested_amount: h.invested_amount, current_price: h.current_price, current_value: h.current_value,
        })));
      } else if (key === "netWorth") {
        const [accounts, cards, loans, invSummary] = await Promise.all([
          db.accounts.list(), db.cards.list(), db.loans.list(), db.investmentHoldings.summary(),
        ]);
        downloadCsv("net-worth-snapshot.csv", [
          ...accounts.map((a: any) => ({ category: "account", name: a.nickname, value: a.current_balance ?? "" })),
          ...cards.map((c: any) => ({ category: "credit card limit", name: c.card_name, value: c.limit_amount ?? "" })),
          ...loans.map((l: any) => ({ category: "loan outstanding", name: l.lender_name, value: l.outstanding_amount ?? "" })),
          { category: "investments", name: "total value", value: invSummary.totalValue },
        ]);
      }
      push("Report downloaded", "ok");
    } catch (e: any) { push(e?.message ?? "export failed", "err"); }
    finally { setExporting(null); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Reports" index="RPT" live="ok" bodyClass="overflow-auto">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
          {REPORTS.map((r) => (
            <div key={r.key} style={{ padding: 12, border: "1px solid var(--edge)" }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 14 }}>{r.label}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, marginBottom: 10 }}>{r.hint}</div>
              <Btn size="sm" onClick={() => runExport(r.key)} disabled={exporting === r.key}>{exporting === r.key ? "exporting…" : "export CSV"}</Btn>
            </div>
          ))}
        </div>
      </HudPanel>
    </div>
  );
}
