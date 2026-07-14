// Parses a Groww mutual-fund "Transaction Statement" export (PDF from
// Profile -> Reports, or CSV) into staged investment_transactions rows for
// the user to review and confirm before insert — mirrors the
// parse-then-confirm shape of finance-upload-statement, but returns rows to
// the client instead of writing them directly, since (unlike bank
// statements) this repo has never parsed a real Groww export and the first
// pass is best-effort. Never silently commits data it isn't confident about.

import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { extractPdfText } from "../_shared/statement-pdf.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const importLimiter = createSlidingWindowLimiter(10, 60_000);
const MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export interface StagedGrowwTxn {
  scheme_name: string;
  folio_or_demat_number: string | null;
  txn_type: "buy" | "sip" | "sell" | "dividend";
  txn_date: string | null; // YYYY-MM-DD, null if unparseable — flagged for manual fix
  units: number | null;
  price: number | null;
  amount: number | null;
  confidence: "high" | "low";
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

function toIsoDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function toOrderType(raw: string): StagedGrowwTxn["txn_type"] | null {
  const s = raw.trim().toLowerCase();
  if (/sip/.test(s)) return "sip";
  if (/purchase|buy|lumpsum/.test(s)) return "buy";
  if (/redeem|sell|redemption/.test(s)) return "sell";
  if (/dividend|idcw/.test(s)) return "dividend";
  return null;
}

// Best-effort line pattern for Groww's typical mutual-fund transaction row:
//   <date>  <scheme name...>  <order type>  <amount>  <nav/price>  <units>  [folio]
// Real layout is unconfirmed against a sample — expect refinement once
// tested against an actual export. Deliberately conservative: unmatched
// lines are dropped, not guessed at.
const TXN_LINE_RX = /(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})\s+(.+?)\s+(SIP|Purchase|Buy|Lumpsum|Redemption|Redeem|Sell|Dividend|IDCW)\s+(?:INR|Rs\.?|₹)?\s*([0-9][0-9,]*(?:\.[0-9]{1,4})?)\s+(?:@\s*)?([0-9][0-9,]*(?:\.[0-9]{1,4})?)\s+([0-9][0-9,]*(?:\.[0-9]{1,4})?)/gi;

function parseGrowwText(text: string): StagedGrowwTxn[] {
  const staged: StagedGrowwTxn[] = [];
  for (const m of text.matchAll(TXN_LINE_RX)) {
    const [, dateRaw, schemeRaw, typeRaw, amountRaw, navRaw, unitsRaw] = m;
    const txn_type = toOrderType(typeRaw);
    if (!txn_type) continue;
    staged.push({
      scheme_name: schemeRaw.trim().slice(0, 200),
      folio_or_demat_number: null,
      txn_type,
      txn_date: toIsoDate(dateRaw),
      amount: Number(amountRaw.replace(/,/g, "")) || null,
      price: Number(navRaw.replace(/,/g, "")) || null,
      units: Number(unitsRaw.replace(/,/g, "")) || null,
      confidence: "low", // format unverified against a real sample — always low until proven otherwise
    });
  }
  return staged;
}

function parseGrowwCsv(csvText: string): StagedGrowwTxn[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const dateIdx = idx(["date", "order date", "txn date", "transaction date"]);
  const schemeIdx = idx(["scheme name", "scheme", "fund name", "name"]);
  const folioIdx = idx(["folio", "folio no", "folio number"]);
  const typeIdx = idx(["order type", "type", "transaction type"]);
  const amountIdx = idx(["amount", "invested amount"]);
  const navIdx = idx(["nav", "price"]);
  const unitsIdx = idx(["units"]);
  if (dateIdx < 0 || schemeIdx < 0 || typeIdx < 0 || amountIdx < 0) return [];

  const staged: StagedGrowwTxn[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const txn_type = toOrderType(cols[typeIdx] ?? "");
    if (!txn_type) continue;
    staged.push({
      scheme_name: (cols[schemeIdx] ?? "").trim().slice(0, 200),
      folio_or_demat_number: folioIdx >= 0 ? (cols[folioIdx] ?? "").trim() || null : null,
      txn_type,
      txn_date: toIsoDate(cols[dateIdx]),
      amount: Number((cols[amountIdx] ?? "").replace(/,/g, "")) || null,
      price: navIdx >= 0 ? Number((cols[navIdx] ?? "").replace(/,/g, "")) || null : null,
      units: unitsIdx >= 0 ? Number((cols[unitsIdx] ?? "").replace(/,/g, "")) || null : null,
      confidence: "high", // structured CSV with matched headers — much more reliable than PDF text-scraping
    });
  }
  return staged;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  const rl = importLimiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const { filename, bytesBase64, csvText, password } = await req.json();

    if (csvText) {
      if (typeof csvText !== "string" || csvText.length > 2_000_000) {
        return new Response(JSON.stringify({ error: "csvText required (max 2MB)" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const staged = parseGrowwCsv(csvText);
      return new Response(JSON.stringify({ ok: true, source: "groww_csv", staged }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (!bytesBase64 || !filename) {
      return new Response(JSON.stringify({ error: "bytesBase64+filename or csvText required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (bytesBase64.length > MAX_BYTES * 1.4) {
      return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const binary = atob(bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) {
      return new Response(JSON.stringify({ error: "file does not appear to be a valid PDF" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const extracted = await extractPdfText(bytes, password);
    if (!extracted.ok) {
      return new Response(JSON.stringify({ ok: false, error: extracted.error ?? "pdf_extraction_failed" }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const staged = parseGrowwText(extracted.text);
    return new Response(JSON.stringify({ ok: true, source: "groww_pdf", staged }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Groww import failed", "finance-import-groww", cors);
  }
});
