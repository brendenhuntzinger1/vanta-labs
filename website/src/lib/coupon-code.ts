/**
 * The canonical spelling of a coupon code.
 *
 * Pure, and deliberately in its own module rather than in `coupons.ts`: that
 * module talks to Supabase, so every suite that touches the checkout path
 * replaces it wholesale with `vi.mock("@/lib/coupons", ...)`. A pure normaliser
 * living behind that mock means anything importing it gets `undefined` in a
 * dozen suites that never meant to stub it — which is exactly what happened
 * when payment-webhook.ts started normalising the code it writes.
 *
 * Uppercases, trims, and drops everything outside [A-Z0-9-]. Every lane that
 * stores a coupon code applies this, so `orders.coupon_code` and `coupons.code`
 * hold the same form and the redemption-limit count can match on `=`.
 */
export function normalizeCouponCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}
