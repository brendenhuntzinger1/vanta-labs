import { describe, expect, it } from "vitest";
import { DISPLAY_TIME_ZONE, daysUntil, formatDisplayDate } from "./format-date";

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
