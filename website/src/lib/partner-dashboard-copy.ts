/**
 * The two numbers on the ambassador dashboard that used to be literals.
 *
 * `sub="14-day hold"` and "15% off your own orders" were both typed into
 * `partner-dashboard-client.tsx`. Production holds commissions for 30 days
 * (raised from 14 so a payout cannot land before the refund window closes) and
 * gives ambassadors 20% off their own orders (raised on 2026-08-23). Neither
 * literal followed, and neither could: a number in a component cannot be kept
 * in step with a value in the database.
 *
 * The component now renders what the server resolved from
 * `getAmbassadorProgramSettings()` and `getReferralProgramConfig()` — the same
 * functions checkout and the commission accrual read. All that is left to get
 * wrong is the wording, and that lives here where a test can hold it.
 */

/** Whole days, or null when the stored value is not a usable number. */
function wholeDays(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

/**
 * How long an earned commission waits before it can be paid out.
 *
 * Shown under the "Pending" figure, so it is the answer to "when do I get
 * this?". A corrupt setting must not print itself at an ambassador — "NaN-day
 * hold" under someone's earnings is worse than saying nothing precise.
 */
export function commissionHoldLabel(days: number): string {
  const resolved = wholeDays(days);
  if (resolved === null) {
    return "held before payout";
  }
  if (resolved === 0) {
    return "no hold";
  }
  return `${resolved}-day hold`;
}

/**
 * The discount an approved ambassador gets on their OWN orders, or null when
 * the programme gives none.
 *
 * Null rather than "0% off your own orders": a programme with no personal
 * discount is a legitimate configuration, and the caller drops the whole clause
 * instead of promising nothing in words that sound like a promise.
 */
export function personalDiscountLabel(percent: number): string | null {
  if (!Number.isFinite(percent) || percent <= 0) {
    return null;
  }
  // Keep whatever precision the admin actually set: 20 stays "20%", 12.5 stays
  // "12.5%". Number's own formatting drops the trailing zero for us.
  return `${Number(percent)}% off your own orders`;
}
