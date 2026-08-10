/**
 * Is the Snap Pixel actually alive on production?
 *
 * Snapchat's own installation checker cannot answer this for us, and the reason
 * is structural rather than a bug on either side. Their crawler fetches the
 * page, never sees a cookie banner it can accept, and so never receives the
 * pixel — which is precisely the behaviour the consent gate is for. A permanent
 * amber "we can't detect it" is what a correctly gated pixel looks like from
 * the outside, so a different instrument is needed to tell that apart from a
 * pixel that is genuinely broken.
 *
 * This is that instrument. It reports what is observable in a real browser on
 * the real deployment, and it keeps the same discipline as the TikTok board:
 * every row names who established the fact.
 *
 *   CODE        — provable from this repository.
 *   PRODUCTION  — observed in the live bundle, in this browser, right now.
 *   SNAP        — Snapchat's own SDK said so.
 *
 * The SNAP tier is narrow on purpose. The strongest thing a page can know
 * without calling Snapchat is that the real SDK replaced its own bootstrap
 * stub: the snippet queues calls into `snaptr.queue` until the downloaded
 * library installs `handleRequest`. If that function exists, sc-static.net was
 * fetched, executed, and is draining the queue. If it does not, the events are
 * sitting in an array going nowhere — which is exactly what an ad blocker, a
 * CSP mistake or a network failure looks like, and none of those are visible
 * from reading the source.
 *
 * Pure by construction: every input is passed in, so the whole board is
 * testable without a browser.
 */

import type { HealthStatus } from "./tracking-health";

export type SnapHealthTier = "CODE" | "PRODUCTION" | "SNAP";

export type SnapHealthCheck = {
  id: string;
  label: string;
  tier: SnapHealthTier;
  status: HealthStatus;
  /** What was actually observed. Never a restatement of the label. */
  detail: string;
  /** The single next thing a human would do about a non-green row. */
  action?: string;
};

export type SnapHealthInput = {
  /** False before anything has reported in — the board renders untested. */
  available: boolean;
  consent: "accepted" | "declined" | "unset";
  /** The id this build is configured to use. */
  configuredPixelId: string;
  /** Number of sc-static.net loader scripts in the document. */
  loaderScripts: number;
  /** The bootstrap stub defined `window.snaptr`. */
  stubPresent: boolean;
  /** The downloaded SDK installed handleRequest — it is really running. */
  sdkLoaded: boolean;
  /** Calls still sitting in the stub's queue, undelivered. */
  queuedCalls: number;
  /** Page views this component has counted since the page loaded. */
  pageViews: number;
  /** Whether each builder produces a well-formed event in the deployed bundle. */
  probes: { viewContent: boolean; addToCart: boolean; checkout: boolean };
};

export const UNTESTED_SNAP: SnapHealthInput = {
  available: false,
  consent: "unset",
  configuredPixelId: "",
  loaderScripts: 0,
  stubPresent: false,
  sdkLoaded: false,
  queuedCalls: 0,
  pageViews: 0,
  probes: { viewContent: false, addToCart: false, checkout: false },
};

const NOT_TESTED = (id: string, label: string, tier: SnapHealthTier): SnapHealthCheck => ({
  id,
  label,
  tier,
  status: "NOT_TESTED",
  detail: "Not measured yet — this row needs the board open in a browser.",
});

export function buildSnapHealthReport(input: SnapHealthInput): SnapHealthCheck[] {
  if (!input.available) {
    return [
      NOT_TESTED("snap-consent", "Cookie choice in this browser", "PRODUCTION"),
      NOT_TESTED("snap-loader", "Pixel script in the page", "PRODUCTION"),
      NOT_TESTED("snap-sdk", "Snap SDK running", "SNAP"),
      NOT_TESTED("snap-pageview", "PAGE_VIEW reported", "PRODUCTION"),
      NOT_TESTED("snap-funnel", "Funnel events well-formed", "CODE"),
    ];
  }

  const checks: SnapHealthCheck[] = [];

  checks.push({
    id: "snap-consent",
    label: "Cookie choice in this browser",
    tier: "PRODUCTION",
    status: input.consent === "accepted" ? "PASS" : "NOT_TESTED",
    detail:
      input.consent === "accepted"
        ? "Accepted, so the pixel is allowed to load here."
        : input.consent === "declined"
          ? "Declined. Nothing below can be green, and that is the gate working."
          : "No choice stored yet, so the pixel has not loaded in this browser.",
    action:
      input.consent === "accepted"
        ? undefined
        : "Accept on the banner (or use the button below) and re-run — every row under this one depends on it.",
  });

  // Two loaders is the failure this board exists to catch early: it double
  // counts every conversion, and nothing about the site looks wrong.
  checks.push({
    id: "snap-loader",
    label: "Pixel script in the page",
    tier: "PRODUCTION",
    // An absent loader is only a failure once consent makes one expected.
    // Marking a correctly gated pixel red is the same conflation Snapchat's
    // own detector makes, and it is the one this board must not repeat.
    status:
      input.loaderScripts === 1
        ? "PASS"
        : input.loaderScripts === 0 && input.consent !== "accepted"
          ? "NOT_TESTED"
          : "FAIL",
    detail:
      input.loaderScripts === 1
        ? `One loader, initialising ${input.configuredPixelId || "the configured pixel"}.`
        : input.loaderScripts === 0
          ? input.consent === "accepted"
            ? "No loader in the document even though cookies are accepted."
            : "No loader — expected, because consent has not been granted in this browser."
          : `${input.loaderScripts} loaders found. Every event is being counted more than once.`,
    action:
      input.loaderScripts > 1
        ? "Something outside this codebase is installing a second Snap Pixel — a tag manager, or the snippet pasted into the site head. Remove it; the app installs the pixel itself."
        : input.loaderScripts === 0 && input.consent === "accepted"
          ? "Reload this page. If it stays empty, the deploy carrying the pixel has not gone out."
          : undefined,
  });

  // The distinction that matters: the stub always works, so "snaptr exists"
  // proves almost nothing. Only handleRequest proves anything was delivered.
  const blocked = input.stubPresent && !input.sdkLoaded;
  checks.push({
    id: "snap-sdk",
    label: "Snap SDK running",
    tier: "SNAP",
    status: input.sdkLoaded ? "VERIFIED" : blocked ? "FAIL" : "NOT_TESTED",
    detail: input.sdkLoaded
      ? "sc-static.net downloaded and took over the queue, so events are leaving the browser."
      : blocked
        ? `The stub is queueing calls but the SDK never took over. ${input.queuedCalls} call(s) are stuck and nothing has reached Snap.`
        : "The pixel has not loaded in this browser, so there is nothing to check.",
    action: blocked
      ? "An ad blocker, a privacy extension or a network policy is stopping sc-static.net. Try a window with extensions disabled before concluding the site is at fault — real visitors with blockers will fail this too, which is what the server-side Conversions API would eventually cover."
      : undefined,
  });

  checks.push({
    id: "snap-pageview",
    label: "PAGE_VIEW reported",
    tier: "PRODUCTION",
    status: input.pageViews > 0 ? "PASS" : input.sdkLoaded ? "FAIL" : "NOT_TESTED",
    detail:
      input.pageViews > 0
        ? `${input.pageViews} page view(s) reported in this session.`
        : input.sdkLoaded
          ? "The SDK is running but no page view has been counted."
          : "Nothing to count until the pixel loads.",
  });

  // CODE tier, and labelled as such: this proves the deployed mapping builds a
  // complete event. It does not prove Snapchat received one.
  const funnel = [input.probes.viewContent, input.probes.addToCart, input.probes.checkout];
  const passing = funnel.filter(Boolean).length;
  checks.push({
    id: "snap-funnel",
    label: "Funnel events well-formed",
    tier: "CODE",
    status: passing === funnel.length ? "PASS" : "FAIL",
    detail:
      passing === funnel.length
        ? "VIEW_CONTENT, ADD_CART and START_CHECKOUT each build with an item id, a currency and a positive price."
        : `${passing} of ${funnel.length} build correctly in the deployed bundle.`,
    action: passing === funnel.length ? undefined : "A builder is producing an incomplete event — check the failing one in snap-events.ts.",
  });

  return checks;
}

/**
 * Why Snapchat's installation checker says what it says.
 *
 * Worth stating outright on the board, because the alternative is rediscovering
 * it every few weeks and wondering which side is broken.
 */
export function snapDetectorExplanation(input: SnapHealthInput): string {
  if (!input.available) return "Open this board in a browser to see how the pixel behaves for Snapchat's checker.";
  return input.sdkLoaded
    ? "Snapchat's installation checker will still report the pixel as undetected, and that is expected: its crawler never accepts the cookie banner, so it is served no pixel. This board is the check that can see past that — the SDK is confirmed running here."
    : "Snapchat's installation checker fetches the page without accepting cookies, so it is served no pixel and reports it as undetected. That is the consent gate working, not a broken install.";
}
