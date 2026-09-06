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

type Hit = { id: number; bucket: string; created_at: string };

const store = vi.hoisted(() => ({
  nextId: 1,
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
      // insert(...).select("id").maybeSingle() — the id is what lets a REFUSED
      // request withdraw its own hit, so the fake has to hand one back.
      insert: ({ bucket }: { bucket: string }) => {
        const result = (() => {
          if (store.failInsert) return { data: null, error: store.failInsert };
          const row: Hit = { id: store.nextId++, bucket, created_at: store.now() };
          store.hits.push(row);
          return { data: { id: row.id }, error: null };
        })();
        return {
          ...result,
          select: () => ({
            ...result,
            maybeSingle: async () => result,
            single: async () => result,
          }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
      },
      select: () => {
        const filters: Record<string, string> = {};
        let ordered = false;
        const chain: Record<string, unknown> = {
          eq(column: string, value: string) { filters[column] = value; return chain; },
          gt(column: string, value: string) { filters[`gt:${column}`] = value; return chain; },
          order() { ordered = true; return chain; },
          // .order().limit() is the oldest-surviving-hit lookup on the deny
          // path; it resolves to rows, not a count.
          limit(n: number) {
            const rows = store.hits
              .filter((h) => h.bucket === filters.bucket && h.created_at > filters["gt:created_at"])
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .slice(0, n)
              .map((h) => ({ created_at: h.created_at }));
            return Promise.resolve({ data: rows, error: null });
          },
          then(resolve: (v: unknown) => unknown) {
            if (ordered) return Promise.resolve(resolve({ data: [], error: null }));
            if (store.failCount) return Promise.resolve(resolve({ count: null, error: store.failCount }));
            const count = store.hits.filter(
              (h) => h.bucket === filters.bucket && h.created_at > filters["gt:created_at"],
            ).length;
            return Promise.resolve(resolve({ count, error: null }));
          },
        };
        return chain;
      },
      delete: () => ({
        // The sampled cleanup.
        lt: async () => ({ error: null }),
        // A refused request withdrawing its own hit.
        eq: async (_column: string, id: number) => {
          store.hits = store.hits.filter((h) => h.id !== id);
          return { error: null };
        },
      }),
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

const { checkRateLimit, __resetRateLimitAlertThrottle, __deniedBucketMemoSize } = await import("@/lib/rate-limit");

beforeEach(() => {
  store.hits = [];
  store.nextId = 1;
  store.failInsert = null;
  store.failCount = null;
  store.throwOnAccess = false;
  store.alerts = [];
  __resetRateLimitAlertThrottle();
  vi.useRealTimers();
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

  it("leaves behind a row for every request it SERVED, and none for the rest", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkRateLimit("coupon:burst2", 5, 60)),
    );
    const served = results.filter((r) => r.allowed).length;

    // THIS ASSERTION USED TO READ `toHaveLength(50)`, and that was the bug.
    //
    // Recording first is still what makes the count truthful under a burst —
    // every request inserts before any of them asks how big the burst is, and
    // that is untouched. What changed is what happens to the hit belonging to a
    // request the limiter then REFUSED: it is withdrawn.
    //
    // Keeping it meant every refusal pushed the trailing window forward from
    // the moment of that refusal, so a bucket never drained while anyone kept
    // trying. The person most likely to keep trying is the customer whose reset
    // email went to spam and who is clicking "Send reset link" again — and
    // since the store now requires an account to see anything, that customer
    // was locked out of the whole site with no way back.
    //
    // The cap is unchanged and is what actually protects the endpoint: at most
    // `limit` requests are SERVED per window, and only served requests leave a
    // trace.
    expect(served).toBeLessThanOrEqual(5);
    expect(store.hits.filter((h) => h.bucket === "coupon:burst2")).toHaveLength(served);
  });
});

// ---------------------------------------------------------------------------
// A REFUSAL IS NOT CONSUMPTION.
// ---------------------------------------------------------------------------

describe("a refused request does not extend the window", () => {
  it("does not record a hit for the request it turned away", async () => {
    for (let i = 0; i < 3; i += 1) await checkRateLimit("password-reset-email:a@b.test", 3, 900);
    expect(store.hits).toHaveLength(3);

    const denied = await checkRateLimit("password-reset-email:a@b.test", 3, 900);
    expect(denied.allowed).toBe(false);
    expect(store.hits, "the refused request must leave no trace").toHaveLength(3);
  });

  it("keeps refusing at the same count however many times it is asked", async () => {
    for (let i = 0; i < 3; i += 1) await checkRateLimit("password-reset-email:c@d.test", 3, 900);
    // The customer clicking "Send reset link" over and over. Before the fix,
    // every one of these recorded a hit and reset the fifteen-minute clock.
    for (let i = 0; i < 20; i += 1) await checkRateLimit("password-reset-email:c@d.test", 3, 900);
    expect(store.hits.filter((h) => h.bucket === "password-reset-email:c@d.test")).toHaveLength(3);
  });

  it("tells the caller when the bucket ACTUALLY frees up, not a blanket window", async () => {
    // Three hits, the oldest of them ten minutes into a fifteen-minute window,
    // so the honest answer is about five minutes rather than fifteen.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.hits.push(
      { id: store.nextId++, bucket: "reset:e@f.test", created_at: tenMinutesAgo },
      { id: store.nextId++, bucket: "reset:e@f.test", created_at: new Date(Date.now() - 60_000).toISOString() },
      { id: store.nextId++, bucket: "reset:e@f.test", created_at: new Date(Date.now() - 30_000).toISOString() },
    );

    const denied = await checkRateLimit("reset:e@f.test", 3, 900);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(250);
    expect(denied.retryAfterSeconds).toBeLessThan(340);
  });

  it("still caps what it SERVES, which is the protection that matters", async () => {
    let served = 0;
    for (let i = 0; i < 30; i += 1) {
      if ((await checkRateLimit("login:9.9.9.9", 5, 900)).allowed) served += 1;
    }
    expect(served, "a sustained attacker gets the limit and no more").toBe(5);
  });
});

describe("a denied bucket must not keep writing — review finding 6", () => {
  it("stops inserting once the bucket is known to be over its limit", async () => {
    // (a) WRITE AMPLIFICATION. Recording before counting is the correct fix for
    // the burst hole, but it made every request an unconditional INSERT — and
    // under exactly the abuse this exists to stop, that turns the limiter into a
    // write amplifier against the storefront's own database. analytics-ip alone
    // allows 600/min/IP.
    for (let i = 0; i < 5; i += 1) await checkRateLimit("abuse:1.2.3.4", 5, 60);
    const afterLimit = store.hits.length;

    for (let i = 0; i < 500; i += 1) await checkRateLimit("abuse:1.2.3.4", 5, 60);

    // One more insert crosses the limit and is what DISCOVERS it. Everything
    // after that is answered without touching the table.
    expect(store.hits.length - afterLimit).toBeLessThanOrEqual(1);
  });

  it("still denies every one of those requests", async () => {
    // Not writing must never mean not throttling.
    for (let i = 0; i < 6; i += 1) await checkRateLimit("abuse:deny", 5, 60);

    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await checkRateLimit("abuse:deny", 5, 60));

    expect(results.every((r) => r.allowed === false)).toBe(true);
    expect(results.every((r) => r.retryAfterSeconds === 60)).toBe(true);
  });

  it("RELEASES the bucket once the window has passed, instead of locking it out forever", async () => {
    // (b) SELF-PERPETUATING LOCKOUT. The window is TRAILING and a denied request
    // used to record a hit, so a bucket under continuous traffic could never
    // drain: every refusal pushed a fresh row into the very window being
    // measured. Fine for an IP; not fine for partner-application:${user.id} or
    // referral-code-change:${user.id}, where a partner who trips their own limit
    // stays locked out for as long as anything keeps hitting it.
    //
    // Reproduced honestly: traffic continues THROUGHOUT the window rather than
    // the store being emptied by hand. Clearing store.hits would sidestep the
    // exact mechanism under test.
    vi.useFakeTimers();
    const start = new Date("2026-08-26T12:00:00.000Z");
    vi.setSystemTime(start);

    const BUCKET = "partner-application:user-1";
    for (let i = 0; i < 4; i += 1) await checkRateLimit(BUCKET, 3, 60);
    expect((await checkRateLimit(BUCKET, 3, 60)).allowed).toBe(false);

    // Somebody keeps hitting it every 5 seconds for the whole window. Under the
    // old behaviour each of these inserted, so the trailing window never emptied.
    for (let step = 1; step <= 12; step += 1) {
      vi.setSystemTime(new Date(start.getTime() + step * 5_000));
      await checkRateLimit(BUCKET, 3, 60);
    }

    // One second past the window that the original four hits occupied.
    vi.setSystemTime(new Date(start.getTime() + 61_000));

    expect((await checkRateLimit(BUCKET, 3, 60)).allowed).toBe(true);
    vi.useRealTimers();
  });

  it("does not let the memo of denied buckets grow without bound", async () => {
    // analytics:${sessionId} mints an unbounded number of distinct buckets. A
    // per-bucket memo that never evicts is a memory leak on a long-lived
    // instance, which would be a worse bug than the one it fixes.
    for (let i = 0; i < 12_000; i += 1) {
      await checkRateLimit(`analytics:session-${i}`, 0, 60);
    }

    expect(__deniedBucketMemoSize()).toBeLessThanOrEqual(10_000);
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
