import { describe, it, expect } from "vitest";
import { qualifiesForMonthlyTierCount, monthStartForTierCount } from "@/lib/ambassador-commission";

// WHY THIS FILE EXISTS
//
// Sabotaging every branch of this predicate left all 2,590 existing tests
// green: fraud-flagged orders, reversed orders, $0/ineligible orders, and
// orders from previous months could all inflate an ambassador's monthly
// qualifying count with nothing turning red. That count is what escalates
// the commission tier, so each wrongly-admitted row raises the percent paid
// on every subsequent order that month. Money, untested.
//
// Every test below has been checked to fail when its branch is removed.

const MONTH_START = new Date(Date.UTC(2026, 7, 1)); // 2026-08-01

function row(overrides: Record<string, unknown> = {}) {
  return {
    created_at: "2026-08-10T12:00:00.000Z",
    payment_status: "paid",
    ineligible_reason: null,
    commission_amount: 12.5,
    fraud_flag: false,
    ...overrides,
  };
}

describe("what counts toward a commission tier", () => {
  it("counts an ordinary paid, eligible, in-month order", () => {
    expect(qualifiesForMonthlyTierCount(row(), MONTH_START)).toBe(true);
  });

  describe("payment status", () => {
    for (const status of ["reversed", "voided", "manual_review"]) {
      it(`excludes a ${status} order`, () => {
        expect(qualifiesForMonthlyTierCount(row({ payment_status: status }), MONTH_START)).toBe(false);
      });

      it(`excludes a ${status.toUpperCase()} order regardless of casing`, () => {
        expect(
          qualifiesForMonthlyTierCount(row({ payment_status: status.toUpperCase() }), MONTH_START),
        ).toBe(false);
      });
    }
  });

  describe("orders that earned nothing", () => {
    it("excludes an order with an ineligible_reason", () => {
      expect(
        qualifiesForMonthlyTierCount(row({ ineligible_reason: "below_minimum_subtotal" }), MONTH_START),
      ).toBe(false);
    });

    it("excludes a zero-commission order", () => {
      expect(qualifiesForMonthlyTierCount(row({ commission_amount: 0 }), MONTH_START)).toBe(false);
    });

    it("excludes a negative-commission order", () => {
      expect(qualifiesForMonthlyTierCount(row({ commission_amount: -5 }), MONTH_START)).toBe(false);
    });

    it("excludes an order with a missing commission amount", () => {
      expect(qualifiesForMonthlyTierCount(row({ commission_amount: null }), MONTH_START)).toBe(false);
    });
  });

  describe("self-dealing", () => {
    it("excludes a fraud-flagged order — this is the tier-farming path", () => {
      expect(qualifiesForMonthlyTierCount(row({ fraud_flag: true }), MONTH_START)).toBe(false);
    });

    it("still counts an order whose fraud flag is explicitly false", () => {
      expect(qualifiesForMonthlyTierCount(row({ fraud_flag: false }), MONTH_START)).toBe(true);
    });
  });

  describe("the month boundary", () => {
    it("excludes an order from the previous month", () => {
      expect(
        qualifiesForMonthlyTierCount(row({ created_at: "2026-07-31T23:59:59.999Z" }), MONTH_START),
      ).toBe(false);
    });

    it("includes an order placed at the first instant of the month", () => {
      expect(
        qualifiesForMonthlyTierCount(row({ created_at: "2026-08-01T00:00:00.000Z" }), MONTH_START),
      ).toBe(true);
    });

    it("excludes an order with an unparseable timestamp rather than counting it", () => {
      expect(qualifiesForMonthlyTierCount(row({ created_at: "not a date" }), MONTH_START)).toBe(false);
    });

    it("excludes an order with no timestamp at all", () => {
      expect(qualifiesForMonthlyTierCount(row({ created_at: null }), MONTH_START)).toBe(false);
    });
  });

  describe("the month boundary is the store's month", () => {
    it("starts at local midnight on the first of the month", () => {
      // Midnight ET on August 1st, which is 04:00Z — not 00:00Z.
      expect(monthStartForTierCount(new Date("2026-08-23T04:15:00.000Z")).toISOString()).toBe(
        "2026-08-01T04:00:00.000Z",
      );
    });

    it("counts a late US evening in the month it was worked, not the next one", () => {
      // Sep 1 03:00 UTC is 11pm ET on AUGUST 31. This used to assert September
      // and justify it as "follow UTC consistently, matching how created_at is
      // stored" — but storage format is not the question. Those four hours are
      // the last of August's selling, and counting them toward September moved
      // an ambassador up a tier a day early while leaving the month she
      // actually worked short.
      expect(monthStartForTierCount(new Date("2026-09-01T03:00:00.000Z")).toISOString()).toBe(
        "2026-08-01T04:00:00.000Z",
      );
    });
  });
});
