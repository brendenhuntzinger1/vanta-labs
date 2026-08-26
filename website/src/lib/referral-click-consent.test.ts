import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasAnalyticsConsent, readCookieConsent, CONSENT_COOKIE_NAME } from "@/lib/cookie-consent-server";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const req = (cookie?: string) =>
  new Request("https://vantalabsresearch.com/r/ABC", cookie ? { headers: { cookie } } : undefined);

// ---------------------------------------------------------------------------
// K-04 — the affiliate link recorded consent-gated data before any consent.
//
// `/r/[code]` is the public link an ambassador shares. On every click it wrote
// utm_source, utm_medium, utm_campaign, the referrer, the user agent and the
// raw IP address into two tables, and set a 30-day identifier cookie — before
// the visitor had answered the banner, and regardless of what they answered.
//
// The published Cookie Policy makes three statements this contradicts:
//
//   1. "**Essential** — cart contents, checkout state, login sessions, and your
//      age confirmation." A 30-day referral attribution cookie is not on that
//      list.
//   2. "**Analytics — only if you accept.** ... any campaign parameters from
//      the link you arrived through ..." — utm_* is named explicitly.
//   3. "Choosing Decline on the banner stops all non-essential storage."
//
// The root cause is architectural, not a missing `if`: the banner stored the
// choice in localStorage, so no server route could see it. The fix mirrors the
// same value into a cookie and gates the tracking fields on it.
//
// WHAT THIS DOES NOT DECIDE. Whether affiliate attribution itself — the
// `vl_referral_code` cookie and the click row that pays an ambassador — counts
// as essential storage is a business and legal question for the owner, not an
// engineering one, and gating it would silently cut ambassador commissions.
// It is left working and is flagged for the owner. What is fixed here is the
// part with no trade-off: the tracking fields the policy itemises as
// consent-gated are no longer captured without consent.
// ---------------------------------------------------------------------------

describe("reading the consent choice on the server", () => {
  it("reads an explicit acceptance", () => {
    expect(readCookieConsent(req(`${CONSENT_COOKIE_NAME}=accepted`))).toBe("accepted");
    expect(hasAnalyticsConsent(req(`${CONSENT_COOKIE_NAME}=accepted`))).toBe(true);
  });

  it("reads an explicit decline", () => {
    expect(readCookieConsent(req(`${CONSENT_COOKIE_NAME}=declined`))).toBe("declined");
    expect(hasAnalyticsConsent(req(`${CONSENT_COOKIE_NAME}=declined`))).toBe(false);
  });

  it("treats NO answer as no consent — the default must not be permissive", () => {
    // A first-time visitor, or one whose browser blocks storage. This is the
    // case the old code got wrong by never asking at all.
    expect(readCookieConsent(req())).toBe("unset");
    expect(readCookieConsent(req("other=1"))).toBe("unset");
    expect(hasAnalyticsConsent(req())).toBe(false);
  });

  it("treats an unrecognised value as unanswered rather than guessing", () => {
    expect(readCookieConsent(req(`${CONSENT_COOKIE_NAME}=yes-please`))).toBe("unset");
    expect(hasAnalyticsConsent(req(`${CONSENT_COOKIE_NAME}=yes-please`))).toBe(false);
  });

  it("finds the cookie among others, in any position", () => {
    expect(readCookieConsent(req(`a=1; ${CONSENT_COOKIE_NAME}=accepted; z=9`))).toBe("accepted");
    expect(readCookieConsent(req(`${CONSENT_COOKIE_NAME}=declined; a=1`))).toBe("declined");
  });

  it("does not match a cookie whose name merely CONTAINS the consent name", () => {
    // `vl_cookie_consent_backup=accepted` must not be read as consent.
    expect(readCookieConsent(req(`${CONSENT_COOKIE_NAME}_backup=accepted`))).toBe("unset");
    expect(readCookieConsent(req(`x_${CONSENT_COOKIE_NAME}=accepted`))).toBe("unset");
  });
});

describe("the affiliate link honours that choice", () => {
  const route = read("src/app/r/[code]/route.ts");

  it("asks whether analytics consent was given", () => {
    expect(route).toContain("hasAnalyticsConsent");
  });

  it("never records campaign parameters, IP, user agent or referrer without consent", () => {
    // Each of these is either named in the policy's analytics category or is
    // the technical data the policy gates behind acceptance. None may appear
    // in a payload built unconditionally.
    for (const field of ["utm_source", "utm_medium", "utm_campaign", "referrer", "user_agent", "ip_address"]) {
      const idx = route.indexOf(`${field}:`);
      expect(idx, `${field} must be written`).toBeGreaterThan(-1);
      // The tracking block must be the consent-gated one.
      const before = route.slice(0, idx);
      expect(
        before.lastIndexOf("analyticsConsented"),
        `${field} must sit inside the consent-gated payload`,
      ).toBeGreaterThan(-1);
    }
  });

  it("still records the attribution that pays the ambassador, consent or not", () => {
    // The negative control. A "fix" that stopped attributing referrals would
    // cut ambassador commissions, which is the owner's decision, not this
    // change's.
    expect(route).toContain("ambassador_id: resolved.ambassadorId");
    expect(route).toContain("referral_code: resolved.currentCode");
    expect(route).toContain("REFERRAL_COOKIE_NAME");
  });
});

describe("the banner publishes the choice where the server can read it", () => {
  const banner = read("src/components/cookie-consent.tsx");

  it("writes the consent cookie as well as localStorage", () => {
    expect(banner).toContain("localStorage.setItem");
    expect(banner).toContain(CONSENT_COOKIE_NAME);
    expect(banner).toContain("document.cookie");
  });

  it("publishes the cookie from the CHOICE handler, not only from the backfill", () => {
    // Asserted separately because a bare `document.cookie` check passes on the
    // backfill path alone: deleting the write in dismiss() would leave a
    // first-time visitor's answer invisible to the server forever, and every
    // string assertion above would still hold.
    const dismiss = banner.slice(banner.indexOf("const dismiss ="));
    expect(dismiss).toContain("publishConsentCookie(choice)");
  });

  it("backfills the cookie for a visitor who already answered before this change", () => {
    // Without this, every existing visitor keeps the old behaviour forever:
    // they have a localStorage answer, so the banner never reappears, so the
    // cookie is never written, so the server keeps seeing "unset".
    //
    // Asserted on the mechanism rather than on a comment: the mount effect must
    // read the STORED value (not merely test for its presence) and write the
    // cookie when it is missing.
    expect(banner).toMatch(/const stored = window\.localStorage\.getItem\(STORAGE_KEY\)/);
    expect(banner).toMatch(/stored === "accepted" \|\| stored === "declined"/);
    expect(banner).toMatch(/publishConsentCookie\(stored\)/);
  });
});
