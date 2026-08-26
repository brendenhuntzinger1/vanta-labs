import { describe, it, vi } from "vitest";
import { resolveCartDiscount } from "@/lib/discount-resolution";
import { resolveCustomerDiscount } from "@/lib/profit-engine";
import { getBundleDiscountedLineTotal, getBundleDiscountedUnitPrice, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
const { calculateCouponDiscount } = await vi.importActual<typeof import("@/lib/coupons")>("@/lib/coupons");
const R = (v: number) => Math.round(v * 100) / 100;
type Line = { price: number; qty: number };

function client(lines: Line[], pc: number) {
  const subtotal = lines.reduce((s, l) => s + getBundleDiscountedLineTotal(l.price, l.qty, DEFAULT_BUNDLE_CONFIG), 0);
  const fullSubtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const qbs = Math.round(Math.max(0, fullSubtotal - subtotal) * 100) / 100;
  const couponRaw = Math.min(Math.max(fullSubtotal * (pc / 100), 0), fullSubtotal);
  const discountAmount = resolveCartDiscount({ subtotal, quantityBundleSavings: qbs, bulkSavingsAmount: 0, memberPricingAmount: 0, ambassadorPersonalAmount: 0, couponDiscountAmount: couponRaw, promo: null }).amount;
  const shipping = calculateShipping(subtotal, "United States", DEFAULT_SHIPPING_CONFIG);
  const fee = calculateShippingProtectionFee(subtotal);
  const total = Math.max(0, Math.max(0, subtotal + shipping - discountAmount)) + fee;
  return { subtotal, fullSubtotal, qbs, couponRaw, discountAmount, shipping, fee, total };
}
function server(lines: Line[], pc: number) {
  const subtotal = R(lines.reduce((s, l) => s + getBundleDiscountedUnitPrice(l.price, l.qty, DEFAULT_BUNDLE_CONFIG) * l.qty, 0));
  const fullSubtotal = R(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const qbs = R(Math.max(0, fullSubtotal - subtotal));
  const couponRaw = calculateCouponDiscount(fullSubtotal, "percent", pc);
  const discountAmount = resolveCustomerDiscount({ subtotal, fullSubtotal, quantityBundleSavings: qbs, productCost: 0, bundleDiscount: 0, referralAccepted: false, referralPercent: 0, isMember: false, membershipPercent: 0, couponDiscount: couponRaw, bulkSavingsAmount: 0, personalDiscountAmount: 0, allowCouponStacking: false, commissionPercent: 0, processingFeePercent: 0, shippingCollected: 0, shippingCost: 0, handlingCollected: 0, taxPercent: 0 }, new Set(["coupon","referral","bundle","membership"] as const)).amount;
  const shipping = R(calculateShipping(subtotal, "United States", DEFAULT_SHIPPING_CONFIG));
  const fee = calculateShippingProtectionFee(subtotal);
  const expectedTotal = R(R(Math.max(0, R(subtotal + shipping - discountAmount))) + fee);
  return { subtotal, fullSubtotal, qbs, couponRaw, discountAmount, shipping, fee, expectedTotal };
}

describe("Altered total detected", () => {
  it("integer-percent coupons only", () => {
    const prices = [19.99, 24.95, 29.99, 33.33, 39.99, 44.99, 49.99, 59.99, 64.99, 69.99, 79.99, 89.99, 99.99, 109.99, 129.99, 149.99];
    const pcts = [5,10,15,20,25,30,35,40,45,50];
    const trips: string[] = []; let n = 0;
    for (const a of prices) for (const b of prices) for (let qa=1; qa<=6; qa++) for (let qb=0; qb<=6; qb++) for (const pc of pcts) {
      const lines: Line[] = qb === 0 ? [{price:a,qty:qa}] : [{price:a,qty:qa},{price:b,qty:qb}];
      n++;
      const c = client(lines, pc), s = server(lines, pc);
      if (c.total < s.expectedTotal - 0.01) trips.push(`${JSON.stringify(lines)} pct=${pc}%  clientTotal=${c.total} serverExpected=${s.expectedTotal} clientDisc=${c.discountAmount} serverDisc=${s.discountAmount} couponRaw c=${c.couponRaw} s=${s.couponRaw} qbs c=${c.qbs} s=${s.qbs}`);
    }
    console.log(`combos=${n} TRIPS=${trips.length}`);
    trips.slice(0,10).forEach(t => console.log("  " + t));
  });

  it("single trace", () => {
    const lines: Line[] = [{price:19.99,qty:2},{price:129.99,qty:2}];
    console.log("client", JSON.stringify(client(lines, 12.5)));
    console.log("server", JSON.stringify(server(lines, 12.5)));
  });
});
