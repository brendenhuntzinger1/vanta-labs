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

// WHO THE SERVER CAN NAME THE CALLER AS. Unset by default, so every assertion
// above this line keeps running against an UNIDENTIFIED caller — which is the
// path that must still behave exactly as AUTH-4 left it.
const caller = {
  user: null as { id: string; email: string | null } | null,
  grant: null as { cartId: string; expiresAtMs: number } | null,
  authThrows: false,
};
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => {
    if (caller.authThrows) throw new Error("auth is down");
    return caller.user;
  },
}));
vi.mock("@/lib/cart-recovery-grant", () => ({
  readGuestGrantCookie: () => (caller.grant ? "grant-token" : null),
  verifyGuestRecoveryGrant: async () => caller.grant,
}));

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
  caller.user = null;
  caller.grant = null;
  caller.authThrows = false;
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

// ---------------------------------------------------------------------------
// THE FIX. The budget above is what an UNIDENTIFIED caller gets, and the tests
// above prove it is unchanged. A caller the server can name is metered on who
// they are, because the oracle only exists when the address asked about is not
// the asker's own — and because a per-IP budget is one a stranger sharing a
// carrier NAT can spend on a customer's behalf.
// ---------------------------------------------------------------------------

describe("a signed-in customer asking about their OWN address", () => {
  beforeEach(() => {
    caller.user = { id: "user-1", email: "shopper@example.test" };
  });

  it("is metered per account, on a budget an ordinary browse cannot reach", async () => {
    await probe("shopper@example.test");

    expect(limiter.calls).toEqual([
      { bucket: "promo-eligibility:self:user-1", limit: 120, windowSeconds: 600 },
    ]);
  });

  it("spends NO per-IP budget, so a stranger on the same address cannot refuse them", async () => {
    await probe("shopper@example.test");

    expect(limiter.calls.some((c) => c.bucket.includes("203.0.113.7"))).toBe(false);
  });

  it("is recognised through case and whitespace rather than probing itself", async () => {
    caller.user = { id: "user-1", email: "  Shopper@Example.TEST " };
    await probe("shopper@example.test");

    expect(limiter.calls[0].bucket).toBe("promo-eligibility:self:user-1");
  });

  it("answers ten page views in a row, which is where the old budget refused", async () => {
    for (let i = 0; i < 12; i += 1) {
      const { status } = await probe("shopper@example.test");
      expect(status).toBe(200);
    }
    expect(limiter.calls).toHaveLength(12);
    expect(new Set(limiter.calls.map((c) => c.bucket)).size).toBe(1);
  });
});

describe("a signed-in customer asking about SOMEBODY ELSE'S address", () => {
  beforeEach(() => {
    caller.user = { id: "user-1", email: "shopper@example.test" };
  });

  it("spends the tight per-account probe budget AND a per-host ceiling", async () => {
    await probe("victim@example.test");

    expect(limiter.calls).toEqual([
      { bucket: "promo-eligibility:probe:user-1", limit: 15, windowSeconds: 600 },
      { bucket: "promo-eligibility:probe-ip:203.0.113.7", limit: 60, windowSeconds: 600 },
    ]);
  });

  it("is refused with the unchanged 429 body, and no lookup runs", async () => {
    limiter.allowed = false;
    const { status, body } = await probe("victim@example.test");

    expect(status).toBe(429);
    expect(body).toEqual({ success: false, error: "Too many requests." });
    expect(exhaustedLookups).toEqual([]);
  });

  it("cannot be widened by wearing a different account from the same host", async () => {
    await probe("victim@example.test");
    caller.user = { id: "user-2", email: "second@example.test" };
    await probe("victim@example.test");

    const hostBuckets = limiter.calls.filter((c) => c.bucket.startsWith("promo-eligibility:probe-ip:"));
    expect(hostBuckets).toHaveLength(2);
    expect(new Set(hostBuckets.map((c) => c.bucket)).size).toBe(1);
  });
});

describe("a guest holding a signed cart-recovery grant", () => {
  it("is metered on the cart the grant names, not on the host", async () => {
    caller.grant = { cartId: "cart-9", expiresAtMs: Date.now() + 60_000 };
    await probe("guest@example.test");

    expect(limiter.calls).toEqual([
      { bucket: "promo-eligibility:grant:cart-9", limit: 30, windowSeconds: 600 },
    ]);
  });

  it("an account beats a grant when both are present", async () => {
    caller.user = { id: "user-1", email: "shopper@example.test" };
    caller.grant = { cartId: "cart-9", expiresAtMs: Date.now() + 60_000 };
    await probe("shopper@example.test");

    expect(limiter.calls[0].bucket).toBe("promo-eligibility:self:user-1");
  });
});

describe("the reordering does not open a new way in", () => {
  it("an oversized body is refused before it is parsed", async () => {
    const { POST } = await import("@/app/api/catalog/promotions/eligibility/route");
    const response = await POST(new Request("https://vanta.test/api/catalog/promotions/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2000000" },
      body: JSON.stringify({ email: "shopper@example.test" }),
    }));

    expect(response.status).toBe(429);
    // Refused before any budget was consulted and before any lookup ran.
    expect(limiter.calls).toEqual([]);
    expect(exhaustedLookups).toEqual([]);
  });

  it("an unparseable body is treated as no address, not as a probe", async () => {
    const { POST } = await import("@/app/api/catalog/promotions/eligibility/route");
    caller.user = { id: "user-1", email: "shopper@example.test" };
    const response = await POST(new Request("https://vanta.test/api/catalog/promotions/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "}{",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, exhaustedPromotionIds: [] });
    expect(limiter.calls[0].bucket).toBe("promo-eligibility:self:user-1");
    expect(exhaustedLookups).toEqual([]);
  });

  it("an auth backend blip falls back to the TIGHTEST budget, never the loosest", async () => {
    caller.authThrows = true;
    await probe("shopper@example.test");

    expect(limiter.calls).toEqual([
      { bucket: "promo-eligibility:203.0.113.7", limit: 10, windowSeconds: 600 },
    ]);
  });
});
