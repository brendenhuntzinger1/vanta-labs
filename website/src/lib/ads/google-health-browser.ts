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
