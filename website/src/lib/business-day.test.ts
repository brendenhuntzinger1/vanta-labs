import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUSINESS_TIME_ZONE,
  startOfBusinessDay,
  startOfBusinessDayIso,
  startOfBusinessMonth,
  startOfBusinessMonthIso,
  startOfBusinessWeek,
  startOfBusinessYear,
} from "./business-day";

// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS FOR (reported from /admin/partners, 2026-09-01).
//
// An ambassador bought at 5:20pm ET. The store read:
//
//   SALES TODAY        $0.00
//   SALES THIS MONTH   $94.96
//
// Both tiles were behaving exactly as written. "Today" was cut at midnight UTC,
// which is 8pm ET — so from 8pm ET onward every evening, "today" is already
// TOMORROW and the whole day's sales fall out of the tile while staying in the
// month. The same 4-5 hour hole sits at the start of every month, where "this
// month" begins on the last evening of the previous one.
//
// format-date.ts already settled that America/New_York is this business's zone,
// and every date an operator reads on /admin is rendered in it. Only the
// aggregation windows were still cut in UTC, so the tiles and the timestamps
// beside them described different days.
// ---------------------------------------------------------------------------

// The exact moment the report came in: 00:25 UTC on Sep 2 = 8:25pm ET on Sep 1.
const REPORTED_AT = new Date("2026-09-02T00:25:48Z");
// The ambassador's order (VL-27C530F8), paid 5:20pm ET the same business day.
const ORDER_PAID_AT = new Date("2026-09-01T21:20:22.657Z");

describe("startOfBusinessDay", () => {
  it("keeps a US-evening sale inside today, which is the reported bug", () => {
    const dayStart = startOfBusinessDay(REPORTED_AT);
    // Midnight ET on Sep 1, not midnight UTC on Sep 2.
    expect(dayStart.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(ORDER_PAID_AT.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());
  });

  it("follows the zone across DST, not a fixed offset", () => {
    // EDT is UTC-4 in September, EST is UTC-5 in January.
    expect(startOfBusinessDayIso(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15T05:00:00.000Z");
    expect(startOfBusinessDayIso(new Date("2026-07-15T12:00:00Z"))).toBe("2026-07-15T04:00:00.000Z");
  });

  it("steps by calendar days, so yesterday is 23 or 25 hours over a DST change", () => {
    // US clocks spring forward on 2026-03-08, so Mar 8 is a 23-hour day.
    const mar9 = new Date("2026-03-09T15:00:00Z");
    const start = startOfBusinessDay(mar9);
    const yesterday = startOfBusinessDay(mar9, -1);
    expect(start.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(yesterday.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(start.getTime() - yesterday.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("does not depend on the machine's timezone", () => {
    const original = process.env.TZ;
    const seen = new Set<string>();
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      seen.add(startOfBusinessDayIso(REPORTED_AT));
    }
    process.env.TZ = original;
    expect([...seen]).toEqual(["2026-09-01T04:00:00.000Z"]);
  });
});

describe("startOfBusinessMonth", () => {
  it("does not start September on the evening of August 31st", () => {
    // 2026-09-01T02:00Z is 10pm ET on Aug 31. A UTC cut called that September.
    expect(startOfBusinessMonthIso(new Date("2026-09-01T02:00:00Z"))).toBe("2026-08-01T04:00:00.000Z");
  });

  it("starts the month at local midnight once the month has actually begun", () => {
    expect(startOfBusinessMonthIso(REPORTED_AT)).toBe("2026-09-01T04:00:00.000Z");
    expect(ORDER_PAID_AT.getTime()).toBeGreaterThanOrEqual(startOfBusinessMonth(REPORTED_AT).getTime());
  });
});

describe("startOfBusinessWeek and startOfBusinessYear", () => {
  it("starts the week on Monday, in the business zone", () => {
    // 2026-09-01 is a Tuesday; the week began at midnight ET on Monday Aug 31.
    expect(startOfBusinessWeek(REPORTED_AT).toISOString()).toBe("2026-08-31T04:00:00.000Z");
    // A Monday is its own week start, and a Sunday belongs to the week before.
    expect(startOfBusinessWeek(new Date("2026-08-31T15:00:00Z")).toISOString()).toBe("2026-08-31T04:00:00.000Z");
    expect(startOfBusinessWeek(new Date("2026-09-06T15:00:00Z")).toISOString()).toBe("2026-08-31T04:00:00.000Z");
  });

  it("starts the year at local midnight on January 1st", () => {
    // 2026-01-01T03:00Z is 10pm ET on Dec 31 2025 — still last year.
    expect(startOfBusinessYear(new Date("2026-01-01T03:00:00Z")).toISOString()).toBe("2025-01-01T05:00:00.000Z");
    expect(startOfBusinessYear(new Date("2026-06-01T12:00:00Z")).toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });
});

describe("the business zone is the one the admin already reads dates in", () => {
  it("is America/New_York, same as format-date's display zone", () => {
    expect(BUSINESS_TIME_ZONE).toBe("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// The definition exists on five admin surfaces, and an operator reads several
// of them side by side. admin-analytics.ts already carried a comment pinning
// them all to UTC "so two tiles on one dashboard cannot disagree" — the reason
// was right and the zone was wrong, so these pin the corrected shape instead.
// Source-level, like admin-metric-definitions.test.ts, because the drift being
// guarded against is one file quietly going back to Date.UTC.
// ---------------------------------------------------------------------------

/** Each surface, and the helper every one of its windows must come from. */
const SURFACES: Array<{ path: string; helpers: string[] }> = [
  // /admin/partners "Sales today / Sales this month", and the ambassador
  // dashboard's "This month" commissions.
  { path: "src/lib/partner-portal.ts", helpers: ["startOfBusinessDayIso(", "startOfBusinessMonthIso(", "startOfBusinessMonth("] },
  // /admin/revenue "today".
  { path: "src/lib/admin-revenue.ts", helpers: ["startOfBusinessDayIso("] },
  // /admin/profit today / yesterday / week / month / year.
  { path: "src/lib/admin-profit.ts", helpers: ["startOfBusinessDay(", "startOfBusinessWeek(", "startOfBusinessMonth(", "startOfBusinessYear("] },
  // The analytics dashboard's day figures.
  { path: "src/lib/admin-analytics.ts", helpers: ["startOfBusinessDayIso("] },
];

function code(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

describe("no admin metric window is cut at midnight UTC", () => {
  for (const { path, helpers } of SURFACES) {
    it(`${path} takes every window from business-day.ts`, () => {
      const src = code(path);
      expect(src).toMatch(/from "@\/lib\/business-day"/);
      for (const helper of helpers) {
        expect(src, `${path} should build its window with ${helper}`).toContain(helper);
      }
    });

    it(`${path} builds no day start out of the UTC accessors`, () => {
      // The defect, stated as source. Both shapes cut the day at midnight UTC,
      // which is the 8pm ET rollover that emptied the "today" tile every
      // evening. A `Date.UTC(y, m, 1)` elsewhere is fine — chart labels are
      // synthesised from month KEYS, not from a window boundary.
      expect(code(path)).not.toMatch(
        /Date\.UTC\(\s*\w+\.getUTCFullYear\(\),\s*\w+\.getUTCMonth\(\),\s*\w+\.getUTCDate\(\)\s*\)/,
      );
      expect(code(path)).not.toMatch(/setUTCHours\(0,\s*0,\s*0,\s*0\)/);
    });
  }
});
