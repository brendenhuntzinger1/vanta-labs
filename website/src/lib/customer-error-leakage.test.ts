import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-09. src/lib/safe-error.ts exists precisely to stop this, and states the
// rule at :5-16:
//
//   "Vanta Labs must be the only brand a customer ever sees. Raw error messages
//    break that ... A Postgres error names tables and columns ("null value in
//    column customer_email of relation orders"). Routes that echo
//    `error instanceof Error ? error.message : fallback` hand all of that
//    straight to the shopper."
//
// It is adopted by ~20 customer-facing routes. Four ANONYMOUS ones still echo
// the raw message into the response body. membership/card-config shows the
// correct shape for comparison (:135-137): log the original, return fixed text.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

/** The kinds of message that must never reach a shopper. */
const LEAKY = [
  'null value in column "customer_email" of relation "orders"',
  "getaddrinfo ENOTFOUND veyragate.com",
  "supabase: JWT expired",
  "SENDGRID_API_KEY is not configured",
];

const thrower = { message: LEAKY[0] };

vi.mock("@/lib/coupons", () => ({
  validateCoupon: async () => { throw new Error(thrower.message); },
  normalizeCouponCode: (c: string) => c.trim().toUpperCase(),
  calculateCouponDiscount: () => 0,
  redeemCoupon: async () => {},
}));

// analytics/track does NOT import a website-analytics module -- it inserts
// through supabaseAdmin and throws the returned error. Mocking the wrong module
// made that case inert: the request was rejected as an unsupported event type
// long before the catch block, so the assertion passed without ever exercising
// the code under test. A negative-control mutation (E4) caught it.
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async () => ({ error: new Error(thrower.message) }),
    }),
  },
}));

// coupons/validate resolves the signed-in shopper before it validates, and
// getAuthenticatedUser reaches next/headers cookies(), which throws outside a
// request scope. Left unmocked it throws FIRST, so the route never reaches the
// error under test and the assertion passes for the wrong reason.
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => null,
}));

vi.mock("@/lib/membership", () => ({
  getMembershipPerks: async () => ({ freeShipping: false, exclusivePricing: false }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/admin-control", () => ({
  getBusinessSettings: async () => { throw new Error(thrower.message); },
  getPaymentMethodsConfig: async () => ({}),
}));

vi.mock("@/lib/email/templates", () => ({
  contactFormNotificationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  contactFormAutoReplyTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));

function post(path: string, body: unknown) {
  return new Request(`https://vanta.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.5" },
    body: JSON.stringify(body),
  });
}

const CASES: Array<[string, () => Promise<(r: Request) => Promise<Response>>, unknown]> = [
  ["/api/coupons/validate", async () => (await import("@/app/api/coupons/validate/route")).POST, { code: "SAVE10" }],
  // A VALID event type and sessionId, so the handler reaches the insert and
  // the catch block rather than short-circuiting on validation.
  ["/api/analytics/track", async () => (await import("@/app/api/analytics/track/route")).POST,
    { eventType: "page_view", pagePath: "/", sessionId: "sess-1" }],
  ["/api/contact", async () => (await import("@/app/api/contact/route")).POST, {
    firstName: "Ada", lastName: "L", email: "ada@example.test",
    subject: "Hi", message: "Hello there", startedAt: 0,
  }],
];

beforeEach(() => { thrower.message = LEAKY[0]; });

describe("I-09 — an anonymous shopper must never see a raw internal error", () => {
  for (const [path, load, body] of CASES) {
    for (const leak of LEAKY) {
      it(`${path} does not echo ${JSON.stringify(leak.slice(0, 28))}…`, async () => {
        thrower.message = leak;
        const handler = await load();
        const text = await (await handler(post(path, body))).text();

        expect(text).not.toContain(leak);
        // and specifically none of the tells safe-error.ts names
        expect(text.toLowerCase()).not.toContain("supabase");
        expect(text.toLowerCase()).not.toContain("veyragate");
        expect(text).not.toMatch(/relation "|column "/);
        expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}\b/);
      });
    }

    it(`${path} still returns a usable error shape`, async () => {
      const handler = await load();
      const response = await handler(post(path, body));
      const parsed = await response.json();

      expect(response.ok).toBe(false);
      expect(typeof parsed.error).toBe("string");
      expect(parsed.error.length).toBeGreaterThan(0);
    });
  }

  it("a genuinely shopper-written message still passes through", async () => {
    // The sanitiser is a deny-list on purpose, so useful validation text
    // survives. A fix that blanks every message would break the coupon form.
    thrower.message = "This coupon has expired.";
    const { POST } = await import("@/app/api/coupons/validate/route");
    const parsed = await (await POST(post("/api/coupons/validate", { code: "SAVE10" }))).json();

    expect(parsed.error).toBe("This coupon has expired.");
  });
});
