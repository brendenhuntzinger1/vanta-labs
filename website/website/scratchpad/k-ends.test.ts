import { describe, it, expect } from "vitest";
import { endsLabel } from "@/lib/storefront-offer-format";

describe("endsLabel truthfulness", () => {
  it("says 'Ends tonight' for a coupon that dies at 9am", () => {
    const now = new Date("2026-08-31T12:00:00Z");        // 8:00 AM ET
    const ends = "2026-08-31T13:00:00.000Z";             // 9:00 AM ET, one hour away
    console.log("  now 8:00 AM ET, coupon dies 9:00 AM ET ->", endsLabel(ends, now));
    expect(endsLabel(ends, now)).toBe("Ends tonight");
  });

  it("says 'Ends tonight' for a coupon a FULL YEAR away", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    const ends = "2027-09-03T20:00:00.000Z";             // same month+day, next year
    console.log("  now Sep 3 2026, coupon dies Sep 3 2027 ->", endsLabel(ends, now));
    expect(endsLabel(ends, now)).toBe("Ends tonight");
  });

  it("prints a year-less date for a far-future coupon", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    console.log("  now Sep 3 2026, coupon dies Dec 1 2028 ->", endsLabel("2028-12-01T20:00:00.000Z", now));
    expect(endsLabel("2028-12-01T20:00:00.000Z", now)).toBe("Ends Dec 1");
  });
});
