# Shoonya authentication

Verified contract used by JARVIS on 2026-07-30.

## Values in the flow

1. The user opens Shoonya authorization for the configured Client ID.
2. Password and the 6-digit TOTP are entered on Shoonya's page.
3. Shoonya returns a separate, single-use authorization `code` in its redirect.
4. JARVIS exchanges that code for the Noren session token.

A 6-digit TOTP is never sent to `GenAcsTok`.

The Redirect URL registered in Shoonya PRISM is the stable Supabase callback URL with no query string:

```text
https://ybtaxgstmxnlwurkritg.supabase.co/functions/v1/shoonya-oauth-callback
```

JARVIS sends the current app origin in OAuth `state` when opening Shoonya. The callback redirects back to `/market/settings?shoonya_code=...`, where JARVIS exchanges the code immediately. JARVIS also accepts direct Shoonya returns to `/market/settings?code=...` or `/market/settings?request_token=...` as a recovery path. If Shoonya lands directly on `/market/settings` without a code, the PRISM Redirect URL is still registered to the app page rather than the Supabase callback.

## Token exchange

```text
POST https://api.shoonya.com/NorenWClientAPI/GenAcsTok
Content-Type: text/plain

jData={
  "code": "<returned authorization code>",
  "checksum": "<sha256(client_id + secret_code + code)>",
  "uid": "<Shoonya user ID>"
}
```

Success is detected by the presence of `access_token`; when Shoonya also returns `susertoken`, JARVIS uses it as the Noren `jKey`. The response's `expires_in` is retained when it can be interpreted as an epoch or duration.

## Session behavior

- API calls use form-encoded `jData` plus `jKey`.
- A rejected session is cleared and marked expired; account calls are not silently routed through another user's broker.
- Order mutations are never automatically replayed after an ambiguous authentication failure.
- Reauthorization requires a fresh, single-use authorization code.
- The PRISM Redirect URL should not include the preview domain, `/market/settings`, or copied `state` / `redirect_uri` query parameters.

## IP whitelist requirement

Shoonya validates the IP address that calls `GenAcsTok` and later Noren API routes. Supabase Edge Functions run on shared cloud infrastructure and their outbound IP can rotate, so repeatedly copying the latest `INVALID_IP` address into PRISM is not durable.

Use the static-IP proxy instead:

1. Run `Apps/relay/shoonya-proxy.mjs` on a VPS or machine with a stable public IP.
2. Put that machine behind HTTPS, ending at `/shoonya`.
3. Set Supabase Edge secrets:
   - `SHOONYA_PROXY_URL=https://<proxy-host>/shoonya`
   - `SHOONYA_PROXY_SECRET=<same strong secret used by the proxy>`
4. Whitelist the proxy machine's public IP in Shoonya PRISM → API Key → IP whitelist.
5. Keep the PRISM Redirect URL as the Supabase callback URL above.

When the proxy secrets are absent, JARVIS falls back to direct Supabase Edge calls; Shoonya may then reject the request with `INVALID_IP` again.

## References

- Shoonya API documentation: https://shoonya.com/api-documentation
- Shoonya official Python SDK: https://github.com/Shoonya-Dev/ShoonyaApi-py