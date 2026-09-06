import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A LIMITED PROMOTION STOPPED BEING LIMITED, SILENTLY.
//
// claimPromotionRedemption answers TRUE when it cannot reach the database, and
// that rule is deliberate: a claim that could not be taken must not refuse a
// sale that was priced correctly moments earlier (case 3 in bxgy-promotions.ts).
// It stays.
//
// What did not hold up is what surrounds it. Production Supabase refuses about
// 0.1% of this app's calls with a 401 whose body reads "JWT issued at future" —
// 36 in twenty-four hours on 2026-08-27, across nine different tables and RPCs,
// with the same call succeeding on the ticks either side. Every one of those
// hitting this function granted a capped promotion with no claim row: it did
// not count against "first 100 orders", and a "one free vial per customer"
// promotion could be taken again by the same shopper, repeatedly. The only
// trace was a console.error.
//
// Two changes, neither of which touches the fail-open rule:
//   * that one narrow class — refused at the EDGE, so the statement provably
//     never ran and re-issuing it cannot claim twice — is retried once, exactly
//     as inventory-reservation.ts retries it;
//   * when the claim really cannot be taken, the operator is told.
// ---------------------------------------------------------------------------

const rpc = vi.hoisted(() => vi.fn());
const alerts = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getHomepageControlConfig: async () => ({}),
  upsertControlValue: async () => {},
}));
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: Record<string, unknown>) => { alerts.push(alert); },
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }),
  },
}));

const JWT_401 = { data: null, error: { message: "JWT issued at future" } };
const TIMEOUT = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
const CLAIMED = { data: true, error: null };
const CAP_REACHED = { data: false, error: null };

const INPUT = {
  promotionId: "promo-free-vial",
  orderId: "order-1",
  customerEmail: "Shopper@Example.test",
  maxRedemptions: 100,
  perCustomerLimit: 1,
};

beforeEach(() => {
  vi.resetModules();
  rpc.mockReset();
  alerts.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a claim refused at the edge before it could run", () => {
  it("is retried once, and the retry's claim is the answer", async () => {
    rpc.mockResolvedValueOnce(JWT_401).mockResolvedValueOnce(CLAIMED);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT)).toBe(true);
    expect(rpc, "one retry, not a loop").toHaveBeenCalledTimes(2);
    expect(alerts, "a claim that succeeded on retry is not an incident").toHaveLength(0);
  });

  it("honours a retry that says the cap is reached, and refuses the order", async () => {
    // The whole point of retrying: without it this order took a redemption the
    // promotion did not have.
    rpc.mockResolvedValueOnce(JWT_401).mockResolvedValueOnce(CAP_REACHED);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT)).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("still lets the order through when both attempts are refused — and says so", async () => {
    rpc.mockResolvedValue(JWT_401);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT), "fail open, as documented").toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("promotion_claim_unenforced");
    expect(String(alerts[0].message)).toContain("promo-free-vial");
    expect((alerts[0].context as Record<string, unknown>).orderId).toBe("order-1");
  });
});

describe("a claim refused by Postgres itself", () => {
  it("is NOT retried — the statement may have run", async () => {
    // The narrowness is the safety argument: a timeout may have executed wholly
    // or partly, and re-issuing it could take a second slot.
    rpc.mockResolvedValue(TIMEOUT);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("raises the unenforced-limit alert, so the cap overrun is visible", async () => {
    rpc.mockResolvedValue(TIMEOUT);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    await claimPromotionRedemption(INPUT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].dedupeWindowMs, "a burst during one outage is one incident").toBeGreaterThan(0);
  });
});

describe("an un-migrated database", () => {
  it("keeps its own path: latched, logged once, and no per-order alert", async () => {
    // Case 1, not case 3. The operator's fix is to apply the migration, and
    // that is already reported by the promotion centre's banner.
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function bxgy_claim_redemption does not exist" } });
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(0);
  });
});

describe("the ordinary case", () => {
  it("claims once and alerts about nothing", async () => {
    rpc.mockResolvedValue(CLAIMED);
    const { claimPromotionRedemption } = await import("@/lib/bxgy-promotions");

    expect(await claimPromotionRedemption(INPUT)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(0);
  });
});
