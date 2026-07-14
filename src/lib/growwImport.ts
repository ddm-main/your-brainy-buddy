/**
 * Parses Groww's real portfolio export format — confirmed against an actual
 * sample (2026-07-12), NOT the transaction-statement format this file
 * originally assumed. The export is an .xlsx workbook shaped like:
 *
 *   Personal Details (Name / Mobile / PAN) — ignored, not imported
 *   HOLDING SUMMARY — Total Investments / Current Portfolio Value / Profit-
 *     Loss / Profit-Loss % / XIRR — a portfolio-level total, used only as a
 *     sanity-check display, not stored per-holding
 *   HOLDINGS AS ON <date> — one row per position: Scheme Name, AMC,
 *     Category, Sub-category, Folio No., Source (Groww/External), Units,
 *     Invested Value, Current Value, Returns, XIRR
 *
 * This is a point-in-time SNAPSHOT, not a transaction ledger — there's no
 * buy/sell/SIP history here, just current holdings. So staged rows map
 * directly onto investment_holdings (units/avg_cost/invested_amount/
 * current_price/current_value set directly), never investment_transactions
 * — matches the "holdings with no transaction history use their own
 * manually-entered fields" fallback already built into InvestmentDetail.
 */

export interface StagedGrowwHolding {
  schemeName: string;
  amc: string | null;
  category: string | null;
  subCategory: string | null;
  folio: string | null;
  source: string | null;
  units: number | null;
  investedValue: number | null;
  currentValue: number | null;
  returns: number | null;
  xirr: number | null;
}

export interface GrowwPortfolioSummary {
  totalInvestments: number | null;
  currentPortfolioValue: number | null;
  profitLoss: number | null;
  profitLossPct: number | null;
  xirr: number | null;
}

type SheetRow = (string | number | null | undefined)[];

function normHeader(cell: unknown): string {
  return String(cell ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toNumber(cell: unknown): number | null {
  if (cell == null || cell === "") return null;
  const n = typeof cell === "number" ? cell : Number(String(cell).replace(/[,%₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toText(cell: unknown): string | null {
  const s = String(cell ?? "").trim();
  return s || null;
}

/** Locates the "HOLDING SUMMARY" totals row (a labeled header row followed
 * immediately by one data row) — used for a sanity-check display only. */
export function parseGrowwSummary(rows: SheetRow[]): GrowwPortfolioSummary | null {
  const headerIdx = rows.findIndex((r) => r.some((c) => normHeader(c) === "total investments"));
  if (headerIdx < 0 || !rows[headerIdx + 1]) return null;
  const header = rows[headerIdx].map(normHeader);
  const data = rows[headerIdx + 1];
  const col = (name: string) => header.indexOf(name);
  return {
    totalInvestments: toNumber(data[col("total investments")]),
    currentPortfolioValue: toNumber(data[col("current portfolio value")]),
    profitLoss: toNumber(data[col("profit/loss")]),
    profitLossPct: toNumber(data[col("profit/loss %")]),
    xirr: toNumber(data[col("xirr")]),
  };
}

/** Locates the "HOLDINGS AS ON ..." table (header row containing "Scheme
 * Name" + "AMC") and parses every data row until the first fully-blank row
 * or end of sheet. Column matching is by header text, not fixed index, so
 * minor column reordering/renaming in future Groww export versions doesn't
 * silently break this. */
export function parseGrowwHoldings(rows: SheetRow[]): StagedGrowwHolding[] {
  const headerIdx = rows.findIndex((r) => {
    const norm = r.map(normHeader);
    return norm.includes("scheme name") && norm.includes("amc");
  });
  if (headerIdx < 0) return [];
  const header = rows[headerIdx].map(normHeader);
  const col = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;

  const schemeCol = col("scheme name");
  const amcCol = col("amc");
  const categoryCol = col("category");
  const subCategoryCol = col("sub-category", "sub category", "subcategory");
  const folioCol = col("folio no.", "folio no", "folio");
  const sourceCol = col("source");
  const unitsCol = col("units");
  const investedCol = col("invested value", "invested amount");
  const currentCol = col("current value");
  const returnsCol = col("returns");
  const xirrCol = col("xirr");
  if (schemeCol < 0) return [];

  const staged: StagedGrowwHolding[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const schemeName = toText(row[schemeCol]);
    if (!schemeName) break; // first blank row ends the table
    staged.push({
      schemeName,
      amc: amcCol >= 0 ? toText(row[amcCol]) : null,
      category: categoryCol >= 0 ? toText(row[categoryCol]) : null,
      subCategory: subCategoryCol >= 0 ? toText(row[subCategoryCol]) : null,
      folio: folioCol >= 0 ? toText(row[folioCol]) : null,
      source: sourceCol >= 0 ? toText(row[sourceCol]) : null,
      units: unitsCol >= 0 ? toNumber(row[unitsCol]) : null,
      investedValue: investedCol >= 0 ? toNumber(row[investedCol]) : null,
      currentValue: currentCol >= 0 ? toNumber(row[currentCol]) : null,
      returns: returnsCol >= 0 ? toNumber(row[returnsCol]) : null,
      xirr: xirrCol >= 0 ? toNumber(row[xirrCol]) : null,
    });
  }
  return staged;
}
