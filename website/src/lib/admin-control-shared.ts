// Client-safe slice of admin-control.ts.
//
// admin-control.ts starts with `import "server-only"`, so ANY import from
// it — even a single pure, dependency-free named export — poisons the whole
// module graph and Next.js hard-errors at build time if a Client Component
// pulls it in ("This module cannot be imported from a Client Component
// module"). `describeEffectiveRate` has zero server dependencies (no
// Supabase, no secrets), so it lives here instead, and admin-control.ts
// re-exports it so server-side callers can still reach it at
// `@/lib/admin-control` as usual. Client Components (e.g.
// admin-control-center-client.tsx) must import from THIS file directly.

/** The coded default processing-fee percent, single-sourced for both admin-control.ts and any client UI. */
export const PROCESSING_FEE_DEFAULT_PERCENT = 8;

/**
 * Assumed unit cost for a SKU with no stored cost (worst case, dollars).
 *
 * Lives here, not in either consumer, because profit-engine.ts's
 * DEFAULT_PROFIT_SETTINGS and admin-control.ts's DEFAULT_PROFIT_CONFIG each
 * held their own literal `33` and nothing imported both, so the two could drift
 * apart with the whole suite green.
 */
export const WORST_CASE_UNIT_COST_DEFAULT = 33;

// THE THREE AMBASSADOR RATES. They are numerically close and mean entirely
// different things, so they are pinned separately (ambassador-personal-discount.test.ts)
// and single-sourced here: the approval email (email/templates.ts) is a Client-safe
// module that cannot import admin-control.ts, and it used to carry its own
// literal copies of all three.

// Default customer discount for a valid ambassador referral code.
export const DEFAULT_REFERRAL_DISCOUNT_PERCENT = 10;
// Default personal discount an approved ambassador gets on their OWN purchases.
// Deliberately HIGHER than the 10% customer/referral discount above: this is
// the ambassador's own benefit, not their audience's, and the two rates are
// independent by design. Raising it does not change what a referred customer
// pays and does not change commission.
export const DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT = 20;
// Starting commission rate for a new ambassador when no explicit per-ambassador
// rate is set. Admins can raise (or lock) any individual ambassador's rate in
// Admin → Partners.
export const DEFAULT_AMBASSADOR_COMMISSION_PERCENT = 10;

/**
 * The highest processing fee this store will accept from a free-text box.
 *
 * `num()` in getProfitSettings had a lower bound and NO upper one, so a typo of
 * "800" was accepted verbatim and applied: an 800% modelled fee puts every
 * order below the profit floor and blocks all checkout, and reports every
 * historical order at a loss. A percentage of a payment cannot exceed the
 * payment, so 100 is the honest ceiling.
 */
export const PROCESSING_FEE_MAX_PERCENT = 100;

/**
 * THE ONE RULE THAT DECIDES WHICH RATE IS APPLIED.
 *
 * Exported so the display beside the admin input and the resolver that actually
 * charges the fee cannot disagree — they had their own copies, and they did:
 * "-5" displayed "-5% in effect" while 8% was applied, and "8%" displayed
 * "NaN% in effect" while 8% was applied. Returns null for "there is no usable
 * rate here, the coded default applies".
 *
 * A blank (or whitespace-only) value is not "0%" — it means the default
 * applies. An explicit "0" IS a real choice (fee-free processing) and must
 * never be mistaken for unset.
 */
export function parseRatePercent(
  value: unknown,
  max: number = PROCESSING_FEE_MAX_PERCENT,
): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

/**
 * What rate is ACTUALLY in effect, for display beside an admin input.
 *
 * Every branch here answers with what parseRatePercent resolves, so the label
 * can only ever state the rate the store is really charging.
 */
export function describeEffectiveRate(stored: string, fallback: number): string {
  const trimmed = String(stored ?? "").trim();
  if (trimmed === "") return `Using the ${fallback}% default`;
  const parsed = parseRatePercent(trimmed);
  if (parsed == null) {
    return `"${trimmed}" is not a usable rate (0–${PROCESSING_FEE_MAX_PERCENT}) — using the ${fallback}% default`;
  }
  return `${parsed}% in effect`;
}
