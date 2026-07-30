import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SHOONYA_BASE,
  SHOONYA_GENACSTOK_CONTENT_TYPE,
  SHOONYA_WS,
  isLikelyTotp,
  normalizeShoonyaCode,
  sha256Hex,
  shoonyaOAuthUrl,
  shoonyaInputError,
  shoonyaTokenRequest,
} from "./shoonyaClient.ts";

Deno.test("Shoonya OAuth uses the NorenWClientAPI base", () => {
  // NorenWClientTP answers `Error Occurred : 5 "no data"` for GenAcsTok.
  assertEquals(SHOONYA_BASE, "https://api.shoonya.com/NorenWClientAPI");
});

Deno.test("Shoonya OAuth streams from the API socket", () => {
  assertEquals(SHOONYA_WS, "wss://api.shoonya.com/NorenWSAPI/");
});

Deno.test("Shoonya OAuth token exchange uses text/plain jData transport", () => {
  assertEquals(SHOONYA_GENACSTOK_CONTENT_TYPE, "text/plain");
});

Deno.test("Shoonya authorize URL can carry the registered redirect", () => {
  const url = new URL(shoonyaOAuthUrl("FA207868_U", "https://project.supabase.co/functions/v1/shoonya-oauth-callback", "origin-token"));
  assertEquals(url.searchParams.get("client_id"), "FA207868_U");
  assertEquals(url.searchParams.get("redirect_uri"), "https://project.supabase.co/functions/v1/shoonya-oauth-callback");
  assertEquals(url.searchParams.get("state"), "origin-token");
});


Deno.test("normalizeShoonyaCode accepts a full redirect URL", () => {
  assertEquals(
    normalizeShoonyaCode("https://app.example/callback?state=x&code=abc%2B123&scope=api"),
    "abc+123",
  );
  assertEquals(
    normalizeShoonyaCode("https://app.example/market/settings?shoonya_code=abc%2F123"),
    "abc/123",
  );
  assertEquals(
    normalizeShoonyaCode("https://app.example/market/settings?code=raw-code"),
    "raw-code",
  );
  assertEquals(
    normalizeShoonyaCode("https://app.example/market/settings?request_token=legacy-token"),
    "legacy-token",
  );
  assertEquals(
    normalizeShoonyaCode("https://app.example/market/settings#code=fragment-code"),
    "fragment-code",
  );
});

Deno.test("Shoonya redirect errors are not exchanged as codes", () => {
  assertMatch(
    shoonyaInputError("https://app.example/market/settings?shoonya_error=Shoonya+did+not+return+an+authorization+code.") ?? "",
    /did not issue an authorization code/i,
  );
});

Deno.test("six-digit TOTP is distinguished from an authorization code", () => {
  assert(isLikelyTotp("425649"));
  assertEquals(isLikelyTotp("oauth-code-425649"), false);
});

Deno.test("GenAcsTok request includes uid and exact checksum", async () => {
  const request = await shoonyaTokenRequest("FA000001", "FA000001_U", "secret", "returned-code");
  assertEquals(request.uid, "FA000001");
  assertEquals(request.code, "returned-code");
  assertEquals(request.checksum, await sha256Hex("FA000001_Usecretreturned-code"));
  assertMatch(request.checksum, /^[a-f0-9]{64}$/);
});