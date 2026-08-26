import { describe, it, vi } from "vitest";
import { resolveCartDiscount } from "@/lib/discount-resolution";
import { resolveCustomerDiscount } from "@/lib/profit-engine";
import { getBundleDiscountedLineTotal, getBundleDiscountedUnitPrice, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { calculateCardProcessingFee, DEFAULT_CARD_PROCESSING_FEE } from "@/lib/payment-methods";

const { calculateCouponDiscount } = await vi.importActual<typeof import("@/lib/coupons")>("@/lib/coupons");
const R = (v: number) => Math.round(v * 100) / 100;

function clientCoupon(subtotal: number, value: number) {
  if (subtotal <= 0 || value <= 0) return 0;
  return Math.min(Math.max(subtotal * (value / 100), 0), subtotal);
}

type Line = { price: number; qty: number };

// --- CLIENT (cart-context.tsx + app/checkout/page.tsx) ---
function clientTotals(lines: Line[], couponPct: number, protection: boolean) {
  const subtotal = lines.reduce((s, l) => s + getBundleDiscountedLineTotal(l.price, l.qty, DEFAULT_BUNDLE_CONFIG), 0);
  const fullSubtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const qbs = Math.round(Math.max(0, fullSubtotal - subtotal) * 100) / 100;
  const couponAmt = clientCoupon(fullSubtotal, couponPct);
  const discountAmount = resolveCartDiscount({
    subtotal, quantityBundleSavings: qbs, bulkSavingsAmount: 0,
    memberPricingAmount: 0, ambassadorPersonalAmount: 0,
    couponDiscountAmount: couponAmt, promo: null,
  }).amount;
  const shipping = calculateShipping(subtotal, "United States", DEFAULT_SHIPPING_CONFIG);
  const totalBeforeCredit = Math.max(0, subtotal + shipping + 0 - discountAmount);
  const fee = protection ? calculateShippingProtectionFee(subtotal) : 0;
  const total = Math.max(0, totalBeforeCredit) + fee;                 // expectedTotal sent to server
  const cardFee = calculateCardProcessingFee(total, DEFAULT_CARD_PROCESSING_FEE);
  return { subtotal, discountAmount, total, finalTotal: Math.max(0, total + cardFee.amount) };
}

// --- SERVER (quote-order.ts) ---
function serverTotals(lines: Line[], couponPct: number, protection: boolean) {
  const priced = lines.map((l) => ({ unit: getBundleDiscountedUnitPrice(l.price, l.qty, DEFAULT_BUNDLE_CONFIG), base: l.price, qty: l.qty }));
  const subtotal = R(priced.reduce((s, l) => s + l.unit * l.qty, 0));
  const fullSubtotal = R(priced.reduce((s, l) => s + l.base * l.qty, 0));
  const qbs = R(Math.max(0, fullSubtotal - subtotal));
  const couponAmt = calculateCouponDiscount(fullSubtotal, "percent", couponPct);
  const discountAmount = resolveCustomerDiscount({
    subtotal, fullSubtotal, quantityBundleSavings: qbs, productCost: 0,
    bundleDiscount: 0, referralAccepted: false, referralPercent: 0,
    isMember: false, membershipPercent: 0, couponDiscount: couponAmt,
    bulkSavingsAmount: 0, personalDiscountAmount: 0, allowCouponStacking: false,
    commissionPercent: 0, processingFeePercent: 0, shippingCollected: 0,
    shippingCost: 0, handlingCollected: 0, taxPercent: 0,
  }, new Set(["coupon", "referral", "bundle", "membership"] as const)).amount;
  const shipping = R(calculateShipping(subtotal, "United States", DEFAULT_SHIPPING_CONFIG));
  const totalBeforePoints = R(subtotal + shipping + 0 - discountAmount);
  const totalAfterCredit = R(Math.max(0, totalBeforePoints - 0));
  const fee = protection ? calculateShippingProtectionFee(subtotal) : 0;
  const expectedTotal = R(Math.max(0, totalAfterCredit - 0) + fee);
  const cardFee = calculateCardProcessingFee(expectedTotal, DEFAULT_CARD_PROCESSING_FEE);
  return { subtotal, discountAmount, expectedTotal, finalTotal: R(expectedTotal + cardFee.amount) };
}

describe("full checkout total: cart preview vs server charge", () => {
  it("fuzz", () => {
    const prices = [19.99, 24.95, 33.33, 39.99, 44.99, 49.99, 59.99, 64.99, 79.99, 89.99, 99.99, 129.99, 7.77, 12.49];
    const pcts = [10, 12.5, 15, 20, 22.5, 25, 30, 33, 35, 45, 50];
    let worst = 0; const trips: string[] = []; const shown: string[] = []; let n = 0;
    for (const a of prices) for (const b of prices) for (let qa = 1; qa <= 4; qa++) for (let qb = 0; qb <= 4; qb++) for (const pc of pcts) {
      const lines: Line[] = qb === 0 ? [{ price: a, qty: qa }] : [{ price: a, qty: qa }, { price: b, qty: qb }];
      n++;
      const c = clientTotals(lines, pc, true);
      const s = serverTotals(lines, pc, true);
      const d = R(c.finalTotal) - s.finalTotal;
      if (Math.abs(d) > Math.abs(worst)) worst = d;
      // The anti-tamper guard in quote-order.ts:783
      if (c.total < s.expectedTotal - 0.01) trips.push(`${JSON.stringify(lines)} pct=${pc} clientTotal=${c.total} serverExpected=${s.expectedTotal}`);
      if (Math.abs(d) >= 0.02) shown.push(`${JSON.stringify(lines)} pct=${pc} cartFinal=${R(c.finalTotal)} charged=${s.finalTotal} delta=${d.toFixed(4)} (clientDisc=${c.discountAmount} serverDisc=${s.discountAmount})`);
    }
    console.log(`combos=${n} worstDelta=${worst.toFixed(4)} guardTrips=${trips.length} deltaGE2c=${shown.length}`);
    trips.slice(0, 5).forEach((t) => console.log("  TRIP " + t));
    shown.slice(0, 12).forEach((t) => console.log("  DIFF " + t));
  });
});
