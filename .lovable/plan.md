I checked the live preview/network trace and the deployed callback path. The app currently opens Shoonya at:

```text
https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id=FA207868_U
```

The preview trace shows only the “get authorize URL” requests to `market-shoonya-login`; there is no callback hit and no second request carrying a returned code. A direct callback check is healthy: `shoonya-oauth-callback?...code=test-code` redirects correctly to `/market/settings?shoonya_code=test-code`. So the broken segment is the Shoonya → app return/capture step, not the app’s token exchange yet.

Plan:

1. Harden the authorize URL
   - Change the Shoonya authorize URL builder so it can include the exact app callback/redirect URL, not just `client_id`.
   - Have the frontend send the displayed Redirect URL to `market-shoonya-login`, and have the backend return an authorize URL that includes it when supported.
   - Keep the current PRISM-registered callback URL visible/copyable so the external Shoonya setup remains exact.

2. Make `/market/settings` resilient to all Shoonya return shapes
   - Capture and exchange any of these query params on return:
     - `shoonya_code`
     - `code`
     - `request_token`
   - Capture broker error params:
     - `shoonya_error`
     - `error`
     - `error_description`
   - Scrub all of those from the URL immediately after reading them so refreshes cannot replay a spent code.

3. Make the callback more tolerant
   - Support both current path-encoded callback URLs and a cleaner base callback URL fallback.
   - Decode origin tokens safely, including base64url/no-padding variants if needed.
   - Preserve the existing allowlist so it only redirects back to localhost or Lovable origins.

4. Improve user-facing diagnostics
   - If Shoonya returns to `/market/settings` without any code/error, show a precise message that PRISM did not send an authorization code and the Redirect URL in Shoonya PRISM is likely wrong.
   - Make the fallback “Shoonya login link” less ambiguous by showing which Redirect URL it expects.

5. Verify and deploy
   - Update edge function tests for:
     - raw `code` on `/market/settings`
     - `request_token`
     - callback redirect behavior
     - authorize URL includes redirect when supplied
   - Run Shoonya edge tests.
   - Deploy changed functions: `market-shoonya-login` and `shoonya-oauth-callback`.

Important boundary: if Shoonya PRISM is currently set to `https://id-preview.../market/settings` instead of the displayed Supabase callback URL, the app can now recover when Shoonya includes `?code=...`, but it cannot invent a missing code if Shoonya redirects with no query string. In that case, the final external fix is to register the app’s displayed Redirect URL in Shoonya PRISM exactly.