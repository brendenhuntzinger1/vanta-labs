// Pure billing math for membership tier changes — no "server-only" import so it
// is unit-testable. Used by membership-billing.ts's upgrade/downgrade branch.

export interface TierChangeBillingInput {
  /** True when the member is still in the $1 intro trial (status "trialing"). */
  isTrialing: boolean;
  /** The membership's billing cycle ("monthly" | "annual" | ...). */
  billingCycle: string;
  monthlyPriceCents: number;
  annualPriceCents: number | null;
  introPriceCents: number;
}

export interface TierChangeBilling {
  /** The amount the NEXT charge should bill. */
  nextBillingAmountCents: number;
  /**
   * The first-month remainder to store, or null to leave it unchanged. Only a
   * trialing member has a pending remainder charge; a non-trial change never
   * touches it.
   */
  firstMonthRemainderCents: number | null;
}

// Reprice a membership after an in-place tier change (upgrade/downgrade).
//
// A TRIALING member's next charge is the first-month REMAINDER (monthly price −
// intro price), so BOTH the next-charge amount and the stored remainder move to
// the new tier's remainder — otherwise the remainder charge bills the old
// tier's amount (undercharge on upgrade, overcharge on downgrade).
//
// An ACTIVE member's next charge is a full renewal, so it reprices to the new
// tier's full monthly (or annual) price and the remainder is left untouched.
export function computeTierChangeBilling(input: TierChangeBillingInput): TierChangeBilling {
  const remainderCents = Math.max(0, input.monthlyPriceCents - input.introPriceCents);

  if (input.isTrialing) {
    return { nextBillingAmountCents: remainderCents, firstMonthRemainderCents: remainderCents };
  }

  const nextBillingAmountCents = input.billingCycle === "annual"
    ? (input.annualPriceCents ?? input.monthlyPriceCents)
    : input.monthlyPriceCents;

  return { nextBillingAmountCents, firstMonthRemainderCents: null };
}
