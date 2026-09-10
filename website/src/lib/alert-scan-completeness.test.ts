import { describe, expect, it } from "vitest";

import { describeScan, qualifyPopulationClaim } from "@/lib/alert-scan-completeness";

// ---------------------------------------------------------------------------
// AN ALERT MAY NOT COUNT A POPULATION IT DID NOT FINISH READING.
//
// Three alerts in one day stated something the data could not support:
//
//   * partner_locked_out named twenty ambassadors as never having signed in.
//     All twenty had. checked:20 / lockedOut:20 was one empty lookup, not
//     twenty lockouts.
//   * signup_confirmation_stalled asserted a Gmail delivery problem from a
//     domain count that was only the shape of the customer base.
//   * the same empty-listing hole made signup_confirmation_stalled report ZERO
//     stalled during an auth incident — silence read as a clean bill.
//
// One property underneath all of them: a scan that could be short produced a
// sentence that reads as complete. "9 account(s)", "20 approved ambassador(s)",
// "3 order(s)" — each is a claim about a POPULATION, and each was written
// without asking whether the whole population had been read.
//
// commission-accrual-repair.ts already had the answer, in its own words:
// "Silent truncation is how the old `.limit()` scan hid the backlog in the
// first place, so it is said out loud." It reports `scanTruncated` and raises
// its own alert. That instinct was correct and stayed in one file; two weeks
// later auth-health.ts shipped the identical bug.
//
// So this generalises THAT pattern rather than inventing a second one, and
// keeps its vocabulary: `truncated`, matching BoundedRead in supabase-page.ts.
// ---------------------------------------------------------------------------

describe("qualifying a counted-population claim", () => {
  it("leaves a complete scan's message exactly as written", () => {
    // The overwhelmingly common case must cost nothing and read identically —
    // a caveat on every alert is a caveat nobody reads.
    const message = "3 order(s) have been unresolved at the payment processor for over 24h.";
    expect(qualifyPopulationClaim(message, { truncated: false })).toBe(message);
  });

  it("is a no-op when no scan is declared at all", () => {
    const message = "Order VL-1 was captured after cancellation.";
    expect(qualifyPopulationClaim(message, undefined)).toBe(message);
  });

  it("says the count is a floor, not a total, when the scan was cut short", () => {
    const out = qualifyPopulationClaim("9 account(s) have been waiting.", { truncated: true });
    expect(out).toContain("9 account(s) have been waiting.");
    expect(out, "a truncated scan must not read as a complete census")
      .toMatch(/incomplete/i);
    expect(out).toMatch(/at least/i);
  });

  it("names how far it got when the scan says so", () => {
    // "at least 9, having read 500" is actionable; "at least 9" alone leaves the
    // reader unable to judge whether the real number is 10 or 10,000.
    const out = qualifyPopulationClaim("9 account(s) waiting.", { truncated: true, scanned: 500 });
    expect(out).toContain("500");
  });

  it("does not double-qualify a message that already carries the caveat", () => {
    const once = qualifyPopulationClaim("9 account(s).", { truncated: true });
    expect(qualifyPopulationClaim(once, { truncated: true })).toBe(once);
  });
});

describe("the scan record kept alongside the alert", () => {
  it("is absent when nothing was declared, so old alerts are unchanged", () => {
    expect(describeScan(undefined)).toBeUndefined();
  });

  it("records completeness even when the scan finished, so silence is legible", () => {
    // A reader looking at an alert with NO scan key cannot tell whether the
    // author checked and it was complete, or never considered it. Recording
    // both outcomes is what makes the absence meaningful.
    expect(describeScan({ truncated: false })).toEqual({ scanTruncated: false });
    expect(describeScan({ truncated: false, scanned: 138 }))
      .toEqual({ scanTruncated: false, scanned: 138 });
  });

  it("flags the truncated case for anything reading the row later", () => {
    expect(describeScan({ truncated: true, scanned: 500 }))
      .toEqual({ scanTruncated: true, scanned: 500 });
  });
});
