import { describe, expect, it } from "vitest";

import {
  STALLED_SIGNUP_AFTER_MS,
  STALLED_SIGNUP_LOOKBACK_MS,
  describeStalledProviders,
  summarisePartnersLockedOut,
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

  it("counts every signup each domain contributed in the same window, confirmed or not", () => {
    // The denominator. Five stalled Gmail accounts means nothing without
    // knowing whether Gmail sent us five signups that week or eighty.
    const stale = STALLED_SIGNUP_AFTER_MS + HOUR;
    const summary = summariseStalledSignups(
      [
        { created_at: iso(stale), email: "one@icloud.com" },
        { created_at: iso(stale), email: "two@icloud.com", email_confirmed_at: iso(stale - HOUR) },
        { created_at: iso(stale), email: "three@gmail.com", email_confirmed_at: iso(stale - HOUR) },
        // Inside the grace window: not evidence either way yet, so not counted.
        { created_at: iso(HOUR), email: "four@gmail.com" },
        // Older than the lookback: not counted either.
        { created_at: iso(STALLED_SIGNUP_LOOKBACK_MS + HOUR), email: "five@gmail.com" },
      ],
      NOW,
    );

    expect(summary.signups).toBe(3);
    expect(summary.signupsByDomain).toEqual({ "icloud.com": 2, "gmail.com": 1 });
    expect(summary.domains).toEqual({ "icloud.com": 1 });
  });
});

// ---------------------------------------------------------------------------
// The sentence that tells the operator WHERE to look. On 2026-09-10 it said
// "5 of them are @gmail.com — check whether that provider is rejecting or
// spam-filing our sending domain", because Gmail had the most stalled
// accounts. Gmail also had eighty-odd signups that week and was confirming
// more than ninety percent of them; iCloud had six and was confirming two.
// The largest count is not the outlier, the worst share is.
// ---------------------------------------------------------------------------

describe("describeStalledProviders", () => {
  it("names the provider whose stalled share is out of line, not the one with the most stalled accounts", () => {
    const { note, outliers } = describeStalledProviders({
      stalled: 9,
      signups: 100,
      domains: { "gmail.com": 5, "icloud.com": 4 },
      signupsByDomain: { "gmail.com": 83, "icloud.com": 6, "yahoo.com": 11 },
    });

    expect(outliers).toEqual(["icloud.com"]);
    expect(note).toContain("4 of the 6 @icloud.com");
    expect(note).not.toContain("@gmail.com");
  });

  it("says so when no provider stands out", () => {
    // Stalled accounts in proportion to signups: spam folders and changed
    // minds, not a provider refusing us.
    const { note, outliers } = describeStalledProviders({
      stalled: 7,
      signups: 100,
      domains: { "gmail.com": 5, "icloud.com": 1, "yahoo.com": 1 },
      signupsByDomain: { "gmail.com": 80, "icloud.com": 10, "yahoo.com": 10 },
    });

    expect(outliers).toEqual([]);
    expect(note).toContain("No single provider stands out");
    expect(note).not.toContain("check whether that provider");
  });

  it("points at our own sending when every provider is stalling", () => {
    const { note, outliers } = describeStalledProviders({
      stalled: 12,
      signups: 15,
      domains: { "gmail.com": 8, "icloud.com": 4 },
      signupsByDomain: { "gmail.com": 10, "icloud.com": 5 },
    });

    expect(outliers).toEqual([]);
    expect(note).toContain("every provider");
  });

  it("never calls out a provider on one or two signups", () => {
    // A mistyped domain is one signup and one stall: a 100% rate that means
    // nothing, and a real customer typo the alert cannot fix.
    const { outliers } = describeStalledProviders({
      stalled: 2,
      signups: 40,
      domains: { "iclouds.com": 1, "gmail.com": 1 },
      signupsByDomain: { "iclouds.com": 1, "gmail.com": 39 },
    });

    expect(outliers).toEqual([]);
  });

  it("carries the overall figure so the outlier can be read against it", () => {
    const { note } = describeStalledProviders({
      stalled: 9,
      signups: 100,
      domains: { "gmail.com": 5, "icloud.com": 4 },
      signupsByDomain: { "gmail.com": 83, "icloud.com": 6, "yahoo.com": 11 },
    });

    expect(note).toContain("9 of 100");
  });
});

// ---------------------------------------------------------------------------
// The check that does NOT expire. An approved ambassador's referral code is
// live and earning whether or not they can open the portal, so unlike a stalled
// signup this condition stays worth reporting for as long as it lasts.
// ---------------------------------------------------------------------------

const DAY = 24 * HOUR;
const APPROVED_LONG_AGO = iso(10 * DAY);

const authUser = (id: string, lastSignInAt: string | null = null) => ({
  id,
  created_at: APPROVED_LONG_AGO,
  email: "amb@example.com",
  last_sign_in_at: lastSignInAt,
});

describe("summarisePartnersLockedOut", () => {
  it("reports an approved ambassador who has never signed in", () => {
    // ZAIN: invited, approved an hour later with a live referral code, and six
    // days on had never confirmed and never signed in.
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "ZAIN", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
    expect(summary.partners[0]).toMatchObject({ partnerId: "p1", referralCode: "ZAIN", reason: "never_signed_in" });
  });

  it("ignores an ambassador who has signed in", () => {
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "OK", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO }],
      [authUser("u1", iso(2 * HOUR))],
      NOW,
    );
    expect(summary.lockedOut).toBe(0);
  });

  it("ignores an ambassador who has signed in even if still unconfirmed", () => {
    // Confirmation is the signup check's business. This check asks one question
    // only: have they ever got in?
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "OK", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO }],
      [{ id: "u1", created_at: APPROVED_LONG_AGO, email_confirmed_at: null, last_sign_in_at: iso(HOUR) }],
      NOW,
    );
    expect(summary.lockedOut).toBe(0);
  });

  it("ignores ambassadors who are not approved", () => {
    // A pending applicant who cannot sign in is the signup check's business; a
    // rejected or disabled one is nobody's.
    const rows = ["pending", "rejected", "disabled", "info_requested"].map((status, index) => ({
      id: `p${index}`, status, referral_code: "X", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO,
    }));
    const summary = summarisePartnersLockedOut(rows, [authUser("u1")], NOW);
    expect(summary.lockedOut).toBe(0);
    expect(summary.checked).toBe(0);
  });

  it("matches the status case-insensitively", () => {
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "Approved", referral_code: "ZAIN", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
  });

  it("holds off inside the grace window", () => {
    // Freshly approved: they have not had time to open the mail yet.
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "NEW", auth_user_id: "u1", approved_at: iso(HOUR) }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(0);
    expect(summary.checked).toBe(1);
  });

  it("does not expire, however old the approval is", () => {
    // The whole point. STALLED_SIGNUP_LOOKBACK_MS drops a stalled signup after
    // seven days; this must still report at ninety.
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "ZAIN", auth_user_id: "u1", approved_at: iso(90 * DAY) }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
  });

  it("reports an approved ambassador with no auth account at all", () => {
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "GHOST", auth_user_id: null, approved_at: APPROVED_LONG_AGO }],
      [],
      NOW,
    );
    expect(summary.partners[0].reason).toBe("no_auth_user");
  });

  it("reports an approved ambassador whose auth account has gone", () => {
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "GONE", auth_user_id: "deleted", approved_at: APPROVED_LONG_AGO }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.partners[0].reason).toBe("auth_user_missing");
  });

  it("falls back to created_at when approved_at is missing", () => {
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "OLD", auth_user_id: "u1", created_at: APPROVED_LONG_AGO }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
  });

  it("does not let an unreadable date exempt a locked-out ambassador", () => {
    // Skipping on an unparseable date would make a bad timestamp a silent
    // amnesty for exactly the row this alert exists to surface.
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "ODD", auth_user_id: "u1", approved_at: "not-a-date" }],
      [authUser("u1")],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
  });

  it("never records an email address", () => {
    // Same principle as domainOf above: system alerts are read by more people
    // and kept longer than the tables behind them.
    const summary = summarisePartnersLockedOut(
      [{ id: "p1", status: "approved", referral_code: "ZAIN", auth_user_id: "u1", approved_at: APPROVED_LONG_AGO }],
      [authUser("u1")],
      NOW,
    );
    expect(JSON.stringify(summary)).not.toContain("@");
  });
});
