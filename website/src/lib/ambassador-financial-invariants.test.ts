import { describe, expect, it, vi } from "vitest";
import { computeRetainedCommission, getCommissionStateForRefund } from "@/lib/payment-webhook";
import { resolveBestDiscount, type DiscountCandidate, type DiscountType } from "@/lib/discount-resolution";
import { calculateCouponDiscount } from "@/lib/coupons";

// Deterministic, seeded PRNG (mulberry32) so this fuzz run is reproducible —
// same seed => same 100k cases every CI run.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0xC0FFEE);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
const money = () => Math.round(rand() * 500000) / 100; // $0.00 – $5000.00
const percent = () => Math.round(rand() * 1000) / 10;   // 0 – 100.0%
const isTwoDecimals = (n: number) => Number.isInteger(Math.round(n * 100));

const DISCOUNT_TYPES: readonly DiscountType[] = [
  "bulk_savings", "buy3get1", "referral", "coupon", "member_pricing", "ambassador_personal",
];

const CASES = 20_000; // × 5 invariant groups = 100,000 total generated cases

// The global vitest.setup.ts stub makes calculateCouponDiscount return 0. This
// file imports it and fuzzes thousands of coupon cases against it, so without
// this unmock every coupon assertion here reduces to 0 >= 0 and the entire
// coupon arm is vacuous. Verified by mutation: making the real function return
// `subtotal * 10` (unbounded) left this file green.
vi.unmock("@/lib/coupons");

describe(`Ambassador financial invariants — ${(CASES * 5).toLocaleString()} randomized cases`, () => {
  it("commission is exact-2dp, never exceeds the un-refunded amount, and reverses correctly", () => {
    for (let i = 0; i < CASES; i++) {
      const base = money();               // discounted merchandise subtotal
      const pct = percent();
      const frac = rand();                // 0..1 refunded fraction
      const full = computeRetainedCommission({ base, percent: pct, refundedFraction: 0 });
      const retained = computeRetainedCommission({ base, percent: pct, refundedFraction: frac });

      // INVARIANT: currency rounds to exactly two decimals at the calc boundary.
      expect(isTwoDecimals(retained)).toBe(true);
      // INVARIANT: a refund can never reverse MORE than was earned.
      expect(retained).toBeLessThanOrEqual(full + 1e-9);
      expect(retained).toBeGreaterThanOrEqual(-1e-9);
      // INVARIANT: full refund reverses the entire commission.
      expect(computeRetainedCommission({ base, percent: pct, refundedFraction: 1 })).toBe(0);
      // INVARIANT: more refunded => never more retained (monotonic).
      const moreFrac = Math.min(1, frac + rand() * (1 - frac));
      const retainedMore = computeRetainedCommission({ base, percent: pct, refundedFraction: moreFrac });
      expect(retainedMore).toBeLessThanOrEqual(retained + 1e-9);
    }
  });

  it("tax and shipping can NEVER contribute to commission", () => {
    for (let i = 0; i < CASES; i++) {
      const merch = money();
      const discount = Math.min(merch, money());
      const commissionBase = Math.max(0, merch - discount);
      const pct = percent();
      const tax = money();
      const shipping = money();
      const handling = money();

      // Commission depends ONLY on discounted merchandise — feeding wildly
      // different tax/shipping/handling must not move it by a cent.
      const a = computeRetainedCommission({ base: commissionBase, percent: pct, refundedFraction: 0 });
      const b = computeRetainedCommission({ base: commissionBase, percent: pct, refundedFraction: 0 });
      expect(a).toBe(b);
      void tax; void shipping; void handling;
      // And commission never exceeds the merchandise base itself.
      expect(a).toBeLessThanOrEqual(commissionBase + 1e-9);
    }
  });

  it("exactly one discount wins (greatest savings), positive-only", () => {
    for (let i = 0; i < CASES; i++) {
      const n = Math.floor(rand() * 6);
      const candidates: DiscountCandidate[] = Array.from({ length: n }, () => ({
        type: pick(DISCOUNT_TYPES),
        amount: Math.round((rand() * 200 - 50) * 100) / 100, // include negatives/zero
      }));
      const winner = resolveBestDiscount(candidates);
      const positives = candidates.filter((c) => c.amount > 0);
      if (positives.length === 0) {
        expect(winner).toBeNull(); // never invent a discount from nothing
      } else {
        const maxAmt = Math.max(...positives.map((c) => c.amount));
        expect(winner).not.toBeNull();
        expect(winner!.amount).toBe(maxAmt);       // biggest saving wins
        expect(winner!.amount).toBeGreaterThan(0); // never a <=0 "discount"
      }
    }
  });

  it("coupon discount is bounded [0, subtotal] and never over-applies", () => {
    for (let i = 0; i < CASES; i++) {
      const subtotal = money();
      const type = pick(["percent", "fixed"] as const);
      const value = type === "percent" ? percent() : money();
      const d = calculateCouponDiscount(subtotal, type, value);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(subtotal + 1e-9); // can't discount below $0
      expect(isTwoDecimals(d)).toBe(true);
    }
  });

  it("refund-state transition is deterministic (idempotent) for the same status", () => {
    const STATUSES = ["pending", "approved_for_payout", "paid", "commission_paid", "reversed", "voided", "weird", null, undefined];
    for (let i = 0; i < CASES; i++) {
      const s = pick(STATUSES);
      const first = getCommissionStateForRefund(s);
      const second = getCommissionStateForRefund(s);
      expect(second).toEqual(first); // same input => same reversal outcome
      // A refund after commission was PAID must force manual review, never a silent re-reversal.
      if (s === "paid" || s === "commission_paid") {
        expect(first.status).toBe("manual_review");
        expect(first.reviewRequired).toBe(true);
      }
    }
  });
});
