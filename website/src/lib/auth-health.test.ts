import { describe, expect, it } from "vitest";

import {
  STALLED_SIGNUP_AFTER_MS,
  STALLED_SIGNUP_LOOKBACK_MS,
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
