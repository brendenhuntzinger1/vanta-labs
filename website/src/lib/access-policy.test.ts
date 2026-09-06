import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { middleware as runMiddleware } from "../../middleware";
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

// ---------------------------------------------------------------------------
// A PUBLIC PAGE WHOSE FORM IS WALLED IS NOT A PUBLIC PAGE.
//
// The list named /contact, /wholesale and /ambassador and stopped there, so the
// endpoints those pages POST to stayed closed. Driven signed out in Chromium
// against the production build, before this fix:
//
//   POST /api/contact          401   {"error":"Sign in to continue"}
//   POST /api/wholesale        401   same
//   POST /api/analytics/track  401   fired after consent, on every page
//
// Each one is dead for precisely the audience its page exists to serve. The
// analytics beacon is the costly one: an ad click arrives at a gated page, the
// wall forwards it to /account/login carrying the ttclid, and the pageview the
// campaign was billed for is the one that never lands.
// ---------------------------------------------------------------------------
describe("the endpoints the public pages call are public too", () => {
  it.each([
    ["/api/contact", "the contact form on the public /contact page"],
    ["/api/wholesale", "the enquiry form on the public /wholesale page"],
    ["/api/analytics/track", "the pageview beacon, on every page, for visitors with no account"],
    ["/api/ads/funnel-event", "the server-side leg of the same ad events the pixel reports"],
  ])("%s is public — %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it("opens those four and nothing next to them", () => {
    // Named one at a time rather than by group, because /api/ads and
    // /api/analytics are not otherwise public: the neighbours read the session
    // or drive the ad account's purchase reporting.
    for (const neighbour of [
      "/api/ads/campaigns",
      "/api/ads/purchase-event/abc",
      "/api/ads/tracking-health",
      "/api/ads/reddit-match-keys",
      "/api/ads/tiktok-test-event",
      "/api/analytics/export",
    ]) {
      expect(requiresAccount(neighbour), `${neighbour} must stay gated`).toBe(true);
    }
  });

  it("keeps the catalog endpoints that were gated before the default closed", () => {
    // /api/catalog and /api/coa were the ONLY API prefixes gated before this
    // change, and the store ran that way. Nothing here is a candidate for
    // reopening on the grounds that a public page happens to mount a component
    // that calls it.
    for (const path of [
      "/api/catalog/promotions", "/api/catalog/bac-water", "/api/catalog/welcome-offer",
      "/api/catalog/referral/validate", "/api/catalog/bulk-savings-config",
      "/api/coa/abc/file", "/api/storefront/offers", "/api/offer/status",
    ]) {
      expect(requiresAccount(path), `${path} must stay gated`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// EVERY PAGE AN AUTH EMAIL CAN LAND ON MUST BE REACHABLE. INHERITED, NOT LOST.
//
// main added this rule against the AGE GATE (age-gate-auth-landings.test.ts)
// after a real incident: a link emailed to set a password opened in a fresh tab,
// the gate rendered because sessionStorage was empty, and the gate's primary
// button is router.push("/account/login") — so the recipient was carried off
// the page the email had sent them to. An affiliate applicant was stuck in that
// loop for eight days.
//
// This branch deletes the gate, so that file goes with it — but the RULE has to
// survive the merge, and it matters MORE here, not less. The gate was a CSS
// overlay a determined visitor could scroll past; the wall is a 307 they
// cannot. A landing path this policy forgets is not "covered", it is gone.
//
// THE LIST IS DERIVED, NOT COPIED — main's design, kept exactly. A hand-written
// list has to be remembered by whoever adds the next auth email, which is the
// failure being guarded against. Add an email whose link lands somewhere gated
// and this fails on that path without anyone having to think of it.
// ---------------------------------------------------------------------------
describe("the wall never blocks a page an auth email links to", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  const SOURCES_THAT_BUILD_AUTH_LANDINGS = [
    "src/app/auth/confirm/route.ts",
    "src/app/api/auth/password-reset/route.ts",
    "src/app/api/auth/resend-confirmation/route.ts",
    "src/app/api/account/email-change/route.ts",
    "src/lib/partner-portal.ts",
  ];

  function authLandingPathsIn(source: string): string[] {
    const found = new Set<string>();
    for (const match of source.matchAll(/\$\{[^}]*\}(\/[A-Za-z0-9/_-]+)/g)) {
      const path = match[1];
      // API endpoints are not documents; the wall answers them 401 and no
      // emailed link points a human at one.
      if (path.startsWith("/api/")) continue;
      // /r/<code> is the referral shortlink: it resolves the code, sets the
      // attribution cookie and redirects INTO the storefront. It is public in
      // its own right, and where it sends people is exactly what the wall is
      // for.
      if (path === "/r" || path.startsWith("/r/")) continue;
      found.add(path);
    }
    return [...found];
  }

  const AUTH_LANDINGS = [
    ...new Set(SOURCES_THAT_BUILD_AUTH_LANDINGS.flatMap((f) => authLandingPathsIn(read(f)))),
  ].sort();

  it("finds the landing paths at all (the extraction itself must not rot)", () => {
    // If a refactor changes how these URLs are built, the regex could silently
    // match nothing and every assertion below would vacuously pass.
    expect(AUTH_LANDINGS).toContain("/account/reset-password");
    expect(AUTH_LANDINGS).toContain("/account/login");
    expect(AUTH_LANDINGS.length).toBeGreaterThanOrEqual(3);
  });

  // TWO KINDS OF LANDING, AND ONLY ONE OF THEM HAS TO BE PUBLIC.
  //
  // Under the age gate every landing had to be exempt, because the gate's
  // primary button navigated the recipient AWAY and the context they were sent
  // was destroyed. The wall does not do that: it redirects to sign-in carrying
  // the full destination in ?next=, so a landing that is merely a DESTINATION
  // survives being gated — the ambassador approval email points at
  // /account/ambassador, and an ambassador has an account by definition.
  //
  // What cannot survive is a landing whose fragment IS the credential. A
  // reset link carries `#access_token=…&type=recovery`; fragments do not
  // survive a redirect to a different page, so gating that path destroys the
  // one-time token. Those must be public, and are named explicitly rather than
  // inferred, because getting this wrong is silent.
  const CREDENTIAL_BEARING = ["/account/reset-password", "/auth/confirm", "/account/login"];

  it.each(CREDENTIAL_BEARING)("%s carries a credential in its fragment, so it must be public", (pathname) => {
    expect(
      isPublicPath(pathname),
      `${pathname} is where a one-time auth token lands. A fragment does not `
        + `survive a redirect, so gating this path destroys the token and the `
        + `recipient has no way back.`,
    ).toBe(true);
  });

  it.each(AUTH_LANDINGS)("%s either needs no account, or keeps its destination", async (pathname) => {
    if (isPublicPath(pathname)) return;

    // Gated is allowed ONLY if nothing is lost: the wall must send them to
    // sign-in with the exact destination, query string and all, preserved.
    const search = pathname === "/account/settings" ? "?email_changed=1" : "";
    const response = await runMiddleware(
      new NextRequest(`https://www.vantalabsresearch.com${pathname}${search}`, { method: "GET" }),
    );
    expect(response.status, `${pathname} must redirect rather than refuse`).toBe(307);
    const location = new URL(response.headers.get("location") ?? "", "https://www.vantalabsresearch.com");
    expect(location.pathname).toBe("/account/login");
    expect(
      location.searchParams.get("next"),
      `${pathname} is where an emailed auth link lands. It may require an `
        + `account — but then the wall has to carry the destination, or the `
        + `recipient signs in and is dropped somewhere they were not sent.`,
    ).toBe(`${pathname}${search}`);
  });

  it("still gates everything the wall actually exists for", () => {
    // The exemptions must never widen into the storefront. If this goes red,
    // the wall has been defeated rather than corrected.
    for (const shopfront of ["/", "/products", "/products/bac-water", "/cart", "/coa-library", "/membership"]) {
      expect(requiresAccount(shopfront), `${shopfront} must stay behind the wall`).toBe(true);
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

  it("keeps the storefront's own chrome off the front door", () => {
    // The header was removed from the portal; the FOOTER was not, so under the
    // gate sat a full storefront menu — All Products, COA Library, Cart — each
    // of which bounces a signed-out visitor back to the page they are on, and
    // each of which Next prefetched, collecting five 307s per load. Measured at
    // 390x844: 2,294px of document for a gate that needs about 1,000.
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("<SiteFooterSlot />");
    expect(layout).not.toContain("<SiteFooter />");
    const slot = readFileSync(join(process.cwd(), "src/components/site-chrome-slot.tsx"), "utf8");
    for (const route of ["/account/login", "/account/forgot-password", "/account/reset-password", "/account/auth/callback", "/auth/confirm"]) {
      expect(slot, `${route} must be chromeless`).toContain(`"${route}"`);
    }
    // Not rendered, not hidden — the same distinction the whole access policy
    // turns on. A CSS rule would leave the menu in the HTML.
    expect(slot).toContain("return null;");
    expect(slot).not.toMatch(/display\s*:\s*none/);
  });

  it("keeps the storefront header off the whole auth surface, not just the portal", () => {
    // The portal lost its header; its two siblings kept theirs, so a customer
    // who cannot sign in was shown a nav of five links — the wordmark,
    // Products, COA Library, Membership, Account — every one of which requires
    // the account they are locked out of, and every one of which bounces back
    // to the form they just left.
    for (const page of ["login", "forgot-password", "reset-password"]) {
      const source = readFileSync(join(process.cwd(), `src/app/account/${page}/page.tsx`), "utf8");
      expect(source, `${page} must not render the storefront header`).not.toContain("<SiteHeaderV2 />");
    }
  });

  it("renders the footer exactly once everywhere it does belong", () => {
    // /wholesale imported SiteFooter and the root layout rendered another, so
    // the page shipped two. Measured in Chromium: 2 <footer> elements on
    // /wholesale, 1 everywhere else.
    const wholesale = readFileSync(join(process.cwd(), "src/app/wholesale/page.tsx"), "utf8");
    expect(wholesale).not.toContain("<SiteFooter />");
    expect(wholesale).not.toContain('from "@/components/site-footer"');
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
    expect(layout).toMatch(
      /const allOffers = signedIn \? await getStorefrontOffers\(\)\.catch\(\(\) => \[\]\) : \[\];/,
    );
  });

  it("asks whether the session is REAL, not whether a cookie is present", () => {
    // This assertion is the one with a scar. `signedIn` used to be
    // `Boolean(cookieStore.get(AUTH_COOKIE_NAME))`, and this layout wraps the
    // PUBLIC pages too — the ones middleware never gates. So a single header,
    // `Cookie: vl_session_token=totally.forged.value`, put "Labor Day · Buy 2
    // Get 1" and a live coupon code into the sign-in page's HTML. There was no
    // deeper layer to catch it, because on /account/login there is no deeper
    // layer.
    expect(layout).toContain("const signedIn = Boolean(await getAuthenticatedUser())");
    // And the presence test must not creep back in beside it.
    expect(layout).not.toMatch(/const signedIn = Boolean\(cookieStore\.get/);
  });

  it("makes the decision before the call, not after", () => {
    const fetchAt = layout.indexOf("getStorefrontOffers()");
    const guardAt = layout.indexOf("const signedIn =");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, "the session must be known before the offers are read").toBeLessThan(fetchAt);
  });
});

// ---------------------------------------------------------------------------
// THE WALL VERIFIES THE TOKEN. IT DOES NOT COUNT COOKIES.
//
// It used to admit on the cookie merely EXISTING, and the comment beside it
// argued that was safe because the page guard, the route guard and row-level
// security all sat behind it. Checked against the routes rather than assumed,
// that was false for five surfaces. Measured on the production build with the
// single header `Cookie: vl_session_token=totally.forged.value`:
//
//   /                        200, 57 KB, "Labor Day · Buy 2 Get 1" in the HTML
//   /api/storefront/offers   200, the live offers including the coupon code
//   /api/catalog/promotions  200, promotion flags and the whole bundle config
//   /api/catalog/bac-water   200, a product row
//   /api/coupons/featured    200, HARNESS10 with its discount type and value
//
// After the change every one of those answers 307 or 401, and a real session
// still reaches all of them — proven end to end in the harness rather than
// here, because only a running GoTrue can tell a good signature from a bad one.
// These assertions hold the SHAPE, so the presence test cannot quietly return.
// ---------------------------------------------------------------------------
describe("the wall verifies the session rather than trusting the cookie", () => {
  const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

  it("gates on a verified session at both call sites", () => {
    expect(mw).toContain("requiresAccount(pathname) && !(await sessionIsVerified())");
    // The /account branch that adds ?next= asks the same question, so a forged
    // cookie cannot skip the return path either.
    expect(mw).toContain('pathname.startsWith("/account")');
    expect(mw.match(/await sessionIsVerified\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("no longer decides anything on the cookie being present", () => {
    // The two conditions that used to be the whole boundary.
    expect(mw).not.toContain("!request.cookies.get(AUTH_COOKIE_NAME) && !refreshedCookie");
  });

  it("actually asks the auth backend, and only about a token that could be live", () => {
    expect(mw).toContain("/auth/v1/user");
    // The free rejection first: a token whose own exp has passed never costs a
    // round trip.
    expect(mw).toContain("accessTokenExpiresAt(tokens.accessToken)");
  });

  it("believes a 401 and only softens a genuine outage", () => {
    // A 401 is GoTrue judging the token; a 5xx or a thrown fetch is GoTrue
    // failing to answer. Only the second may reuse a previous answer, and with
    // no previous answer both are closed.
    expect(mw).toContain("response.status === 401 || response.status === 403");
    expect(mw).toContain("return cached ? cached.value : false;");
  });

  it("verifies at most once per request", () => {
    // Two call sites, one answer: without this the home page would pay for the
    // /account branch and the wall separately.
    expect(mw).toContain("sessionVerification ??= hasVerifiedSession(request, refreshedCookie)");
  });

  it("caps the verified-token cache", () => {
    // Keyed by customer token, so unlike the admin cache beside it this one
    // grows with traffic. An eviction costs a re-verification, never an
    // admission.
    expect(mw).toContain("CUSTOMER_SESSION_CACHE_MAX");
    expect(mw).toMatch(/customerSessionCache\.size >= CUSTOMER_SESSION_CACHE_MAX/);
  });
});

describe("the static files the layout declares are reachable without an account", () => {
  it("serves the manifest the app actually names", () => {
    // The list said "/manifest.webmanifest" — the path a manifest.ts route
    // would produce, and there is no such route. layout.tsx declares
    // "/site.webmanifest", which sits in public/ and was answering 307 on every
    // page in the store.
    expect(isPublicPath("/site.webmanifest")).toBe(true);
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/site.webmanifest"');
  });

  it("serves the icons every page asks for", () => {
    for (const icon of [
      "/icons/icon-16.png", "/icons/icon-32.png", "/icons/icon-192.png",
      "/icons/icon-512.png", "/icons/apple-icon-180.png",
    ]) {
      expect(isPublicPath(icon), `${icon} is requested by every page`).toBe(true);
    }
  });

  it("still walls the static file that is catalog data", () => {
    // /product-images.json maps slugs to imagery. It lives in public/ beside
    // the icons and is fetched by the catalog client, which only ever runs for
    // a signed-in visitor. An icon is a brand mark; this is the shop's contents.
    expect(requiresAccount("/product-images.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVERY COOKIE-AUTHENTICATED WRITE IS ORIGIN-CHECKED.
//
// The list started as the five prefixes somebody thought of, and six routes
// that read the session and change state sat outside it — including
// /api/checkout/create-session, which writes an order row. SameSite=Lax was
// withholding the cookie cross-site anyway (verified in Chromium, WebKit and
// Firefox by driving a real cross-site form POST, all three answering 401), so
// this is a second layer rather than a first. It is still asserted here,
// because a prefix list is exactly the kind of thing that falls behind the
// routes it is supposed to cover.
// ---------------------------------------------------------------------------

describe("the CSRF origin check covers every cookie-authenticated write", () => {
  const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
  const listed = (mw.match(/const CSRF_PROTECTED_PREFIXES = \[([\s\S]*?)\];/) ?? [])[1] ?? "";

  it.each([
    ["/api/admin", "admin writes"],
    ["/api/account", "account settings"],
    ["/api/auth", "the session endpoint itself"],
    ["/api/membership", "subscription changes"],
    ["/api/partner", "ambassador writes"],
    ["/api/checkout", "creates an order row"],
    ["/api/cart", "cart mutations"],
    ["/api/coupons", "coupon validation"],
    ["/api/catalog", "subscribe-and-save"],
  ])("%s is origin-checked — %s", (prefix) => {
    expect(listed).toContain(`"${prefix}"`);
  });

  it("leaves the self-authenticating server-to-server routes out of it", () => {
    // Webhooks carry an HMAC signature and cron carries a bearer secret; they
    // are not same-origin by nature and an origin check would break them.
    for (const notListed of ["/api/webhooks", "/api/cron", "/api/health", "/api/email"]) {
      expect(listed, `${notListed} must not be origin-checked`).not.toContain(`"${notListed}"`);
    }
  });

  it("still only applies to state-changing methods", () => {
    expect(mw).toContain("isStateChangingMethod(request.method)");
  });
});
