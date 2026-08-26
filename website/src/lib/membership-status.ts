// Pure membership-activity logic, kept in its own module (no DB / server-only
// deps) so it can be unit-tested directly — the main membership.ts is mocked in
// the test suite. membership.ts imports and re-exports isMembershipActive.

// Grace window for the date guard: a membership whose paid period has ended is
// treated as lapsed only after this many days, so a monthly member being renewed
// by the (every-30-min) billing sweep is never dropped in the brief window
// between their renewal moment and the successful charge, while a genuinely
// expired/stalled membership still loses benefits promptly.
export const MEMBERSHIP_EXPIRY_GRACE_DAYS = 3;

/**
 * The event types that represent MONEY CHANGING HANDS. Everything else written
 * to membership_billing_events — cancellation, pause, resume, skip, tier_change
 * — is a lifecycle record stored with status "succeeded" and amount_cents 0,
 * because the *operation* succeeded, not because anyone paid.
 *
 * Never treat "has a succeeded billing event" as proof of payment: an account
 * that only ever failed to pay and then cancelled has succeeded rows. That
 * mistake produced a false all-clear when auditing the first test account,
 * which had two succeeded cancellations and zero real charges.
 */
export const PAID_EVENT_TYPES = ["intro_charge", "first_month_remainder", "renewal"] as const;

export interface BillingEventLike {
  eventType: string;
  status: string;
  amountCents: number;
}

/** True only if this event moved money. */
export function isPaidBillingEvent(event: BillingEventLike): boolean {
  return (
    event.status === "succeeded" &&
    event.amountCents > 0 &&
    (PAID_EVENT_TYPES as readonly string[]).includes(event.eventType)
  );
}

/**
 * Has this member already used their one skip for the paid period they are in?
 *
 * K-07. The single definition of the rule, in the pure module so the SERVER
 * guard (skipNextBilling) and the ACCOUNT PAGE that offers the button share it.
 * Two hand-written copies of a rule like this is how the original defect
 * survived: the cap lived 200 lines from the advance it was capping, and the
 * reminder window that made it exploitable was a third constant somewhere else.
 *
 * Events must be supplied NEWEST FIRST. Walking back from now, the first genuinely
 * PAID event ends the current period — a renewal starts a new one and restores
 * the entitlement. A failed charge does not, and neither does a zero-amount
 * lifecycle row (cancellation, pause, resume, tier_change), which is exactly what
 * isPaidBillingEvent above already encodes and why this reuses it rather than
 * matching on event_type.
 *
 * A member with no paid event at all (an admin comp) has one skip ever, which is
 * the conservative reading of "one per paid period" when no period was paid for.
 */
export function skipUsedThisPaidPeriod(
  eventsNewestFirst: ReadonlyArray<BillingEventLike>,
): boolean {
  for (const event of eventsNewestFirst) {
    if (isPaidBillingEvent(event)) return false;
    if (event.eventType === "skip" && event.status === "succeeded") return true;
  }
  return false;
}

export interface MembershipActivityInput {
  status: string;
  nextBillingAt: string | null;
  renewsAt: string | null;
}

// Single source of truth for "is this membership currently active?". Requires an
// active/trialing status AND that the paid period hasn't clearly ended. The date
// guard means an expired membership loses its benefits even if the billing sweep
// never ran to flip its status — so a customer can never keep a paid tier past
// the term they paid for just because a cron job stalled.
export function isMembershipActive(membership: MembershipActivityInput, now: number = Date.now()): boolean {
  if (membership.status !== "active" && membership.status !== "trialing") {
    return false;
  }
  const periodEndRaw = membership.nextBillingAt ?? membership.renewsAt;
  if (periodEndRaw) {
    const periodEnd = new Date(periodEndRaw).getTime();
    const graceMs = MEMBERSHIP_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(periodEnd) && periodEnd + graceMs < now) {
      return false;
    }
  }
  return true;
}
