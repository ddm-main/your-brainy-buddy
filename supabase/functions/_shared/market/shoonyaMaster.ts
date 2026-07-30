// Shoonya (Noren) symbol master.
//
// Shoonya publishes one zipped CSV per exchange segment at
// `https://api.shoonya.com/<SEG>_symbols.txt.zip`. The NSE/BSE cash files
// carry the instrument `Token` every Noren data route (GetQuotes, TPSeries,
// WS touchline) is keyed by, so we mirror it into
// `market_stocks.shoonya_token` and never guess a token at request time.
import { unzipSync } from "npm:fflate@0.8.2";

export const SHOONYA_MASTER_BASE = "https://api.shoonya.com";

export interface MasterRow {
  exchange: "NSE" | "BSE";
  symbol: string;      // app symbol (no -EQ suffix)
  tsym: string;        // Noren trading symbol
  token: string;
  lot_size: number | null;
  tick_size: number | null;
  instrument: string | null;
}

/** Download + unzip one segment file and return its raw CSV text. */
export async function fetchMasterCsv(segment: "NSE" | "BSE"): Promise<string> {
  const url = `${SHOONYA_MASTER_BASE}/${segment}_symbols.txt.zip`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Shoonya ${segment} symbol master failed (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const files = unzipSync(buf);
  const name = Object.keys(files).find((n) => /\.txt$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new Error(`Shoonya ${segment} symbol master archive was empty`);
  return new TextDecoder().decode(files[name]);
}

const numOrNull = (v: string | undefined): number | null => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/**
 * Parse the segment CSV by HEADER NAME, not column position — Noren has
 * shuffled column order between segments before, and a positional parse
 * silently writes lot sizes into the token column when it does.
 */
export function parseMasterCsv(csv: string, exchange: "NSE" | "BSE"): MasterRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iToken = idx("token");
  const iTsym = idx("tradingsymbol", "trading symbol", "tsym");
  const iSymbol = idx("symbol");
  const iLot = idx("lotsize", "lot size");
  const iTick = idx("ticksize", "tick size");
  const iInst = idx("instrument");
  if (iToken < 0 || iTsym < 0) return [];

  const out: MasterRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const token = String(c[iToken] ?? "").trim();
    const tsym = String(c[iTsym] ?? "").trim().toUpperCase();
    if (!token || !tsym) continue;
    const instrument = iInst >= 0 ? String(c[iInst] ?? "").trim().toUpperCase() : null;
    // Cash-segment equities only — derivatives live in their own files and
    // would collide with the equity row for the same underlying.
    if (exchange === "NSE" && !/-EQ$/.test(tsym) && !/^EQ$/i.test(instrument ?? "")) continue;
    const symbol = (iSymbol >= 0 ? String(c[iSymbol] ?? "").trim().toUpperCase() : tsym).replace(/-EQ$/, "");
    if (!symbol) continue;
    const key = `${exchange}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      exchange,
      symbol,
      tsym,
      token,
      lot_size: numOrNull(c[iLot]),
      tick_size: numOrNull(c[iTick]),
      instrument,
    });
  }
  return out;
}

export async function fetchShoonyaMaster(segment: "NSE" | "BSE"): Promise<MasterRow[]> {
  return parseMasterCsv(await fetchMasterCsv(segment), segment);
}
