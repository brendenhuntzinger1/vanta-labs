import { describe, expect, it } from "vitest";
import { isMembershipActive, type MembershipActivityInput } from "@/lib/membership-status";

// A day in ms, and a fixed "now" so the tests are deterministic.
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function membership(overrides: Partial<MembershipActivityInput>): MembershipActivityInput {
  return {
    status: "active",
    renewsAt: null,
    nextBillingAt: null,
    ...overrides,
  };
}

describe("isMembershipActive — status + date guard", () => {
  it("is active when status is active and no period-end date is set", () => {
    expect(isMembershipActive(membership({ status: "active" }), NOW)).toBe(true);
  });

  it("is active when trialing", () => {
    expect(isMembershipActive(membership({ status: "trialing" }), NOW)).toBe(true);
  });

  it("is inactive for cancelled / past_due / paused status", () => {
    expect(isMembershipActive(membership({ status: "cancelled" }), NOW)).toBe(false);
    expect(isMembershipActive(membership({ status: "past_due" }), NOW)).toBe(false);
    expect(isMembershipActive(membership({ status: "paused" }), NOW)).toBe(false);
  });

  it("stays active while the paid period is still in the future", () => {
    const m = membership({ status: "active", nextBillingAt: new Date(NOW + 30 * DAY).toISOString() });
    expect(isMembershipActive(m, NOW)).toBe(true);
  });

  it("stays active in the short window right after the renewal date (grace)", () => {
    // Renewal was due 1 day ago; the sweep hasn't charged yet. A paying member
    // must not lose benefits in this window.
    const m = membership({ status: "active", nextBillingAt: new Date(NOW - 1 * DAY).toISOString() });
    expect(isMembershipActive(m, NOW)).toBe(true);
  });

  it("goes inactive once the paid period ended beyond the grace window (stalled sweep)", () => {
    // Period ended 10 days ago and status was never flipped — benefits must stop
    // even though status still says "active".
    const m = membership({ status: "active", nextBillingAt: new Date(NOW - 10 * DAY).toISOString() });
    expect(isMembershipActive(m, NOW)).toBe(false);
  });

  it("uses renews_at when next_billing_at is absent", () => {
    const expired = membership({ status: "active", renewsAt: new Date(NOW - 10 * DAY).toISOString() });
    expect(isMembershipActive(expired, NOW)).toBe(false);
    const current = membership({ status: "active", renewsAt: new Date(NOW + 10 * DAY).toISOString() });
    expect(isMembershipActive(current, NOW)).toBe(true);
  });
});
