import { describe, it, vi } from "vitest";
import { resolveCartDiscount } from "@/lib/discount-resolution";
import { resolveCustomerDiscount } from "@/lib/profit-engine";
import { getBundleDiscountedLineTotal, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";

// vitest.setup.ts globally stubs @/lib/coupons with calculateCouponDiscount:()=>0,
// so pull the REAL implementation.
const { calculateCouponDiscount } = await vi.importActual<typeof import("@/lib/coupons")>("@/lib/coupons");

function clientCoupon(subtotal: number, type: string, value: number) {
  if (subtotal <= 0 || value <= 0) return 0;
  const amount = type === "fixed" ? value : subtotal * (value / 100);
  return Math.min(Math.max(amount, 0), subtotal);
}

describe("cart vs server discount divergence", () => {
  it("fuzz percent coupons over realistic carts", () => {
    const prices = [19.99, 39.99, 44.99, 49.99, 59.99, 64.99, 79.99, 89.99, 99.99, 129.99, 24.95, 33.33, 12.49, 7.77];
    const percents = [5, 7, 10, 12, 15, 17.5, 20, 22.5, 25, 30, 33, 35, 40, 45, 50, 12.5, 7.5, 3.33, 66.67];
    const rows: string[] = [];
    let count = 0;
    for (const p of prices) {
      for (let q = 1; q <= 12; q++) {
        for (const pc of percents) {
          count++;
          const subtotal = getBundleDiscountedLineTotal(p, q, DEFAULT_BUNDLE_CONFIG);
          const fullSubtotal = p * q;
          const qbs = Math.round(Math.max(0, fullSubtotal - subtotal) * 100) / 100;

          const clientAmt = clientCoupon(fullSubtotal, "percent", pc);
          const serverAmt = calculateCouponDiscount(fullSubtotal, "percent", pc);

          const client = resolveCartDiscount({
            subtotal, quantityBundleSavings: qbs, bulkSavingsAmount: 0,
            memberPricingAmount: 0, ambassadorPersonalAmount: 0,
            couponDiscountAmount: clientAmt, promo: null,
          }).amount;

          const server = resolveCustomerDiscount({
            subtotal, fullSubtotal, quantityBundleSavings: qbs, productCost: 0,
            bundleDiscount: 0, referralAccepted: false, referralPercent: 0,
            isMember: false, membershipPercent: 0, couponDiscount: serverAmt,
            bulkSavingsAmount: 0, personalDiscountAmount: 0, allowCouponStacking: false,
            commissionPercent: 0, processingFeePercent: 0, shippingCollected: 0,
            shippingCost: 0, handlingCollected: 0, taxPercent: 0,
          }, new Set(["coupon", "referral", "bundle", "membership"] as const)).amount;

          if (Math.abs(client - server) > 0.0001) {
            rows.push(`price=${p} q=${q} pct=${pc}% full=${fullSubtotal} sub=${subtotal} qbs=${qbs} clientRaw=${clientAmt} serverRaw=${serverAmt} => cartShows=${client} serverCharges=${server} delta=${(client-server).toFixed(4)}`);
          }
        }
      }
    }
    console.log(`checked ${count} combos; DIVERGENCES: ${rows.length}`);
    rows.slice(0, 30).forEach((r) => console.log("  " + r));
  });
});
