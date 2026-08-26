import { describe, expect, it, vi } from "vitest";
import {
  computeProfit,
  resolveCustomerDiscount,
  protectProfit,
  DEFAULT_PROFIT_SETTINGS,
  type OrderInputs,
  type DiscountComponent,
} from "@/lib/profit-engine";
import { resolveRefundOutcome, computeRetainedCommission } from "@/lib/payment-webhook";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { calculateTaxAmount as calculateTax } from "@/lib/sales-tax";
import {
  getBundleDiscountedUnitPrice,
  getBundleDiscountedLineTotal,
  bundleDiscountRate,
  DEFAULT_BUNDLE_CONFIG,
} from "@/lib/bundle-pricing";
import { calculateBulkSavingsDiscount, DEFAULT_BULK_SAVINGS_CONFIG } from "@/lib/bulk-savings";
import { calculateCouponDiscount } from "@/lib/coupons";
import { netOrderRevenue } from "@/lib/ledger";

// ============================================================================
// PROPERTY-BASED / FUZZ INVARIANTS
// ----------------------------------------------------------------------------
// Every pure money/commission/refund/shipping/ledger function is driven with
// tens of thousands of randomized inputs from a SEEDED PRNG, so the run is
// exhaustive AND perfectly repeatable (same seed -> same cases every run).
// We assert INVARIANTS that must hold for ALL inputs — far stronger than
// re-running one hand-picked example. Total ≈ ITER × #properties randomized
// cases, each verifying several invariants. A fast throwing `check()` is used
// in the hot loop (vitest's expect() is ~100× slower per call).
// ============================================================================

const ITER = 150_000;
const EPS = 1e-9;
const TIMEOUT = { timeout: 60_000 };

// Deterministic PRNG (mulberry32) — no Math.random, so runs are reproducible.
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

let CASES = 0;
function check(cond: boolean, msg: () => string) {
  if (!cond) throw new Error(msg());
}
const isMoney = (x: number) => Number.isFinite(x) && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const round2 = (x: number) => Math.round(x * 100) / 100;

function makeRng(seed: number) {
  const r = mulberry32(seed);
  return {
    f: (min: number, max: number) => min + r() * (max - min),
    money: (max: number) => Math.round(r() * max * 100) / 100,
    int: (min: number, max: number) => Math.floor(min + r() * (max - min + 1)),
    bool: () => r() < 0.5,
    pick: <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)],
  };
}

function randomOrderInputs(g: ReturnType<typeof makeRng>): OrderInputs {
  const subtotal = g.money(3000);
  return {
    subtotal,
    productCost: g.money(subtotal),
    bundleDiscount: g.bool() ? g.money(subtotal * 0.25) : 0,
    referralAccepted: g.bool(),
    referralPercent: g.pick([0, 5, 8, 10, 12, 15]),
    bundleReferralPercent: g.pick([0, 5]),
    isMember: g.bool(),
    membershipPercent: g.pick([0, 5, 10, 15]),
    couponDiscount: g.bool() ? g.money(subtotal * 0.3) : 0,
    bulkSavingsAmount: g.bool() ? g.money(subtotal * 0.12) : 0,
    personalDiscountAmount: g.bool() ? g.money(subtotal * 0.2) : 0,
    personalDiscountPercent: g.pick([0, 10, 20]),
    allowCouponStacking: g.bool(),
    commissionPercent: g.pick([0, 5, 10, 15, 20, 25]),
    processingFeePercent: g.pick([0, 3, 5, 10]),
    shippingCollected: g.pick([0, 15, 60]),
    shippingCost: g.pick([0, 8, 10, 20]),
    handlingCollected: 0,
    taxPercent: g.pick([0, 6.5, 8.25, 10]),
  };
}

const ALL = new Set<DiscountComponent>(["coupon", "referral", "bundle", "membership"]);

// The global vitest.setup.ts stub makes calculateCouponDiscount return 0. This
// file imports it and fuzzes thousands of coupon cases against it, so without
// this unmock every coupon assertion here reduces to 0 >= 0 and the entire
// coupon arm is vacuous. Verified by mutation: making the real function return
// `subtotal * 10` (unbounded) left this file green.
vi.unmock("@/lib/coupons");

describe(`fuzz: profit engine invariants (${ITER.toLocaleString()} cases each)`, () => {
  it("computeProfit: money fields well-formed and P&L identity holds", TIMEOUT, () => {
    const g = makeRng(0xc0ffee);
    for (let i = 0; i < ITER; i++) {
      const inp = randomOrderInputs(g);
      const d = resolveCustomerDiscount(inp, ALL);
      const p = computeProfit(inp, d);
      check(d.amount >= 0 && d.amount <= inp.subtotal + EPS, () => `discount out of range: ${d.amount}/${inp.subtotal}`);
      check(p.discountedSubtotal >= 0 && p.discountedSubtotal <= inp.subtotal + EPS, () => `discountedSubtotal ${p.discountedSubtotal}`);
      check(inp.referralAccepted || p.commission === 0, () => `commission ${p.commission} without referral`);
      check(p.commission >= 0 && p.commission <= p.discountedSubtotal + EPS, () => `commission ${p.commission} > base ${p.discountedSubtotal}`);
      check(p.taxCollected >= 0 && p.processingFee >= 0, () => `neg tax/fee`);
      check(p.amountCharged >= p.revenue - EPS, () => `charge ${p.amountCharged} < revenue ${p.revenue}`);
      const expected = round2(p.revenue - p.productCost - p.processingFee - p.commission - p.shippingCost);
      check(Math.abs(p.grossProfit - expected) < 1e-6, () => `grossProfit ${p.grossProfit} != ${expected}`);
      for (const v of [p.discountedSubtotal, p.commission, p.revenue, p.processingFee, p.taxCollected, p.amountCharged, p.grossProfit]) {
        check(isMoney(v), () => `not 2dp money: ${v}`);
      }
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("resolveCustomerDiscount: single best discount (or +coupon when stacking)", TIMEOUT, () => {
    const g = makeRng(0x1234);
    for (let i = 0; i < ITER; i++) {
      const inp = randomOrderInputs(g);
      const d = resolveCustomerDiscount(inp, ALL);
      check(d.amount >= 0 && d.amount <= inp.subtotal + EPS, () => `amount ${d.amount}`);
      check(isMoney(d.amount), () => `not money ${d.amount}`);
      if (!inp.allowCouponStacking) {
        const removable = d.components.filter((c) => c === "coupon" || c === "referral" || c === "bundle");
        check(removable.length <= 1, () => `>1 removable: ${d.components.join(",")}`);
      }
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("protectProfit: finalizable => meets floor; removing promos only raises profit", TIMEOUT, () => {
    const g = makeRng(0xbeef);
    for (let i = 0; i < ITER; i++) {
      const inp = randomOrderInputs(g);
      const guarded = protectProfit(inp, DEFAULT_PROFIT_SETTINGS);
      if (guarded.profitable) {
        check(guarded.grossProfit >= DEFAULT_PROFIT_SETTINGS.minProfitDollars - EPS, () => `finalized below floor: ${guarded.grossProfit}`);
        check(guarded.blockedReason === null, () => `profitable but blockedReason set`);
      } else {
        check(guarded.blockedReason !== null, () => `blocked but no reason`);
      }
      const withAll = computeProfit(inp, resolveCustomerDiscount(inp, ALL));
      check(guarded.grossProfit >= withAll.grossProfit - 1e-6, () => `guard lowered profit ${guarded.grossProfit} < ${withAll.grossProfit}`);
      check(!guarded.removed.includes("membership"), () => `removed membership`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });
});

describe(`fuzz: refund / commission invariants (${ITER.toLocaleString()} cases each)`, () => {
  const REFUND = ["refund.completed", "chargeback.created", "chargeback.lost", "payment.canceled", "payment.failed"];
  const NON = ["payment.succeeded", "payment.pending", "unknown.event"];
  const statusFor = (e: string) =>
    e === "refund.completed" || e.startsWith("chargeback") ? "refunded"
      : e === "payment.canceled" ? "canceled"
      : e === "payment.failed" ? "payment_failed"
      : "paid";

  it("resolveRefundOutcome: bounded amount, valid fraction, partial/full/chargeback rules", TIMEOUT, () => {
    const g = makeRng(0x5eed);
    for (let i = 0; i < ITER; i++) {
      const amountPaid = g.money(1500);
      const merchandiseBase = g.money(amountPaid);
      const existing = g.money(amountPaid);
      const isRefund = g.bool();
      const eventType = isRefund ? g.pick(REFUND) : g.pick(NON);
      const nextStatus = statusFor(eventType) as never;
      const refundEventAmount = g.bool() ? g.money(amountPaid * 1.2) : 0;
      const o = resolveRefundOutcome({ eventType, nextStatus, refundEventAmount, amountPaid, merchandiseBase, existingRefundAmount: existing });
      check(o.refundedFraction >= 0 && o.refundedFraction <= 1, () => `fraction ${o.refundedFraction}`);
      check(o.recordedRefundAmount >= 0 && o.recordedRefundAmount <= amountPaid + EPS, () => `recorded ${o.recordedRefundAmount}/${amountPaid}`);
      check(isMoney(o.recordedRefundAmount), () => `recorded not money`);
      if (!NON.includes(eventType)) {
        if (eventType.startsWith("chargeback")) {
          check(o.isFullRefund && o.refundedFraction === 1 && o.paymentStatus === "refunded", () => `chargeback not full`);
        }
        if (o.paymentStatus === "partially_refunded") check(!o.isFullRefund && !o.shouldRestock, () => `partial restocked`);
        if (o.isFullRefund) check(o.shouldRestock, () => `full without restock`);
      } else {
        check(!o.isRefundEvent && !o.shouldRestock, () => `non-refund treated as refund`);
      }
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("computeRetainedCommission: within [0, full], monotonically decreasing in refund fraction", TIMEOUT, () => {
    const g = makeRng(0xabcd);
    for (let i = 0; i < ITER; i++) {
      const base = g.money(1000);
      const percent = g.pick([0, 5, 10, 15, 20, 25]);
      const full = round2(base * (percent / 100));
      const f1 = g.f(0, 1);
      const f2 = Math.min(1, f1 + g.f(0, 1));
      const r1 = computeRetainedCommission({ base, percent, refundedFraction: f1 });
      const r2 = computeRetainedCommission({ base, percent, refundedFraction: f2 });
      check(r1 >= 0 && r1 <= full + EPS, () => `retained ${r1}/${full}`);
      check(isMoney(r1), () => `retained not money`);
      check(r2 <= r1 + 1e-6, () => `more refunded kept more: ${r2} > ${r1}`);
      check(computeRetainedCommission({ base, percent, refundedFraction: 1 }) === 0, () => `full refund kept commission`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });
});

describe(`fuzz: pricing / shipping / tax / ledger invariants (${ITER.toLocaleString()} cases each)`, () => {
  it("calculateShipping: free at/above threshold, flat fee below, never negative", TIMEOUT, () => {
    const g = makeRng(0x11);
    const cfg = DEFAULT_SHIPPING_CONFIG;
    for (let i = 0; i < ITER; i++) {
      const subtotal = g.money(1500);
      const zone = g.pick(["domestic", "north_america", "international"] as const);
      const country = zone === "domestic" ? "United States" : zone === "north_america" ? "Canada" : "Germany";
      const ship = calculateShipping(subtotal, country, cfg);
      check(ship >= 0, () => `neg ship`);
      const expected = subtotal <= 0 ? 0
        : zone === "domestic" ? (subtotal >= cfg.freeShippingThreshold ? 0 : cfg.domesticFee)
        : zone === "north_america" ? (subtotal >= cfg.northAmericaFreeShippingThreshold ? 0 : cfg.northAmericaFee)
        : (subtotal >= cfg.internationalFreeShippingThreshold ? 0 : cfg.internationalFee);
      check(ship === expected, () => `ship ${ship} != ${expected} (zone ${zone})`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("calculateTax: exact rate, non-negative, zero on empty base/rate", TIMEOUT, () => {
    const g = makeRng(0x22);
    for (let i = 0; i < ITER; i++) {
      const base = g.money(2000);
      const rate = g.pick([0, 6.5, 8.25, 10, 25]);
      const tax = calculateTax(base, rate);
      check(tax >= 0 && isMoney(tax), () => `tax ${tax}`);
      const expected = base <= 0 || rate <= 0 ? 0 : round2(base * (rate / 100));
      check(Math.abs(tax - expected) < 1e-6, () => `tax ${tax} != ${expected}`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("bundle pricing: discounted unit <= list; rate non-decreasing in quantity", TIMEOUT, () => {
    const g = makeRng(0x33);
    for (let i = 0; i < ITER; i++) {
      const unit = g.money(500);
      const qty = g.int(1, 15);
      const unitDisc = getBundleDiscountedUnitPrice(unit, qty, DEFAULT_BUNDLE_CONFIG);
      const line = getBundleDiscountedLineTotal(unit, qty, DEFAULT_BUNDLE_CONFIG);
      check(unitDisc >= 0 && unitDisc <= unit + EPS, () => `unit ${unitDisc}/${unit}`);
      check(line <= unit * qty + EPS, () => `line ${line} > ${unit * qty}`);
      check(isMoney(unitDisc) && isMoney(line), () => `bundle not money`);
      check(bundleDiscountRate(qty, DEFAULT_BUNDLE_CONFIG) >= bundleDiscountRate(qty - 1, DEFAULT_BUNDLE_CONFIG) - EPS, () => `rate dropped at qty ${qty}`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("bulk savings + coupon: discounts bounded by [0, subtotal]", TIMEOUT, () => {
    const g = makeRng(0x44);
    for (let i = 0; i < ITER; i++) {
      const subtotal = g.money(3000);
      const bulk = calculateBulkSavingsDiscount(subtotal, g.bool(), DEFAULT_BULK_SAVINGS_CONFIG);
      check(bulk.amount >= 0 && bulk.amount <= subtotal + EPS && isMoney(bulk.amount), () => `bulk ${bulk.amount}`);
      const type = g.bool() ? "fixed" : "percent";
      const value = type === "fixed" ? g.money(4000) : g.f(0, 150);
      const coupon = calculateCouponDiscount(subtotal, type, value);
      check(coupon >= 0 && coupon <= subtotal + EPS && isMoney(coupon), () => `coupon ${coupon}/${subtotal}`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });

  it("ledger.netOrderRevenue: clamped to [0, amount_paid]", TIMEOUT, () => {
    const g = makeRng(0x55);
    for (let i = 0; i < ITER; i++) {
      const paid = g.money(2000);
      const refunded = g.money(paid * 1.5);
      const net = netOrderRevenue({ amount_paid: paid, refund_amount: refunded });
      check(net >= 0 && net <= paid + EPS, () => `net ${net}/${paid}`);
      check(Math.abs(net - round2(Math.max(0, paid - refunded))) < 1e-6, () => `net mismatch`);
      CASES++;
    }
    expect(CASES).toBeGreaterThan(0);
  });
});

describe("fuzz: coverage summary", () => {
  it("reports the total number of randomized cases exercised", () => {
    // 10 properties × ITER, run above. Confirms the fuzzer actually ran.
    expect(CASES).toBeGreaterThanOrEqual(ITER * 9);
    console.log(`\n  ✓ fuzz-invariants exercised ${CASES.toLocaleString()} randomized cases (seeded, reproducible)\n`);
  });
});
