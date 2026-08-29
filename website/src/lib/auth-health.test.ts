import { describe, expect, it } from "vitest";

import {
  STALLED_SIGNUP_AFTER_MS,
  STALLED_SIGNUP_LOOKBACK_MS,
  summariseStalledSignups,
} from "@/lib/auth-health";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const HOUR = 60 * 60 * 1000;

describe("summariseStalledSignups", () => {
  it("ignores accounts that confirmed", () => {
    const summary = summariseStalledSignups(
      [{ created_at: iso(48 * HOUR), email: "a@example.com", email_confirmed_at: iso(47 * HOUR) }],
      NOW,
    );
    expect(summary.stalled).toBe(0);
  });

  it("ignores an account confirmed by phone, where only confirmed_at is set", () => {
    const summary = summariseStalledSignups(
      [{ created_at: iso(48 * HOUR), email: "a@example.com", confirmed_at: iso(47 * HOUR) }],
      NOW,
    );
    expect(summary.stalled).toBe(0);
  });

  it("ignores an unconfirmed account that has nonetheless signed in", () => {
    // Auto-confirm off but a session established some other way: this person is
    // not locked out, so they are not evidence of a delivery problem.
    const summary = summariseStalledSignups(
      [{ created_at: iso(48 * HOUR), email: "a@example.com", last_sign_in_at: iso(47 * HOUR) }],
      NOW,
    );
    expect(summary.stalled).toBe(0);
  });

  it("does not alert inside the grace window", () => {
    const justUnder = STALLED_SIGNUP_AFTER_MS - HOUR;
    const summary = summariseStalledSignups([{ created_at: iso(justUnder), email: "a@example.com" }], NOW);
    expect(summary.stalled).toBe(0);
  });

  it("counts an account past the grace window", () => {
    const justOver = STALLED_SIGNUP_AFTER_MS + HOUR;
    const summary = summariseStalledSignups([{ created_at: iso(justOver), email: "a@example.com" }], NOW);
    expect(summary.stalled).toBe(1);
    expect(summary.oldestCreatedAt).toBe(iso(justOver));
  });

  it("stops counting once an account is older than the lookback", () => {
    // Otherwise the number only ever grows, and an alert that always fires is
    // an alert nobody reads.
    const tooOld = STALLED_SIGNUP_LOOKBACK_MS + HOUR;
    const summary = summariseStalledSignups([{ created_at: iso(tooOld), email: "a@example.com" }], NOW);
    expect(summary.stalled).toBe(0);
  });

  it("groups by mailbox domain and never records a full address", () => {
    // The real-world shape this exists to surface: one provider refusing us
    // while the others are fine.
    const stale = STALLED_SIGNUP_AFTER_MS + HOUR;
    const summary = summariseStalledSignups(
      [
        { created_at: iso(stale), email: "one@yahoo.com" },
        { created_at: iso(stale), email: "two@yahoo.com" },
        { created_at: iso(stale), email: "three@gmail.com" },
      ],
      NOW,
    );

    expect(summary.stalled).toBe(3);
    expect(summary.domains).toEqual({ "yahoo.com": 2, "gmail.com": 1 });

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("one@");
    expect(serialised).not.toContain("three@");
  });

  it("survives a row with a missing or unparseable created_at", () => {
    const summary = summariseStalledSignups(
      [{ email: "a@example.com" }, { created_at: "not-a-date", email: "b@example.com" }],
      NOW,
    );
    expect(summary.stalled).toBe(0);
    expect(summary.scanned).toBe(2);
  });

  it("labels an address with no @ rather than dropping it", () => {
    const stale = STALLED_SIGNUP_AFTER_MS + HOUR;
    const summary = summariseStalledSignups([{ created_at: iso(stale), email: null }], NOW);
    expect(summary.stalled).toBe(1);
    expect(summary.domains).toEqual({ "(unknown)": 1 });
  });
});
