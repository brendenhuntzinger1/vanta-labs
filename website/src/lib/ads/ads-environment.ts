/**
 * THE ONE GATE THAT DECIDES WHETHER AN AD EVENT MAY LEAVE THIS DEPLOYMENT.
 *
 * WHY THIS EXISTS (audit finding K-16). All three pixel ids are hard-coded as
 * env fallbacks — in tiktok-pixel.tsx, snap-pixel.tsx and ads/reddit-pixel-id.ts
 * — and they are the store's LIVE advertising accounts, not placeholders. (The
 * ids are deliberately NOT repeated here: single-data-source.test.ts and
 * reddit-pixel-source.test.ts assert each literal appears in exactly one file,
 * and a second copy is precisely the drift they exist to catch. Quoting them in
 * this comment reddened both, correctly.)
 *
 * Before this module there was NO environment guard anywhere in the analytics
 * path. Every `VERCEL_ENV` check in the repo gated CRAWLABILITY (robots.ts,
 * layout.tsx metadata), not tracking. So a preview deployment, a local run with
 * analytics enabled, a CI job or a Playwright script reported into the real ad
 * accounts — and because the server legs share the same constant, a paid test
 * order posted a real Purchase conversion carrying a real order value, training
 * the bid optimiser on revenue the store never took.
 *
 * That is not hypothetical: Phase 20 of the audit plan schedules a paid test
 * order on a Vercel preview.
 *
 * THE RULE IS DENY BY DEFAULT. A caller must present a production environment.
 * Absence of a signal is not permission — an unset VERCEL_ENV refuses, because
 * "we could not tell" and "this is production" must never be the same answer for
 * something that spends the store's advertising reputation.
 *
 * THERE IS DELIBERATELY NO OVERRIDE. An env var that re-enables reporting would
 * be one mistyped Vercel variable away from the defect this closes — the same
 * reasoning that removed ALLOW_MOCK_PAYMENTS from both payment lanes
 * (payment-provider.ts:299-313, billing-provider.ts:114-118). To report from a
 * non-production deployment, point the pixel ids at a test ad account with the
 * NEXT_PUBLIC_*_PIXEL_ID variables; do not defeat the environment check.
 *
 * NOTE ON META: there is no Meta/Facebook pixel in this codebase, and no Snap
 * Conversions API server leg. Google Ads has both legs, and both pass through
 * here — the browser tag via browserAdsReportingAllowed in google-pixel.tsx,
 * the Enhanced Conversions leg via serverAdsReportingAllowed in
 * google-conversions.ts. This gate is the chokepoint any future one must pass
 * through, which is the point of having exactly one.
 */

/**
 * Everything the decision depends on, passed explicitly.
 *
 * The decision is a pure function of these five values so it can be exhaustively
 * tested without stubbing `process.env` or a global `navigator` — the two things
 * that made the original omission invisible. `readServerAdsEnvironment` and
 * `readBrowserAdsEnvironment` below are the only places that touch ambient state.
 */
export interface AdsEnvironment {
  /** `VERCEL_ENV` on the server, `NEXT_PUBLIC_VERCEL_ENV` in the browser. */
  vercelEnv?: "production" | "preview" | "development" | string;
  /** `NODE_ENV`. A production Vercel deployment always builds with "production". */
  nodeEnv?: string;
  /** The `CI` variable. Set by GitHub Actions, Vercel builds and most runners. */
  ci?: string;
  /** `location.hostname` in the browser. Undefined on a server leg, which is fine. */
  hostname?: string;
  /** `navigator.webdriver`. Undefined on a server leg, which is fine. */
  webdriver?: boolean;
}

export type AdsRefusalReason =
  | "not_production_environment"
  | "not_production_build"
  | "automated_environment"
  | "non_production_host"
  | "automated_browser";

export type AdsVerdict =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: AdsRefusalReason };

const ALLOWED: AdsVerdict = { allowed: true };

/**
 * Hosts that are never the live storefront.
 *
 * `*.vercel.app` matters most: every preview deployment is served from it, and a
 * preview inherits production's environment variables unless they were scoped by
 * hand (Vercel defaults new variables to all environments). So the host check is
 * the backstop for a misconfigured `VERCEL_ENV`, not a duplicate of it.
 */
function isNonProductionHost(rawHostname: string): boolean {
  // Strip a port and lowercase: "LOCALHOST:3000" is localhost.
  const hostname = rawHostname.trim().toLowerCase().replace(/:\d+$/, "");
  if (!hostname) return true;

  return (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".vercel.app")
    || hostname.endsWith(".ngrok.io")
    || hostname.endsWith(".ngrok-free.app")
  );
}

/**
 * `CI` is set to "1" or "true" by runners that mean it, and some tools set it to
 * "false"/"0" explicitly. Treating any non-empty value as truthy would refuse a
 * production deployment whose platform set `CI=false`, so the check is on the
 * value, not on presence.
 */
function isAutomatedEnvironment(ci: string | undefined): boolean {
  if (!ci) return false;
  const value = ci.trim().toLowerCase();
  if (value === "" || value === "false" || value === "0") return false;
  return true;
}

/**
 * The decision. Ordered from broadest to narrowest so the reported reason is
 * stable when several apply — an operator reading a log wants the same answer
 * every time, not whichever check happened to run first.
 */
export function adsReportingAllowed(environment: AdsEnvironment): AdsVerdict {
  if (environment.vercelEnv !== "production") {
    return { allowed: false, reason: "not_production_environment" };
  }

  // A production Vercel deployment always builds with NODE_ENV=production. If it
  // does not, something is running the production environment's variables under
  // a dev or test build — a local `vercel env pull`, or a test importing a
  // component. Refuse.
  if (environment.nodeEnv !== "production") {
    return { allowed: false, reason: "not_production_build" };
  }

  if (isAutomatedEnvironment(environment.ci)) {
    return { allowed: false, reason: "automated_environment" };
  }

  // Undefined means "no location object", i.e. a server leg. That is legitimate;
  // an empty string is not, and isNonProductionHost refuses it.
  if (environment.hostname !== undefined && isNonProductionHost(environment.hostname)) {
    return { allowed: false, reason: "non_production_host" };
  }

  // The one rule that fires on production. Playwright, Puppeteer and Selenium all
  // set navigator.webdriver, so a QA pass against the live site — which the audit
  // plan explicitly contemplates — records nothing in the ad account.
  if (environment.webdriver === true) {
    return { allowed: false, reason: "automated_browser" };
  }

  return ALLOWED;
}

/** The server's view. The only place server-side ambient state is read. */
export function readServerAdsEnvironment(): AdsEnvironment {
  return {
    vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
    ci: process.env.CI,
    // A server leg has no location and no navigator; both stay undefined so the
    // host and webdriver checks correctly do not apply.
  };
}

/** The browser's view. The only place browser ambient state is read. */
export function readBrowserAdsEnvironment(): AdsEnvironment {
  // NEXT_PUBLIC_VERCEL_ENV is inlined at build time by Next.js on Vercel, so it
  // reflects the deployment that served this bundle — which is exactly the
  // question being asked.
  const vercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;
  const nodeEnv = process.env.NODE_ENV;

  if (typeof window === "undefined") {
    return { vercelEnv, nodeEnv };
  }

  return {
    vercelEnv,
    nodeEnv,
    hostname: window.location?.hostname,
    // Read defensively: `navigator` exists in every browser, but a test
    // environment or an embedded webview may not provide it.
    webdriver: typeof navigator === "undefined" ? undefined : navigator.webdriver === true,
  };
}

/** Convenience for server callers: one call, no environment plumbing. */
export function serverAdsReportingAllowed(): AdsVerdict {
  return adsReportingAllowed(readServerAdsEnvironment());
}

/** Convenience for browser callers: one call, no environment plumbing. */
export function browserAdsReportingAllowed(): AdsVerdict {
  return adsReportingAllowed(readBrowserAdsEnvironment());
}
