// Pure points math shared between server code (src/lib/membership.ts) and
// client components (cart/checkout previews). No Supabase or "server-only"
// imports here on purpose, so this can be bundled into the browser.

export const POINTS_PER_DOLLAR_REDEMPTION = 100; // 100 points = $1 store credit

function roundPoints(value: number) {
  return Math.max(0, Math.floor(value));
}

export function calculateEarnedPoints(chargeableAmount: number, pointsPerDollar: number, eventMultiplier: number) {
  return roundPoints(chargeableAmount * pointsPerDollar * eventMultiplier);
}

export function pointsToDollars(points: number) {
  return Math.round((points / POINTS_PER_DOLLAR_REDEMPTION) * 100) / 100;
}

/**
 * How many points must be DEBITED to fund a discount of `dollars`.
 *
 * THE FLOOR IS POLICY; THE FLOAT ERROR WAS NOT.
 *
 * This was `Math.floor(dollars * 100)` on a raw double, and a raw double cannot
 * hold most two-decimal dollar amounts exactly: `18.08 * 100` is
 * 1807.9999999999998, so an $18.08 redemption debited 1807 points. 4.6% of all
 * two-decimal dollar values between $0.01 and $2000.00 land a fraction of a
 * cent BELOW their true product and lose a whole point to the floor.
 *
 * That is not a rounding policy, it is a wrong answer, and on this codebase it
 * is load-bearing on REVENUE: quote-order.ts:809-810 takes the discount off the
 * customer's total at the full $18.08 and records `points_redeemed = 1807`,
 * while admin-profit.ts reconstructs the redemption as
 * `pointsToDollars(1807) = $18.07`. Gross revenue then exceeds `amount_paid` by
 * a cent on every such order, and the customer keeps 1 point of value that was
 * never taken off their balance.
 *
 * The fix does NOT change the policy. A fractional-cent request still floors —
 * $1.009 is still 100 points, never 101, so a customer can never be given more
 * discount than they paid points for. It only snaps a product that is already
 * within a rounding error of a whole point back onto that point, which is the
 * value exact arithmetic would have produced.
 */
export function dollarsToPoints(dollars: number) {
  const scaled = dollars * POINTS_PER_DOLLAR_REDEMPTION;
  const nearest = Math.round(scaled);
  // Relative, so it stays a float-error band rather than an absolute slice of a
  // point, at every order size. A genuine fractional-cent amount is orders of
  // magnitude outside it and falls through to the floor untouched.
  const withinFloatError = Math.abs(scaled - nearest) <= Math.max(1, Math.abs(scaled)) * 1e-9;
  return roundPoints(withinFloatError ? nearest : scaled);
}
