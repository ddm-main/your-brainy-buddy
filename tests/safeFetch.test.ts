import { describe, it, expect } from "vitest";

// Mirror of isPrivateHost in supabase/functions/_shared/http.ts
const PRIVATE_HOST_RE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i;
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_HOST_RE.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const oct = parseInt(m[1], 10);
    if (oct >= 16 && oct <= 31) return true;
  }
  return false;
}

describe("isPrivateHost", () => {
  it("blocks loopback/private", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "::1", "fc00::1"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["duckduckgo.com", "api.openai.com", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});
