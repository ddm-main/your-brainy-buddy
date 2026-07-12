import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { calcGainLoss, calcAllocation } from "@/lib/investmentCalc";
import { HudDonutChart } from "@/components/hud/HudChart";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { parseGrowwHoldings, parseGrowwSummary, type StagedGrowwHolding, type GrowwPortfolioSummary } from "@/lib/growwImport";

const GROWW_MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function growwToIsoDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m) { const mon = GROWW_MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`; }
  return null;
}
function growwOrderType(raw: string): "buy" | "sip" | "sell" | "dividend" | null {
  const s = (raw || "").trim().toLowerCase();
  if (/sip/.test(s)) return "sip";
  if (/purchase|buy|lumpsum/.test(s)) return "buy";
  if (/redeem|sell/.test(s)) return "sell";
  if (/dividend|idcw/.test(s)) return "dividend";
  return null;
}
// Groww's real export (confirmed 2026-07-12) is an .xlsx portfolio
// SNAPSHOT — see src/lib/growwImport.ts — not a transaction statement. That
// parser is the primary/validated path below. The CSV/PDF transaction-
// ledger parsers here are kept as a fallback for if a real transaction
// statement export ever shows up, but remain unverified against a sample —
// CSV parsing happens client-side via papaparse (handles quoted commas a
// hand-rolled split(",") gets wrong); PDF goes through the edge function
// since text extraction requires pdfjs-dist server-side.
function parseGrowwCsvClientSide(csvText: string): any[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
  const staged: any[] = [];
  for (const row of parsed.data) {
    const keys = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
    const txn_type = growwOrderType(keys["order type"] ?? keys["type"] ?? keys["transaction type"] ?? "");
    if (!txn_type) continue;
    const schemeName = (keys["scheme name"] ?? keys["scheme"] ?? keys["fund name"] ?? keys["name"] ?? "").trim();
    if (!schemeName) continue;
    staged.push({
      scheme_name: schemeName.slice(0, 200),
      folio_or_demat_number: (keys["folio"] ?? keys["folio no"] ?? keys["folio number"] ?? "").trim() || null,
      txn_type,
      txn_date: growwToIsoDate(keys["date"] ?? keys["order date"] ?? keys["txn date"] ?? keys["transaction date"]),
      amount: Number((keys["amount"] ?? keys["invested amount"] ?? "").replace(/,/g, "")) || null,
      price: Number((keys["nav"] ?? keys["price"] ?? "").replace(/,/g, "")) || null,
      units: Number((keys["units"] ?? "").replace(/,/g, "")) || null,
      confidence: "high",
      source: "groww_csv",
    });
  }
  return staged;
}

const PRIMARY_TYPES = [{ value: "mutual_fund", label: "mutual fund" }, { value: "stock", label: "stock" }];
const OPTIONAL_TYPES = [
  { value: "etf", label: "ETF" }, { value: "gold", label: "gold" }, { value: "ppf", label: "PPF" },
  { value: "epf", label: "EPF" }, { value: "nps", label: "NPS" }, { value: "fd", label: "FD" },
  { value: "bonds", label: "bonds" }, { value: "real_estate", label: "real estate" }, { value: "crypto", label: "crypto" },
];
const ALL_TYPES = [...PRIMARY_TYPES, ...OPTIONAL_TYPES];

// ---------- Investments ----------
// Settings toggle for optional asset-type visibility lives inline here
// (bottom of the panel) rather than a dedicated /finance/settings route —
// this is the only setting in the whole app so far.
export default function Investments() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [enabledTypes, setEnabledTypes] = useState<string[]>(["mutual_fund", "stock"]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [draft, setDraft] = useState<any>({ asset_type: "mutual_fund", name: "", symbol_or_scheme_code: "", units: "", avg_cost: "", current_price: "" });
  const [staged, setStaged] = useState<
    | { kind: "holdings"; rows: StagedGrowwHolding[]; summary: GrowwPortfolioSummary | null }
    | { kind: "transactions"; rows: any[] }
    | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const settings = await db.financeSettings.get();
    const types: string[] = settings.enabled_asset_types ?? ["mutual_fund", "stock"];
    setEnabledTypes(types);
    setItems(await db.investmentHoldings.list({ assetTypes: types }));
  };
  useEffect(() => { load(); }, []);

  const toggleType = async (type: string, on: boolean) => {
    const next = on ? [...new Set([...enabledTypes, type])] : enabledTypes.filter((t) => t !== type);
    setEnabledTypes(next);
    try { await db.financeSettings.setEnabledAssetTypes(next); load(); }
    catch (e: any) { push(e?.message ?? "failed to save setting", "err"); }
  };

  const addHolding = async () => {
    if (!draft.name?.trim()) return;
    setAdding(true);
    try {
      const units = draft.units ? Number(draft.units) : null;
      const avgCost = draft.avg_cost ? Number(draft.avg_cost) : null;
      const currentPrice = draft.current_price ? Number(draft.current_price) : null;
      await db.investmentHoldings.create({
        asset_type: draft.asset_type, name: draft.name.trim(),
        symbol_or_scheme_code: draft.symbol_or_scheme_code || null,
        units, avg_cost: avgCost,
        invested_amount: units && avgCost ? units * avgCost : null,
        current_price: currentPrice,
        current_price_source: currentPrice ? "manual" : null,
        current_price_updated_at: currentPrice ? new Date().toISOString() : null,
        current_value: units && currentPrice ? units * currentPrice : null,
      });
      push("Holding added", "ok");
      setDraft({ asset_type: "mutual_fund", name: "", symbol_or_scheme_code: "", units: "", avg_cost: "", current_price: "" });
      setShowAdd(false);
      load();
    } catch (e: any) { push(e?.message ?? "failed to add holding", "err"); }
    finally { setAdding(false); }
  };

  const syncNav = async () => {
    setSyncing(true);
    try {
      const j = await db.navSync.sync();
      push(`Synced ${j.schemesSynced ?? 0} schemes · repriced ${j.holdingsRepriced ?? 0} holdings`, "ok");
      load();
    } catch (e: any) { push(e?.message ?? "NAV sync failed", "err"); }
    finally { setSyncing(false); }
  };

  const handleGrowwFile = async (file: File) => {
    setImporting(true);
    setStaged(null);
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
        const holdings = parseGrowwHoldings(rows);
        const summary = parseGrowwSummary(rows);
        if (holdings.length === 0) { push("Could not find a holdings table in that file — expected a 'HOLDINGS AS ON ...' section with Scheme Name/AMC columns", "err"); return; }
        setStaged({ kind: "holdings", rows: holdings, summary });
      } else if (name.endsWith(".csv")) {
        const text = await file.text();
        const rows = parseGrowwCsvClientSide(text);
        if (rows.length === 0) push("No recognizable transaction rows found in that CSV", "warn");
        setStaged({ kind: "transactions", rows });
      } else {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const bytesBase64 = btoa(binary);
        const j = await db.growwImport.parse({ filename: file.name, bytesBase64 });
        if (!j.ok) { push(`Could not read that PDF: ${j.error ?? "unknown error"}`, "err"); return; }
        if ((j.staged ?? []).length === 0) push("No recognizable transaction rows found — this PDF parser hasn't been tested against a real Groww export yet, try the .xlsx portfolio export instead", "warn");
        setStaged({ kind: "transactions", rows: (j.staged ?? []).map((r: any) => ({ ...r, source: "groww_pdf" })) });
      }
    } catch (e: any) { push(e?.message ?? "import failed", "err"); }
    finally { setImporting(false); }
  };

  // Holdings-snapshot import: one investment_holdings row per staged row,
  // matched to an existing holding by name (case-insensitive) so re-
  // importing an updated export updates rather than duplicates. No
  // transactions are created — see growwImport.ts's header comment.
  const confirmHoldingsImport = async (rows: StagedGrowwHolding[]) => {
    setConfirming(true);
    try {
      let created = 0, updated = 0;
      for (const row of rows) {
        const units = row.units;
        const investedAmount = row.investedValue;
        const currentValue = row.currentValue;
        const avgCost = units && investedAmount ? investedAmount / units : null;
        const currentPrice = units && currentValue ? currentValue / units : null;
        const patch = {
          units, invested_amount: investedAmount, current_value: currentValue,
          avg_cost: avgCost, current_price: currentPrice,
          current_price_source: "manual" as const, current_price_updated_at: new Date().toISOString(),
          folio_or_demat_number: row.folio, category: row.category,
          notes: [row.subCategory, row.amc, row.source ? `Source: ${row.source}` : null].filter(Boolean).join(" · ") || null,
        };
        const existing = items.find((h) => h.name.trim().toLowerCase() === row.schemeName.trim().toLowerCase());
        if (existing) { await db.investmentHoldings.update(existing.id, patch); updated++; }
        else { await db.investmentHoldings.create({ asset_type: "mutual_fund", name: row.schemeName, ...patch }); created++; }
      }
      push(`Imported ${created} new holding${created === 1 ? "" : "s"}, updated ${updated}`, "ok");
      setStaged(null);
      load();
    } catch (e: any) { push(e?.message ?? "import failed", "err"); }
    finally { setConfirming(false); }
  };

  // Transaction-ledger import (CSV/PDF fallback path): groups staged rows by
  // scheme name, finds-or-creates one holding per scheme, then inserts every
  // staged row as a transaction against it.
  const confirmTransactionsImport = async (rows: any[]) => {
    setConfirming(true);
    try {
      const byScheme = new Map<string, any[]>();
      for (const row of rows) {
        if (!row.txn_date) continue; // unparseable date — skip, don't guess
        const key = row.scheme_name.trim().toLowerCase();
        if (!byScheme.has(key)) byScheme.set(key, []);
        byScheme.get(key)!.push(row);
      }
      let created = 0, skipped = rows.length;
      for (const [, group] of byScheme) {
        const schemeName = group[0].scheme_name;
        let holding = items.find((h) => h.name.trim().toLowerCase() === schemeName.trim().toLowerCase());
        if (!holding) {
          holding = await db.investmentHoldings.create({ asset_type: "mutual_fund", name: schemeName, folio_or_demat_number: group[0].folio_or_demat_number ?? null });
        }
        for (const row of group) {
          await db.investmentTransactions.create({
            holding_id: holding.id, txn_type: row.txn_type, txn_date: row.txn_date,
            units: row.units, price: row.price, amount: row.amount ?? 0,
            source: row.source ?? "groww_csv",
          });
          created++; skipped--;
        }
      }
      push(`Imported ${created} transaction${created === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped (missing date)` : ""}`, "ok");
      setStaged(null);
      load();
    } catch (e: any) { push(e?.message ?? "import failed", "err"); }
    finally { setConfirming(false); }
  };

  const totalValue = items.reduce((sum, h) => sum + (Number(h.current_value) || 0), 0);
  const totalInvested = items.reduce((sum, h) => sum + (Number(h.invested_amount) || 0), 0);
  const { gain, gainPct } = calcGainLoss(totalValue, totalInvested);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Investments" index="INV" live="ok"
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            <Btn size="sm" onClick={syncNav} disabled={syncing}>{syncing ? "syncing…" : "sync MF NAV"}</Btn>
            <Btn size="sm" onClick={() => setShowSettings((v) => !v)}>{showSettings ? "hide types" : "asset types"}</Btn>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv,.pdf" style={{ display: "none" }} disabled={importing}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleGrowwFile(f); e.target.value = ""; }} />
            <Btn size="sm" disabled={importing} onClick={() => fileInputRef.current?.click()}>{importing ? "reading…" : "import from Groww"}</Btn>
            <Btn size="sm" variant="primary" onClick={() => setShowAdd((v) => !v)}>{showAdd ? "cancel" : "+ add holding"}</Btn>
          </div>
        }>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
          <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
            <div className="hud-label">current value</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--accent)" }}><KineticNumber value={totalValue} /></div>
          </div>
          <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
            <div className="hud-label">invested</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22 }}><KineticNumber value={totalInvested} /></div>
          </div>
          <div style={{ padding: 12, border: "1px solid var(--edge)" }}>
            <div className="hud-label">gain/loss</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: gain >= 0 ? "var(--ok)" : "var(--err)" }}>
              {inr(gain)}{gainPct != null && ` (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%)`}
            </div>
          </div>
        </div>

        {staged?.kind === "holdings" && (
          <div style={{ padding: 12, border: "1px solid var(--warn)", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div className="hud-label">review before import — {staged.rows.length} holding{staged.rows.length === 1 ? "" : "s"} parsed, nothing saved yet</div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="sm" onClick={() => setStaged(null)}>discard</Btn>
                <Btn size="sm" variant="primary" disabled={confirming} onClick={() => confirmHoldingsImport(staged.rows)}>{confirming ? "importing…" : "confirm import"}</Btn>
              </div>
            </div>
            {staged.summary && (
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
                Groww reports: invested {inr(staged.summary.totalInvestments ?? 0)} · current value {inr(staged.summary.currentPortfolioValue ?? 0)}
                {staged.summary.xirr != null && ` · portfolio XIRR ${staged.summary.xirr}%`} — cross-check against the imported rows below.
              </div>
            )}
            <div style={{ maxHeight: 220, overflow: "auto" }}>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <thead><tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                  <th style={{ padding: "4px 6px" }}>scheme</th><th style={{ padding: "4px 6px" }}>folio</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>units</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>invested</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>current</th>
                  <th style={{ padding: "4px 6px" }}>source</th>
                </tr></thead>
                <tbody>
                  {staged.rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--edge)" }}>
                      <td style={{ padding: "4px 6px" }}>{r.schemeName}</td>
                      <td style={{ padding: "4px 6px", color: "var(--text-dim)" }}>{r.folio ?? "—"}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.units ?? "—"}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.investedValue != null ? inr(r.investedValue) : "—"}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.currentValue != null ? inr(r.currentValue) : "—"}</td>
                      <td style={{ padding: "4px 6px" }}><Chip>{r.source ?? "—"}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {staged?.kind === "transactions" && (
          <div style={{ padding: 12, border: "1px solid var(--warn)", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div className="hud-label">review before import — {staged.rows.length} row{staged.rows.length === 1 ? "" : "s"} parsed, nothing saved yet</div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="sm" onClick={() => setStaged(null)}>discard</Btn>
                <Btn size="sm" variant="primary" disabled={confirming} onClick={() => confirmTransactionsImport(staged.rows)}>{confirming ? "importing…" : "confirm import"}</Btn>
              </div>
            </div>
            <div style={{ maxHeight: 200, overflow: "auto" }}>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <thead><tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                  <th style={{ padding: "4px 6px" }}>scheme</th><th style={{ padding: "4px 6px" }}>date</th>
                  <th style={{ padding: "4px 6px" }}>type</th><th style={{ padding: "4px 6px", textAlign: "right" }}>amount</th>
                  <th style={{ padding: "4px 6px" }}>confidence</th>
                </tr></thead>
                <tbody>
                  {staged.rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--edge)", color: r.txn_date ? "inherit" : "var(--err)" }}>
                      <td style={{ padding: "4px 6px" }}>{r.scheme_name}</td>
                      <td style={{ padding: "4px 6px" }}>{r.txn_date ?? "unparseable — will be skipped"}</td>
                      <td style={{ padding: "4px 6px" }}>{r.txn_type}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.amount != null ? inr(r.amount) : "—"}</td>
                      <td style={{ padding: "4px 6px" }}><Chip tone={r.confidence === "high" ? "ok" : "warn"}>{r.confidence}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {items.length > 1 && (
          <div style={{ padding: 12, border: "1px solid var(--edge)", marginBottom: 14 }}>
            <div className="hud-label" style={{ marginBottom: 10 }}>allocation by asset type</div>
            <HudDonutChart data={calcAllocation(items.map((h) => ({ key: h.asset_type.replace("_", " "), value: Number(h.current_value) || 0 }))).map((s) => ({ label: s.key, value: s.value }))} />
          </div>
        )}

        {showSettings && (
          <div style={{ padding: 10, border: "1px solid var(--edge)", marginBottom: 14 }}>
            <div className="hud-label" style={{ marginBottom: 8 }}>enabled asset types</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {OPTIONAL_TYPES.map((t) => (
                <label key={t.value} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={enabledTypes.includes(t.value)} onChange={(e) => toggleType(t.value, e.target.checked)} />
                  {t.label}
                </label>
              ))}
            </div>
          </div>
        )}

        {showAdd && (
          <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--edge)" }}>
            <div><label style={labelStyle}>type</label><HudSelect value={draft.asset_type} onChange={(v) => setDraft({ ...draft, asset_type: v })} options={ALL_TYPES.filter((t) => enabledTypes.includes(t.value))} /></div>
            <div style={{ minWidth: 180 }}><label style={labelStyle}>name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ ...inputStyle, width: "100%" }} /></div>
            <div><label style={labelStyle}>symbol / scheme code</label><input value={draft.symbol_or_scheme_code} onChange={(e) => setDraft({ ...draft, symbol_or_scheme_code: e.target.value })} style={{ ...inputStyle, width: 140 }} /></div>
            <div><label style={labelStyle}>units</label><input type="number" value={draft.units} onChange={(e) => setDraft({ ...draft, units: e.target.value })} style={{ ...inputStyle, width: 90 }} /></div>
            <div><label style={labelStyle}>avg cost</label><input type="number" value={draft.avg_cost} onChange={(e) => setDraft({ ...draft, avg_cost: e.target.value })} style={{ ...inputStyle, width: 90 }} /></div>
            <div><label style={labelStyle}>current price</label><input type="number" value={draft.current_price} onChange={(e) => setDraft({ ...draft, current_price: e.target.value })} style={{ ...inputStyle, width: 100 }} /></div>
            <Btn size="sm" variant="primary" disabled={adding || !draft.name?.trim()} onClick={addHolding}>{adding ? "adding…" : "add"}</Btn>
          </div>
        )}

        {items.length === 0 ? <EmptyState hint="add a holding above">no investments yet</EmptyState> :
         <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
           {items.map((h) => {
             const value = Number(h.current_value) || 0;
             const invested = Number(h.invested_amount) || 0;
             const { gain: hGain, gainPct: hGainPct } = calcGainLoss(value, invested);
             const stale = h.current_price_updated_at && (Date.now() - new Date(h.current_price_updated_at).getTime()) / 86400000 > 14;
             return (
               <NavLink key={h.id} to={`/finance/investments/${h.id}`} style={{ display: "block", padding: 12, border: "1px solid var(--edge)", textDecoration: "none", color: "inherit" }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{h.name}</div>
                   <Chip>{h.asset_type.replace("_", " ")}</Chip>
                   {stale && <Chip tone="warn">stale price</Chip>}
                 </div>
                 <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                   {inr(value)}{h.units ? ` · ${h.units} units` : ""}
                 </div>
                 <div style={{ fontSize: 12, marginTop: 4, color: hGain >= 0 ? "var(--ok)" : "var(--err)" }}>
                   {inr(hGain)}{hGainPct != null && ` (${hGainPct >= 0 ? "+" : ""}${hGainPct.toFixed(1)}%)`}
                 </div>
               </NavLink>
             );
           })}
         </div>}
      </HudPanel>
    </div>
  );
}
