// Stock universe for the EOD pipeline. Primary: official NIFTY 500 list from
// NSE archives (CSV). Fallback: a static list of liquid large/mid caps so the
// pipeline still works when NSE blocks datacenter IPs.

const NIFTY500_SOURCES = [
  "https://niftyindices.com/IndexConstituent/ind_nifty500list.csv",
  "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
];

export async function fetchNifty500(): Promise<string[]> {
  for (const url of NIFTY500_SOURCES) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!r.ok) continue;
      const text = await r.text();
      const lines = text.split(/\r?\n/).slice(1);
      const out: string[] = [];
      for (const line of lines) {
        // CSV: Company Name,Industry,Symbol,Series,ISIN Code
        const cols = line.split(",");
        const symbol = cols[2]?.trim();
        if (symbol && /^[A-Z0-9&-]+$/.test(symbol)) out.push(symbol);
      }
      if (out.length > 50) return out;
    } catch { /* try next */ }
  }
  return [];
}

// Static fallback — liquid NSE large/mid caps (Nifty 100 + prominent midcaps).
export const FALLBACK_UNIVERSE: string[] = [
  "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "SBIN", "LICI",
  "HINDUNILVR", "ITC", "LT", "BAJFINANCE", "HCLTECH", "MARUTI", "SUNPHARMA", "KOTAKBANK",
  "TITAN", "ULTRACEMCO", "AXISBANK", "NTPC", "ONGC", "ADANIENT", "ADANIPORTS", "WIPRO",
  "M&M", "POWERGRID", "TATAMOTORS", "TATASTEEL", "COALINDIA", "BAJAJFINSV", "NESTLEIND",
  "ASIANPAINT", "JSWSTEEL", "GRASIM", "HINDALCO", "SBILIFE", "HDFCLIFE", "TECHM",
  "BRITANNIA", "EICHERMOT", "DIVISLAB", "CIPLA", "DRREDDY", "APOLLOHOSP", "TATACONSUM",
  "INDUSINDBK", "BAJAJ-AUTO", "HEROMOTOCO", "UPL", "BPCL", "SHRIRAMFIN", "ADANIGREEN",
  "ADANIPOWER", "IOC", "DLF", "VBL", "ZOMATO", "TRENT", "PIDILITIND", "SIEMENS", "ABB",
  "AMBUJACEM", "GAIL", "GODREJCP", "HAL", "BEL", "VEDL", "DABUR", "SHREECEM", "BANKBARODA",
  "PNB", "CANBK", "UNIONBANK", "IDFCFIRSTB", "FEDERALBNK", "AUBANK", "CHOLAFIN", "PFC",
  "RECLTD", "IRFC", "JIOFIN", "NAUKRI", "PAYTM", "POLICYBZR", "TVSMOTOR", "MOTHERSON",
  "BOSCHLTD", "MRF", "BALKRISIND", "APOLLOTYRE", "ASHOKLEY", "BHARATFORG", "CUMMINSIND",
  "ESCORTS", "EXIDEIND", "LUPIN", "AUROPHARMA", "ALKEM", "TORNTPHARM", "ZYDUSLIFE",
  "BIOCON", "GLENMARK", "LAURUSLABS", "MAXHEALTH", "FORTIS", "SYNGENE", "LALPATHLAB",
  "MPHASIS", "LTIM", "COFORGE", "PERSISTENT", "OFSS", "TATAELXSI", "KPITTECH", "CYIENT",
  "SONACOMS", "TATAPOWER", "TATACOMM", "TATACHEM", "JSWENERGY", "NHPC", "SJVN", "TORNTPOWER",
  "CESC", "INDUSTOWER", "IDEA", "HFCL", "ITI", "RVNL", "IRCON", "NBCC", "NCC", "KEC",
  "GMRINFRA", "IRCTC", "CONCOR", "INDIGO", "JUBLFOOD", "DEVYANI", "SAPPHIRE", "PAGEIND",
  "ABFRL", "DMART", "COLPAL", "MARICO", "EMAMILTD", "PGHH", "BATAINDIA", "RELAXO",
  "CROMPTON", "HAVELLS", "POLYCAB", "KEI", "FINOLEXIND", "VOLTAS", "BLUESTARCO", "WHIRLPOOL",
  "DIXON", "AMBER", "PIIND", "SRF", "AARTIIND", "DEEPAKNTR", "ATUL", "COROMANDEL", "CHAMBLFERT",
  "BSE", "MCX", "CDSL", "ANGELONE", "MOTILALOFS", "IEX", "CAMS", "KFINTECH", "HDFCAMC",
  "NAM-INDIA", "UTIAMC", "ICICIGI", "ICICIPRULI", "STARHEALTH", "NIACL", "GICRE",
  "SAIL", "NMDC", "JINDALSTEL", "APLAPOLLO", "RATNAMANI", "NATIONALUM", "HINDZINC",
  "PETRONET", "IGL", "MGL", "GUJGASLTD", "ATGL", "OIL", "HINDPETRO", "MRPL", "CASTROLIND",
  "ASTRAL", "SUPREMEIND", "PRINCEPIPE", "KAJARIACER", "CERA", "GRANULES", "IPCALAB",
  "JBCHEPHARM", "MANKIND", "ABBOTINDIA", "SANOFI", "PFIZER", "GLAXO",
];

export function dedupe(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
}
