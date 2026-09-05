import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE REFERRAL LINK IS THE MOST-SHARED URL THE BRAND HAS. It must never
// forward a visitor off the site, whatever rides in ?next=.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/admin-auth", () => ({ getRequestIpAddress: () => "203.0.113.9" }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: false, retryAfterSeconds: 60 }) }));
vi.mock("@/lib/referral-code-service", () => ({ resolveReferralCode: async () => null }));
vi.mock("@/lib/cookie-consent-server", () => ({ hasAnalyticsConsent: () => false }));

async function follow(next: string) {
  const { GET } = await import("@/app/r/[code]/route");
  const url = `https://www.vantalabsresearch.com/r/NOPE?next=${encodeURIComponent(next)}`;
  const response = await GET(new Request(url), { params: Promise.resolve({ code: "NOPE" }) });
  return new URL(response.headers.get("location") ?? "", "https://www.vantalabsresearch.com");
}

describe("/r/[code] ?next=", () => {
  it("keeps an internal destination", async () => {
    const dest = await follow("/products/bpc-157?ref=1");
    expect(dest.origin).toBe("https://www.vantalabsresearch.com");
    expect(dest.pathname + dest.search).toBe("/products/bpc-157?ref=1");
  });

  it.each(["/\\evil.example/steal", "//evil.example/steal", "https://evil.example/", "/\\\\evil.example"])(
    "never leaves the origin for %j",
    async (next) => {
      const dest = await follow(next);
      expect(dest.origin).toBe("https://www.vantalabsresearch.com");
      expect(dest.pathname).toBe("/products");
    },
  );
});
