import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isVerifiedForDocument } from "@/components/age-gate";

// ---------------------------------------------------------------------------
// EVERY PAGE AN AUTH EMAIL CAN LAND ON MUST BE REACHABLE THROUGH THE GATE.
//
// This is the general form of the 2026-09-06 defect, and it exists so that one
// is the last of its kind. The specific bug — the gate covering
// /account/reset-password — is pinned in age-gate-password-recovery.test.ts.
// This file pins the RULE that would have caught it before a customer did.
//
// Why an emailed link is the dangerous case. Age confirmation is scoped to one
// visit, in sessionStorage, deliberately (see age-gate.tsx). A link clicked in
// a mail client opens a FRESH TAB, so sessionStorage is empty and the gate
// renders. That makes an auth email the one arrival where the gate is
// guaranteed to be up — for every recipient, every time.
//
// And the gate does not merely sit there. Its primary call to action is
// handleAccount(), which is `router.push("/account/login")`. So a visitor who
// was emailed a link to set a password, and who taps the most prominent button
// on the screen covering it, is carried off to a sign-in form — and the
// recovery context they were sent is gone. That is precisely the loop the
// affiliate applicant ava.mci.media@gmail.com was stuck in for eight days:
// gate, sign-in form, wrong password, click the link again.
//
// THE LIST IS DERIVED, NOT COPIED. A hand-maintained list would have to be
// remembered by whoever adds the next auth email, which is the exact failure
// mode this is guarding. So the landing paths are extracted from the routes
// that actually build them. Add a new auth email whose link lands somewhere the
// gate covers, and this test fails on that path without anyone having to think
// of it.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * The modules that turn an auth token into a place to land.
 *
 * Each of these builds an absolute URL off the site origin and hands it to
 * GoTrue as `redirectTo`, or puts it in an email body as the thing to click.
 */
const SOURCES_THAT_BUILD_AUTH_LANDINGS = [
  "src/app/auth/confirm/route.ts",
  "src/app/api/auth/password-reset/route.ts",
  "src/app/api/auth/resend-confirmation/route.ts",
  "src/app/api/account/email-change/route.ts",
  "src/lib/partner-portal.ts",
];

/**
 * Every `${origin}/some/path` written in those modules, as a bare pathname.
 *
 * Matches an interpolation followed immediately by a path, which is the only
 * shape these files use to name a landing (`${site}/account/reset-password`,
 * `${getSiteUrl().replace(/\/+$/, "")}/account/login?verified=1&next=...`).
 * The query string and any further interpolation are dropped: the gate decides
 * on pathname alone.
 */
function authLandingPathsIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\$\{[^}]*\}(\/[A-Za-z0-9/_-]+)/g)) {
    const path = match[1];
    // API endpoints are not documents and never render the gate — click
    // trackers, unsubscribe handlers and the like.
    if (path.startsWith("/api/")) continue;
    // /r/<code> is a referral shortlink: a route handler that resolves the code,
    // sets the attribution cookie and REDIRECTS into the storefront. It renders
    // no document of its own, so the gate never runs on it — and it must not be
    // exempt, because the place it sends people (/products by default) is
    // exactly what the gate is for.
    if (path === "/r" || path.startsWith("/r/")) continue;
    found.add(path);
  }
  return [...found];
}

const AUTH_LANDINGS = [
  ...new Set(SOURCES_THAT_BUILD_AUTH_LANDINGS.flatMap((f) => authLandingPathsIn(read(f)))),
].sort();

/** A link opened from a mail client: new tab, nothing confirmed yet. */
const freshDocumentFromEmail = { confirmedInMemory: false, sessionConfirmed: false };

describe("the age gate never covers a page an auth email links to", () => {
  it("finds the landing paths at all (the extraction itself must not rot)", () => {
    // If a refactor changes how these URLs are built, the regex above could
    // silently match nothing and every assertion below would vacuously pass.
    // These two are the anchors: the recovery landing that caused the incident,
    // and the confirmation landing that has always been exempt.
    expect(AUTH_LANDINGS).toContain("/account/reset-password");
    expect(AUTH_LANDINGS).toContain("/account/login");
    expect(AUTH_LANDINGS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(AUTH_LANDINGS)("%s is reachable in a fresh tab from an email", (pathname) => {
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname }),
      `${pathname} is a destination for an emailed auth link, but the age gate `
        + `covers it. In a fresh tab the gate is always up, and its primary `
        + `button is router.push("/account/login") — so the recipient is `
        + `carried off the page the email sent them to. Either exempt this path `
        + `in age-gate.tsx, or stop sending people here from an email.`,
    ).toBe(true);
  });

  it("still gates everything the gate actually exists for", () => {
    // The exemptions above must never widen into the storefront. If this goes
    // red, the gate has been defeated rather than corrected.
    for (const shopfront of ["/", "/products", "/products/bac-water", "/cart", "/coa-library", "/membership"]) {
      expect(
        isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: shopfront }),
        `${shopfront} must always be behind the age gate`,
      ).toBe(false);
    }
  });
});
