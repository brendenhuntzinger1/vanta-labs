import { describe, expect, it } from "vitest";
import { currentMonthKey, previousMonthKey } from "@/lib/ambassador-leaderboard";

// Month keys drive the monthly leaderboard's automatic reset — they must be
// stable 'YYYY-MM' and roll over year boundaries correctly.
describe("leaderboard month keys", () => {
  it("formats the current month as YYYY-MM (UTC)", () => {
    expect(currentMonthKey(new Date("2026-07-22T10:00:00Z"))).toBe("2026-07");
    expect(currentMonthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(currentMonthKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("rolls the previous month back across a year boundary", () => {
    expect(previousMonthKey(new Date("2026-07-22T10:00:00Z"))).toBe("2026-06");
    expect(previousMonthKey(new Date("2026-01-15T10:00:00Z"))).toBe("2025-12");
    expect(previousMonthKey(new Date("2026-03-01T00:00:00Z"))).toBe("2026-02");
  });
});
