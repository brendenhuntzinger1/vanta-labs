// Pure membership-activity logic, kept in its own module (no DB / server-only
// deps) so it can be unit-tested directly — the main membership.ts is mocked in
// the test suite. membership.ts imports and re-exports isMembershipActive.

// Grace window for the date guard: a membership whose paid period has ended is
// treated as lapsed only after this many days, so a monthly member being renewed
// by the (every-30-min) billing sweep is never dropped in the brief window
// between their renewal moment and the successful charge, while a genuinely
// expired/stalled membership still loses benefits promptly.
export const MEMBERSHIP_EXPIRY_GRACE_DAYS = 3;

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
