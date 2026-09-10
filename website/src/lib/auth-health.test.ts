import { describe, expect, it } from "vitest";

import {
  STALLED_SIGNUP_AFTER_MS,
  STALLED_SIGNUP_LOOKBACK_MS,
  summarisePartnersLockedOut,
  summariseStalledSignups,
  canConcludeLockout,
  overRepresentedDomain,
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

// ---------------------------------------------------------------------------
// THE DOMAIN NOTE MUST BE EVIDENCE, NOT THE SHAPE OF THE CUSTOMER BASE.
//
// The note fired whenever the commonest stalled domain had more than one
// account, and then asserted a cause: "check whether that provider is rejecting
// or spam-filing our sending domain". For a consumer store whose customers are
// mostly on Gmail and iCloud that condition is met essentially always, so the
// alert accused Gmail every time it fired.
//
// On 2026-09-10 it did exactly that — "5 of them are @gmail.com" — and every
// one of those nine confirmations had been DELIVERED within three to seven
// seconds, Gmail included, one of them opened. Nothing had bounced and nothing
// was suppressed. The reader was sent to audit sending-domain reputation for a
// problem that did not exist, which is the same failure this file's sibling
// test was written about: an alert that names the wrong system.
//
// A domain is only evidence if it is over-represented AMONG THE STALLED
// relative to its share of everyone scanned. That baseline is free — the same
// list is already in memory — so this costs no extra query in a sweep that is
// already close to its deadline.
// ---------------------------------------------------------------------------

describe("the stalled domain mix is only reported when it is disproportionate", () => {
  const stalledUser = (email: string) => ({ created_at: iso(48 * HOUR), email });
  const healthyUser = (email: string) => ({
    created_at: iso(48 * HOUR), email, email_confirmed_at: iso(47 * HOUR),
  });

  it("records the domain mix of everyone scanned, not only the stalled", () => {
    const summary = summariseStalledSignups(
      [stalledUser("a@gmail.com"), healthyUser("b@gmail.com"), healthyUser("c@icloud.com")],
      NOW,
    );
    expect(summary.domains).toEqual({ "gmail.com": 1 });
    expect(summary.scannedDomains).toEqual({ "gmail.com": 2, "icloud.com": 1 });
  });

  it("names no domain when the stalled mix simply mirrors the customer base", () => {
    // The production case: Gmail is most of the stalled accounts because Gmail
    // is most of the customers. 6 of 10 stalled, 60 of 100 scanned.
    const users = [
      ...Array.from({ length: 6 }, (_, i) => stalledUser(`s${i}@gmail.com`)),
      ...Array.from({ length: 4 }, (_, i) => stalledUser(`s${i}@icloud.com`)),
      ...Array.from({ length: 54 }, (_, i) => healthyUser(`h${i}@gmail.com`)),
      ...Array.from({ length: 36 }, (_, i) => healthyUser(`h${i}@icloud.com`)),
    ];
    const summary = summariseStalledSignups(users, NOW);
    expect(summary.stalled).toBe(10);
    expect(overRepresentedDomain(summary)).toBeNull();
  });

  it("names a domain that stalls far more often than its share of signups", () => {
    // The case actually worth an alert: yahoo is 10% of signups and 80% of the
    // stalled. That is a provider problem and the note should say so.
    const users = [
      ...Array.from({ length: 8 }, (_, i) => stalledUser(`s${i}@yahoo.com`)),
      ...Array.from({ length: 2 }, (_, i) => stalledUser(`s${i}@gmail.com`)),
      ...Array.from({ length: 2 }, (_, i) => healthyUser(`h${i}@yahoo.com`)),
      ...Array.from({ length: 88 }, (_, i) => healthyUser(`h${i}@gmail.com`)),
    ];
    const found = overRepresentedDomain(summariseStalledSignups(users, NOW));
    expect(found?.domain).toBe("yahoo.com");
    expect(found?.stalled).toBe(8);
  });

  it("stays silent on a tiny sample, where a ratio means nothing", () => {
    // Two stalled accounts on one domain is not a pattern, however lopsided the
    // arithmetic looks. Crying wolf here is what taught people to skim it.
    const users = [
      stalledUser("a@yahoo.com"),
      stalledUser("b@yahoo.com"),
      ...Array.from({ length: 98 }, (_, i) => healthyUser(`h${i}@gmail.com`)),
    ];
    expect(overRepresentedDomain(summariseStalledSignups(users, NOW))).toBeNull();
  });

  it("survives a scanned population with no usable domains at all", () => {
    const summary = summariseStalledSignups([{ created_at: iso(48 * HOUR), email: null }], NOW);
    expect(() => overRepresentedDomain(summary)).not.toThrow();
    expect(overRepresentedDomain(summary)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A LISTING THAT FAILED MUST NOT READ AS A LISTING THAT FOUND NOTHING.
//
// On 2026-09-09 partner_locked_out reported "20 approved ambassador(s) have
// never signed in", named all 20 referral codes, and said their codes were
// earning commission they could not see. Every one of those 20 had signed in.
// Checked against the database on 2026-09-10: 21 approved ambassadors, all 21
// with an auth_user_id, all 21 with a last_sign_in_at. AVAMCI had signed in
// that same afternoon.
//
// checked:20, lockedOut:20 — a hundred percent — is the shape of a lookup that
// returned nothing, not of twenty individual lockouts.
//
// listAllAuthUsers breaks out of its paging loop on error and RETURNS WHAT IT
// HAS. An empty result therefore means either "there are no users" or "the very
// first page failed", and the caller cannot tell which. With an empty list,
// every partner's auth_user_id resolves to nothing, every one is labelled
// auth_user_missing, and the alert renders all of them as "never signed in".
//
// Hitting MAX_PAGES is the same silent truncation — 139 users today, so it does
// not bite, but past 1000 it produces this identical false alert.
//
// The same hole makes the OTHER alert lie in the opposite direction: a failed
// listing gives summariseStalledSignups nothing to count, so it reports zero
// stalled and stays quiet during exactly the auth incident it exists to catch.
// ---------------------------------------------------------------------------

describe("an incomplete auth-user listing", () => {
  const approved = (code: string, authUserId: string | null) => ({
    id: `p-${code}`, status: "approved", referral_code: code,
    auth_user_id: authUserId, approved_at: iso(48 * HOUR),
  });

  it("does not turn a signed-in ambassador into a locked-out one", () => {
    // The production case, reduced: the partner rows load fine, the user
    // listing comes back empty because it failed, and every ambassador is
    // accused. summarisePartnersLockedOut cannot know — so the CALLER must.
    const summary = summarisePartnersLockedOut(
      [approved("AVAMCI", "u-1"), approved("KENDRA25", "u-2")],
      [],
      NOW,
    );

    expect(summary.lockedOut).toBe(2);
    expect(summary.partners.every((p) => p.reason === "auth_user_missing")).toBe(true);
    expect(canConcludeLockout({ truncated: true, summary }),
      "an incomplete listing must never support a lockout conclusion").toBe(false);
  });

  it("still concludes normally when the listing is complete", () => {
    const summary = summarisePartnersLockedOut(
      [approved("REAL", "u-1")],
      [{ id: "u-2", last_sign_in_at: iso(HOUR) }],
      NOW,
    );
    expect(summary.lockedOut).toBe(1);
    expect(canConcludeLockout({ truncated: false, summary })).toBe(true);
  });

  it("allows a complete listing to clear an ambassador who has signed in", () => {
    const summary = summarisePartnersLockedOut(
      [approved("AVAMCI", "u-1")],
      [{ id: "u-1", last_sign_in_at: iso(HOUR) }],
      NOW,
    );
    expect(summary.lockedOut).toBe(0);
  });

  it("permits the conclusion when every reason stands without the user table", () => {
    // no_auth_user is decided from the PARTNER row alone — no lookup involved —
    // so an incomplete user listing cannot have manufactured it. Suppressing
    // this case too would trade a false alarm for a real ambassador nobody is
    // told about.
    const summary = summarisePartnersLockedOut([approved("NOLINK", null)], [], NOW);
    expect(summary.partners[0].reason).toBe("no_auth_user");
    expect(canConcludeLockout({ truncated: true, summary })).toBe(true);
  });
});
