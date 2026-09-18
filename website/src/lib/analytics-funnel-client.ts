import { hasAcceptedConsent } from "@/lib/cookie-consent-client";

// ---------------------------------------------------------------------------
// ONE EVENT FROM A COMPONENT THAT IS NOT THE PAGE TRACKER.
//
// site-analytics-tracker.tsx owns the session — it is what creates the session
// and visitor ids and what sends page views. This is for a component that needs
// to record one thing that happened inside a page, on exactly the terms the
// tracker already established.
//
// IT NEVER CREATES A SESSION. The tracker's ids are read, never minted here. A
// component that invented one would be reporting a visit nobody made, and the
// funnel would count invitations shown to sessions that do not exist anywhere
// else in the table. No session id, no event: the page tracker will have
// created one by the time anything interesting happens, and if it has not, the
// visitor declined analytics and there is nothing to send.
//
// THE SAME CONSENT GATE, CHECKED AGAIN HERE. Decline is a real no-track path in
// this store, and a second sender that skipped the gate would quietly undo it.
//
// WHAT MAY BE SENT THROUGH IT. The route's allow-list is the real boundary and
// it is deliberately narrow — the header there explains what happened the last
// time it was not. Nothing here carries money, an order, or anything a report
// treats as revenue; the facts that matter about a spin are written server-side
// into customer_offers, where a browser cannot reach them.
// ---------------------------------------------------------------------------

const SESSION_KEY = "vl_analytics_session_id";
const VISITOR_KEY = "vl_analytics_visitor_id";

function storedId(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    // Storage blocked (private mode). The page tracker is silent for the same
    // reason, so this stays silent with it rather than inventing an identity.
    return "";
  }
}

/**
 * Record one in-page event against the session the page tracker established.
 *
 * Fire-and-forget by design: a funnel measurement must never delay, block or
 * fail the thing it is measuring. Every refusal is silent.
 */
export function trackFunnelEvent(eventType: string, payload?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    if (!hasAcceptedConsent()) return;
    const sessionId = storedId(SESSION_KEY);
    if (!sessionId) return;

    const body = JSON.stringify({
      eventType,
      sessionId,
      visitorId: storedId(VISITOR_KEY) || null,
      pagePath: window.location.pathname,
      pageUrl: window.location.href,
      deviceType: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
      payload: payload ?? {},
    });

    if (typeof navigator.sendBeacon === "function") {
      // A beacon survives the navigation this is usually reporting — the
      // invitation's own "accepted" event is sent as the page is leaving for
      // the wheel, and a plain fetch would be cancelled on the way out.
      navigator.sendBeacon("/api/analytics/track", new Blob([body], { type: "application/json" }));
      return;
    }

    void fetch("/api/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* a measurement is never worth an error on screen */
  }
}
