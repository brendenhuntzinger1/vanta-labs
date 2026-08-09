"use client";

/**
 * Ask the server to report the event the browser just reported.
 *
 * Fire-and-forget, and silent on every failure: this runs on product and
 * checkout pages, where a measurement problem must never become a visible one.
 * The browser leg has already happened by the time this is called, so the worst
 * case is one unreported server event.
 *
 * It passes the SAME event id the pixel used, which is what makes the pair one
 * event to TikTok instead of two. No prices are sent — the server re-resolves
 * those from the catalogue — and no personal data is sent either; the request's
 * own IP and user agent are all the match signal it needs beyond the click id.
 */

const CLICK_ID_KEY = "vl_attribution";

/** The click id captured on arrival, if this visitor arrived from an ad. */
function readClickId(): string | null {
  try {
    const raw = window.localStorage.getItem(CLICK_ID_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { last?: { ttclid?: string | null }; first?: { ttclid?: string | null } };
    return parsed?.last?.ttclid ?? parsed?.first?.ttclid ?? null;
  } catch {
    return null;
  }
}

export function relayToServer(input: {
  event: "ViewContent" | "AddToCart" | "InitiateCheckout";
  eventId: string;
  lines: { slug: string; quantity?: number }[];
  claimedTotal?: number;
}): void {
  try {
    void fetch("/api/ads/funnel-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, ttclid: readClickId(), pageUrl: window.location.href }),
      keepalive: true, // survives the navigation that a checkout click causes
      cache: "no-store",
    }).catch(() => {});
  } catch {
    /* never let measurement break a page */
  }
}
