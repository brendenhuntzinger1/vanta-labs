/**
 * A browser-side tally of Google page views.
 *
 * The gtag call goes into a vendor queue and leaves nothing behind to inspect,
 * so the admin health board has no other way to know a page view happened.
 * Mirrors snap-health-browser.ts.
 */
const KEY = "vl_google_pageviews";

export function countGooglePageView(): void {
  try {
    const current = Number(window.sessionStorage.getItem(KEY) ?? "0");
    window.sessionStorage.setItem(KEY, String((Number.isFinite(current) ? current : 0) + 1));
  } catch {
    /* storage blocked; the tally is diagnostics, never a gate */
  }
}

/**
 * The gate decision, as a pure function.
 *
 * The component's three early returns delegate here so the decision is
 * testable without a DOM. A source-text assertion cannot catch a deleted early
 * return or an inverted condition; this can, and does — see the exhaustive
 * table in google-gate.test.ts.
 *
 * All three must hold. Any false is a no, and absence of a signal is a false.
 */
export function shouldLoadGoogleTag(input: {
  accepted: boolean;
  adsAllowed: boolean;
  conversionIdConfigured: boolean;
}): boolean {
  return input.accepted && input.adsAllowed && input.conversionIdConfigured;
}
