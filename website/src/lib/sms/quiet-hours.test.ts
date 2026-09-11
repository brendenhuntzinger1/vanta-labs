import { describe, expect, it } from "vitest";

import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  FALLBACK_END_HOUR_ET,
  FALLBACK_START_HOUR_ET,
  marketingSendAllowedAt,
  resolveTimezone,
} from "@/lib/sms/quiet-hours";

// ---------------------------------------------------------------------------
// Invariant 44: boundaries at each zone edge, plus the continental fallback.
//
// The tests use real instants and real IANA zones through Intl, rather than
// arithmetic on offsets, because the bug this module can actually have is a
// DST one — and an offset-based test would share the mistake.
//
// 2026-09-11 is EDT (UTC-4), so 16:00Z = 12:00 ET = 09:00 PT.
// 2026-01-15 is EST (UTC-5), so 17:00Z = 12:00 ET = 09:00 PT.
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

describe("resolveTimezone — never from the area code", () => {
  it("prefers a stored subscriber timezone", () => {
    expect(resolveTimezone({ subscriberTimezone: "America/Denver", lastOrderState: "FL" }))
      .toEqual({ timezone: "America/Denver", source: "subscriber" });
  });

  it("falls back to the shipping state on a real order", () => {
    expect(resolveTimezone({ lastOrderState: "CA" }))
      .toEqual({ timezone: "America/Los_Angeles", source: "order_state" });
  });

  it("is case-insensitive and tolerant of whitespace in the state", () => {
    expect(resolveTimezone({ lastOrderState: " wa " }).timezone).toBe("America/Los_Angeles");
  });

  it("reports unknown rather than guessing", () => {
    for (const input of [{}, { lastOrderState: "" }, { lastOrderState: "ZZ" }, { subscriberTimezone: "  " }]) {
      expect(resolveTimezone(input)).toEqual({ timezone: null, source: "fallback" });
    }
  });

  it("accepts no area-code input at all — the signature makes the mistake unavailable", () => {
    // The 813 number in Seattle is the case this design exists for. There is
    // deliberately no parameter through which an area code could be passed.
    const call = resolveTimezone as unknown as (input: Record<string, unknown>) => unknown;
    expect(call({ areaCode: "813" })).toEqual({ timezone: null, source: "fallback" });
  });
});

describe("the known-timezone path, at the boundaries", () => {
  it("refuses at 07:59 local and allows at 08:00 local", () => {
    // 11:59Z = 07:59 EDT; 12:00Z = 08:00 EDT.
    expect(marketingSendAllowedAt({ now: at("2026-09-11T11:59:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(false);
    expect(marketingSendAllowedAt({ now: at("2026-09-11T12:00:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(true);
  });

  it("allows at 20:59 local and refuses at 21:00 local", () => {
    // 00:59Z next day = 20:59 EDT; 01:00Z = 21:00 EDT.
    expect(marketingSendAllowedAt({ now: at("2026-09-12T00:59:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(true);
    expect(marketingSendAllowedAt({ now: at("2026-09-12T01:00:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(false);
  });

  it("applies the recipient's zone, not the server's", () => {
    // 15:00Z is 11:00 EDT (allowed) but 08:00 PDT (also allowed) and
    // 05:00 AKDT (refused). One instant, three answers.
    const instant = at("2026-09-11T15:00:00Z");
    expect(marketingSendAllowedAt({ now: instant, subscriberTimezone: "America/New_York" }).allowed).toBe(true);
    expect(marketingSendAllowedAt({ now: instant, subscriberTimezone: "America/Los_Angeles" }).allowed).toBe(true);
    expect(marketingSendAllowedAt({ now: instant, subscriberTimezone: "America/Anchorage" }).allowed).toBe(false);
  });

  it("handles the DST shift without an offset assumption", () => {
    // 12:00Z is 08:00 EDT in September (allowed) and 07:00 EST in January
    // (refused). Identical wall-clock UTC, different answers.
    expect(marketingSendAllowedAt({ now: at("2026-09-11T12:00:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(true);
    expect(marketingSendAllowedAt({ now: at("2026-01-15T12:00:00Z"), subscriberTimezone: "America/New_York" }).allowed).toBe(false);
  });

  it("uses the default 8-21 window", () => {
    expect(DEFAULT_START_HOUR).toBe(8);
    expect(DEFAULT_END_HOUR).toBe(21);
  });
});

describe("states with stricter statutes", () => {
  it.each(["FL", "OK", "WA", "MD"])("closes %s at 20:00 rather than 21:00", (state) => {
    // 00:30Z = 20:30 EDT. Inside the federal window, outside the state one.
    const decision = marketingSendAllowedAt({
      now: at("2026-09-12T00:30:00Z"),
      subscriberTimezone: "America/New_York",
      lastOrderStateCode: state,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(state);
  });

  it("still allows the same instant for a state with no stricter rule", () => {
    const decision = marketingSendAllowedAt({
      now: at("2026-09-12T00:30:00Z"),
      subscriberTimezone: "America/New_York",
      lastOrderStateCode: "NY",
    });
    expect(decision.allowed).toBe(true);
  });

  it("reports the narrower window it applied", () => {
    const decision = marketingSendAllowedAt({
      now: at("2026-09-11T16:00:00Z"),
      subscriberTimezone: "America/New_York",
      lastOrderStateCode: "FL",
    });
    expect(decision.window.end).toBe(20);
  });
});

describe("the continental-safe fallback, when the timezone is unknown", () => {
  it("is 12:00-20:00 ET", () => {
    expect(FALLBACK_START_HOUR_ET).toBe(12);
    expect(FALLBACK_END_HOUR_ET).toBe(20);
  });

  it("refuses before 12:00 ET and allows from 12:00 ET", () => {
    // 15:59Z = 11:59 EDT; 16:00Z = 12:00 EDT.
    expect(marketingSendAllowedAt({ now: at("2026-09-11T15:59:00Z") }).allowed).toBe(false);
    expect(marketingSendAllowedAt({ now: at("2026-09-11T16:00:00Z") }).allowed).toBe(true);
  });

  it("refuses from 20:00 ET", () => {
    // 23:59Z = 19:59 EDT; 00:00Z = 20:00 EDT.
    expect(marketingSendAllowedAt({ now: at("2026-09-11T23:59:00Z") }).allowed).toBe(true);
    expect(marketingSendAllowedAt({ now: at("2026-09-12T00:00:00Z") }).allowed).toBe(false);
  });

  it("is inside 8am-9pm local for every continental zone across the whole window", () => {
    // The property the window exists for, checked rather than asserted: at
    // every allowed instant, all four continental zones are inside 8-21.
    const zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
    for (let etHour = FALLBACK_START_HOUR_ET; etHour < FALLBACK_END_HOUR_ET; etHour++) {
      const utc = etHour + 4; // EDT
      const instant = at(`2026-09-11T${String(utc).padStart(2, "0")}:30:00Z`);
      expect(marketingSendAllowedAt({ now: instant }).allowed, `${etHour}:30 ET should be allowed`).toBe(true);
      for (const zone of zones) {
        const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(instant)) % 24;
        expect(hour, `${zone} at ${etHour}:30 ET`).toBeGreaterThanOrEqual(8);
        expect(hour, `${zone} at ${etHour}:30 ET`).toBeLessThan(21);
      }
    }
  });

  it("says the timezone was unknown, so an operator can tell why the window was narrow", () => {
    const decision = marketingSendAllowedAt({ now: at("2026-09-11T16:00:00Z") });
    expect(decision.source).toBe("fallback");
    expect(decision.reason).toContain("unknown");
  });
});

describe("fails closed", () => {
  it("refuses on an unparseable timezone rather than falling through to a guess", () => {
    const decision = marketingSendAllowedAt({
      now: at("2026-09-11T16:00:00Z"),
      subscriberTimezone: "Not/AZone",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Could not read");
  });

  it("refuses on an invalid instant", () => {
    expect(marketingSendAllowedAt({ now: new Date(NaN) }).allowed).toBe(false);
  });

  it("never throws", () => {
    for (const input of [
      { now: at("2026-09-11T16:00:00Z"), subscriberTimezone: "" },
      { now: at("2026-09-11T16:00:00Z"), lastOrderState: null },
      { now: new Date(NaN), subscriberTimezone: "America/New_York" },
    ]) {
      expect(() => marketingSendAllowedAt(input)).not.toThrow();
    }
  });
});
