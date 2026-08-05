import { describe, expect, it, vi } from "vitest";

// "server-only" is a bundler guard with no meaning in the vitest node
// environment. Hoisted above the import below.
vi.mock("server-only", () => ({}));

import { priorMonthWindow } from "@/lib/volume-cost-service";

/**
 * The wholesale sheet sets the tier from the PRIOR month's product purchases,
 * so the window this reads has to be exactly last month — no overlap into the
 * current month (which would let this month's orders raise this month's own
 * discount) and no gap (which would silently drop a day of purchases).
 */
describe("prior-month window", () => {
  it("is the whole of last month, exclusive of this month", () => {
    const { start, end } = priorMonthWindow(new Date("2026-08-05T12:00:00Z"));
    expect(start).toBe("2026-07-01T00:00:00.000Z");
    expect(end).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rolls back across a year boundary", () => {
    const { start, end } = priorMonthWindow(new Date("2026-01-14T09:30:00Z"));
    expect(start).toBe("2025-12-01T00:00:00.000Z");
    expect(end).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles a short prior month", () => {
    const { start, end } = priorMonthWindow(new Date("2026-03-31T23:59:59Z"));
    expect(start).toBe("2026-02-01T00:00:00.000Z");
    expect(end).toBe("2026-03-01T00:00:00.000Z");
  });

  it("never includes any of the current month", () => {
    // The failure this guards: an overlap would mean this month's own orders
    // raise this month's discount, which is not the deal on the sheet.
    for (const day of ["2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z", "2026-08-31T23:59:59Z"]) {
      const { end } = priorMonthWindow(new Date(day));
      expect(end, day).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("leaves no gap between the window end and the current month start", () => {
    const now = new Date("2026-06-10T00:00:00Z");
    const { end } = priorMonthWindow(now);
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    expect(end).toBe(currentMonthStart);
  });

  it("is stable for every day of the month — the rate does not drift mid-month", () => {
    const windows = new Set(
      Array.from({ length: 28 }, (_, i) =>
        JSON.stringify(priorMonthWindow(new Date(`2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`))),
      ),
    );
    expect(windows.size).toBe(1);
  });
});
