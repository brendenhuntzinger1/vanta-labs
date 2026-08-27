import { describe, expect, it } from "vitest";

import { commissionHoldLabel, personalDiscountLabel } from "@/lib/partner-dashboard-copy";

// ---------------------------------------------------------------------------
// TWO NUMBERS THE AMBASSADOR DASHBOARD TOLD ITS OWN AMBASSADORS, WRONGLY.
//
// The "Pending" card read `sub="14-day hold"` as a literal, and the welcome
// paragraph read "15% off your own orders" as a literal. Production stores
// commission_hold_days = 30 and personal_discount_percent = 20, and both were
// deliberate changes — the hold was raised from 14 to 30 so a commission is not
// paid out before the refund window closes (referral-config.ts), and the
// personal discount was raised to 20 on 2026-08-23.
//
// Neither literal moved. Seven approved ambassadors are about to read that
// dashboard daily: every one of them would have been told to expect their
// commission on day 15, and would have been told they get 5 points less off
// their own orders than they actually do.
//
// A literal in a component cannot be kept in step with a value in the database.
// The fix is that the component no longer holds either number — it renders what
// the server resolved — and the only thing left to get wrong is the wording,
// which is here, where it can be tested.
// ---------------------------------------------------------------------------

describe("commissionHoldLabel", () => {
  it("says what the programme is actually configured to hold", () => {
    expect(commissionHoldLabel(30)).toBe("30-day hold");
  });

  // The regression, stated directly. This is the string that was hardcoded.
  it("never says 14 days when the programme holds 30", () => {
    expect(commissionHoldLabel(30)).not.toContain("14");
  });

  it("keeps the singular readable", () => {
    expect(commissionHoldLabel(1)).toBe("1-day hold");
  });

  it("says there is no hold rather than '0-day hold'", () => {
    expect(commissionHoldLabel(0)).toBe("no hold");
  });

  // A corrupt setting must not print itself at an ambassador. The failure mode
  // being avoided is "NaN-day hold" on someone's earnings page.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -5],
  ])("says nothing specific rather than printing a %s", (_label, value) => {
    const label = commissionHoldLabel(value);
    expect(label).toBe("held before payout");
    expect(label).not.toMatch(/NaN|Infinity|-/);
  });

  it("rounds a fractional setting to whole days", () => {
    expect(commissionHoldLabel(30.4)).toBe("30-day hold");
  });
});

describe("personalDiscountLabel", () => {
  it("states the discount the programme actually gives an ambassador", () => {
    expect(personalDiscountLabel(20)).toBe("20% off your own orders");
  });

  it("never says 15% when the programme gives 20%", () => {
    expect(personalDiscountLabel(20)).not.toContain("15");
  });

  // An ambassador whose programme gives no personal discount must not be told
  // they have one. The caller drops the whole clause on null.
  it.each([
    ["zero", 0],
    ["negative", -10],
    ["NaN", Number.NaN],
  ])("promises nothing when the personal discount is %s", (_label, value) => {
    expect(personalDiscountLabel(value)).toBeNull();
  });

  it("does not invent decimals the admin did not set", () => {
    expect(personalDiscountLabel(12.5)).toBe("12.5% off your own orders");
    expect(personalDiscountLabel(20.0)).toBe("20% off your own orders");
  });
});
