// Data validation engine — runs nightly after all sync jobs complete.
// Validates: no duplicates, market_cap > 0, PE matches Price/EPS, ROE recalc, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const errors: string[] = [];
    const warnings: string[] = [];
    let validated = 0;
    let fixed = 0;

    // 1. Check for duplicate symbols
    const { data: duplicates } = await supabase.rpc("check_duplicate_symbols");
    if (duplicates && duplicates.length > 0) {
      errors.push(`Found ${duplicates.length} duplicate symbols`);
      console.error("Duplicate symbols:", duplicates);
    }

    // 2. Fetch all active rows for validation
    const { data: rows, error: fetchError } = await supabase
      .from("market_data")
      .select("symbol, exchange, ltp, market_cap, pe, eps, roe, debt_equity, sales, net_profit")
      .eq("is_active", true);

    if (fetchError) throw fetchError;
    if (!rows) throw new Error("No data to validate");

    validated = rows.length;

    for (const row of rows) {
      const updates: Record<string, any> = {};
      let needsUpdate = false;

      // 3. Validate market_cap > 0
      if (row.market_cap != null && Number(row.market_cap) <= 0) {
        warnings.push(`${row.symbol}: negative/zero market_cap (${row.market_cap})`);
        updates.market_cap = null; // Clear invalid data
        needsUpdate = true;
      }

      // 4. Recalculate PE = Price / EPS if mismatch > 5%
      if (row.ltp != null && row.eps != null && Number(row.eps) > 0) {
        const expectedPe = Number(row.ltp) / Number(row.eps);
        const actualPe = row.pe != null ? Number(row.pe) : null;

        if (actualPe != null) {
          const diff = Math.abs((actualPe - expectedPe) / expectedPe);
          if (diff > 0.05) {
            warnings.push(`${row.symbol}: PE mismatch (stored ${actualPe.toFixed(2)}, calc ${expectedPe.toFixed(2)})`);
            updates.pe = expectedPe;
            needsUpdate = true;
          }
        } else if (expectedPe > 0) {
          // Missing PE but we can calculate it
          updates.pe = expectedPe;
          needsUpdate = true;
        }
      }

      // 5. Recalculate ROE from net profit / equity if available
      // (Simplified: would need balance sheet data for true equity)
      // Skip for now — requires book_value or shareholders_equity field

      // 6. Validate debt_equity is not negative
      if (row.debt_equity != null && Number(row.debt_equity) < 0) {
        warnings.push(`${row.symbol}: negative debt_equity (${row.debt_equity})`);
        updates.debt_equity = null;
        needsUpdate = true;
      }

      // 7. Apply updates if needed
      if (needsUpdate) {
        const { error: updateError } = await supabase
          .from("market_data")
          .update(updates)
          .eq("symbol", row.symbol)
          .eq("exchange", row.exchange);

        if (updateError) {
          errors.push(`Failed to update ${row.symbol}: ${updateError.message}`);
        } else {
          fixed++;
        }
      }
    }

    // 8. Check for NULL treated as 0 (should be explicit 0 or NULL, never implicit)
    // This is a data entry issue — validate during sync, not here

    const summary = {
      validated,
      fixed,
      errors: errors.length,
      warnings: warnings.length,
      details: {
        errors: errors.slice(0, 50),
        warnings: warnings.slice(0, 50),
      },
    };

    console.log("Validation summary:", summary);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: errors.length > 0 ? 500 : 200,
    });
  } catch (error) {
    console.error("Validation failed:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});

// Helper SQL function for checking duplicates
// CREATE OR REPLACE FUNCTION check_duplicate_symbols()
// RETURNS TABLE(symbol text, exchange text, count bigint) AS $$
//   SELECT symbol, exchange, count(*) as count
//   FROM market_data
//   WHERE is_active = true
//   GROUP BY symbol, exchange
//   HAVING count(*) > 1;
// $$ LANGUAGE SQL;
