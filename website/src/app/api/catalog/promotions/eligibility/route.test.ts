import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AUTH-4. POST /api/catalog/promotions/eligibility takes an arbitrary email and
// answers which per-customer-limited promotions that address has used up — an
// unauthenticated "has this email bought here?" oracle for a research-peptide
// store. Its only guard was 30 probes a minute per IP. The budget is now ten
// per ten minutes per IP; the response shapes (success, 429) are unchanged.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const limiter = {
  calls: [] as Array<{ bucket: string; limit: number; windowSeconds: number }>,
  allowed: true,
};
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (bucket: string, limit: number, windowSeconds: number) => {
    limiter.calls.push({ bucket, limit, windowSeconds });
    return { allowed: limiter.allowed, retryAfterSeconds: 60 };
  },
}));
vi.mock("@/lib/admin-auth", () => ({ getRequestIpAddress: () => "203.0.113.7" }));

const exhaustedLookups: string[] = [];
vi.mock("@/lib/bxgy-promotions", () => ({
  getBxgyPromotions: async () => [{ id: "promo-1", perCustomerLimit: 1 }],
  getExhaustedPromotionIds: async (_candidates: unknown[], input: { customerEmail: string }) => {
    exhaustedLookups.push(input.customerEmail);
    return ["promo-1"];
  },
}));
vi.mock("@/lib/bxgy-engine", () => ({ liveBxgyPromotions: (promotions: unknown[]) => promotions }));

async function probe(email: string) {
  const { POST } = await import("@/app/api/catalog/promotions/eligibility/route");
  const response = await POST(new Request("https://vanta.test/api/catalog/promotions/eligibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  limiter.calls.length = 0;
  limiter.allowed = true;
  exhaustedLookups.length = 0;
});

describe("the purchase oracle is tightly rate limited per IP", () => {
  it("spends one unit of a ten-per-ten-minutes bucket keyed on the caller's IP", async () => {
    const { ELIGIBILITY_RATE_LIMIT } = await import("@/app/api/catalog/promotions/eligibility/route");
    await probe("target@example.test");

    expect(limiter.calls).toEqual([{ bucket: "promo-eligibility:203.0.113.7", limit: 10, windowSeconds: 600 }]);
    expect(ELIGIBILITY_RATE_LIMIT).toEqual({ limit: 10, windowSeconds: 600 });
    // Tight means tight: not the 30-a-minute the audit found.
    expect(limiter.calls[0].limit * (60 / limiter.calls[0].windowSeconds)).toBeLessThan(30);
  });

  it("a throttled caller gets the same 429 body as before and no lookup runs", async () => {
    limiter.allowed = false;
    const { status, body } = await probe("target@example.test");

    expect(status).toBe(429);
    expect(body).toEqual({ success: false, error: "Too many requests." });
    expect(exhaustedLookups).toEqual([]);
  });

  it("an allowed caller still gets the unchanged success shape", async () => {
    const { status, body } = await probe("shopper@example.test");

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, exhaustedPromotionIds: ["promo-1"] });
    expect(exhaustedLookups).toEqual(["shopper@example.test"]);
  });
});
