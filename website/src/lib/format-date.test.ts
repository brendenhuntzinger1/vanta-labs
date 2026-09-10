import { describe, expect, it } from "vitest";
import { DISPLAY_TIME_ZONE, daysUntil, easternWallClockToUtcIso, formatDisplayDate } from "./format-date";

describe("formatDisplayDate", () => {
  it("reports the US evening date, not the UTC one it rolls over into", () => {
    // 2026-09-03T01:00:00Z is 9pm on September 2nd in New York. Every
    // server-rendered page and billing email used to call this "September 3".
    expect(formatDisplayDate("2026-09-03T01:00:00Z")).toBe("September 2, 2026");
    expect(formatDisplayDate("2026-09-03T01:00:00Z", "medium")).toBe("Sep 2, 2026");
    expect(formatDisplayDate("2026-09-03T01:00:00Z", "short")).toBe("Sep 2");
  });

  it("is unchanged for timestamps that are the same day in both zones", () => {
    expect(formatDisplayDate("2026-09-03T16:00:00Z")).toBe("September 3, 2026");
  });

  it("does not depend on the machine's timezone", () => {
    // The whole point: the same input yields the same string wherever it runs.
    // TZ is fixed by the formatter, not by the environment.
    const original = process.env.TZ;
    const stamp = "2026-09-03T01:00:00Z";
    const seen = new Set<string>();
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      seen.add(String(formatDisplayDate(stamp)));
    }
    process.env.TZ = original;
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe("September 2, 2026");
  });

  it("handles DST on both sides of the change", () => {
    // EDT (UTC-4) in July, EST (UTC-5) in January.
    expect(formatDisplayDate("2026-07-04T03:00:00Z")).toBe("July 3, 2026");
    expect(formatDisplayDate("2026-01-04T04:00:00Z")).toBe("January 3, 2026");
  });

  it("returns null for anything that is not a real date", () => {
    expect(formatDisplayDate(null)).toBeNull();
    expect(formatDisplayDate(undefined)).toBeNull();
    expect(formatDisplayDate("")).toBeNull();
    expect(formatDisplayDate("not a date")).toBeNull();
    expect(formatDisplayDate(Number.NaN)).toBeNull();
  });

  it("accepts strings, epoch millis and Date objects alike", () => {
    const iso = "2026-09-03T16:00:00Z";
    const expected = "September 3, 2026";
    expect(formatDisplayDate(iso)).toBe(expected);
    expect(formatDisplayDate(Date.parse(iso))).toBe(expected);
    expect(formatDisplayDate(new Date(iso))).toBe(expected);
  });

  it("formats a datetime without dropping the time", () => {
    const out = formatDisplayDate("2026-09-03T16:30:00Z", "datetime") ?? "";
    expect(out).toContain("Sep 3, 2026");
    expect(out).toMatch(/12:30/); // 16:30Z is 12:30pm EDT
  });

  it("pins the business zone", () => {
    expect(DISPLAY_TIME_ZONE).toBe("America/New_York");
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-08-04T14:00:00Z"); // 10am ET, Aug 4

  it("counts whole calendar days in the display zone", () => {
    expect(daysUntil("2026-08-04T20:00:00Z", now)).toBe(0);
    expect(daysUntil("2026-08-05T20:00:00Z", now)).toBe(1);
    expect(daysUntil("2026-08-11T20:00:00Z", now)).toBe(7);
  });

  it("flips at local midnight, not at 7pm ET", () => {
    // 2026-08-05T03:00:00Z is still 11pm on Aug 4 in New York — same day, 0 left.
    expect(daysUntil("2026-08-05T03:00:00Z", now)).toBe(0);
    // An hour later it is Aug 5 locally.
    expect(daysUntil("2026-08-05T05:00:00Z", now)).toBe(1);
  });

  it("never goes negative once the date has passed", () => {
    expect(daysUntil("2026-07-01T00:00:00Z", now)).toBe(0);
  });

  it("counts across a DST boundary without drifting", () => {
    // Nov 1 2026 is the EDT->EST change; 30 calendar days must still be 30.
    const before = new Date("2026-10-20T16:00:00Z");
    expect(daysUntil("2026-11-19T16:00:00Z", before)).toBe(30);
  });

  it("returns null for junk", () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("nope", now)).toBeNull();
  });
});

describe("formatDisplayDate — datetimeShort", () => {
  it("renders a compact stamp with the time, in Eastern", () => {
    // 8:30 PM Tuesday in Florida, stored as the next UTC day.
    expect(formatDisplayDate("2026-09-09T00:30:00Z", "datetimeShort")).toBe("Sep 8, 8:30 PM");
  });

  it("does not depend on the machine's timezone", () => {
    // The send ledger is a SERVER component: this runs on Vercel, in UTC. Before
    // this style existed it called toLocaleTimeString with no zone and reported
    // "Sep 9 12:30 AM" for the send above — wrong hour and wrong day.
    const original = process.env.TZ;
    const seen = new Set<string>();
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      seen.add(String(formatDisplayDate("2026-09-09T00:30:00Z", "datetimeShort")));
    }
    process.env.TZ = original;
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe("Sep 8, 8:30 PM");
  });

  it("tracks DST rather than a fixed -5", () => {
    expect(formatDisplayDate("2026-07-04T18:00:00Z", "datetimeShort")).toBe("Jul 4, 2:00 PM"); // EDT
    expect(formatDisplayDate("2026-01-04T18:00:00Z", "datetimeShort")).toBe("Jan 4, 1:00 PM"); // EST
  });
});

describe("easternWallClockToUtcIso", () => {
  it("reads a datetime-local value as Eastern, not as the browser's zone", () => {
    // The campaign scheduler's <input type="datetime-local"> yields a bare wall
    // clock with no zone. `new Date(value)` used to resolve it against whatever
    // zone the browser happened to be in, so the same "2:30 PM" scheduled a
    // different instant depending on where the operator was sitting.
    expect(easternWallClockToUtcIso("2026-09-15T14:30")).toBe("2026-09-15T18:30:00.000Z"); // EDT, -4
    expect(easternWallClockToUtcIso("2026-01-15T14:30")).toBe("2026-01-15T19:30:00.000Z"); // EST, -5
  });

  it("is stable wherever the browser is", () => {
    const original = process.env.TZ;
    const seen = new Set<string>();
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = tz;
      seen.add(String(easternWallClockToUtcIso("2026-09-15T14:30")));
    }
    process.env.TZ = original;
    expect(seen.size).toBe(1);
  });

  it("round-trips back through the display formatter", () => {
    const iso = easternWallClockToUtcIso("2026-09-15T14:30");
    expect(formatDisplayDate(iso, "datetimeShort")).toBe("Sep 15, 2:30 PM");
  });

  it("handles midnight and the seconds-bearing form", () => {
    expect(easternWallClockToUtcIso("2026-09-15T00:00")).toBe("2026-09-15T04:00:00.000Z");
    expect(easternWallClockToUtcIso("2026-09-15T14:30:00")).toBe("2026-09-15T18:30:00.000Z");
  });

  it("returns null for junk rather than an Invalid Date", () => {
    expect(easternWallClockToUtcIso("")).toBeNull();
    expect(easternWallClockToUtcIso("nope")).toBeNull();
    expect(easternWallClockToUtcIso(null)).toBeNull();
  });
});

describe("formatDisplayDate — time", () => {
  it("renders a bare clock time in Eastern", () => {
    // 20:23Z is 4:23 PM in Florida — the reading that prompted this sweep.
    expect(formatDisplayDate("2026-09-10T20:23:00Z", "time")).toBe("4:23 PM");
  });

  it("tracks DST rather than a fixed offset", () => {
    expect(formatDisplayDate("2026-09-10T20:23:00Z", "time")).toBe("4:23 PM"); // EDT, -4
    expect(formatDisplayDate("2026-01-10T20:23:00Z", "time")).toBe("3:23 PM"); // EST, -5
  });

  it("does not depend on the machine's timezone", () => {
    const original = process.env.TZ;
    const seen = new Set<string>();
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      seen.add(String(formatDisplayDate("2026-09-10T20:23:00Z", "time")));
    }
    process.env.TZ = original;
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe("4:23 PM");
  });
});
