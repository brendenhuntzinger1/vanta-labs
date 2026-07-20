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

export function dollarsToPoints(dollars: number) {
  return roundPoints(dollars * POINTS_PER_DOLLAR_REDEMPTION);
}
