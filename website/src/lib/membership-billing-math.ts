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

// ── Membership checkout idempotency ────────────────────────────────────────

export interface OpenMembershipAttempt {
  orderId: string;
  orderNumber: string;
  amountPaid: number;
}

export type MembershipAttemptDecision =
  | { action: "reuse"; orderId: string; orderNumber: string }
  | { action: "replace"; retireOrderId: string }
  | { action: "create" };

/**
 * Decides what to do when a buyer starts membership checkout and an unpaid
 * attempt for the same tier + cycle already exists.
 *
 * createMembershipCheckoutSession used to insert a new order unconditionally,
 * so a double click, a back-and-retry, or a page refresh each left another
 * "awaiting payment" order behind — the first test account accumulated one per
 * signup attempt.
 *
 * Reuse is deliberately not time-boxed: a stale open attempt is reused rather
 * than blocked. The only reason to abandon one is a PRICE change, where sending
 * the buyer back to a checkout for the old amount would be wrong.
 */
export function decideMembershipAttempt(
  openAttempt: OpenMembershipAttempt | null,
  amount: number,
): MembershipAttemptDecision {
  if (!openAttempt) return { action: "create" };

  // Money compared with a half-cent tolerance — amount_paid round-trips through
  // the DB as a numeric and must not fail an equality check on representation.
  const priceMatches = Math.abs(Number(openAttempt.amountPaid ?? 0) - amount) < 0.005;
  if (priceMatches) {
    return { action: "reuse", orderId: openAttempt.orderId, orderNumber: openAttempt.orderNumber };
  }
  return { action: "replace", retireOrderId: openAttempt.orderId };
}

// ── Duplicate-purchase guard ───────────────────────────────────────────────

export type MembershipPurchaseDecision =
  | { allowed: true; kind: "new" | "plan_change" | "rejoin" }
  | { allowed: false; reason: string };

/**
 * Whether a membership purchase may proceed.
 *
 * startMembershipSignup already no-ops when the buyer is active on the same
 * tier, but createMembershipCheckoutSession — the hosted-checkout lane — had no
 * such guard, so an ACTIVE member who reached the subscribe page again was sent
 * to a live checkout and charged a second time for a membership they already
 * hold.
 *
 * A different tier is a legitimate plan change, and a lapsed/cancelled/paused
 * member rejoining is exactly what we want. Only "already active on this very
 * tier" is refused.
 */
export function guardDuplicateMembershipPurchase(
  existing: { status: string; tierId: string; tierName?: string; cancelAtPeriodEnd?: boolean } | null,
  requestedTierId: string,
): MembershipPurchaseDecision {
  if (!existing) return { allowed: true, kind: "new" };

  const status = (existing.status ?? "").trim().toLowerCase();
  const holdsBenefits = status === "active" || status === "trialing";
  if (!holdsBenefits) return { allowed: true, kind: "rejoin" };

  // A member winding down is NOT continuing — they are on their way out, and
  // buying again is a legitimate way back in. Refusing them left an account
  // with no route to reinstate at all: "Keep my membership" is the cheaper
  // path (no charge), but the purchase must not be blocked either.
  if (existing.cancelAtPeriodEnd) return { allowed: true, kind: "rejoin" };

  if (existing.tierId !== requestedTierId) return { allowed: true, kind: "plan_change" };

  const tier = (existing.tierName ?? "").trim();
  return {
    allowed: false,
    reason: tier
      ? `You're already a ${tier} member. Manage your plan from your account instead of purchasing again.`
      : "You already have an active membership. Manage your plan from your account instead of purchasing again.",
  };
}
