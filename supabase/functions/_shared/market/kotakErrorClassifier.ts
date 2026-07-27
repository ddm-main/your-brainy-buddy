// Pure Kotak error classification helpers. Kept dependency-free so the same
// broker-session rules can be regression-tested outside the Deno edge runtime.

export function isKotakSessionFailure(status: number, detailText: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;

  // Kotak can use a bare "unauthorised" 403 for RMS/business rejections
  // (common on SELL flows: delivery quantity, product, segment, T2T blocks).
  // Only expire/reconnect when the body explicitly says auth/session/token is
  // missing, invalid, required, or expired.
  const detail = detailText.toLowerCase();
  return /(?:invalid|expired|missing)\s+(?:auth|token|session)|(?:auth|token|session)\s+(?:expired|invalid|missing|required)|authentication\s+(?:failed|required|expired|invalid)|access\s+token\s+(?:expired|invalid|required|missing)|jwt\s+(?:expired|invalid)/.test(detail);
}