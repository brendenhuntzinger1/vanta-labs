// ---------------------------------------------------------------------------
// THE STORE REQUIRES AN ACCOUNT. A SHORT, NAMED LIST OF PATHS DOES NOT.
//
// This used to be the other way round: a handful of gated prefixes, everything
// else open. That failed in the direction that matters — every route added
// afterwards arrived PUBLIC unless someone remembered to gate it, and the
// promotion banner proved it, serving "Labor Day · Buy 2 Get 1" in the raw
// homepage HTML to anyone who asked.
//
// So the default is now closed. A path is reachable without an account only if
// it is named below, and each entry states why it has to be. A new route is
// protected on the day it is created, by doing nothing.
//
// THIS IS A UNIFORM WALL, AND THAT IS THE WHOLE POINT. There is no user-agent
// test here, no IP test, no crawler list. Googlebot, TikTok's reviewer, Meta's
// reviewer, a competitor and an ordinary signed-out shopper all receive the
// identical response, because they are all simply unauthenticated. Any rule
// that varied by WHO is asking would be cloaking, which is against the ad
// platforms' policies and is a far larger risk than the one it would solve.
// If a future change needs to know the requester's identity to decide what to
// serve here, that change is wrong.
//
// THE PRICE, STATED PLAINLY: the home page and the research library are no
// longer indexable, because Googlebot is unauthenticated like everyone else.
// That is a deliberate decision by the owner, taken with the consequence in
// front of them, not an accident of this rule.
//
// WHY MIDDLEWARE CARRIES IT.
//
//   * IT SEES EVERY SHAPE OF REQUEST. A page load, a client-side navigation's
//     RSC payload fetch, a prefetch and an API call all pass through here.
//     Verified against production: an anonymous request carrying `RSC: 1`
//     returns the redirect, not the payload. A guard that lived in the page
//     component would hand the flight payload to anyone who asked directly.
//   * IT RUNS BEFORE THE DATA IS FETCHED. A server component that reads the
//     catalog and then renders nothing still serialises what it read into the
//     flight payload. Not fetching is the only version of "hidden" that holds,
//     and it is the reason the old age gate protected nothing: that one
//     rendered the storefront and covered it with CSS.
//   * IT CANNOT ENUMERATE. This file knows nothing about which slugs exist, so
//     /products/glp-1 and /products/does-not-exist produce byte-identical
//     answers. A guard inside the page would have to look the product up, and
//     the 404-versus-redirect difference would leak the entire catalog to
//     anyone willing to iterate a word list.
//
// The page and route guards remain as defence in depth, because one check in
// one layer is one deploy away from being bypassed. The real boundary is
// neither of them: it is row-level security in Postgres, which is what stops
// the public anon key reading the products table straight off PostgREST
// regardless of anything in this app.

/** Public, matched exactly. Anything not listed here or below needs an account. */
export const PUBLIC_EXACT = new Set([
  // The maintenance page IS the answer when the store is closed.
  "/maintenance",
  // Crawler and browser conventions. Serving a redirect for these is noise.
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  // THE MANIFEST THE APP ACTUALLY SERVES, not the one Next would have named.
  //
  // This entry said "/manifest.webmanifest" — the path a `manifest.ts` route
  // would produce. There is no such route: layout.tsx declares
  // `manifest: "/site.webmanifest"` and the file sits in public/. So the
  // exemption covered an address nothing requests while the real manifest was
  // answered with a 307 to the login page on EVERY page in the store,
  // including the sign-in page itself. Chrome then reports "no manifest" and
  // the install prompt is gone.
  "/site.webmanifest",
  // Reaching a human must not require an account. Someone locked out of their
  // own account is exactly the person who needs the contact form.
  "/contact",
  // A prospective wholesale buyer or ambassador has no account yet by
  // definition; putting recruitment behind a login ends recruitment.
  "/wholesale",
  "/ambassador",
  "/partner",
  // /login is a redirect to /account/login and must be able to perform it.
  "/login",
]);

/**
 * Public by prefix. Each of these would BREAK something real if gated.
 */
export const PUBLIC_PREFIXES = [
  // ---- Authentication itself. Gating these is an infinite redirect loop. ----
  "/account/login",
  "/account/forgot-password",
  "/account/reset-password",
  // Where Google and Apple return. It holds no data, and the session it
  // establishes is verified server-side against GoTrue by /api/auth/session.
  "/account/auth/callback",
  // The confirmation link in a signup email, which by definition arrives
  // without a session.
  "/auth/confirm",
  "/api/auth",

  // ---- Legal. A policy has to be readable to be agreed to, and several of
  // these are required to be reachable regardless of who is asking. ----
  "/legal",

  // ---- Surfaces with their OWN authentication boundary. Putting the customer
  // gate in front of an admin login would lock the owner out of their own
  // store, and would be a second gate in front of a first — the exact mistake
  // this change exists to end. ----
  "/admin",
  "/api/admin",
  "/vault",
  "/partner/login",
  "/partner/pending",
  "/partner/dashboard",
  "/api/partner",

  // ---- Server-to-server. No browser, no cookie, ever. These authenticate
  // themselves: webhooks by HMAC signature, cron by bearer secret. Serving any
  // of them a sign-in page silently breaks payments, fulfilment and email. ----
  "/api/webhooks",
  "/api/veyra",
  "/api/cron",
  "/api/health",

  // ---- Opened from an email client, which carries no session by design.
  // Unsubscribe in particular must work for anyone, forever: an unsubscribe
  // link that demands a login is not an unsubscribe link. ----
  "/api/email",
  "/api/unsubscribe",

  // ---- WHAT THE PUBLIC PAGES ABOVE ACTUALLY CALL.
  //
  // This list named the PAGES and forgot the endpoints behind them, and the
  // justifications above are what make that a bug rather than an oversight:
  // /contact is public because "someone locked out of their own account is
  // exactly the person who needs the contact form", and its form POSTs to
  // /api/contact, which answered 401. Driven in a real browser, signed out:
  //
  //   POST /api/contact          401   the contact form is dead
  //   POST /api/wholesale        401   the enquiry form is dead
  //   POST /api/analytics/track  401   every signed-out pageview unrecorded
  //
  // The third is the expensive one. Nearly all traffic here is paid, and an ad
  // click lands on a page the wall forwards to /account/login carrying its
  // ttclid — so the pageview that the campaign is billed for was the one being
  // dropped. The relay beside it reports the same events to TikTok server-side.
  //
  // None of these is a hole opened for convenience. Every one was public before
  // the default was closed, and every one defends itself: contact and wholesale
  // with a honeypot, a minimum fill time and three submissions per IP per
  // window; analytics with 120/minute per session, 600/minute per IP and an
  // 8 KB payload cap; the relay with 240/minute per IP, prices re-read from the
  // catalogue rather than the request, and purchase events refused outright.
  // Its own header already says it "is a public endpoint, so it is written as
  // though the caller is hostile".
  //
  // Named one at a time, never "/api/ads" or "/api/analytics" wholesale:
  // /api/ads also holds campaigns, tracking-health and the purchase relay, and
  // those read the session.
  "/api/contact",
  "/api/wholesale",
  "/api/analytics/track",
  "/api/ads/funnel-event",

  // ---- The referral link. A visitor following an ambassador's link has never
  // been here; /r/[code] sets the attribution cookie and redirects, and it has
  // to run BEFORE the wall or the ambassador loses the credit. ----
  "/r/",

  // ---- Framework and static assets. ----
  //
  // /icons holds the favicons and the apple-touch icon, all four of which are
  // declared in the root layout's metadata and therefore requested by the
  // browser on every page — the login page and the legal pages included. Gated,
  // each one answered 307 to /account/login, so a signed-out visitor got no tab
  // icon and iOS got no home-screen icon. An icon reveals nothing: these are
  // brand marks, not catalog data, and they are already embedded in every
  // page's <head> for anyone who asks.
  "/_next",
  "/icons",
  "/images",
  "/videos",
  "/fonts",
];

/**
 * Whether this path may be served to a request with no account.
 *
 * Exact matches first so a public leaf cannot be widened by accident, then
 * prefixes. Everything else requires a session.
 */
export function isPublicPath(pathname: string) {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

/** The inverse, named for the thing it decides at the call site. */
export function requiresAccount(pathname: string) {
  return !isPublicPath(pathname);
}

