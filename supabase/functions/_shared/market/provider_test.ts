// Unit test: getActiveProvider must return Kotak when a Kotak row is
// connected, and fall back to Yahoo when no Kotak session exists.
// Runs with `deno test --allow-net --allow-env`.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getActiveProvider } from "./provider.ts";

type Row = Record<string, unknown>;

function fakeSvc(rows: Row[]): any {
  // Minimal PostgREST-like builder chain that returns the fixture rows for
  // any `.from("market_api_settings").select(...).eq("user_id", ...)` call.
  const builder: any = {
    _rows: rows,
    select() { return builder; },
    eq() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { return Promise.resolve({ data: builder._rows[0] ?? null, error: null }); },
    then(resolve: any) { return Promise.resolve({ data: builder._rows, error: null }).then(resolve); },
  };
  return {
    from(_t: string) { return builder; },
  };
}

Deno.test("getActiveProvider — no Kotak row → yahoo", async () => {
  const svc = fakeSvc([]);
  const { provider } = await getActiveProvider(svc, "user-1");
  assertEquals(provider.name, "yahoo");
});

Deno.test("getActiveProvider — Kotak row without session → yahoo", async () => {
  const svc = fakeSvc([{
    id: "kotak-1",
    user_id: "user-1",
    active_provider: "kotak_neo",
    session_token_enc: null,
    sid: null,
    totp_secret_enc: null,
  }]);
  const { provider } = await getActiveProvider(svc, "user-1");
  assertEquals(provider.name, "yahoo");
});

Deno.test("getActiveProvider — Kotak row with live session → kotak_neo", async () => {
  const svc = fakeSvc([{
    id: "kotak-1",
    user_id: "user-1",
    active_provider: "kotak_neo",
    session_token_enc: "enc",
    sid: "sess",
    totp_secret_enc: "totp",
    consumer_key_enc: "ck",
    consumer_secret_enc: "cs",
    mobile: "9999999999",
    ucc: "UCC",
    mpin_enc: "mpin",
  }]);
  const { provider } = await getActiveProvider(svc, "user-1");
  assertEquals(provider.name, "kotak_neo");
});
