# Penny stocks out for good — verify, close the last gaps, monthly rescan

Checked against the live database just now. Most of what you asked for is already in force; what remains are three real gaps plus one field that makes the state look wrong.

## Verified current state

- Rule live as stated: penny = market cap < ₹1,000 Cr **or** last close < ₹50, with unknown cap judged on price and unknown price judged on cap.
- 2,793 active stocks, **1,141 flagged penny**. Zero active stocks fail the rule while unflagged (0 on cap, 0 on price). Zero inactive stocks fail unflagged either.
- Zero penny rows remain in daily prices, EOD, scores, score history, screener snapshot, indicators cache, fundamentals, NSE master, live prices, shares outstanding.
- The universe surface (`market_universe`) already excludes them: it selects active stocks where the penny flag is not true.
- Monthly rescan already scheduled: NSE listing refresh on the 1st at 02:00 UTC, penny sweep on the 1st at 02:30 UTC. Last sweep ran today at 17:59 UTC.
- The earlier build failure does not reproduce: dependency install is clean, and the two files named in it (`Statements.tsx`, a `gmail_sync_runs` call) no longer exist in the app.

## Gaps to close

### 1. The `in_universe` column is dead and says the opposite of the truth

`in_universe` is **false on all 3,305 rows**, including every clean stock. Nothing breaks today because the universe view ignores the column and derives membership from active + not-penny — but any query or future job that trusts the column sees an empty universe.

Fix: have the monthly sweep set `in_universe` to the same truth the view uses (active and not penny), and re-stamp all rows once now, so the column and the view can never disagree again.

### 2. 25 stocks have never been scanned

25 rows carry no penny-check timestamp. They pass today only because nothing judged them.

Fix: the sweep already evaluates every symbol; run one pass after the change so all rows carry a check date, and treat "never checked" as out-of-universe until proven clean.

### 3. 271 active stocks have no market cap on record

By your rule these are correctly judged on price alone, so they stay. But an unknown cap is a data gap, not a verdict.

Fix: no rule change. Feed those symbols to the existing shares/fundamentals sync so the next monthly scan can judge them on both tests, and surface the count in the sweep result so it is visible when it grows.

### 4. Sweep visibility

A failed monthly sweep is currently silent. Record each run (flagged, reinstated, rows purged, unknown-cap count) in the maintenance log so a missed scan is obvious rather than discovered months later.

## What stays exactly as-is

- The threshold values and the OR semantics.
- Monthly cadence on the 1st: listing refresh, then penny scan.
- The write-blocking triggers on the derived tables, which keep penny rows from coming back between scans.
- Penny rows in `market_stocks` are kept and flagged — that is what keeps them out while still letting a genuine re-rating bring a stock back.

## Technical notes

- One migration updating `market_penny_sweep()` to maintain `in_universe`, stamp every row, count unknown-cap symbols, and write a maintenance-log entry.
- One data operation to re-stamp `in_universe` across existing rows.
- One manual sweep invocation afterwards, then verification: zero unflagged failures, zero penny rows in the gated tables, `in_universe` count equal to the universe view count, and every row carrying a check date.
- No frontend changes — the screener, breakout and score surfaces already read the penny-filtered universe.