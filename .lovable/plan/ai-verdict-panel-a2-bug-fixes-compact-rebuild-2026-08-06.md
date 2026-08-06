# AI Verdict panel (A2) — bug fixes + compact rebuild

Deep check of the panel, the hook, and `market-stock-insight`, verified against the live database.

## Confirmed bugs

1. **The verdict is never actually fed live price.** The function reads `market_quotes.select("ltp,day_change_pct,as_of")` and filters `.eq("exchange", …)`. That table has none of those columns (it is `symbol, name, kind, price, change_abs, change_pct, source, fetched_at`) and no `exchange` column, so the query always errors, `quoteRow` is always null, and the prompt always says "Live price: unavailable" — entry/stop/targets are anchored on the EOD close.
2. **The panel claims otherwise.** The line "live price context included" is driven by the client's own quote, not by what the function actually sent, so it asserts something that is always false today.
3. **Market breadth is always unknown.** The function selects `adv_decline_ratio` from `market_breadth_daily`, which has no such column (it has `advances`, `declines`, `market_score`, `india_vix`, `nifty_change_pct`). The select errors, so every verdict reasons breadth-blind — that is exactly why the visible risk list says "market breadth unknown". Latest breadth row is also only 16 rows deep; freshness must be checked.
4. **Nothing is being cached.** The `upsert` return is never checked and nothing is logged. The JGCHEM row in `market_stock_ai` is still the Jul-27 `wait` verdict with all flat columns NULL, while the panel is showing a freshly generated Aug-06 `buy` — no row has been written in over a week (0 rows in the last 2 days). Every visit to an Analysis page therefore pays a fresh LLM call and the 6h TTL is dead. Fix: check the error, log it, and return a `cached:false, persisted:false` flag so the UI can say the verdict is not stored.
5. **`alignment` / `score_adjustment` never survive.** 0 of 54 cached payloads have them, so the alignment chip and the "AI-adjusted" breakout score silently fall back to raw for every cached read. Same root cause as (4), plus `normalizeAiPayload`'s fallback object omits these fields entirely.
6. **Stale-quote confidence.** `sanitizeAiTrade` anchors on `quoteRow.ltp` when present — with (1) fixed it must also reject a quote whose `fetched_at` is older than the current session, otherwise a days-old price becomes the plausibility anchor.
7. **Drift note anchors on the wrong number.** `insight.entry ?? score.close` — entry is a *limit* price the user has not filled, so a deliberate pullback entry reads as "price has moved -3%". Anchor the drift on the close the technicals were computed from, and show the entry distance separately.
8. **Old cached rows can show 100% confidence.** The 0.95 cap is applied on read for `payload.confidence`, but rows written earlier stored `1` and some list views read the flat `confidence` column, which is uncapped/NULL.
9. **News window has no recency bound.** Top 8 headlines by `published_at` with no age cut-off — a quiet stock feeds the model months-old news as "recent". Cap at 14 days. 56 of 633 news rows are still unclassified (`sentiment` NULL); the function falls back to the client-side classifier, which is fine, but the fallback should also be persisted.
10. **No stale-verdict guard in the UI.** A verdict older than the last completed session still renders identically to a fresh one; only the timestamp hints at it.

## Compact rebuild of the panel

Target: the whole panel readable in roughly half the current height, no data lost.

```text
A2  AI Verdict                                  ⟳
BUY  95%  confirms  +4        EOD Aug 05 · 3h ago
Entry 548.25   Stop 526.00   T1 575.00   T2 600.00   10d
Strong momentum and relative strength at 52w highs;
ADX and MACD support the trend.                  more
▸ 2 risks · 1 adjustment
```

- One dense header line: verdict chip, confidence as a bare `95%`, alignment chip, signed score adjustment chip. Vintage + relative age collapse into one right-aligned muted string; the long "generated Aug 06, 10:27 AM / based on EOD technicals …" pair goes away (full detail in the title tooltip).
- Levels become a single wrapping grid of compact `label value` cells (Entry / Stop / T1..T3 / Hold) instead of five full-width `Row`s — same `StatGrid` pattern the Quote block uses.
- Rationale clamped to 2 lines with an inline "more" toggle.
- Risks, plausibility flags, and the adjustment reason merge into one collapsed disclosure line, expanded on click. Drift and stale warnings stay unconditional (single 10px line) since they are the ones that matter before acting.
- Loading/error/empty states shrink to one line each.

## Improvements

- Show a **not-stored / not-cached** badge when persistence fails, so a broken cache is visible rather than silent.
- Show **age relative to the last session** ("verdict predates today's session") when the verdict is older than the newest `trade_date` in scores.
- Feed the function the fields it already asks for but cannot get: live price from the correct quote column with a freshness guard, breadth from real columns (`advances`/`declines` ratio computed, `india_vix`, `market_score`, `nifty_change_pct`).
- Send **delivery %, turnover/liquidity and sector rank** explicitly (currently partly present) and state plainly in the prompt when a field is unavailable, so the model stops emitting "unknown" as a risk bullet.
- Cap `confidence` on write for the flat column too, and backfill the handful of rows storing `1`.
- Refresh button: keep the per-symbol pending scoping, add a one-line "refreshing costs an AI call" title, and disable while a verdict younger than 2 minutes exists.

## Technical notes

Files: `src/routes/market/Analysis.tsx` (A2 panel + a small `LevelGrid`/clamp helper), `src/lib/market/hooks.ts` (`StockInsight` gains `persisted`, `quote_used`, `breadth_used`), `supabase/functions/market-stock-insight/index.ts` (correct quote/breadth columns, news recency window, checked upsert with logging, capped flat confidence).

No schema migration needed; one small data touch-up (`confidence > 0.95` rows clamped) can ride along with the next migration if you want it.
