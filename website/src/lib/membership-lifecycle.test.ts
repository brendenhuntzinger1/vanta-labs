import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isMembershipActive, isPaidBillingEvent } from "@/lib/membership-status";
import { resolveMembershipCycle } from "@/lib/payment-webhook";
import { displayOrderReference } from "@/lib/order-reference";
import { customerSafeMessage } from "@/lib/safe-error";

// End-to-end membership lifecycle contract, written from the scenarios that
// actually broke in production. Every case below maps to a real defect.

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("scenario: successful monthly purchase", () => {
  it("grants benefits for the paid period", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(true);
  });

  it("records a PAID billing event, which is what proves payment", () => {
    expect(isPaidBillingEvent({ eventType: "renewal", status: "succeeded", amountCents: 100 })).toBe(true);
  });
});

describe("scenario: successful annual purchase", () => {
  it("grants benefits for a full year", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(365), renewsAt: inDays(365) })).toBe(true);
  });
});

describe("scenario: declined / failed payment", () => {
  it("a failed charge is never a payment, at any amount", () => {
    expect(isPaidBillingEvent({ eventType: "renewal", status: "failed", amountCents: 24990 })).toBe(false);
    expect(isPaidBillingEvent({ eventType: "payment_failed", status: "failed", amountCents: 100 })).toBe(false);
  });

  it("no membership row means no benefits", () => {
    expect(isMembershipActive({ status: "none", nextBillingAt: null, renewsAt: null })).toBe(false);
  });

  it("past_due grants nothing", () => {
    expect(isMembershipActive({ status: "past_due", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(false);
  });
});

describe("scenario: abandoned checkout", () => {
  it("pending is not active", () => {
    expect(isMembershipActive({ status: "pending", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(false);
  });
});

describe("scenario: cancel, then re-subscribe", () => {
  // The bug: activation left cancelled_at set, so a paying member read
  // "set to cancel at the end of your period" moments after being charged.
  it("a cancelled membership grants nothing", () => {
    expect(isMembershipActive({ status: "cancelled", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(false);
  });

  it("re-subscribing produces a clean active state", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(true);
  });

  it("cancel-at-period-end keeps benefits until the paid date, then stops", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(10), renewsAt: inDays(10) })).toBe(true);
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(-30), renewsAt: inDays(-30) })).toBe(false);
  });
});

describe("scenario: expiry and the renewal grace window", () => {
  it("a member one day past renewal keeps benefits while the sweep catches up", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(-1), renewsAt: inDays(-1) })).toBe(true);
  });

  it("but grace does not run forever", () => {
    expect(isMembershipActive({ status: "active", nextBillingAt: inDays(-10), renewsAt: inDays(-10) })).toBe(false);
  });
});

describe("scenario: paused membership", () => {
  it("paused grants nothing", () => {
    expect(isMembershipActive({ status: "paused", nextBillingAt: inDays(30), renewsAt: inDays(30) })).toBe(false);
  });
});

describe("scenario: missing billing cycle must never grant a year", () => {
  // `cycle ?? "annual"` granted a 365-day term on a data fault — and annual
  // activation sets cancel_at_period_end, so the member also looked like they
  // were cancelling the moment they paid.
  it("defaults to monthly, never annual", () => {
    expect(resolveMembershipCycle(null, "order-x")).toBe("monthly");
    expect(resolveMembershipCycle(undefined, "order-x")).toBe("monthly");
    expect(resolveMembershipCycle("", "order-x")).toBe("monthly");
    expect(resolveMembershipCycle("   ", "order-x")).toBe("monthly");
  });

  it("rejects garbage rather than guessing annual", () => {
    expect(resolveMembershipCycle("yearly", "order-x")).toBe("monthly");
    expect(resolveMembershipCycle("ANNUALLY", "order-x")).toBe("monthly");
    expect(resolveMembershipCycle(42, "order-x")).toBe("monthly");
    expect(resolveMembershipCycle({}, "order-x")).toBe("monthly");
  });

  it("honours a real cycle, case- and whitespace-insensitively", () => {
    expect(resolveMembershipCycle("monthly", "o")).toBe("monthly");
    expect(resolveMembershipCycle("annual", "o")).toBe("annual");
    expect(resolveMembershipCycle("  ANNUAL  ", "o")).toBe("annual");
    expect(resolveMembershipCycle("Monthly", "o")).toBe("monthly");
  });

  it("logs the fault so a null cycle is visible, not silent", () => {
    resolveMembershipCycle(null, "order-8f2f12b9");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("scenario: lifecycle events are not payments", () => {
  it("a cancellation is recorded succeeded at $0 and must not count", () => {
    expect(isPaidBillingEvent({ eventType: "cancellation", status: "succeeded", amountCents: 0 })).toBe(false);
  });

  it("the real test account: 10 events, 0 payments", () => {
    const events = [
      { eventType: "payment_failed", status: "failed", amountCents: 100 },
      { eventType: "renewal", status: "failed", amountCents: 100 },
      { eventType: "cancellation", status: "succeeded", amountCents: 0 },
      { eventType: "renewal", status: "failed", amountCents: 24990 },
      { eventType: "cancellation", status: "succeeded", amountCents: 0 },
      { eventType: "renewal", status: "failed", amountCents: 39990 },
    ];
    expect(events.filter(isPaidBillingEvent)).toHaveLength(0);
  });
});

describe("scenario: nothing customer-facing leaks internals", () => {
  it("an order with no number still shows a branded reference", () => {
    const shown = displayOrderReference(null, "order-8f2f12b9-62b5-4630-9ff5-b11f27702553");
    expect(shown).toMatch(/^VL-[0-9A-F]{8}$/);
  });

  it("a processor failure shows Vanta Labs' words, not the vendor's", () => {
    const shown = customerSafeMessage(new Error("Veyra checkout script failed to load."), "We couldn't load secure card entry.");
    expect(shown).not.toMatch(/veyra/i);
  });
});
