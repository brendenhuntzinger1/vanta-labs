import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isPublicPath, requiresAccount, PUBLIC_EXACT, PUBLIC_PREFIXES } from "@/lib/access-policy";

// ---------------------------------------------------------------------------
// THE ONE ACCESS DECISION, EXERCISED DIRECTLY.
//
// The store used to name the handful of paths that were CLOSED, which meant
// every route added afterwards arrived open unless somebody remembered. That
// is not a hypothetical failure: the promotion banner shipped "Labor Day ·
// Buy 2 Get 1" in the raw homepage HTML to anyone who asked, with no session,
// because nobody had thought to add it to a list.
//
// The default is closed now, so these tests are about the exemptions: each one
// is a hole by construction, and each has to earn its place by naming what
// would break without it.
// ---------------------------------------------------------------------------

describe("everything a customer touches requires an account", () => {
  const PROTECTED = [
    // The storefront itself.
    "/",
    "/products",
    "/products/glp-1",
    "/products/anything-at-all",
    "/coa-library",
    "/research",
    "/research/some-article",
    "/cart",
    "/cart/restore",
    "/checkout",
    "/membership",
    "/membership/pro/subscribe",
    // The account area beyond the sign-in surface.
    "/account",
    "/account/orders",
    "/account/settings",
    "/account/rewards",
    "/account/ambassador",
    // Everything that answers with catalog, price, promotion or customer data.
    "/api/catalog/products",
    "/api/catalog/promotions",
    "/api/catalog/bac-water",
    "/api/coa/abc/file",
    "/api/cart/validate",
    "/api/checkout/quote",
    "/api/membership/subscribe",
    "/api/account/me",
    "/api/coupons/featured",
    "/api/storefront/offers",
    "/api/offer/status",
  ];

  it.each(PROTECTED)("%s requires an account", (path) => {
    expect(requiresAccount(path)).toBe(true);
  });

  it("gates a path nobody has thought of yet", () => {
    // The whole point of closing the default: a route invented tomorrow is
    // protected today, without anyone editing this file.
    expect(requiresAccount("/some-route-added-next-year")).toBe(true);
    expect(requiresAccount("/api/whatever/comes/next")).toBe(true);
  });

  it("cannot be walked out of with traversal or casing tricks", () => {
    for (const probe of [
      "/products/../products",
      "/PRODUCTS",
      "/api/CATALOG/products",
      "/products%2Fglp-1",
    ]) {
      expect(requiresAccount(probe), `${probe} slipped past`).toBe(true);
    }
  });

  it("does not let a public prefix open a longer path that merely starts with it", () => {
    // "/legal" is public; "/legally-distinct-storefront" is not the same thing.
    expect(requiresAccount("/legalish")).toBe(true);
    expect(requiresAccount("/admin-ish")).toBe(true);
    expect(requiresAccount("/contact-us-secretly")).toBe(true);
    // And the real ones still are public.
    expect(isPublicPath("/legal")).toBe(true);
    expect(isPublicPath("/legal/privacy")).toBe(true);
  });
});

describe("the exemptions, each of which has to earn its place", () => {
  const MUST_BE_PUBLIC: Array<[string, string]> = [
    ["/account/login", "gating the sign-in page is an infinite redirect loop"],
    ["/account/forgot-password", "the person locked out cannot sign in to ask for help"],
    ["/account/reset-password", "same, and the link arrives with no session"],
    ["/account/auth/callback", "where Google returns; gating it loops the OAuth handshake"],
    ["/auth/confirm", "the signup confirmation link carries no session by definition"],
    ["/api/auth/session", "this is the endpoint that CREATES the session"],
    ["/api/auth/signup", "an account cannot be created by someone who has one"],
    ["/legal/privacy", "a policy must be readable to be agreed to"],
    ["/legal/terms", "same"],
    ["/admin", "admin has its own authentication; a second gate locks the owner out"],
    ["/api/admin/orders", "same boundary"],
    ["/vault", "this IS the admin login form"],
    ["/partner/login", "the ambassador portal has its own sign-in"],
    ["/api/partner/summary", "same boundary"],
    ["/api/webhooks/payment", "server-to-server, HMAC-signed; a login page breaks payments"],
    ["/api/webhooks/shippo", "same; breaks fulfilment"],
    ["/api/webhooks/email", "same; breaks delivery and bounce tracking"],
    ["/api/veyra/express-shipping-callback", "processor callback, no browser"],
    ["/api/cron/sweep", "bearer-secret; a login page silently stops every scheduled job"],
    ["/api/health", "a health check that requires a login reports nothing useful"],
    ["/api/email/open", "opened by a mail client with no session"],
    ["/api/email/track/click", "same"],
    ["/api/unsubscribe", "an unsubscribe link that demands a login is not one"],
    ["/r/ABC123", "the ambassador's link runs BEFORE the wall or attribution is lost"],
    ["/contact", "someone locked out of their account needs the contact form"],
    ["/wholesale", "a prospective buyer has no account by definition"],
    ["/ambassador", "recruitment behind a login ends recruitment"],
    ["/maintenance", "this IS the answer when the store is closed"],
    ["/robots.txt", "convention"],
    ["/sitemap.xml", "convention"],
    ["/_next/static/chunk.js", "the page cannot render without its own assets"],
  ];

  it.each(MUST_BE_PUBLIC)("%s is public — %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it("keeps the exemption list short enough to read in one sitting", () => {
    // Not a style rule. Every entry is a hole, and a list nobody reads is a
    // list nobody audits. If this needs raising, raise it deliberately.
    expect(PUBLIC_EXACT.size + PUBLIC_PREFIXES.length).toBeLessThanOrEqual(40);
  });

  it("exempts no storefront surface", () => {
    // A regression here is the whole failure this change exists to prevent.
    const forbidden = ["/products", "/coa-library", "/cart", "/checkout", "/api/catalog", "/api/coa"];
    for (const entry of [...PUBLIC_EXACT, ...PUBLIC_PREFIXES]) {
      for (const f of forbidden) {
        expect(entry === f, `${f} must never be exempt`).toBe(false);
      }
    }
  });
});

describe("the deliberate cost of closing the default", () => {
  it("puts the home page and the research library behind the wall", () => {
    // Recorded as a test rather than a comment because it is the one
    // consequence that is easy to undo by accident and expensive to discover:
    // Googlebot is unauthenticated like everyone else, so these two leave the
    // index. The owner chose this with the consequence in front of them.
    expect(requiresAccount("/")).toBe(true);
    expect(requiresAccount("/research")).toBe(true);
  });

  it("says so in the policy, where the next person will look", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/access-policy.ts"), "utf8");
    // Normalised: this is a prose comment that wraps, and pinning where the
    // line breaks fall would fail on a re-wrap while the statement it guards
    // is still right there.
    const prose = source.replace(/\/\//g, " ").replace(/\s+/g, " ");
    expect(prose).toMatch(/no longer indexable/i);
    expect(prose).toMatch(/Googlebot is unauthenticated like everyone else/i);
  });
});

describe("the policy is the only place the decision is made", () => {
  it("middleware imports it rather than keeping a second copy", () => {
    const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    expect(mw).toContain('from "@/lib/access-policy"');
    expect(mw).toContain("requiresAccount(pathname)");
    // The old inverted predicate must not survive anywhere.
    expect(mw).not.toContain("GATED_PREFIXES");
    expect(mw).not.toContain("isGatedPath");
  });

  it("no second access overlay has reappeared in the component tree", () => {
    // The store had two access systems and the older one protected nothing —
    // it rendered the storefront and covered it with CSS. One is the rule.
    const components = readdirSync(join(process.cwd(), "src/components"));
    expect(components).not.toContain("age-gate.tsx");
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).not.toContain("AgeGate");
    expect(layout).not.toContain("data-age-verified");
  });
});

// ---------------------------------------------------------------------------
// A PROMOTION IS STOREFRONT DATA, AND A FEW PAGES ARE PUBLIC BY NECESSITY.
//
// The sign-in page, the legal policies and the contact form cannot require an
// account. The root layout wraps those too, and it used to fetch the live
// offers for every one of them — so "Labor Day · Buy 2 Get 1" and a working
// coupon code shipped in the raw HTML of the login page. Measured before this
// change: the campaign name twice and the code four times, with no session.
// ---------------------------------------------------------------------------

describe("the layout does not fetch offers for a visitor without a session", () => {
  const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

  it("gates the FETCH, not the render", () => {
    // Hiding is not withholding. A server component that reads the offers and
    // renders nothing still serialises what it read into the flight payload,
    // where it is just as readable and harder to notice — which is exactly how
    // the old overlay "protected" the storefront.
    expect(layout).toContain("const signedIn = Boolean(cookieStore.get(AUTH_COOKIE_NAME))");
    expect(layout).toMatch(
      /const allOffers = signedIn \? await getStorefrontOffers\(\)\.catch\(\(\) => \[\]\) : \[\];/,
    );
  });

  it("makes the decision before the call, not after", () => {
    const fetchAt = layout.indexOf("getStorefrontOffers()");
    const guardAt = layout.indexOf("const signedIn =");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, "the session must be known before the offers are read").toBeLessThan(fetchAt);
  });
});
