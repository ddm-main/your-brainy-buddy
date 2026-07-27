## What I confirmed

- The visible runtime problem is real: `Holdings.tsx` is triggering `Maximum update depth exceeded` from an effect that depends on `rows`.
- The SELL request returned HTTP 200 with `ok:false`, but the payload still says `session_expired:true`, so the UI opens the reconnect path and hides the broker reason behind an ambiguous warning.
- Error visibility is weak: order failures only appear as short toasts at the bottom, and long broker messages can be visually lost behind modals/overlays.

## Fix plan

1. **Stop the Holdings render loop**
   - Replace unstable `rows` object dependency usage with a stable holdings identity key.
   - Only update `scores` / `sectors` when the fetched symbol set changes.
   - Stabilize live quote subscription keys so `subscribeSymbolsForTicks()` does not receive a new array every render.

2. **Correct ambiguous SELL error handling**
   - In `market-order-place`, return `session_expired` based on the actual `KotakAmbiguousOrderError` classification instead of always setting it to `true`.
   - Preserve the “do not retry blindly” behavior for true mid-request session failures.
   - For broker/business rejections, return a normal failed order response that can be shown directly to the user without opening reconnect.

3. **Make order errors visible inside the ticket**
   - Add persistent inline error state to `OrderTicket` above the footer/content area.
   - Keep the modal open after failures and show the exact safe broker/app message with status/code context.
   - Keep toasts as secondary notifications only, not the sole error surface.

4. **Improve Kotak reconnect trigger discipline**
   - Only dispatch `kotak:reconnect` when the backend explicitly flags a proven session expiry.
   - Do not show the reconnect modal for generic SELL/business errors.

5. **Regression coverage**
   - Extend the Kotak classifier test to cover the current response shape and common SELL rejection wording.
   - Add a lightweight Holdings stability test if the existing test setup can mount route components cleanly; otherwise verify by targeted browser/runtime check after implementation.

## Files to change

- `src/routes/market/Holdings.tsx`
- `src/components/market/OrderTicket.tsx`
- `supabase/functions/market-order-place/index.ts`
- `supabase/functions/_shared/market/kotakClient.ts` if the ambiguous error needs a `sessionExpired` flag
- `tests/kotakSessionClassifier.test.ts`

## Validation

- Run the Kotak classifier regression test.
- Verify `/market/holdings` no longer logs maximum update depth warnings.
- Verify a SELL failure remains visible in the order ticket and does not automatically open the reconnect modal unless the backend explicitly proves session expiry.