import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The surfaces that carry a date but are not a dashboard tile: a batch label an
// operator reads out loud, and the store-credit period key that decides whether
// a member has already been granted this month.
//
// Both were cut in UTC, and the store-credit one has a witness in production —
// a $5.00 `membership_monthly_grant` stamped `period_month = '2026-09'`, written
// at 2026-09-01T00:01:34Z, which is 8:01pm ET on AUGUST 31st. The sweep believed
// September had begun while the store was still selling August.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({ supabaseAdmin: {} }));

// 8:01pm ET on Aug 31 — the instant that grant was actually written.
const LATE_AUGUST_EVENING = new Date("2026-09-01T00:01:34.981Z");

describe("suggestBatchLabel", () => {
  it("names the evening batch after the day the operator is having", async () => {
    const { suggestBatchLabel } = await import("./fulfillment-batches");
    // 2026-09-02T00:30Z is 8:30pm ET on September 1st. On UTC this came out
    // `2026-09-02-AM`: tomorrow's date, and "AM" for an evening shift.
    expect(suggestBatchLabel(new Date("2026-09-02T00:30:00Z"))).toBe("2026-09-01-PM");
  });

  it("still says AM in the morning", async () => {
    const { suggestBatchLabel } = await import("./fulfillment-batches");
    expect(suggestBatchLabel(new Date("2026-09-01T11:00:00Z"))).toBe("2026-09-01-AM"); // 7am ET
  });
});

describe("the store-credit grant period", () => {
  it("does not start September on the evening of August 31st", async () => {
    const { currentPeriodMonth, startOfCurrentMonthIso } = await import("./store-credit");
    expect(currentPeriodMonth(LATE_AUGUST_EVENING)).toBe("2026-08");
    expect(startOfCurrentMonthIso(LATE_AUGUST_EVENING)).toBe("2026-08-01T04:00:00.000Z");
  });

  it("keeps the dedupe key and the spendable window on the same month", async () => {
    // These two ARE the same rule seen from either side: `period_month` decides
    // whether a member may be granted, `startOfCurrentMonthIso` decides what
    // they can still spend. If they disagreed at the boundary a member would be
    // granted twice, or hold credit their balance could not see.
    const { currentPeriodMonth, startOfCurrentMonthIso } = await import("./store-credit");
    for (const iso of [
      "2026-09-01T00:01:34.981Z", // 8:01pm ET, Aug 31
      "2026-09-01T04:00:00.000Z", // midnight ET, Sep 1
      "2026-09-15T12:00:00.000Z",
      "2026-01-01T02:00:00.000Z", // 9pm ET, Dec 31 — a year boundary too
    ]) {
      const now = new Date(iso);
      expect(startOfCurrentMonthIso(now).slice(0, 7)).toBe(currentPeriodMonth(now));
    }
  });
});
