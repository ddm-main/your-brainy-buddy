## Fix Gmail OAuth callback popup

**Problem:** The callback edge function returns inline HTML with a script that should `postMessage` to the opener and close the popup. The Supabase Functions runtime isn't reliably serving it as `text/html`, so the browser renders the source as text and the handoff never runs.

**Fix:** Replace the inline-HTML handoff with an HTTP 302 redirect back to the app. The frontend already handles the popup handoff via URL params.

### Changes

1. `supabase/functions/gmail-oauth-callback/index.ts`
   - On success: `return Response.redirect(<app-origin>/config/email?aid=<aid>&gmail_connected=<email>, 302)`
   - On error: `return Response.redirect(<app-origin>/config/email?aid=<aid>&gmail_error=<msg>, 302)`
   - Use the `origin` embedded in the OAuth `state` (already present, per the start function logs) as the redirect base; fall back to a safe default if missing.
   - Preserve existing state validation, token exchange, and DB writes — only the final response changes.

2. `src/pages/ConfigEmail.tsx` (or whichever component owns `/config/email`)
   - On mount, read `gmail_connected` / `gmail_error` / `aid` from the URL.
   - If `window.opener` exists and isn't closed: `postMessage({ type: 'gmail-oauth-result', connected, error, aid }, window.location.origin)` then `window.close()`.
   - Otherwise: show a toast, refresh the account list, and strip the params from the URL.
   - This mirrors the logic previously inlined in the callback HTML, so the parent-window listener keeps working unchanged.

### Verification

- Redeploy `gmail-oauth-callback`.
- Reconnect Gmail from `/config/email`; popup should redirect to the app, hand off via `postMessage`, and close.
- Check `gmail-oauth-callback` logs show a 302 and no errors.
- Confirm the connected account appears in the Email Accounts list without a manual refresh.

### Notes

- No schema or secret changes.
- No changes to `gmail-oauth-start`.
- Keeps the same success/error contract the parent listener already expects.