import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-15 — THE THROTTLE HAS TO HOLD UNDER THE TRAFFIC IT EXISTS TO STOP.
//
// Two independent defects in one 40-line module:
//
//   (a) It failed open on any storage error with no log, no alert and no
//       distinguishable return value. "Under the limit" and "the rate-limit
//       table is unreachable" looked identical to every caller. If the table
//       were ever dropped or unmigrated, EVERY rate limit in the application
//       would be off, on every route, silently. (rate_limit_hits DOES exist in
//       production — verified this session — so that worst case is not live.
//       The silence is.)
//
//   (b) It SELECTed the count and then INSERTed. Two hundred requests arriving
//       together all read a count below the limit, all passed, and all then
//       inserted. The effective limit under a concurrent burst was UNBOUNDED —
//       it only ever throttled serial traffic, and automated abuse is
//       concurrent by construction.
//
// Behind that gate: coupon-code enumeration (the only barrier — codes are minted
// as SAVE-XXXX and matched case-insensitively), order creation, payment
// submission, wallet session minting, and two unauthenticated email-sending
// forms.
//
// Fail-open is KEPT. It is a documented, deliberate posture — an abuse
// speed-bump must not take down checkout, and admin login has its own separate
// mechanism. What is fixed is the silence and the arithmetic.
// ---------------------------------------------------------------------------

type Hit = { bucket: string; created_at: string };

const store = vi.hoisted(() => ({
  hits: [] as Hit[],
  failInsert: null as null | { message: string },
  failCount: null as null | { message: string },
  throwOnAccess: false,
  alerts: [] as Array<{ type: string; severity: string }>,
  /** Serialises nothing: every call sees the store as it is at that instant. */
  now: () => new Date().toISOString(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string }) => {
    store.alerts.push({ type: alert.type, severity: alert.severity });
  },
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (store.throwOnAccess) throw new Error("connection reset");
    if (table !== "rate_limit_hits") throw new Error(`unexpected table ${table}`);
    const builder: Record<string, unknown> = {
      insert: async ({ bucket }: { bucket: string }) => {
        if (store.failInsert) return { error: store.failInsert };
        store.hits.push({ bucket, created_at: store.now() });
        return { error: null };
      },
      select: () => {
        const filters: Record<string, string> = {};
        const chain: Record<string, unknown> = {
          eq(column: string, value: string) { filters[column] = value; return chain; },
          gt(column: string, value: string) { filters[`gt:${column}`] = value; return chain; },
          then(resolve: (v: unknown) => unknown) {
            if (store.failCount) return Promise.resolve(resolve({ count: null, error: store.failCount }));
            const count = store.hits.filter(
              (h) => h.bucket === filters.bucket && h.created_at > filters["gt:created_at"],
            ).length;
            return Promise.resolve(resolve({ count, error: null }));
          },
        };
        return chain;
      },
      delete: () => ({ lt: async () => ({ error: null }) }),
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

const { checkRateLimit, __resetRateLimitAlertThrottle } = await import("@/lib/rate-limit");

beforeEach(() => {
  store.hits = [];
  store.failInsert = null;
  store.failCount = null;
  store.throwOnAccess = false;
  store.alerts = [];
  __resetRateLimitAlertThrottle();
  // The cleanup sampler must not fire during a measurement.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

describe("the limit holds under a serial run", () => {
  it("allows exactly `limit` requests and then denies", async () => {
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await checkRateLimit("coupon:1.2.3.4", 5, 60));

    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results.slice(5).every((r) => r.allowed)).toBe(false);
    expect(results[5].retryAfterSeconds).toBe(60);
  });

  it("keeps buckets independent", async () => {
    for (let i = 0; i < 5; i += 1) await checkRateLimit("a", 5, 60);

    expect((await checkRateLimit("a", 5, 60)).allowed).toBe(false);
    expect((await checkRateLimit("b", 5, 60)).allowed).toBe(true);
  });
});

describe("the limit holds under a CONCURRENT burst — K-15b", () => {
  /**
   * THE DEFECT. With count-then-insert, all 200 read a count of 0, all pass, and
   * all then insert: 200 allowed against a limit of 5.
   */
  it("does not let a burst of 200 walk through a limit of 5", async () => {
    const burst = await Promise.all(
      Array.from({ length: 200 }, () => checkRateLimit("coupon:burst", 5, 60)),
    );

    const allowed = burst.filter((r) => r.allowed).length;

    // AT MOST five. Under the perfect simultaneity this fake produces — every
    // insert lands before any count — the answer is zero, and that is correct
    // and safe: a burst that big is the abuse the gate exists to stop. Real
    // traffic interleaves, so some pass; the serial test above is what proves
    // legitimate traffic is not locked out.
    expect(allowed).toBeLessThanOrEqual(5);
    // The pre-fix behaviour was 200. Anything near the burst size is the defect.
    expect(allowed).toBeLessThan(50);
  });

  it("lets legitimate traffic through while a burst is in flight, once the window rolls", async () => {
    await Promise.all(Array.from({ length: 200 }, () => checkRateLimit("coupon:burst3", 5, 60)));
    // A different visitor is a different bucket, and must be unaffected.
    expect((await checkRateLimit("coupon:someone-else", 5, 60)).allowed).toBe(true);
  });

  it("every request in the burst is counted, allowed or not", async () => {
    await Promise.all(Array.from({ length: 50 }, () => checkRateLimit("coupon:burst2", 5, 60)));

    // Recording first is what makes the count truthful. A denied request still
    // costs a row — the deliberate trade, and the safe direction.
    expect(store.hits.filter((h) => h.bucket === "coupon:burst2")).toHaveLength(50);
  });
});

describe("failing open is loud — K-15a", () => {
  it("still allows the request when the count cannot be read", async () => {
    store.failCount = { message: 'relation "rate_limit_hits" does not exist' };

    const result = await checkRateLimit("checkout", 5, 60);

    // The posture is deliberate: a limiter outage must not take down checkout.
    expect(result.allowed).toBe(true);
  });

  it("says so, instead of looking like 'under the limit'", async () => {
    store.failCount = { message: 'relation "rate_limit_hits" does not exist' };

    const result = await checkRateLimit("checkout", 5, 60);

    expect(result.degraded).toBe(true);
    expect(store.alerts).toContainEqual({ type: "rate_limit_degraded", severity: "critical" });
  });

  it("raises the alarm when the hit cannot be recorded either", async () => {
    store.failInsert = { message: "permission denied for table rate_limit_hits" };

    const result = await checkRateLimit("checkout", 5, 60);

    expect(result).toMatchObject({ allowed: true, degraded: true });
    expect(store.alerts).toHaveLength(1);
  });

  it("raises the alarm when the client throws outright", async () => {
    store.throwOnAccess = true;

    const result = await checkRateLimit("checkout", 5, 60);

    expect(result).toMatchObject({ allowed: true, degraded: true });
    expect(store.alerts).toHaveLength(1);
  });

  it("does not bury the signal under one alert per request", async () => {
    store.failCount = { message: "down" };

    for (let i = 0; i < 25; i += 1) await checkRateLimit("checkout", 5, 60);

    // An outage hits every route at once. One alert per five minutes.
    expect(store.alerts).toHaveLength(1);
  });

  /**
   * NEGATIVE CONTROL. A healthy limiter must never report degraded, or the
   * signal means nothing.
   */
  it("never reports degraded on the happy path", async () => {
    const ok = await checkRateLimit("healthy", 5, 60);
    const denied = await Promise.all(
      Array.from({ length: 10 }, () => checkRateLimit("healthy", 1, 60)),
    );

    expect(ok.degraded).toBeUndefined();
    expect(denied.some((r) => r.degraded)).toBe(false);
    expect(store.alerts).toHaveLength(0);
  });
});
