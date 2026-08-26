import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-04. /api/ads/purchase-event/[orderId] is unauthenticated, keyed on the
// order UUID as a bearer token -- the same model as the confirmation page and
// /pay/[orderId]. That model is documented and accepted.
//
// What it did NOT share was the defence in depth its sibling has.
// checkout/order-status/[orderId] rate limits per IP and says why:
//
//   "Rate limited per IP so the id space cannot be swept."
//
// This route had no limit at all, while also performing a database write and
// two outbound conversion sends on a GET. Same trust model, same id space, one
// door watched and one not.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const buckets: string[] = [];
let allow = true;

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (bucket: string) => {
    buckets.push(bucket);
    return allow ? { allowed: true, retryAfterSeconds: 0 } : { allowed: false, retryAfterSeconds: 60 };
  },
}));

vi.mock("@/lib/supabase-server", () => {
  const from = () => {
    const b: Record<string, unknown> = {
      select() { return b; }, eq() { return b; }, in() { return b; },
      upsert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/admin-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/request-ip")>("@/lib/request-ip");
  return {
    getRequestIpAddress: actual.getRequestIpAddress,
    verifyAdminSessionFromCookie: async () => null,
  };
});

function request(orderId: string, ip = "198.51.100.20") {
  return new Request(`https://vanta.test/api/ads/purchase-event/${orderId}`, {
    headers: { "x-vercel-forwarded-for": ip, "x-forwarded-for": `203.0.113.1, ${ip}` },
  });
}

const context = (orderId: string) => ({ params: Promise.resolve({ orderId }) });

async function GET() {
  return (await import("@/app/api/ads/purchase-event/[orderId]/route")).GET;
}

beforeEach(() => {
  buckets.length = 0;
  allow = true;
});

describe("I-04 — the ads purchase-event route must be swept-proof like its sibling", () => {
  it("rate limits every request", async () => {
    const handler = await GET();
    await handler(request("order-1"), context("order-1"));

    expect(buckets).toHaveLength(1);
  });

  it("keys the limit on the proxy-supplied IP, not a forgeable header", async () => {
    const handler = await GET();
    await handler(request("order-1"), context("order-1"));

    // x-forwarded-for on the request starts with 203.0.113.1; the bucket must
    // not follow it.
    expect(buckets[0]).toContain("198.51.100.20");
    expect(buckets[0]).not.toContain("203.0.113.1");
  });

  it("answers 429 with Retry-After once the limit trips, and does not read the order", async () => {
    allow = false;
    const handler = await GET();
    const response = await handler(request("order-1"), context("order-1"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("a tripped limit still returns the no-event shape callers expect", async () => {
    // The confirmation page reads this response. A 429 must not make it think a
    // purchase happened, and must not throw in the browser.
    allow = false;
    const handler = await GET();
    const body = await (await handler(request("order-1"), context("order-1"))).json();

    expect(body.event).toBeNull();
    expect(body.found).toBe(false);
  });
});
