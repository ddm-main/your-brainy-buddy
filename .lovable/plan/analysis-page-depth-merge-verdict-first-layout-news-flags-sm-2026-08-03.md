# Analysis page: depth merge, verdict-first layout, news flags, smarter AI verdict

## 1. Market Depth merged into the Quote panel

- Remove the standalone A2 "Market Depth" panel from the Analysis right rail.
- Render the ladder inside the A1 Quote panel, below the Open/High/Low/Prev Close stats, behind a small "Depth" Show/Hide control in the panel header.
- Default is **hidden**: flip the persisted preference default from visible to hidden (`market.depth.visible` — absent key now means hidden). Nothing subscribes until the user presses Show.
- While hidden, no REST depth polling and no relay depth lease (the subscription hook already gates on the visible flag; the Analysis page's `useDepth` query gets gated on the same flag so it stops polling too).
- Panel indices shift: Breakout Intelligence, Indicators, etc. keep their numbering except the freed A2 slot is reused by whatever follows so the rail stays A1..A7 without a gap.

## 2. AI Verdict moves above Breakout Intelligence

- Order in the right rail becomes: Quote (+depth) → Alerts → **AI Verdict** → Breakout Intelligence → Indicators → Range & Strength → Fundamentals → News.
- AI Verdict is rendered outside the `!score` coverage guard as today, so it still shows for uncovered symbols.

## 3. Green / red flags on every news item

The `market_news` table already has `sentiment` (numeric) and `impact` (text) columns, but all 720 rows are NULL — nothing has ever written them.

- Add a shared lexicon-based classifier (`_shared/market/newsSentiment.ts`): scores a headline in −1..+1 from weighted bullish terms (order win, profit up, record, upgrade, stake buy, dividend, expansion) and bearish terms (fraud, probe, downgrade, loss, default, resignation, penalty, recall, stake sale), plus negation handling.
- `market-news-sync` classifies each headline at insert and writes `sentiment`, `impact` (`positive` / `negative` / `neutral`) and `classified_at`.
- Backfill existing rows: the sync run re-classifies any row for the synced symbol whose `classified_at` is null.
- UI: each headline in A8 gets a leading dot/flag — green for positive, red for negative, muted for neutral — with a tooltip showing the score. Applies to every news list in the app that renders `market_news` (Analysis A8 and any dashboard news strip).
- `useMarketNews` selects the two extra columns.

## 4. Smarter AI verdict, and the verdict feeds the breakout score

**Richer inputs to `market-stock-insight`:**
- Live/latest quote (LTP, day change, vs the EOD close the technicals were computed from) so the model stops reasoning off a stale close.
- Detected chart patterns and setup flags, v4 bucket breakdown (levels/volume/indicators/setups/strength/patterns) and the breakout band/stage.
- Recent news: top 8 headlines with their sentiment scores and the window average.
- Market context: breadth regime, sector strength and sector rank, relative strength vs Nifty, delivery %, liquidity/turnover.
- Prompt asks for an explicit `score_adjustment` (−10..+10) and `alignment` (`confirms` / `neutral` / `contradicts`) alongside the existing verdict fields, with a one-line justification. Existing plausibility sanitisation stays.

**Feeding it back into Breakout Intelligence:**
- The v4 `sentiment` bucket stops being "no data": `news_sentiment` is now populated from the classified window average, and a new `ai_alignment` leg inside the same bucket uses the cached AI verdict (buy/hold/wait/avoid + confidence).
- The A3 panel shows the composite as **Breakout Score** with an "AI-adjusted" chip and the raw pre-AI number underneath, so the stored pipeline score stays auditable and the score explainer keeps reconciling.
- If no AI verdict is cached for the symbol, the leg abstains — score is unchanged, no penalty.

## 5. Additional issues found during the check

- `useDepth` polls the `market-depth` edge function once a second regardless of whether the ladder is on screen; gating it on the (now default-off) visibility flag removes that cost entirely for most sessions.
- The depth panel currently hides itself outside market hours *after* it already ran hooks; with the merged version the "market closed" state becomes a one-line note inside the Quote panel instead of a vanishing section that reflows the rail.
- AI Verdict timestamp shows a 6h-cached result with no indication that price has moved since; add a "price moved X% since this verdict" note when LTP drifts more than 2% from the entry anchor.
- News panel currently prints "Yahoo Finance" as a hardcoded source fallback while the feed is actually Google News RSS — corrected.

## Technical notes

Files touched: `src/routes/market/Analysis.tsx`, `src/components/market/MarketDepthLadder.tsx`, `src/lib/market/depthPanelPrefs.ts`, `src/lib/market/hooks.ts`, `supabase/functions/market-news-sync/index.ts`, `supabase/functions/market-stock-insight/index.ts`, `supabase/functions/_shared/market/scoring.ts`, new `supabase/functions/_shared/market/newsSentiment.ts`, plus unit tests for the classifier and the sentiment bucket.

No schema migration required — `sentiment`, `impact`, `classified_at` already exist on `market_news`.
