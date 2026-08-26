import { describe, expect, it } from "vitest";
import { endsLabel } from "@/lib/storefront-offer-format";

// ---------------------------------------------------------------------------
// "Ends tonight" has to be true.
//
// FOUND DURING THE DEAD-CODE SWEEP, not by looking for it. A stray file at
// `website/website/scratchpad/k-ends.test.ts` — a nested path that should never
// have been committed — was being COLLECTED by vitest and counted among the
// passing suites. Its three tests asserted:
//
//     expect(endsLabel(ends, now)).toBe("Ends tonight");   // coupon dies in 1 hour, at 9am
//     expect(endsLabel(ends, now)).toBe("Ends tonight");   // coupon dies A FULL YEAR LATER
//
// They passed. They were written to DEMONSTRATE the defect, and by living in
// the suite they pinned it: anyone fixing endsLabel would have broken three
// green tests and, reasonably, assumed they were the ones in the wrong.
//
// THE DEFECT. The same-day check compared two RENDERED SHORT DATES:
//
//     formatDisplayDate(end, "short") === formatDisplayDate(now, "short")
//
// and `short` is `{ month: "short", day: "numeric" }` — it carries no year. So
// 3 September 2027 renders "Sep 3", 3 September 2026 renders "Sep 3", they
// compare equal, and a promotion twelve months away is advertised to every
// visitor as ending tonight. False urgency on a storefront banner is a
// customer-trust problem before it is anything else.
//
// The second defect is smaller and in the same sentence: an offer expiring at
// 9am is not ending "tonight". "Ends today" is true for every same-day expiry,
// morning or evening, and keeps the urgency without the falsehood. That word is
// the one judgement call here and is trivially reversible if the owner prefers
// the old copy for genuinely end-of-day offers.
//
// Dates below are chosen in UTC but asserted through the pinned business zone
// (America/New_York), which is the zone the label itself renders in.
// ---------------------------------------------------------------------------

describe("endsLabel tells the truth about when an offer ends", () => {
  it("does NOT claim a coupon a full year away ends today", () => {
    // The headline case. Same month and day, next year.
    const now = new Date("2026-09-03T15:00:00Z");
    const nextYear = "2027-09-03T20:00:00.000Z";

    const label = endsLabel(nextYear, now);

    expect(label).not.toBe("Ends today");
    expect(label).not.toBe("Ends tonight");
    expect(label).toBe("Ends Sep 3");
  });

  it("does not claim it for a coupon a year away in the other direction either", () => {
    // A guard against a fix that compares only the year and forgets the month.
    const now = new Date("2026-09-03T15:00:00Z");
    expect(endsLabel("2028-09-03T20:00:00.000Z", now)).toBe("Ends Sep 3");
  });

  it("still says so for an offer that really does end later today", () => {
    // The negative control: the fix must not destroy the case the label exists
    // for. 3pm ET today, asked at noon ET today.
    const now = new Date("2026-09-03T16:00:00Z");
    const laterToday = "2026-09-03T19:00:00.000Z";

    expect(endsLabel(laterToday, now)).toBe("Ends today");
  });

  it("says 'today', not 'tonight', for an offer that dies in the morning", () => {
    // 8am ET now, expiry 9am ET. "Ends tonight" was false by thirteen hours.
    const now = new Date("2026-08-31T12:00:00Z");
    const nineAm = "2026-08-31T13:00:00.000Z";

    expect(endsLabel(nineAm, now)).toBe("Ends today");
  });

  it("names the date for an offer later this year", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    expect(endsLabel("2026-12-01T20:00:00.000Z", now)).toBe("Ends Dec 1");
  });

  it("names tomorrow as a date rather than as today", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    expect(endsLabel("2026-09-04T20:00:00.000Z", now)).toBe("Ends Sep 4");
  });

  it("shows nothing for an offer that has already ended", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    expect(endsLabel("2026-09-03T14:00:00.000Z", now)).toBeNull();
    expect(endsLabel("2025-01-01T00:00:00.000Z", now)).toBeNull();
  });

  it("shows nothing for a missing or unparseable date", () => {
    expect(endsLabel(null)).toBeNull();
    expect(endsLabel("not a date")).toBeNull();
  });

  it("decides 'today' in the BUSINESS zone, not the machine's", () => {
    // 01:00 UTC on 4 September is still 9pm ET on 3 September. A server
    // comparing UTC calendar days would call this "tomorrow" while the shopper
    // in New York is still in the same evening — the wrong claim AND a
    // hydration mismatch.
    const now = new Date("2026-09-04T01:00:00Z");        // 3 Sep, 9pm ET
    const laterSameEveningEt = "2026-09-04T03:00:00Z";   // 3 Sep, 11pm ET

    expect(endsLabel(laterSameEveningEt, now)).toBe("Ends today");
  });
});
