// Provider API keys — resolved from the admin-managed encrypted store first,
// falling back to the Edge Function environment secret.
//
// Keys entered in Market Config are AES-256-GCM encrypted with
// STATEMENT_ENC_SECRET and stored in public.market_provider_credentials.
// Only service-role code (this module) can decrypt them; the browser never
// receives the plaintext.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { decryptStatementPassword, type StatementPasswordRule } from "../crypto.ts";

export type KeyedProvider = "fmp" | "alpha_vantage";

const ENV_NAME: Record<KeyedProvider, string> = {
  fmp: "FINANCIAL_MODELING_PREP_API_KEY",
  alpha_vantage: "ALPHA_VANTAGE_API_KEY",
};

const CACHE_MS = 60_000;
const cache = new Map<KeyedProvider, { value: string | null; at: number }>();

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

/** Returns the API key for a provider, or null when none is configured. */
export async function getProviderKey(provider: KeyedProvider): Promise<string | null> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value: string | null = null;
  try {
    const { data } = await svc()
      .from("market_provider_credentials")
      .select("api_key_enc,key_set")
      .eq("provider", provider)
      .maybeSingle();
    if (data?.key_set && data.api_key_enc) {
      value = await decryptStatementPassword(data.api_key_enc as unknown as StatementPasswordRule);
    }
  } catch (e) {
    console.error(`[providerKeys] ${provider} lookup failed:`, e instanceof Error ? e.message : e);
  }

  if (!value) value = Deno.env.get(ENV_NAME[provider]) ?? null;
  cache.set(provider, { value, at: Date.now() });
  return value;
}

/** Drops the memo so a freshly saved key takes effect immediately. */
export function invalidateProviderKey(provider: KeyedProvider) {
  cache.delete(provider);
}

export function providerEnvName(provider: KeyedProvider): string {
  return ENV_NAME[provider];
}
